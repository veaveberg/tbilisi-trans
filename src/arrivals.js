/**
 * Arrivals Module
 * Handles fetching, processing, and rendering bus arrival data
 */

import * as api from './api.js';
import { getStaticRouteDetails } from './api.js';
import { db } from './db.js';
import { simplifyNumber, shouldShowRoute } from './settings.js';
import { loadIntervalData, getIntervalDescription } from './intervals.js';
import { getCurrentStopNamesLanguage, t } from './i18n.ts';

// --- Module State ---
let v3RoutesMap = null;
let v3RoutesPromise = null;
const V3_ROUTES_CACHE_KEY = 'v3_routes_map_cache';
const V3_CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours
const scheduledArrivalsCache = new Map(); // key -> { minutes, timeDisplay }
const scheduledArrivalsByStop = new Map(); // stopId -> Map(key -> { route, headsign, directionIndex, minutes, timeDisplay })
let selectedStopRouteIds = new Set();
let selectedStopRouteFilterStopId = null;

// --- Dependencies (injected from main.js) ---
let deps = {
    getEquivalentStops: null,
    mergeSourcesMap: null,
    stopToRoutesMap: null,
    renderAllRoutes: null,
    getRouteDisplayColor: null,
    getPatternHeadsign: null,
    allRoutes: null,
    // renderArrivals dependencies
    filterManager: null,
    showRouteOnMap: null,
    RouteGeometry: null,
    v3RoutesMap: null,
    getVirtualPatterns: null
};

/**
 * Normalize a route ID for comparison across different formats.
 * Handles: "1:R835" -> "R835", "rR835" -> "R835", "2:R835" -> "R835"
 */
function normalizeRouteId(id) {
    if (!id) return '';
    let s = String(id);
    // Strip numeric prefixes like "1:", "2:"
    if (/^\d+:/.test(s)) {
        s = s.replace(/^\d+:/, '');
    }
    // Strip lowercase 'r' prefix (Rustavi app-internal format)
    if (s.startsWith('r') && s.length > 1 && /[A-Z0-9]/.test(s[1])) {
        s = s.substring(1);
    }
    return s;
}

function isRailLikeMode(mode) {
    const m = String(mode || '').toUpperCase();
    return m === 'SUBWAY' || m === 'GONDOLA';
}

function getScheduleSpanMinutes(firstMinutes, lastMinutes) {
    if (!Number.isFinite(firstMinutes) || !Number.isFinite(lastMinutes)) return null;
    return lastMinutes >= firstMinutes
        ? (lastMinutes - firstMinutes)
        : ((lastMinutes + 24 * 60) - firstMinutes);
}

function shouldUseTripCountSummary(tripCount, firstMinutes, lastMinutes) {
    if (!Number.isFinite(tripCount) || tripCount <= 0) return false;
    const spanMinutes = getScheduleSpanMinutes(firstMinutes, lastMinutes);
    if (!Number.isFinite(spanMinutes) || spanMinutes <= 0) return false;
    return (tripCount / (spanMinutes / 60)) < 1;
}

function formatTripCountSummary(tripCount, firstTime, lastTime, options = {}) {
    const includeTimes = options.includeTimes !== false;
    if (!Number.isFinite(tripCount) || tripCount <= 0) return null;
    if (includeTimes && firstTime && lastTime) {
        return `__FULL__<span class="schedule-times">${t('scheduledTripsBetween', tripCount, firstTime, lastTime)}</span>`;
    }
    return t('scheduledTripsCount', tripCount);
}

function resolveRouteByShortName(shortName, options = {}) {
    const target = String(shortName || '').trim();
    if (!target || !deps.allRoutes) return null;

    const pool = deps.allRoutes();
    if (!Array.isArray(pool) || pool.length === 0) return null;
    const candidates = pool.filter(r => String(r.shortName) === target);
    if (!candidates.length) return null;

    const preferredStopId = options.preferredStopId ? String(options.preferredStopId) : '';
    const preferredStopIds = preferredStopId && typeof deps.getEquivalentStops === 'function'
        ? deps.getEquivalentStops(preferredStopId, false).map(id => String(id))
        : (preferredStopId ? [preferredStopId] : []);
    const preferredStopNorms = new Set(preferredStopIds.map(id => normalizeRouteId(id)));
    const preferBus = options.preferBus !== false;

    let best = null;
    let bestScore = -Infinity;

    for (const c of candidates) {
        let score = 0;
        const mode = String(c.mode || '').toUpperCase();
        if (preferBus && mode === 'BUS') score += 40;
        if (preferBus && isRailLikeMode(mode)) score -= 30;

        if (preferredStopNorms.size > 0 && Array.isArray(c.stops) && c.stops.length > 0) {
            const hasStop = c.stops.some(sid => preferredStopNorms.has(normalizeRouteId(sid)));
            if (hasStop) score += 55;
        }

        if (score > bestScore) {
            bestScore = score;
            best = c;
        }
    }

    return best || candidates[0];
}

/**
 * Initialize the arrivals module with dependencies from main.js
 */
export function initArrivals(dependencies) {
    deps = { ...deps, ...dependencies };
    // Load interval pattern data for schedule descriptions
    loadIntervalData().catch(e => console.warn('Failed to load interval data:', e));

    // Listen for static data preload to refresh arrivals (fixes direction logic on first load)
    window.addEventListener('static-routes-loaded', () => {
        // Skip if arrivals are actively loading (controller is handling it)
        if (window.arrivalsLoading) return;

        if (window.currentStopId && window.lastArrivals) {
            renderArrivals(window.lastArrivals, window.currentStopId);
        }
    });
}

export function resetStopRouteFilter(stopId = null) {
    selectedStopRouteIds = new Set();
    selectedStopRouteFilterStopId = stopId ? String(stopId) : null;
}

export function setStopRouteFilterIds(routeIds = [], stopId = null) {
    selectedStopRouteIds = new Set(
        Array.isArray(routeIds)
            ? routeIds.map(id => String(id).trim()).filter(Boolean)
            : []
    );
    selectedStopRouteFilterStopId = stopId ? String(stopId) : null;
    return getSelectedStopRouteFilterIds(stopId);
}

export function getSelectedStopRouteFilterIds(stopId = null) {
    if (stopId && selectedStopRouteFilterStopId && String(stopId) !== String(selectedStopRouteFilterStopId)) {
        return new Set();
    }
    return new Set(selectedStopRouteIds);
}

export function pruneStopRouteFilterIds(validRouteIds = [], stopId = null) {
    const normalizedStopId = stopId ? String(stopId) : selectedStopRouteFilterStopId;
    const valid = new Set((Array.isArray(validRouteIds) ? validRouteIds : []).map(id => String(id)));
    if (normalizedStopId && selectedStopRouteFilterStopId && selectedStopRouteFilterStopId !== normalizedStopId) {
        return new Set();
    }
    selectedStopRouteIds = new Set(Array.from(selectedStopRouteIds).filter(id => valid.has(String(id))));
    if (normalizedStopId) selectedStopRouteFilterStopId = normalizedStopId;
    return new Set(selectedStopRouteIds);
}

export function toggleStopRouteFilter(routeId, stopId = null) {
    const normalizedStopId = stopId ? String(stopId) : null;
    if (normalizedStopId && selectedStopRouteFilterStopId !== normalizedStopId) {
        selectedStopRouteIds = new Set();
        selectedStopRouteFilterStopId = normalizedStopId;
    } else if (!selectedStopRouteFilterStopId && normalizedStopId) {
        selectedStopRouteFilterStopId = normalizedStopId;
    }

    const routeKey = String(routeId || '').trim();
    if (!routeKey) return getSelectedStopRouteFilterIds(normalizedStopId);

    if (selectedStopRouteIds.has(routeKey)) {
        selectedStopRouteIds.delete(routeKey);
    } else {
        selectedStopRouteIds.add(routeKey);
    }

    return getSelectedStopRouteFilterIds(normalizedStopId);
}

// === UTILITY FUNCTIONS ===

/**
 * Resolves the correct directionIndex and headsign for an arrival, 
 * applying invertDirection and authoritative static mapping fixes.
 * Returns an object with { directionIndex, headsign, verifiedHeadsign, fixedDirection }.
 */
function resolveDirectionInfo(a, matchedRoute, stopId) {
    // Debug routes for tracing direction issues
    const debugRoutes = ['414', '437', '336'];
    const isLoopRoute = matchedRoute?._overrides?.isLoop === true ||
        matchedRoute?._overrides?.isLoop === 'true' ||
        matchedRoute?.isLoop === true;
    const overrides = matchedRoute?._overrides;
    if (a.shortName === '387' || a.shortName === '397') {
        console.log('[Arrivals Debug][Loop] resolveDirectionInfo enter', {
            shortName: a.shortName,
            id: a.id,
            stopId,
            patternSuffix: a.patternSuffix,
            headsign: a.headsign
        });
    }

    // --- DIRECTION FIX LOGIC (Static Check) ---
    const routeId = matchedRoute ? matchedRoute.id : (a.routeId || a.id);
    const staticDetails = getStaticRouteDetails(routeId);

    let directionIndex = 0;
    if (a.patternSuffix) {
        if (staticDetails && staticDetails.patterns) {
            const idx = staticDetails.patterns.findIndex(p => p.patternSuffix === a.patternSuffix);
            if (idx !== -1) {
                directionIndex = idx;
            } else {
                const part = a.patternSuffix.split(':')[0];
                directionIndex = parseInt(part) || 0;
            }
        } else {
            const part = a.patternSuffix.split(':')[0];
            directionIndex = parseInt(part) || 0;
        }
    }

    const invertDirection = matchedRoute?._overrides?.invertDirection === true;
    if (invertDirection) {
        directionIndex = directionIndex === 0 ? 1 : 0;
    }

    let verifiedHeadsign = null;
    let fixedDirection = false;
    let loopAmbiguous = false;

    if (staticDetails && staticDetails._stopsOfPatterns && stopId) {
        // Find stop entry
        const stopEntry = staticDetails._stopsOfPatterns.find(s => {
            const sId = String(s.stop.id || s.stop); // Handle object or string
            // Normalization for comparison
            const n1 = normalizeRouteId(sId);
            const n2 = normalizeRouteId(stopId);
            return sId === stopId || n1 === n2;
        });

        // Debug for problem routes (414, 437, etc.)
        if (debugRoutes.includes(a.shortName)) {
            console.log(`[${a.shortName} Init] stopId=${stopId} | stopEntry=${!!stopEntry} | patterns=${staticDetails.patterns?.length || 0} | hasDestinations=${!!matchedRoute?._overrides?.destinations} | isLoop=${matchedRoute?._overrides?.isLoop}`);
            if (stopEntry) {
                console.log(`[${a.shortName} Init] stopName="${stopEntry.stop?.name}" | suffixes=${JSON.stringify(stopEntry.patternSuffixes)}`);
            }
        }

        // --- VIRTUAL PATTERN DIRECTION DETECTION ---
        // For loop routes, check cached virtual patterns (_PART0, _PART1) to determine direction.
        // This is the same approach used by route card in main.js.
        if (isLoopRoute && stopEntry?.patternSuffixes && stopEntry.patternSuffixes.length > 1) {
            loopAmbiguous = true;
        }

        if (isLoopRoute && deps.getVirtualPatterns) {
            let virtualPatterns = deps.getVirtualPatterns(routeId);

            // FALLBACK: If missing from cache but we have static details, generate on-the-fly
            if ((!virtualPatterns || virtualPatterns.length === 0) && staticDetails?.patterns?.length === 1) {
                const originalPattern = staticDetails.patterns[0];
                const stops = originalPattern.stops;
                if (stops && stops.length > 0 && deps.RouteGeometry) {
                    try {
                        let forcedId = matchedRoute?._overrides?.terminusStopId_override ||
                            matchedRoute?._overrides?.terminusStopId ||
                            matchedRoute?._overrides?.virtualTerminusStopId;

                        virtualPatterns = deps.RouteGeometry.generateVirtualPatterns(
                            originalPattern,
                            stops,
                            matchedRoute.longName,
                            forcedId
                        );
                        if (debugRoutes.includes(a.shortName)) {
                            console.log(`[${a.shortName}] Generated on-the-fly virtual patterns for ${routeId}`);
                        }
                    } catch (e) {
                        console.warn(`[${a.shortName}] On-the-fly virtualization failed for ${routeId}`, e);
                    }
                }
            }

            if (virtualPatterns && virtualPatterns.length > 0) {
                // Find which virtual pattern(s) contain this stop
                const normalizedStopId = normalizeRouteId(stopId);
                const stopName = stopEntry?.stop?.name ? String(stopEntry.stop.name).toLowerCase().trim() : null;
                const candidates = [];

                for (let i = 0; i < virtualPatterns.length; i++) {
                    const vp = virtualPatterns[i];
                    const vpStops = vp.stops || [];

                    const containsStop = vpStops.some(s => {
                        const sId = String(s.id || s.stopId || s);
                        return sId === stopId || normalizeRouteId(sId) === normalizedStopId;
                    });

                    if (containsStop) {
                        candidates.push(vp);
                    }
                }

                if (candidates.length > 0) {
                    let chosen = candidates[0];

                    if (candidates.length > 1) {
                        // Ambiguous (usually terminus shared by both parts). Prefer the "other" terminus.
                        const isSplitPoint = candidates.some(vp => {
                            const splitId = vp._splitPoint?.id;
                            return splitId && (String(splitId) === String(stopId) || normalizeRouteId(splitId) === normalizedStopId);
                        });

                        if (isSplitPoint) {
                            const preferPart1 = candidates.find(vp => (vp.patternSuffix || '').endsWith('_PART1'));
                            if (preferPart1) chosen = preferPart1;
                        } else if (stopName) {
                            const preferOtherHeadsign = candidates.find(vp => {
                                const suffix = vp.patternSuffix || '';
                                const dirIdx = suffix.endsWith('_PART1') ? 1 : 0;
                                let hs = vp.headsign || '';
                                if (overrides?.destinations && overrides.destinations[dirIdx]?.headsign) {
                                    const dest = overrides.destinations[dirIdx];
                                    const locale = getCurrentStopNamesLanguage();
                                    hs = typeof dest.headsign === 'string'
                                        ? dest.headsign
                                        : (dest.headsign[locale] || dest.headsign.en || dest.headsign.ka || hs);
                                }
                                return hs && !hs.toLowerCase().includes(stopName);
                            });
                            if (preferOtherHeadsign) chosen = preferOtherHeadsign;
                        } else {
                            const preferPart0 = candidates.find(vp => (vp.patternSuffix || '').endsWith('_PART0'));
                            if (preferPart0) chosen = preferPart0;
                        }
                    }

                    // Found! Determine direction from suffix
                    const suffix = chosen.patternSuffix || '';
                    if (suffix.endsWith('_PART0')) {
                        directionIndex = 0;
                    } else if (suffix.endsWith('_PART1')) {
                        directionIndex = 1;
                    }

                    // Get headsign from pattern or overrides
                    if (overrides?.destinations && overrides.destinations[directionIndex]) {
                        const dest = overrides.destinations[directionIndex];
                        const locale = getCurrentStopNamesLanguage();
                        if (dest.headsign) {
                            verifiedHeadsign = typeof dest.headsign === 'string'
                                ? dest.headsign
                                : (dest.headsign[locale] || dest.headsign.en || dest.headsign.ka || '');
                        }
                    }

                    // If no headsign from overrides, use pattern headsign
                    if (!verifiedHeadsign && chosen.headsign) {
                        verifiedHeadsign = chosen.headsign;
                    }

                    fixedDirection = true;

                    if (debugRoutes.includes(a.shortName)) {
                        console.log(`[${a.shortName} VirtualPattern] Found stop in ${suffix} → dir=${directionIndex} headsign="${verifiedHeadsign}"`);
                    }
                }

                // If we found direction via virtual pattern, return early
                if (fixedDirection) {
                    const headsign = verifiedHeadsign || deps.getPatternHeadsign(matchedRoute, directionIndex, a.headsign);
                    if (debugRoutes.includes(a.shortName)) {
                        console.log(`[${a.shortName} Final] dir=${directionIndex} | headsign="${headsign}" | verified="${verifiedHeadsign}" | fixed=${fixedDirection}`);
                    }
                    if (a.shortName === '387' || a.shortName === '397') {
                        console.log('[Arrivals Debug][Loop] resolveDirectionInfo virtual', {
                            shortName: a.shortName,
                            stopId,
                            directionIndex,
                            headsign,
                            verifiedHeadsign,
                            fixedDirection,
                            loopAmbiguous
                        });
                    }
                    return { directionIndex, headsign, verifiedHeadsign, fixedDirection, loopAmbiguous };
                }
            } else if (debugRoutes.includes(a.shortName)) {
                console.log(`[${a.shortName}] No virtual patterns available for ${routeId}`);
            }
        }

        if (stopEntry && stopEntry.patternSuffixes && stopEntry.patternSuffixes.length === 1) {
            // If stop is EXCLUSIVE to one pattern, trust that pattern's direction
            const uniqueSuffix = stopEntry.patternSuffixes[0];
            const patternIndex = staticDetails.patterns ? staticDetails.patterns.findIndex(p => p.patternSuffix === uniqueSuffix) : -1;
            let staticRawDir = patternIndex !== -1 ? patternIndex : 0;

            if (invertDirection) {
                staticRawDir = staticRawDir === 0 ? 1 : 0;
            }

            // --- FORCE HEADSIGN FOR EXCLUSIVE STOPS ---
            // If we are SURE this bus is in a specific direction because the stop is exclusive,
            // we should also use the headsign from that static pattern (or overrides) to override ambiguous live data.
            const patternDef = staticDetails.patterns?.find(p => p.patternSuffix === uniqueSuffix);
            if (patternDef) {
                // Use getPatternHeadsign to respect Convex overrides, falling back to static pattern headsign
                verifiedHeadsign = deps.getPatternHeadsign(matchedRoute, staticRawDir, patternDef.headsign || a.headsign);
            }

            if (directionIndex !== staticRawDir) {
                if (debugRoutes.includes(a.shortName)) {
                    console.log(`[Direction Fix] ${a.shortName} at ${stopId}:`);
                    console.log(`   Live Suffix: ${a.patternSuffix} -> Live Index: ${directionIndex}`);
                    console.log(`   Static Suffix: ${uniqueSuffix} -> Forced Index: ${staticRawDir}`);
                    if (verifiedHeadsign) console.log(`   Forced headsign: "${verifiedHeadsign}"`);
                }

                directionIndex = staticRawDir;
                fixedDirection = true;
            } else if (debugRoutes.includes(a.shortName)) {
                // Direction index matches, but we still might have verifiedHeadsign forced
                console.log(`[${a.shortName} Dir] Match | staticRawDir=${staticRawDir} | verifiedHeadsign="${verifiedHeadsign}"`);
            }
        }
    }

    if (isLoopRoute && overrides?.destinations && a.headsign) {
        const locale = getCurrentStopNamesLanguage();
        const normalize = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
        const src = normalize(a.headsign);
        const scoreMatch = (candidate) => {
            const tgt = normalize(candidate);
            if (!src || !tgt) return 0;
            const srcTokens = new Set(src.split(' ').filter(Boolean));
            const tgtTokens = new Set(tgt.split(' ').filter(Boolean));
            let score = 0;
            srcTokens.forEach(t => {
                if (tgtTokens.has(t)) score += 1;
            });
            return score;
        };

        let bestIdx = null;
        let bestScore = -1;
        overrides.destinations.forEach((dest, idx) => {
            if (!dest || !dest.headsign) return;
            const cand = typeof dest.headsign === 'string'
                ? dest.headsign
                : (dest.headsign[locale] || dest.headsign.en || dest.headsign.ka || '');
            const s = scoreMatch(cand);
            if (s > bestScore) {
                bestScore = s;
                bestIdx = idx;
            }
        });

        if (bestIdx !== null && bestScore > 0) {
            directionIndex = bestIdx;
            const dest = overrides.destinations[bestIdx];
            verifiedHeadsign = typeof dest.headsign === 'string'
                ? dest.headsign
                : (dest.headsign[locale] || dest.headsign.en || dest.headsign.ka || verifiedHeadsign);
            fixedDirection = true;
        }
    }

    if (!verifiedHeadsign && isLoopRoute && a.headsign) {
        verifiedHeadsign = a.headsign;
    }
    const headsign = verifiedHeadsign || deps.getPatternHeadsign(matchedRoute, directionIndex, a.headsign);

    // Debug for problem routes
    if (debugRoutes.includes(a.shortName)) {
        console.log(`[${a.shortName} Final] dir=${directionIndex} | headsign="${headsign}" | verified="${verifiedHeadsign}" | fixed=${fixedDirection}`);
    }

    if (a.shortName === '387' || a.shortName === '397') {
        console.log('[Arrivals Debug][Loop] resolveDirectionInfo final', {
            shortName: a.shortName,
            stopId,
            directionIndex,
            headsign,
            verifiedHeadsign,
            fixedDirection,
            loopAmbiguous
        });
    }
    return { directionIndex, headsign, verifiedHeadsign, fixedDirection, loopAmbiguous };
}

/**
 * Returns an array of valid directionIndex values for a route at a stop based on static data.
 * Supports multiple stop IDs (equivalent stops).
 */
function getValidDirectionsForRoute(routeId, stopIds) {
    const matchedRoute = deps.allRoutes().find(r => String(r.id) === String(routeId)) || { id: routeId };
    if (matchedRoute?.shortName === '387' || matchedRoute?.shortName === '397') {
        console.log('[Arrivals Debug][Loop] getValidDirectionsForRoute', {
            routeId,
            shortName: matchedRoute.shortName,
            stopIds
        });
    }
    const staticDetails = getStaticRouteDetails(routeId);
    if (!staticDetails || !staticDetails._stopsOfPatterns || !stopIds || (Array.isArray(stopIds) && stopIds.length === 0)) return [0];

    const targetIds = Array.isArray(stopIds) ? stopIds.map(id => String(id)) : [String(stopIds)];
    const finalDirs = new Set();

    targetIds.forEach(id => {
        const stopEntry = staticDetails._stopsOfPatterns.find(s => {
            const sId = String(s.stop.id || s.stop);
            return sId === id || normalizeRouteId(sId) === normalizeRouteId(id);
        });

        if (stopEntry && stopEntry.patternSuffixes) {
            stopEntry.patternSuffixes.forEach(suffix => {
                const info = resolveDirectionInfo({ patternSuffix: suffix }, matchedRoute, id);
                finalDirs.add(info.directionIndex);
            });
        }
    });

    return finalDirs.size > 0 ? Array.from(finalDirs) : [0];
}

// Public wrapper to match stop-card direction resolution behavior.
export function getValidDirectionsForStop(routeId, stopIds) {
    return getValidDirectionsForRoute(routeId, stopIds);
}

/**
 * Public wrapper for stop-card direction/headsign resolution.
 * Reuses the same internal logic used by arrivals rendering.
 */
export function resolveDirectionForStop(arrivalLike, route, stopId) {
    return resolveDirectionInfo(arrivalLike, route, stopId);
}

/**
 * Format minutes from now to HH:mm (Tbilisi Time)
 */
export function formatScheduledTime(minutesFromNow) {
    const now = new Date();
    const target = new Date(now.getTime() + minutesFromNow * 60000);

    return new Intl.DateTimeFormat('en-GB', {
        timeZone: "Asia/Tbilisi",
        hour: 'numeric',
        minute: '2-digit',
        hour12: false
    }).format(target);
}

/**
 * Calculate minutes from now for a time string (HH:mm)
 */
export function getMinutesFromNow(timeStr) {
    if (!timeStr || timeStr === '--:--' || timeStr === '...') return 9999;

    const [h, m] = timeStr.split(':').map(Number);
    if (isNaN(h) || isNaN(m)) return 9999;

    const now = new Date();
    const tbilisiParts = new Intl.DateTimeFormat('en-US', {
        timeZone: "Asia/Tbilisi",
        hour: 'numeric',
        minute: 'numeric',
        hour12: false
    }).formatToParts(now);

    const currH = parseInt(tbilisiParts.find(p => p.type === 'hour').value);
    const currM = parseInt(tbilisiParts.find(p => p.type === 'minute').value);

    let diff = (h * 60 + m) - (currH * 60 + currM);
    if (diff < -60) { // Likely tomorrow
        diff += 24 * 60;
    }
    return diff;
}

function getCurrentTbilisiMinutes() {
    const now = new Date();
    const tbilisiParts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Tbilisi',
        hour: 'numeric',
        minute: 'numeric',
        hour12: false
    }).formatToParts(now);

    const h = parseInt(tbilisiParts.find(p => p.type === 'hour').value, 10);
    const m = parseInt(tbilisiParts.find(p => p.type === 'minute').value, 10);
    return h * 60 + m;
}

function shouldShowLateDepotWarning(etaMinutes, lastScheduledMinutes, firstScheduledMinutes) {
    const eta = Number(etaMinutes);
    const lastScheduled = Number(lastScheduledMinutes);
    const firstScheduled = Number(firstScheduledMinutes);

    if (!Number.isFinite(eta) || !Number.isFinite(lastScheduled)) return false;
    if (eta < 0 || eta === 999) return false;

    let currentMinutes = getCurrentTbilisiMinutes();

    // If the schedule extends past midnight, compare against the same extended-day frame.
    if (lastScheduled >= 24 * 60 && currentMinutes < 4 * 60) {
        currentMinutes += 24 * 60;
    }

    // For ordinary schedules that end before midnight, very-late live ETAs after midnight
    // should still be compared against the previous service day, not the new day's 00:xx clock.
    // Otherwise a suspicious 38' bus at 00:10 looks like 00:48 and stops being flagged on refresh.
    if (
        lastScheduled < 24 * 60 &&
        Number.isFinite(firstScheduled) &&
        currentMinutes < 4 * 60 &&
        currentMinutes + eta < firstScheduled
    ) {
        currentMinutes += 24 * 60;
    }

    const predictedArrivalMinutes = currentMinutes + eta;
    if (predictedArrivalMinutes <= lastScheduled + 15) return false;

    if (Number.isFinite(firstScheduled)) {
        const nextDayFirstScheduledMinutes = firstScheduled + 24 * 60;
        if (predictedArrivalMinutes >= nextDayFirstScheduledMinutes - 15) {
            return false;
        }
    }

    return true;
}

function isRealtimeArrival(value) {
    return value === true || value === 1 || value === '1' || value === 'true';
}

function logLateWarningDebug(stage, payload = {}) {
    try {
        if (!payload || (!payload.lateIndices?.length && !payload.lateWarningIndices?.length)) return;
        console.log(`[LateWarning][${stage}]`, payload);
    } catch (_) { }
}

function getLateWarningIndices(item, lastScheduledMinutes, firstScheduledMinutes, options = {}) {
    if (options.isMetroCard === true) return [];
    if (item.type !== 'live') return [];

    const displayArrivals = Array.isArray(item.displayArrivals) ? item.displayArrivals.slice(0, 3) : [];
    if (displayArrivals.length === 0) return [];

    const lateIndices = displayArrivals.flatMap((entry, index) => {
        if (entry.isScheduled) return [];
        const isLate = shouldShowLateDepotWarning(entry.minutes, lastScheduledMinutes, firstScheduledMinutes);
        if (!isLate) return [];
        return [index];
    });

    logLateWarningDebug('compute', {
        route: item?.data?.shortName,
        routeId: item?.data?.id,
        headsign: item?.headsign,
        firstScheduledMinutes,
        lastScheduledMinutes,
        displayArrivals: displayArrivals.map((entry, index) => ({
            index,
            minutes: entry?.minutes,
            isScheduled: entry?.isScheduled,
            text: entry?.text
        })),
        lateIndices
    });

    return lateIndices;
}

function getLateWarningEntries(item, lastScheduledMinutes, firstScheduledMinutes, options = {}) {
    const warningIndexes = getLateWarningIndices(item, lastScheduledMinutes, firstScheduledMinutes, options);
    const displayArrivals = Array.isArray(item.displayArrivals) ? item.displayArrivals.slice(0, 3) : [];
    const liveIndexes = displayArrivals.flatMap((entry, index) => entry.isScheduled ? [] : [index]);
    return getLateWarningEntriesFromIndices(warningIndexes, liveIndexes);
}

function getLateWarningEntriesFromIndices(warningIndexes, liveIndexes = []) {
    const warningIndexList = Array.isArray(warningIndexes) ? warningIndexes : [];
    if (warningIndexList.length === 0) return [];
    return [{
        index: warningIndexList[0],
        message: t('lateArrivalWarning')
    }];
}

function buildLateArrivalWarningHtml(item, lastScheduledMinutes, firstScheduledMinutes, options = {}) {
    const warningIndexes = Array.isArray(options.lateWarningIndices)
        ? options.lateWarningIndices
        : getLateWarningIndices(item, lastScheduledMinutes, firstScheduledMinutes, options);
    const displayArrivals = Array.isArray(item.displayArrivals) ? item.displayArrivals.slice(0, 3) : [];
    const liveIndexes = displayArrivals.flatMap((entry, index) => entry.isScheduled ? [] : [index]);
    const warnings = getLateWarningEntriesFromIndices(warningIndexes, liveIndexes);
    if (warnings.length === 0) return '';
    return warnings.map(warning => `<div class="arrival-warning">${warning.message}</div>`).join('');
}

function buildArrivalBottomHtml(baseHtml, item, lastScheduledMinutes, firstScheduledMinutes, options = {}) {
    const warningHtml = buildLateArrivalWarningHtml(item, lastScheduledMinutes, firstScheduledMinutes, options);
    return `${baseHtml || '&nbsp;'}${warningHtml}`;
}

function extractBaseArrivalBottomHtml(html) {
    const raw = String(html || '');
    if (!raw) return raw;
    return raw.replace(/<div class="arrival-warning">[\s\S]*?<\/div>/g, '').trim() || '&nbsp;';
}

/**
 * Sort the arrivals list by ETA
 */
export function sortArrivalsList() {
    const listEl = document.getElementById('arrivals-list');
    if (!listEl) return;

    const allChildren = Array.from(listEl.children);
    const items = allChildren.filter(child => !child.classList.contains('all-routes-container'));
    const nonSorted = allChildren.filter(child => child.classList.contains('all-routes-container'));

    items.sort((a, b) => {
        const aRouteSelected = a.getAttribute('data-route-chip-match') === '1';
        const bRouteSelected = b.getAttribute('data-route-chip-match') === '1';
        if (aRouteSelected && !bRouteSelected) return -1;
        if (!aRouteSelected && bRouteSelected) return 1;

        const aDestinationMatch = a.getAttribute('data-destination-match') !== '0';
        const bDestinationMatch = b.getAttribute('data-destination-match') !== '0';
        if (aDestinationMatch && !bDestinationMatch) return -1;
        if (!aDestinationMatch && bDestinationMatch) return 1;

        const minA = parseInt(a.getAttribute('data-minutes') || '99999');
        const minB = parseInt(b.getAttribute('data-minutes') || '99999');

        const diff = minA - minB;
        if (diff !== 0) return diff;

        const nameA = a.querySelector('.route-number')?.textContent?.trim() || '';
        const nameB = b.querySelector('.route-number')?.textContent?.trim() || '';
        return nameA.localeCompare(nameB, undefined, { numeric: true });
    });

    const desiredOrder = [...nonSorted, ...items];
    const isSameOrder = desiredOrder.length === allChildren.length &&
        desiredOrder.every((el, idx) => el === allChildren[idx]);

    if (isSameOrder) return;

    const fragment = document.createDocumentFragment();
    desiredOrder.forEach(item => fragment.appendChild(item));
    listEl.appendChild(fragment);
}

let arrivalsSortTimer = null;
function scheduleArrivalsSort() {
    if (arrivalsSortTimer) return;
    arrivalsSortTimer = setTimeout(() => {
        arrivalsSortTimer = null;
        sortArrivalsList();
    }, 50);
}

// === V3 SCHEDULE FUNCTIONS ===

/**
 * Fetch V3 routes mapping (shortName -> routeId)
 */
export async function fetchV3Routes() {
    if (v3RoutesMap) return;
    if (v3RoutesPromise) return v3RoutesPromise;

    // Try cache first
    try {
        const cached = await db.get(V3_ROUTES_CACHE_KEY);
        if (cached) {
            const { timestamp, data } = cached;
            if (Date.now() - timestamp < V3_CACHE_DURATION) {
                console.log('[V3] Loaded routes map from local cache');
                v3RoutesMap = new Map(data);
                return;
            }
        }
    } catch (e) {
        console.warn('[V3] Error reading local routes cache', e);
    }

    // Fetch from API
    v3RoutesPromise = (async () => {
        try {
            const cached = await db.get(V3_ROUTES_CACHE_KEY);
            if (cached && (Date.now() - cached.timestamp < V3_CACHE_DURATION)) {
                console.log('[V3] Loaded global routes list from DB Cache');
                v3RoutesMap = new Map(cached.data);
                return;
            }
        } catch (e) { }

        try {
            console.log('[V3] Fetching global routes list from API...');
            const routes = await api.fetchV3Routes();

            v3RoutesMap = new Map();
            routes.forEach(r => {
                v3RoutesMap.set(String(r.shortName), r.id);
            });
            console.log(`[V3] Mapped ${v3RoutesMap.size} routes`);

            try {
                await db.set(V3_ROUTES_CACHE_KEY, {
                    timestamp: Date.now(),
                    data: Array.from(v3RoutesMap.entries())
                });
            } catch (e) {
                console.warn('LS Write Failed (V3 Routes)', e);
            }

        } catch (e) {
            console.error('[V3] Global routes fetch failed', e);
            v3RoutesMap = null;
        } finally {
            v3RoutesPromise = null;
        }
    })();

    return v3RoutesPromise;
}

/**
 * Parse schedule response into next arrival times
 */
export function parseSchedule(schedule, potentialIds, patternSuffix = null, routeShortName = null) {
    if (!schedule || !Array.isArray(schedule)) {
        if (schedule !== null && schedule !== undefined) {
            console.warn(`[V3 Debug] Invalid schedule format`, schedule);
        }
        return null;
    }

    try {
        const tbilisiNow = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Tbilisi' });
        const todayStr = tbilisiNow;

        let daySchedule = schedule.find(s => s.serviceDates.includes(todayStr));

        if (!daySchedule) {
            console.warn(`[V3 Debug] No schedule found for today(${todayStr}). Using first available.`);
            daySchedule = schedule[0];
        }

        let firstTimeStr = null;
        let lastTimeStr = null;
        let firstScheduledMinutes = null;
        let lastScheduledMinutes = null;
        let nextTimes = [];

        // 1. Collect all departures for the day
        let allDepartures = [];
        if (daySchedule && daySchedule.stops) {
            const matchedStops = daySchedule.stops.filter((s, idx) => {
                const isTerminus = idx === daySchedule.stops.length - 1;
                if (isTerminus) return false;

                const sId = String(s.id);
                // Matching logic
                return potentialIds.some(pid => {
                    const pIdStr = String(pid);
                    const normalize = (id) => String(id).replace(/^\d+:/, '').replace(/^[rR]/, '');
                    const pIdNorm = normalize(pIdStr);
                    const sIdNorm = normalize(sId);
                    const sCode = String(s.code || '');
                    if (pIdStr === sId) return true;
                    if (pIdNorm === sIdNorm) return true;
                    if (sCode && normalize(sCode) === pIdNorm) return true;
                    return false;
                });
            });

            matchedStops.forEach((stop, idx) => {
                if (stop.arrivalTimes) {
                    stop.arrivalTimes.split(',').forEach(t => {
                        const [h, m] = t.split(':').map(Number);
                        const mins = h * 60 + m;
                        allDepartures.push({
                            time: `${h % 24}:${String(m).padStart(2, '0')}`,
                            minutes: mins,
                            hour: h % 24,
                            progress: idx / daySchedule.stops.length, // approximate
                            patternSuffix: patternSuffix
                        });
                    });
                }
            });
        }

        // 2. Process Departures (Sort & Find Extremes)
        if (allDepartures.length > 0) {
            allDepartures.sort((a, b) => a.minutes - b.minutes);

            // Format time helper (handle > 24h if necessary, though raw string is usually fine)
            const formatTime = (dep) => {
                const [h, m] = dep.time.split(':');
                return `${parseInt(h) % 24}:${m}`;
            };

            // Special handling for route 174 - split into service windows
            if (String(routeShortName) === '174') {
                // Morning: hours 5-7, Evening: hours 23-24 and 0-1
                const morning = allDepartures.filter(d => d.hour >= 5 && d.hour < 8);
                const evening = allDepartures.filter(d => d.hour >= 23 || d.hour < 2);

                let serviceWindows = null;
                if (morning.length > 0 && evening.length > 0) {
                    const morningFirst = formatTime(morning[0]);
                    const morningLast = formatTime(morning[morning.length - 1]);
                    const eveningFirst = formatTime(evening[0]);
                    const eveningLast = formatTime(evening[evening.length - 1]);
                    serviceWindows = `${morningFirst} – ${morningLast} and ${eveningFirst} – ${eveningLast}`;
                } else if (morning.length > 0) {
                    const morningFirst = formatTime(morning[0]);
                    const morningLast = formatTime(morning[morning.length - 1]);
                    serviceWindows = `${morningFirst} – ${morningLast}`;
                } else if (evening.length > 0) {
                    const eveningFirst = formatTime(evening[0]);
                    const eveningLast = formatTime(evening[evening.length - 1]);
                    serviceWindows = `${eveningFirst} – ${eveningLast}`;
                }

                if (serviceWindows) {
                    // Return with special serviceWindows field for route 174
                    const result = {
                        nextArrivals: [],
                        firstTime: null,
                        lastTime: null,
                        serviceWindows: serviceWindows
                    };

                    // Still calculate next arrivals
                    const now = new Date();
                    const tbilisiParts = new Intl.DateTimeFormat('en-US', {
                        timeZone: "Asia/Tbilisi",
                        hour: 'numeric',
                        minute: 'numeric',
                        hour12: false
                    }).formatToParts(now);
                    const h = parseInt(tbilisiParts.find(p => p.type === 'hour').value);
                    const m = parseInt(tbilisiParts.find(p => p.type === 'minute').value);
                    const curMinutes = h * 60 + m;
                    const futureDepartures = allDepartures.filter(d => d.minutes > curMinutes);
                    if (futureDepartures.length > 0) {
                        result.nextArrivals = futureDepartures.slice(0, 3);
                    }

                    return result;
                }
            }

            // First & Last (normal routes)
            const first = allDepartures[0];
            const last = allDepartures[allDepartures.length - 1];

            firstTimeStr = formatTime(first);
            lastTimeStr = formatTime(last);
            firstScheduledMinutes = first.minutes;
            lastScheduledMinutes = last.minutes;

            // 3. Find Next Arrival
            // Get current time in Tbilisi
            const now = new Date();
            const tbilisiParts = new Intl.DateTimeFormat('en-US', {
                timeZone: "Asia/Tbilisi",
                hour: 'numeric',
                minute: 'numeric',
                hour12: false
            }).formatToParts(now);
            const h = parseInt(tbilisiParts.find(p => p.type === 'hour').value);
            const m = parseInt(tbilisiParts.find(p => p.type === 'minute').value);
            const curMinutes = h * 60 + m;

            // Filter for future (or very recent past if we want to be generous? No, strictly future for "Next")
            const futureDepartures = allDepartures.filter(d => d.minutes > curMinutes);
            if (futureDepartures.length > 0) {
                nextTimes = futureDepartures.slice(0, 3); // Take next 3
            } else {
                // If today is finished, show the first arrivals of the next cycle (effectively tomorrow)
                nextTimes = allDepartures.slice(0, 3);
            }

        }
        const sparseTripSummary = (firstScheduledMinutes !== null && lastScheduledMinutes !== null)
            && shouldUseTripCountSummary(allDepartures.length, firstScheduledMinutes, lastScheduledMinutes)
            ? formatTripCountSummary(allDepartures.length, firstTimeStr, lastTimeStr, { includeTimes: true })
            : null;
        const result = {
            nextArrivals: nextTimes || [],
            firstTime: firstTimeStr,
            lastTime: lastTimeStr,
            firstScheduledMinutes: firstScheduledMinutes,
            lastScheduledMinutes: lastScheduledMinutes,
            sparseTripSummary
        };
        return result;

    } catch (err) {
        console.warn(`[V3] Logic Error parsing schedule: `, err);
    }
    return { nextArrivals: [], firstTime: null, lastTime: null };
}

/**
 * Get schedule for a specific route at a stop
 */
export async function getV3Schedule(routeShortName, stopId, explicitRouteId = null, explicitSuffix = null, options = {}) {
    let routeId = explicitRouteId;
    if (!routeId) {
        if (!v3RoutesMap) await fetchV3Routes();
        routeId = v3RoutesMap && v3RoutesMap.get(String(routeShortName));
    }

    if (!routeId) {
        console.warn(`[V3 Debug] Route ID not found for ${routeShortName}`);
        return null;
    }

    const stopIds = deps.getEquivalentStops ? deps.getEquivalentStops(stopId) : [stopId];
    if (deps.mergeSourcesMap?.has(stopId)) {
        deps.mergeSourcesMap.get(stopId).forEach(s => stopIds.push(s));
    }

    const result = await api.fetchScheduleForStop(routeId, stopIds, explicitSuffix, options);
    if (!result) {
        // console.warn(`[V3 Debug] No schedule returned from API for ${routeId}`);
        return null;
    }

    const { schedule, patternSuffix } = result;
    return parseSchedule(schedule, stopIds, patternSuffix, routeShortName);
}

/**
 * Format day label from fromDay-toDay (e.g., "MONDAY-FRIDAY" -> "Mon-Fri")
 */
function formatDayLabel(fromDay, toDay) {
    const dayAbbr = {
        'MONDAY': t('weekdayMon'),
        'TUESDAY': t('weekdayTue'),
        'WEDNESDAY': t('weekdayWed'),
        'THURSDAY': t('weekdayThu'),
        'FRIDAY': t('weekdayFri'),
        'SATURDAY': t('weekdaySat'),
        'SUNDAY': t('weekdaySun')
    };
    const from = dayAbbr[fromDay] || fromDay;
    const to = dayAbbr[toDay] || toDay;
    return from === to ? from : `${from}-${to}`;
}

/**
 * Get schedule entries metadata for tab UI
 * @param {Array} schedule - Raw schedule array from API
 * @returns {Array} Array of { label, index, isToday }
 */
export function getScheduleEntries(schedule) {
    if (!schedule || !Array.isArray(schedule)) return [];

    const tbilisiNow = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Tbilisi' });
    const dayNames = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
    const todayName = dayNames[new Date().getDay()];
    const todayIdx = dayNames.indexOf(todayName);

    return schedule.map((entry, index) => {
        let isToday = entry.serviceDates?.includes(tbilisiNow) || false;
        if (!isToday && entry.fromDay && entry.toDay) {
            const fIdx = dayNames.indexOf(entry.fromDay);
            const tIdx = dayNames.indexOf(entry.toDay);
            if (fIdx !== -1 && tIdx !== -1) {
                if (fIdx <= tIdx) isToday = todayIdx >= fIdx && todayIdx <= tIdx;
                else isToday = todayIdx >= fIdx || todayIdx <= tIdx;
            }
        }
        return {
            label: formatDayLabel(entry.fromDay, entry.toDay),
            index,
            isToday
        };
    });
}

/**
 * Get full schedule grouped by hour for a specific route at a stop
 * @param {string} routeShortName
 * @param {string} stopId
 * @param {string|null} explicitRouteId
 * @param {string|null} explicitSuffix
 * @param {Object} options - { strategy, scheduleIndex }
 * @returns {Promise<Object|null>} { grouped: Map of hour -> minutes, entries: tab metadata, activeIndex }
 */
export async function getFullScheduleGrouped(routeShortName, stopId, explicitRouteId = null, explicitSuffix = null, options = {}) {
    let routeId = explicitRouteId;
    if (!routeId) {
        if (!v3RoutesMap) await fetchV3Routes();
        routeId = v3RoutesMap && v3RoutesMap.get(String(routeShortName));
    }

    if (!routeId) return null;

    const stopIds = deps.getEquivalentStops ? deps.getEquivalentStops(stopId) : [stopId];
    if (deps.mergeSourcesMap?.has(stopId)) {
        deps.mergeSourcesMap.get(stopId).forEach(s => stopIds.push(s));
    }

    const result = await api.fetchScheduleForStop(routeId, stopIds, explicitSuffix, options);
    if (!result || !result.schedule) return null;

    const { schedule } = result;
    // Determine today's info for isToday check
    const tbilisiNow = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Tbilisi' });
    const dayNames = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
    const todayName = dayNames[new Date().getDay()];
    const todayIdx = dayNames.indexOf(todayName);

    // Build entries for tabs
    const entries = schedule.map((entry, index) => {
        const label = formatDayLabel(entry.fromDay, entry.toDay);

        // Calculate isToday
        let isToday = entry.serviceDates?.includes(tbilisiNow) || false;
        if (!isToday && entry.fromDay && entry.toDay) {
            const fIdx = dayNames.indexOf(entry.fromDay);
            const tIdx = dayNames.indexOf(entry.toDay);
            if (fIdx !== -1 && tIdx !== -1) {
                if (fIdx <= tIdx) isToday = todayIdx >= fIdx && todayIdx <= tIdx;
                else isToday = todayIdx >= fIdx || todayIdx <= tIdx;
            }
        }

        // Calculate summary (First - Last, Interval)
        let summaryTimes = '';
        let summaryInterval = '';
        const matchedStops = entry.stops?.filter((s, idx) => {
            const isTerminus = idx === entry.stops.length - 1;
            if (isTerminus) return false;
            const sId = String(s.id);
            const normalize = (id) => String(id).replace(/^\d+:/, '').replace(/^[rR]/, '');
            return stopIds.some(pid => {
                const pIdStr = String(pid);
                return pIdStr === sId || normalize(pIdStr) === normalize(sId) || (s.code && normalize(s.code) === normalize(pIdStr));
            });
        }) || [];

        if (matchedStops.length > 0) {
            const allTimes = [];
            matchedStops.forEach(s => {
                if (s.arrivalTimes) allTimes.push(...s.arrivalTimes.split(','));
            });
            if (allTimes.length > 0) {
                const toMins = t => {
                    let [h, m] = t.split(':').map(Number);
                    if (h < 4) h += 24;
                    return h * 60 + m;
                };
                allTimes.sort((a, b) => toMins(a) - toMins(b));
                const first = allTimes[0];
                const last = allTimes[allTimes.length - 1];

                const formatTime = (t) => {
                    if (!t) return '';
                    const [h, m] = t.split(':');
                    if (parseInt(h) >= 24) return `${parseInt(h) - 24}:${m}`;
                    return t;
                };
                summaryTimes = `${formatTime(first)} – ${formatTime(last)}`;

                const tripCount = allTimes.length;
                if (shouldUseTripCountSummary(tripCount, toMins(first), toMins(last))) {
                    summaryInterval = formatTripCountSummary(tripCount, null, null, { includeTimes: false }) || '';
                }
            }
        }

        if (!summaryInterval) {
            summaryInterval = getIntervalDescription(routeId);
        }
        // Fallback for Metro Line 2 (V3 ID check or shortName if available)
        if (!summaryInterval && routeShortName === '2') {
            summaryInterval = `${t('everyMinutes', 5)}, ${t('afterTimeEveryMinutes', '21:00', 10)}`;
        }

        return { label, index, isToday, summaryTimes, summaryInterval };
    });

    // Determine which schedule to use
    let activeIndex = options.scheduleIndex;
    if (activeIndex === undefined || activeIndex === null || isNaN(activeIndex)) {
        // Default to today's schedule
        const dayNames = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
        const todayName = dayNames[new Date().getDay()];
        const todayIdx = dayNames.indexOf(todayName);

        activeIndex = schedule.findIndex(s => {
            if (s.serviceDates?.includes(tbilisiNow)) return true;
            if (s.fromDay && s.toDay) {
                const fIdx = dayNames.indexOf(s.fromDay);
                const tIdx = dayNames.indexOf(s.toDay);
                if (fIdx !== -1 && tIdx !== -1) {
                    if (fIdx <= tIdx) return todayIdx >= fIdx && todayIdx <= tIdx;
                    return todayIdx >= fIdx || todayIdx <= tIdx;
                }
            }
            return false;
        });
        if (activeIndex === -1 && schedule.length > 0) activeIndex = 0;
    }

    const daySchedule = schedule[activeIndex];
    if (!daySchedule || !daySchedule.stops) return null;

    const matchedStops = daySchedule.stops.filter((s, idx) => {
        const isTerminus = idx === daySchedule.stops.length - 1;
        if (isTerminus) return false;

        const sId = String(s.id);
        const sCode = String(s.code || '');
        return stopIds.some(pid => {
            const pIdStr = String(pid);
            const normalize = (id) => String(id).replace(/^\d+:/, '').replace(/^[rR]/, '');
            return pIdStr === sId || normalize(pIdStr) === normalize(sId) || (sCode && normalize(sCode) === normalize(pIdStr));
        });
    });

    if (matchedStops.length === 0) return null;

    const grouped = {};
    matchedStops.forEach(stop => {
        if (stop.arrivalTimes) {
            stop.arrivalTimes.split(',').forEach(t => {
                const [h, m] = t.split(':');
                const hour = String(parseInt(h) % 24).padStart(2, '0');
                const mins = m.padStart(2, '0');
                if (!grouped[hour]) grouped[hour] = [];
                if (!grouped[hour].includes(mins)) grouped[hour].push(mins);
            });
        }
    });

    // Sort minutes in each hour
    Object.keys(grouped).forEach(hour => {
        grouped[hour].sort((a, b) => parseInt(a) - parseInt(b));
    });

    return { grouped, entries, activeIndex };
}

// Legacy sync version (returns null)
export function getV3ScheduleSync(routeShortName, stopId) {
    return null;
}

// === ARRIVALS FETCHING ===

/**
 * Quick fetch of scheduled arrivals from static cache
 */
export async function fetchArrivalsOptimistic(stopId) {
    const equivalentIds = deps.getEquivalentStops ?
        deps.getEquivalentStops(stopId, false) : [stopId];

    const idsToCheck = new Set();
    equivalentIds.forEach(eqId => {
        idsToCheck.add(eqId);
        const subIds = deps.mergeSourcesMap?.get(eqId) || [];
        subIds.forEach(sId => idsToCheck.add(sId));
    });

    const routeIdsSet = new Set();
    Array.from(idsToCheck).forEach(id => {
        const rids = api.getRoutesForStopStatic(id);
        rids.forEach(rid => routeIdsSet.add(rid));
    });

    const routeIds = Array.from(routeIdsSet);
    if (!routeIds || routeIds.length === 0) return [];

    const allRoutes = deps.allRoutes() || [];

    const schedulePromises = routeIds.map(async (rid) => {
        const r = allRoutes.find(route => route.id === rid);
        if (!r) return null;

        const sched = await getV3Schedule(r.shortName, stopId, rid, null, { strategy: 'cache-only' });
        if (!sched || !sched.nextArrivals || sched.nextArrivals.length === 0) return null;

        return sched.nextArrivals.map(arr => ({
            shortName: r.shortName,
            id: r.id,
            displayShortName: r.customShortName || r.shortName,
            scheduledArrivalMinutes: getMinutesFromNow(arr.time),
            headsign: arr.headsign || sched.headsign || r.longName,
            realtime: false,
            _source: r._source,
            patternSuffix: arr.patternSuffix
        }));
    });

    const results = await Promise.all(schedulePromises);
    const flattened = results.flat().filter(Boolean);

    // Sort by time
    flattened.sort((a, b) => a.scheduledArrivalMinutes - b.scheduledArrivalMinutes);

    return flattened;
}

/**
 * Fetch arrivals for a stop (including equivalent/merged stops)
 */
export async function fetchArrivals(stopId) {
    const equivalentIds = deps.getEquivalentStops ?
        deps.getEquivalentStops(stopId, false) : [stopId];

    const idsToCheck = new Set();
    equivalentIds.forEach(eqId => {
        idsToCheck.add(eqId);
        const subIds = deps.mergeSourcesMap?.get(eqId) || [];
        subIds.forEach(sId => idsToCheck.add(sId));
    });

    const routeIdsSet = new Set();
    Array.from(idsToCheck).forEach(id => {
        const routeIds = api.getRoutesForStopStatic(id);
        routeIds.forEach(routeId => routeIdsSet.add(routeId));
    });
    const routeCount = routeIdsSet.size;
    const maxNumberOfArrivalTimes = Math.min(150, Math.max(5, routeCount > 0 ? routeCount * 5 : 5));

    // Note: Loading state is managed by ArrivalsController
    const combined = await api.fetchArrivalsForStopIds(Array.from(idsToCheck), { maxNumberOfArrivalTimes });

    // Group by route, prefer live over scheduled
    const arrivalsByRoute = new Map();
    combined.forEach(a => {
        const routeKey = a.shortName;
        if (!arrivalsByRoute.has(routeKey)) {
            arrivalsByRoute.set(routeKey, []);
        }
        arrivalsByRoute.get(routeKey).push(a);
    });

    const filtered = [];
    arrivalsByRoute.forEach((arrivals, routeKey) => {
        const hasLive = arrivals.some(a => a.realtime);
        if (hasLive) {
            filtered.push(...arrivals.filter(a => a.realtime));
        } else {
            filtered.push(...arrivals);
        }
    });

    // Deduplicate
    const unique = [];
    const seen = new Set();
    filtered.forEach(a => {
        const time = a.realtimeArrivalMinutes !== undefined ? a.realtimeArrivalMinutes : a.scheduledArrivalMinutes;
        const key = `${a.shortName}_${time}_${a.headsign}`;
        if (!seen.has(key)) {
            seen.add(key);
            unique.push(a);
        }
    });

    // Sort by time
    unique.sort((a, b) => {
        const timeA = a.realtimeArrivalMinutes !== undefined ? a.realtimeArrivalMinutes : a.scheduledArrivalMinutes;
        const timeB = b.realtimeArrivalMinutes !== undefined ? b.realtimeArrivalMinutes : b.scheduledArrivalMinutes;
        return timeA - timeB;
    });

    return unique;
}

function getArrivalMinutesValue(arrival) {
    if (!arrival) return 999;
    if (arrival.realtime) {
        return (arrival.realtimeArrivalMinutes !== undefined && arrival.realtimeArrivalMinutes !== null)
            ? arrival.realtimeArrivalMinutes
            : 999;
    }
    return (arrival.scheduledArrivalMinutes !== undefined && arrival.scheduledArrivalMinutes !== null)
        ? arrival.scheduledArrivalMinutes
        : 999;
}

function formatArrivalDisplayValue(minutes, isScheduled) {
    if (minutes === 999 || minutes === null || minutes === undefined) return '--:--';
    if (isScheduled) {
        const scheduled = formatScheduledTime(minutes);
        return scheduled ? `${scheduled}˚` : '--:--';
    }
    return `${minutes}'`;
}

function buildDisplayedArrivals(arrivals, limit = 3) {
    if (!Array.isArray(arrivals) || arrivals.length === 0) return [];
    return arrivals
        .slice()
        .sort((a, b) => getArrivalMinutesValue(a) - getArrivalMinutesValue(b))
        .slice(0, limit)
        .map(a => {
            const minutes = getArrivalMinutesValue(a);
            const isScheduled = !a.realtime;
            return {
                minutes,
                isScheduled,
                text: formatArrivalDisplayValue(minutes, isScheduled)
            };
        });
}

function buildScheduleDisplayEntries(nextArrivals, limit = 3) {
    if (!Array.isArray(nextArrivals) || nextArrivals.length === 0) return [];
    return nextArrivals.slice(0, limit).map(arr => {
        const rawTime = String(arr?.time || '');
        const minutes = getMinutesFromNow(rawTime);
        return {
            minutes,
            isScheduled: true,
            text: rawTime ? (rawTime.includes('˚') ? rawTime : `${rawTime}˚`) : '--:--'
        };
    });
}

function buildArrivalTimesMarkup(displayArrivals, timeElId, options = {}) {
    const entries = Array.isArray(displayArrivals) ? displayArrivals.slice(0, 3) : [];
    const primary = entries[0] || { text: '--:--', isScheduled: false };
    const isMetroCard = options.isMetroCard === true;
    const lateWarningIndices = new Set(Array.isArray(options.lateWarningIndices) ? options.lateWarningIndices : []);
    const lateStyleAttr = ` style="color:#fbbf24 !important; text-shadow:0 0 5px rgba(251, 191, 36, 0.28) !important;"`;
    const primaryClasses = ['led-text', 'arrival-time-primary'];
    if (primary.isScheduled) primaryClasses.push('scheduled-time');
    if (lateWarningIndices.has(0)) primaryClasses.push('late-depot-time');
    const primaryText = isMetroCard && primary.isScheduled ? String(primary.text || '').replace(/˚$/, '') : primary.text;
    const primaryMarkup = isMetroCard && primary.isScheduled
        ? `
            <div class="metro-scheduled-time-stack">
                <div id="${timeElId}" class="${primaryClasses.join(' ')}"${lateWarningIndices.has(0) ? lateStyleAttr : ''}>${primaryText}</div>
                <div class="scheduled-disclaimer">${t('scheduled')}</div>
            </div>
        `
        : `<div id="${timeElId}" class="${primaryClasses.join(' ')}"${lateWarningIndices.has(0) ? lateStyleAttr : ''}>${primaryText}</div>`;

    const secondaryMarkup = entries.length > 1 ? `
        <div class="time-secondary-stack">
            ${entries.slice(1, 3).map((entry, index) => {
                const classes = ['led-text', 'led-text-secondary'];
                if (entry.isScheduled) classes.push('scheduled-time');
                if (lateWarningIndices.has(index + 1)) classes.push('late-depot-time');
                return `<div class="${classes.join(' ')}" data-secondary-index="${index + 1}"${lateWarningIndices.has(index + 1) ? lateStyleAttr : ''}>${entry.text}</div>`;
            }).join('')}
        </div>
    ` : '';

    return `
        <div class="time-container ${entries.length > 1 ? 'time-container-multi' : 'time-container-single'}">
            <div class="time-primary-wrap">
                ${primaryMarkup}
            </div>
            ${secondaryMarkup}
        </div>
    `;
}

function applyLateWarningClasses(cardEl, lateWarningIndices = []) {
    if (!cardEl) return;
    const lateSet = new Set(Array.isArray(lateWarningIndices) ? lateWarningIndices : []);
    const applyLateStyle = (el, isLate) => {
        if (!el) return;
        el.classList.toggle('late-depot-time', isLate);
        if (isLate) {
            el.style.setProperty('color', '#fbbf24', 'important');
            el.style.setProperty('text-shadow', '0 0 5px rgba(251, 191, 36, 0.28)', 'important');
        } else {
            el.style.removeProperty('color');
            el.style.removeProperty('text-shadow');
        }
    };
    const primaryEl = cardEl.querySelector('.arrival-time-primary');
    if (primaryEl) {
        applyLateStyle(primaryEl, lateSet.has(0));
    }
    const secondaryEls = cardEl.querySelectorAll('.led-text-secondary');
    secondaryEls.forEach((secondaryEl, index) => {
        applyLateStyle(secondaryEl, lateSet.has(index + 1));
    });
}

function updateCardDisplayArrivals(cardEl, timeElId, displayEntries, primaryMinutes = null, options = {}) {
    if (!cardEl || !Array.isArray(displayEntries) || displayEntries.length === 0) return;
    const lateWarningIndices = Array.isArray(options.lateWarningIndices) ? options.lateWarningIndices : [];
    const currentTimeContainer = cardEl.querySelector('.time-container');
    if (currentTimeContainer) {
        currentTimeContainer.outerHTML = buildArrivalTimesMarkup(displayEntries, timeElId, options);
    }
    cardEl.setAttribute('data-late-warning-indices', lateWarningIndices.join(','));
    applyLateWarningClasses(cardEl, lateWarningIndices);
    cardEl.setAttribute('data-display-arrival-minutes', displayEntries.map(entry => entry.minutes).join(','));
    cardEl.setAttribute('data-display-arrival-scheduled', displayEntries.map(entry => entry.isScheduled ? '1' : '0').join(','));
    if (Number.isFinite(primaryMinutes)) {
        cardEl.setAttribute('data-minutes', primaryMinutes);
        cardEl.setAttribute('data-minutes-original', primaryMinutes);
    }
}

// === RENDER ARRIVALS
export function renderArrivals(arrivalsData, currentStopId = null) {
    const listEl = document.getElementById('arrivals-list');
    if (!listEl) return;

    const stopId = currentStopId || window.currentStopId;
    const allStops = (typeof window !== 'undefined' && Array.isArray(window.allStops)) ? window.allStops : [];
    const stopObj = allStops.find(s => String(s.id) === String(stopId));
    const activeMode = String(stopObj?.mode || stopObj?.vehicleMode || window.currentStopMode || '').toUpperCase();
    const isGondolaStop = activeMode === 'GONDOLA';
    const isMetroStop = activeMode === 'SUBWAY';

    // --- CROSS-STOP PROTECTION ---
    // If this render is for a stop that is no longer the current one, ignore it.
    // This prevents async results from previous stops from overwriting the current UI.
    if (stopId && window.currentStopId && String(stopId) !== String(window.currentStopId)) {
        return;
    }

    // --- STOP CHANGE DETECTION ---
    // If we've switched stops, we MUST clear the list immediately to avoid
    // showing old stop's arrivals and to prevent ID collisions.
    if (
        window._lastRenderedStopId !== null &&
        window._lastRenderedStopId !== undefined &&
        String(window._lastRenderedStopId) !== String(stopId)
    ) {
        listEl.innerHTML = '';
        listEl.scrollTop = 0;
        resetStopRouteFilter(stopId);
    }
    window._lastRenderedStopId = String(stopId);


    // NOTE: Staleness-based refresh is now handled by ArrivalsController
    // renderArrivals is now a pure render function - no fetching



    // --- RENDER LOGIC ---

    // 0. Ensure All Routes (Chips)
    if (window.lastRoutes) {
        const tiles = deps.renderAllRoutes(window.lastRoutes, arrivalsData);
        let chipsContainer = listEl.querySelector('.all-routes-container');
        if (!chipsContainer && tiles) {
            // Chips should be at the very top
            listEl.insertBefore(tiles, listEl.firstChild);
        } else if (tiles) {
            if (chipsContainer !== tiles) chipsContainer.replaceWith(tiles);
        } else if (chipsContainer && !tiles) {
            chipsContainer.remove();
        }
    }


    // 1. Identify "Missing" Routes
    const uniqueRoutesMap = new Map();
    const representedKeys = new Set();
    let equivalentIds = [stopId];

    if (stopId) {
        equivalentIds = deps.getEquivalentStops(stopId, false);

        equivalentIds.forEach(eqId => {
            const routes = deps.stopToRoutesMap.get(eqId) || [];
            routes.forEach(r => {
                const key = `${r.shortName}_${r.longName || ''}_${r.id}`;
                if (!uniqueRoutesMap.has(key)) {
                    uniqueRoutesMap.set(key, r);
                }
            });
        });
    }

    const validRouteIdsForStop = [
        ...Array.from(uniqueRoutesMap.values()).map(route => route.id || (resolveRouteByShortName(route.shortName, { preferredStopId: stopId, preferBus: true }) || {}).id),
        ...arrivalsData.map(arrival => {
            const resolvedRoute = deps.allRoutes().find(route => String(route.id) === String(arrival.id)) ||
                deps.allRoutes().find(route => normalizeRouteId(route.id) === normalizeRouteId(arrival.id)) ||
                resolveRouteByShortName(arrival.shortName, { preferredStopId: stopId, preferBus: true });
            return resolvedRoute?.id || arrival.id || null;
        })
    ]
        .filter(Boolean)
        .map(id => String(id));
    const selectedRouteIds = pruneStopRouteFilterIds(validRouteIdsForStop, stopId);

    // 2. Filter Logic (User Route Filter)
    const shouldFilterArrivals = !!(deps.filterManager &&
        (deps.filterManager.state.active ||
            (deps.filterManager.state.targetIds && deps.filterManager.state.targetIds.size > 0) ||
            window.isFilterModeActive) &&
        deps.filterManager.state.filteredRoutes &&
        deps.filterManager.state.filteredRoutes.length > 0);

    let isRouteAllowed = null;
    if (shouldFilterArrivals) {
        const filteredRoutes = deps.filterManager.state.filteredRoutes || [];
        const filteredIds = new Set(filteredRoutes.map(id => String(id)));
        const filteredIdsNorm = new Set(filteredRoutes.map(id => normalizeRouteId(id)));
        const allowedShortNames = new Set();

        (deps.allRoutes() || []).forEach(route => {
            if (!route) return;
            const rId = String(route.id);
            if (filteredIds.has(rId) || filteredIdsNorm.has(normalizeRouteId(rId))) {
                allowedShortNames.add(String(route.shortName));
            }
        });

        const isFilteredRouteId = (routeId) => {
            if (!routeId) return false;
            const idStr = String(routeId);
            return filteredIds.has(idStr) || filteredIdsNorm.has(normalizeRouteId(idStr));
        };

        isRouteAllowed = (arrivalOrRoute) => {
            if (!arrivalOrRoute) return false;
            const aId = arrivalOrRoute.id;
            const aShort = arrivalOrRoute.shortName;
            if (isFilteredRouteId(aId)) return true;
            if (allowedShortNames.has(String(aShort))) return true;

            const r = deps.allRoutes().find(route => String(route.id) === String(aId)) ||
                deps.allRoutes().find(route => normalizeRouteId(route.id) === normalizeRouteId(aId)) ||
                resolveRouteByShortName(aShort, { preferredStopId: stopId, preferBus: true });
            return r ? isFilteredRouteId(r.id) : false;
        };

    }

    // 2.5 Show Minibuses Filter
    arrivalsData = arrivalsData.filter(a => {
        // Precise matching: exact ID, normalized ID, then shortName
        const r = deps.allRoutes().find(route => String(route.id) === String(a.id)) ||
            deps.allRoutes().find(route => normalizeRouteId(route.id) === normalizeRouteId(a.id)) ||
            resolveRouteByShortName(a.shortName, { preferredStopId: stopId, preferBus: true });
        return shouldShowRoute(a.shortName, r);
    });

    const selectedRouteIdsNorm = new Set(Array.from(selectedRouteIds).map(id => normalizeRouteId(id)));
    const isSelectedStopRoute = (routeLike) => {
        if (!routeLike) return false;
        const matchedRoute = deps.allRoutes().find(route => String(route.id) === String(routeLike.id)) ||
            deps.allRoutes().find(route => normalizeRouteId(route.id) === normalizeRouteId(routeLike.id)) ||
            resolveRouteByShortName(routeLike.shortName, { preferredStopId: stopId, preferBus: true }) ||
            routeLike;
        const routeId = String(matchedRoute.id || routeLike.id || '');
        return selectedRouteIds.has(routeId) || selectedRouteIdsNorm.has(normalizeRouteId(routeId));
    };

    // 3. Unified List Creation with Cache Lookup
    let renderList = [];

    // --- LIVE ARRIVALS GROUPING LOGIC ---
    // User wants multiple arrivals (e.g. 5', 12') for the same route to be grouped.
    // Group by: ShortName + Direction (Headsign/PatternSuffix)
    const liveGroups = new Map(); // Key -> { primary: arrival, secondaries: [arrival] }
    const liveRouteKeys = new Set();

    console.log(`[Arrivals Debug] Processing ${arrivalsData.length} live arrivals.ShortNames: `, arrivalsData.map(a => a.shortName));
    arrivalsData.forEach(a => {
        // Robustness: Handle minutes
        let minutes = 999;
        if (a.realtime) {
            minutes = (a.realtimeArrivalMinutes !== undefined && a.realtimeArrivalMinutes !== null) ? a.realtimeArrivalMinutes : 999;
        } else {
            minutes = (a.scheduledArrivalMinutes !== undefined && a.scheduledArrivalMinutes !== null) ? a.scheduledArrivalMinutes : 999;
        }
        a._calculatedMinutes = minutes; // Store temporarily


        const actualStopId = a._sourceStopId || stopId;

        // Match by ID first (exact), then normalized ID (handles 1:R835 vs rR835), then source-aware shortName
        const matchedRouteForColor = deps.allRoutes().find(r => String(r.id) === String(a.id)) ||
            deps.allRoutes().find(r => normalizeRouteId(r.id) === normalizeRouteId(a.id)) ||
            resolveRouteByShortName(a.shortName, { preferredStopId: actualStopId, preferBus: true });

        // Ensure we have a valid ID for this arrival (use matched route if missing in LIVE data)
        if (!a.id && matchedRouteForColor) a.id = matchedRouteForColor.id;
        if (!a.displayShortName && matchedRouteForColor) {
            a.displayShortName = matchedRouteForColor.customShortName || matchedRouteForColor.shortName;
        }

        const resolveStopId = stopId || actualStopId;
        const { directionIndex, headsign, verifiedHeadsign, loopAmbiguous } = resolveDirectionInfo(a, matchedRouteForColor, resolveStopId);
        if (verifiedHeadsign) a._verifiedHeadsign = verifiedHeadsign;
        const routeIdForKey = String((matchedRouteForColor && matchedRouteForColor.id) || a.id || a.shortName);
        const cacheKey = `${actualStopId}|${routeIdForKey}|${directionIndex}`;
        if (!a.realtime && minutes !== 999) {
            const schedTime = formatScheduledTime(minutes);
            const timeDisplay = schedTime ? `${schedTime}˚` : null;
            scheduledArrivalsCache.set(cacheKey, {
                minutes,
                timeDisplay
            });
            if (actualStopId) {
                if (!scheduledArrivalsByStop.has(actualStopId)) {
                    scheduledArrivalsByStop.set(actualStopId, new Map());
                }
                const stopMap = scheduledArrivalsByStop.get(actualStopId);
                const groupKey = `${routeIdForKey}_${directionIndex}`;
                stopMap.set(groupKey, {
                    route: {
                        id: routeIdForKey,
                        shortName: a.shortName,
                        longName: a.longName,
                        customShortName: a.displayShortName
                    },
                    headsign,
                    directionIndex,
                    minutes,
                    timeDisplay
                });
            }
        }

        // Group Key: ShortName + Direction Index (or Headsign if fuzzy)
        // We use DirectionIndex as primary differentiator for grouped rows.
        const groupKey = loopAmbiguous ? `${routeIdForKey}_loop` : `${routeIdForKey}_${directionIndex}`;
        if (a.shortName === '387' || a.shortName === '397') {
            console.log('[Arrivals Debug][Loop] Live groupKey', {
                shortName: a.shortName,
                directionIndex,
                loopAmbiguous,
                groupKey,
                stopId: resolveStopId,
                id: a.id,
                headsign
            });
        }
        representedKeys.add(groupKey);
        liveRouteKeys.add(routeIdForKey);

        if (!liveGroups.has(groupKey)) {
            liveGroups.set(groupKey, {
                primary: a,
                headsign: headsign,
                directionIndex: directionIndex,
                color: deps.getRouteDisplayColor(matchedRouteForColor || { ...a, id: a.id }),
                arrivals: [],
                key: groupKey
            });
        }
        liveGroups.get(groupKey).arrivals.push(a);
    });

    // Convert Groups to RenderList Items
    liveGroups.forEach(group => {
        // Sort arrivals in this group by time
        group.arrivals.sort((a, b) => a._calculatedMinutes - b._calculatedMinutes);

        // Take only the closest arrival
        const primaryArrival = group.arrivals[0];

        renderList.push({
            type: 'live',
            data: primaryArrival,
            minutes: primaryArrival._calculatedMinutes,
            color: group.color,
            headsign: group.headsign,
            directionIndex: group.directionIndex,
            allArrivals: group.arrivals,
            displayArrivals: buildDisplayedArrivals(group.arrivals, 3),
            key: group.key || `${primaryArrival.shortName}_${group.directionIndex}`
        });
    });

    // Add Extra Routes (Scheduled/Missing)
    // We iterate through all unique routes found for this stop and add scheduled entries
    // for directions not currently represented in liveGroups.
    const sharedStopRoutes = new Set();
    if (stopId) {
        uniqueRoutesMap.forEach(r => {
            const staticDetails = getStaticRouteDetails(r.id);
            const stopEntry = staticDetails?._stopsOfPatterns?.find(s => {
                const sId = String(s.stop?.id || s.stop);
                return sId === String(stopId) || normalizeRouteId(sId) === normalizeRouteId(stopId);
            });
            if (stopEntry && Array.isArray(stopEntry.patternSuffixes) && stopEntry.patternSuffixes.length > 1) {
                sharedStopRoutes.add(String(r.id || r.shortName));
            }
        });
    }

    uniqueRoutesMap.forEach(r => {
        // Apply Global Filters (User selection & Minibus settings)
        if (shouldFilterArrivals) {
            const rId = String(r.id);
            const filteredRoutes = deps.filterManager.state.filteredRoutes || [];
            const filteredIds = new Set(filteredRoutes.map(id => String(id)));
            const filteredIdsNorm = new Set(filteredRoutes.map(id => normalizeRouteId(id)));
            const allowedShortNames = new Set();
            (deps.allRoutes() || []).forEach(route => {
                if (!route) return;
                const idStr = String(route.id);
                if (filteredIds.has(idStr) || filteredIdsNorm.has(normalizeRouteId(idStr))) {
                    allowedShortNames.add(String(route.shortName));
                }
            });
        }
        if (!shouldShowRoute(r.shortName, r)) return;
        const routeIdentity = String(r.id || r.shortName);
        if (liveRouteKeys.has(routeIdentity) && sharedStopRoutes.has(routeIdentity)) return;

        const validDirs = getValidDirectionsForRoute(r.id, equivalentIds);
        validDirs.forEach(dirIdx => {
            const key = `${routeIdentity}_${dirIdx}`;
            if (!representedKeys.has(key)) {
                const realRoute = deps.allRoutes().find(route => String(route.id) === String(r.id)) ||
                    deps.allRoutes().find(route => normalizeRouteId(route.id) === normalizeRouteId(r.id)) ||
                    resolveRouteByShortName(r.shortName, { preferredStopId: stopId, preferBus: true }) ||
                    r;
                const isLoopRoute = realRoute?._overrides?.isLoop === true || realRoute?.isLoop === true || realRoute?._overrides?.isLoop === 'true';
                if (liveRouteKeys.has(routeIdentity) && isLoopRoute) return;
                // Determine headsign for this direction at this stop
                const { headsign } = resolveDirectionInfo({ id: realRoute.id, shortName: realRoute.shortName, directionIndex: dirIdx }, realRoute, stopId);
                const stableId = `route-${realRoute.id || r.id}-${dirIdx}`;
                const existingEl = document.getElementById(stableId);
                let existingMinutes = 99999;
                let existingTimeDisplay = null;
                const cacheKey = `${stopId}|${realRoute.id || r.id}|${dirIdx}`;
                const cached = scheduledArrivalsCache.get(cacheKey);
                if (cached) {
                    if (cached.timeDisplay) existingTimeDisplay = cached.timeDisplay;
                    const cachedMins = cached.timeDisplay ? getMinutesFromNow(cached.timeDisplay.replace('˚', '')) : cached.minutes;
                    if (!Number.isNaN(cachedMins) && cachedMins !== null && cachedMins !== undefined) {
                        existingMinutes = cachedMins;
                    } else if (cached.minutes !== undefined && cached.minutes !== null) {
                        existingMinutes = cached.minutes;
                    }
                }
                if (existingEl) {
                    const storedMinutes = parseInt(existingEl.getAttribute('data-minutes') || existingEl.getAttribute('data-minutes-original') || '99999');
                    const existingTimeEl = existingEl.querySelector('.led-text');
                    const existingText = existingTimeEl?.textContent || '';
                    if (existingText && existingText !== '--:--') {
                        existingTimeDisplay = existingText;
                        const recomputed = getMinutesFromNow(existingText.replace('˚', ''));
                        if (!Number.isNaN(recomputed)) {
                            existingMinutes = recomputed;
                        }
                    } else if (!Number.isNaN(storedMinutes) && storedMinutes < 99999) {
                        existingMinutes = storedMinutes;
                    }
                }

                const scheduledItem = {
                    type: 'scheduled',
                    data: realRoute,
                    minutes: existingMinutes,
                    color: deps.getRouteDisplayColor(realRoute),
                    directionIndex: dirIdx,
                    headsign: headsign,
                    needsFetch: true,
                    timeDisplay: existingTimeDisplay || undefined,
                    key: key
                };

                // If no live data and this stop has multiple patterns for this route, keep only the earliest scheduled item
                if (!liveRouteKeys.has(routeIdentity) && sharedStopRoutes.has(routeIdentity)) {
                    const existingIdx = renderList.findIndex(item =>
                        item.type === 'scheduled' && String(item.data.id || item.data.shortName) === routeIdentity
                    );
                    if (existingIdx !== -1) {
                        if (scheduledItem.minutes < renderList[existingIdx].minutes) {
                            renderList[existingIdx] = scheduledItem;
                        }
                    } else {
                        renderList.push(scheduledItem);
                    }
                } else {
                    renderList.push(scheduledItem);
                }
                representedKeys.add(key);
            }
        });
    });

    // Fallback: Add cached scheduled routes for this stop if they are missing
    if (stopId && scheduledArrivalsByStop.has(stopId)) {
        const stopMap = scheduledArrivalsByStop.get(stopId);
        stopMap.forEach((cached, key) => {
            if (representedKeys.has(key)) return;
            const minsFromDisplay = cached.timeDisplay ? getMinutesFromNow(cached.timeDisplay.replace('˚', '')) : cached.minutes;
            renderList.push({
                type: 'scheduled',
                data: cached.route,
                minutes: minsFromDisplay,
                color: deps.getRouteDisplayColor(cached.route),
                directionIndex: cached.directionIndex,
                headsign: cached.headsign,
                needsFetch: true,
                timeDisplay: cached.timeDisplay || undefined,
                key: key
            });
            representedKeys.add(key);
        });
    }

    // 4. Sort EVERYTHING
    renderList.sort((a, b) => {
        if (selectedRouteIds.size > 0) {
            const aSelected = isSelectedStopRoute(a.data);
            const bSelected = isSelectedStopRoute(b.data);
            if (aSelected && !bSelected) return -1;
            if (!aSelected && bSelected) return 1;
        }
        if (shouldFilterArrivals && typeof isRouteAllowed === 'function') {
            const aAllowed = isRouteAllowed(a.data);
            const bAllowed = isRouteAllowed(b.data);
            if (aAllowed && !bAllowed) return -1;
            if (!aAllowed && bAllowed) return 1;
        }
        const minDiff = a.minutes - b.minutes;
        if (minDiff !== 0) return minDiff; // Sort by Time

        // Secondary Sort: Route Number
        const nameA = String(a.data.shortName || '');
        const nameB = String(b.data.shortName || '');
        return nameA.localeCompare(nameB, undefined, { numeric: true });
    });

    // -- FLIP ANIMATION START --
    // 1. Record positions of existing items
    const oldRects = new Map();
    listEl.querySelectorAll('.arrival-item').forEach(el => {
        oldRects.set(el.id, el.getBoundingClientRect());
    });

    const activeIds = new Set();

    const emptyId = 'arrivals-empty-msg';
    const isActuallyLoading = window.arrivalsLoading;

    if (renderList.length === 0 && !isActuallyLoading && !isGondolaStop) {
        activeIds.add(emptyId);
        let emptyDiv = document.getElementById(emptyId);
        if (!emptyDiv) {
            emptyDiv = document.createElement('div');
            emptyDiv.id = emptyId;
            emptyDiv.className = 'empty';
            emptyDiv.style.opacity = '0';
            // Use setTimeout to ensure it's in the DOM before animating
            setTimeout(() => { if (emptyDiv) emptyDiv.style.opacity = '1'; }, 10);
        }
        const msg = (deps.filterManager && deps.filterManager.state.active)
            ? t('noArrivalsForSelectedDestination')
            : t('noUpcomingArrivals');
        if (emptyDiv.textContent !== msg) emptyDiv.textContent = msg;

        // Position it
        const chips = listEl.querySelector('.all-routes-container');
        if (chips) {
            if (chips.nextSibling !== emptyDiv) chips.after(emptyDiv);
        } else if (listEl.firstChild !== emptyDiv) {
            listEl.insertBefore(emptyDiv, listEl.firstChild);
        }
    } else {
        const existingEmpty = document.getElementById(emptyId);
        if (existingEmpty) existingEmpty.remove();
    }

    // 2. Diff and Render
    renderList.forEach((item, index) => {
        const routeId = item.data.id || item.data.shortName || 'unknown';
        const dirIdx = item.directionIndex !== undefined ? item.directionIndex : 0;
        const stableId = `route-${item.key || `${routeId}_${dirIdx}`}`;
        activeIds.add(stableId);

        let div = document.getElementById(stableId);
        const isNew = !div;

        if (isNew) {
            div = document.createElement('div');
            div.id = stableId;
            div.className = 'arrival-item';
            div.style.opacity = '0'; // Start invisible
        }

        // Tag with metadata for tracking and cleanup
        div.setAttribute('data-stop-id', stopId);
        div.setAttribute('data-route-id', routeId);
        div.setAttribute('data-direction', dirIdx);

        if (div.style.opacity === '0' && !isNew) {
            div.style.opacity = '1';
            div.style.transform = '';
        }

        // Record last active timestamp for expiration logic
        div.setAttribute('data-last-active', Date.now());

        div.setAttribute('data-minutes', item.minutes);
        div.setAttribute('data-minutes-original', item.minutes); // Reset original minutes for countdown
        div.setAttribute('data-item-type', item.type);
        div.setAttribute('data-needs-fetch', item.needsFetch ? '1' : '0');
        div.style.borderLeftColor = item.color;
        const destinationFilterActive = shouldFilterArrivals && typeof isRouteAllowed === 'function';
        const matchesDestinationFilter = destinationFilterActive ? isRouteAllowed(item.data) : true;
        const routeChipFilterActive = selectedRouteIds.size > 0;
        const matchesRouteChipFilter = routeChipFilterActive ? isSelectedStopRoute(item.data) : true;
        div.setAttribute('data-route-chip-match', matchesRouteChipFilter ? '1' : '0');
        div.setAttribute('data-destination-match', matchesDestinationFilter ? '1' : '0');
        div.classList.remove('route-filter-faded', 'route-filter-extra-faded');
        if (destinationFilterActive && !matchesDestinationFilter) {
            div.classList.add(routeChipFilterActive ? 'route-filter-extra-faded' : 'route-filter-faded');
        } else if (routeChipFilterActive && !matchesRouteChipFilter) {
            div.classList.add('route-filter-faded');
        }

        // -- Data Prep --
        let routeShortName, headsign, timeDisplay, isScheduled, needsDisclaimer, routeIdForClick;
        let displayArrivals = Array.isArray(item.displayArrivals) ? item.displayArrivals.slice(0, 3) : [];
        let lateWarningIndices = [];
        let routeColor = item.color;

        if (item.type === 'live') {
            const a = item.data;
            routeShortName = a.displayShortName || a.shortName;
            headsign = item.headsign;
            isScheduled = !a.realtime;
            routeIdForClick = a.id;
            // No debug logging

            const rawMins = item.minutes;
            if (rawMins === 999 || rawMins === null || rawMins === undefined) {
                timeDisplay = '--:--';
            } else if (isScheduled) {
                timeDisplay = formatScheduledTime(rawMins);
            } else {
                timeDisplay = `${rawMins}'`;
            }
            if (isScheduled && timeDisplay !== '--:--' && !timeDisplay.includes('˚')) {
                timeDisplay += '˚';
            }
            needsDisclaimer = isScheduled;
            if (displayArrivals.length === 0) {
                displayArrivals = [{
                    minutes: rawMins,
                    isScheduled,
                    text: timeDisplay
                }];
            }
        } else {
            const r = item.data;
            routeShortName = r.customShortName || r.shortName;

            const freshRoute = deps.allRoutes().find(route =>
                String(route.id) === String(r.id) ||
                String(route.id) === `1:${r.id}` ||
                `1:${route.id}` === String(r.id)
            ) || r;

            headsign = item.headsign;
            isScheduled = true;
            needsDisclaimer = true;
            timeDisplay = item.timeDisplay || '--:--';
            routeIdForClick = r.id;
            if (displayArrivals.length === 0) {
                displayArrivals = [{
                    minutes: item.minutes,
                    isScheduled: true,
                    text: timeDisplay
                }];
            }
        }

        div.setAttribute('data-display-arrival-minutes', displayArrivals.map(entry => entry.minutes).join(','));
        div.setAttribute('data-display-arrival-scheduled', displayArrivals.map(entry => entry.isScheduled ? '1' : '0').join(','));

        if (!headsign || headsign === 'undefined') {
            headsign = t('destinationUnknown');
        }

        const timeElId = `time-${stableId}`;
        const bottomBarId = `bottom-${stableId}`;
        const bottomBarAttr = `id="${bottomBarId}"`;

        let bottomContent = '&nbsp;';
        // Preserve bottom content if already exists
        const existingBottom = div.querySelector('.arrival-card-bottom');
        if (existingBottom && existingBottom.innerHTML.trim() !== '&nbsp;') {
            const baseHtml = existingBottom.dataset.baseHtml || extractBaseArrivalBottomHtml(existingBottom.innerHTML);
            const lastScheduledMinutes = existingBottom.dataset.lastScheduledMinutes;
            const firstScheduledMinutes = existingBottom.dataset.firstScheduledMinutes;
            lateWarningIndices = getLateWarningIndices(item, lastScheduledMinutes, firstScheduledMinutes, { isMetroCard: isMetroStop });
            if (lateWarningIndices.length === 0) {
                lateWarningIndices = (div.getAttribute('data-late-warning-indices') || '')
                    .split(',')
                    .filter(Boolean)
                    .map(v => parseInt(v, 10))
                    .filter(v => Number.isFinite(v));
            }
            logLateWarningDebug('render-existing-bottom', {
                route: item?.data?.shortName,
                routeId: item?.data?.id,
                cardId: stableId,
                firstScheduledMinutes,
                lastScheduledMinutes,
                lateWarningIndices
            });
            bottomContent = buildArrivalBottomHtml(baseHtml, item, lastScheduledMinutes, firstScheduledMinutes, {
                isMetroCard: isMetroStop,
                lateWarningIndices
            });
        }

        const innerContent = `
            <div class="arrival-card-left">
                <div class="arrival-card-top">
                    <div class="route-number" style="color: ${routeColor}">${simplifyNumber(routeShortName)}</div>
                    <div class="destination" title="${headsign}">${headsign}</div>
                </div>
                <div class="arrival-card-bottom" ${bottomBarAttr}>
                    ${bottomContent}
                </div>
            </div>
            <div class="arrival-card-right">
                ${buildArrivalTimesMarkup(displayArrivals, timeElId, { isMetroCard: isMetroStop, lateWarningIndices })}
            </div>
        `;

        if (div.innerHTML !== innerContent) {
            div.innerHTML = innerContent;
        }
        div.setAttribute('data-late-warning-indices', lateWarningIndices.join(','));
        applyLateWarningClasses(div, lateWarningIndices);
        logLateWarningDebug('render-card', {
            route: item?.data?.shortName,
            routeId: item?.data?.id,
            cardId: stableId,
            lateWarningIndices,
            displayArrivals: displayArrivals.map((entry, index) => ({
                index,
                minutes: entry?.minutes,
                isScheduled: entry?.isScheduled,
                text: entry?.text
            }))
        });

        // Click handler (refresh every time to ensure latest closure)
        let routeObj = deps.allRoutes().find(r => r.id === routeIdForClick) ||
            deps.allRoutes().find(r => normalizeRouteId(r.id) === normalizeRouteId(routeIdForClick)) ||
            resolveRouteByShortName(item.data.shortName, { preferredStopId: stopId, preferBus: true });

        if (routeObj) {
            div.onclick = () => {
                deps.showRouteOnMap(routeObj, true, {
                    preserveBounds: false,
                    fromStopId: stopId,
                    targetHeadsign: headsign,
                    initialDirectionIndex: item.directionIndex,
                    routeSource: 'stop'
                });
            };
        }

        if (item.type === 'live' && displayArrivals.length < 3 && routeIdForClick) {
            const liveFetchState = div.getAttribute('data-live-route-arrivals-fetch');
            if (liveFetchState !== 'pending') {
                div.setAttribute('data-live-route-arrivals-fetch', 'pending');
                const actualStopId = item.data._sourceStopId || stopId;
                api.fetchRouteArrivalsForStop(actualStopId, routeIdForClick).then(routeArrivals => {
                    if (String(div.getAttribute('data-stop-id') || '') !== String(stopId)) {
                        return;
                    }
                    if (!Array.isArray(routeArrivals) || routeArrivals.length === 0) {
                        div.setAttribute('data-live-route-arrivals-fetch', 'done');
                        return;
                    }

                    const filteredRouteArrivals = routeArrivals.filter(arrival => {
                        const matchedRoute = deps.allRoutes().find(r => String(r.id) === String(routeIdForClick)) ||
                            deps.allRoutes().find(r => normalizeRouteId(r.id) === normalizeRouteId(routeIdForClick)) ||
                            resolveRouteByShortName(arrival.shortName, { preferredStopId: actualStopId, preferBus: true });
                        const directionInfo = resolveDirectionInfo(arrival, matchedRoute, actualStopId);
                        return directionInfo.directionIndex === item.directionIndex;
                    });

                    const liveOnly = filteredRouteArrivals.filter(arrival => arrival.realtime);
                    const candidateArrivals = liveOnly.length > 0 ? liveOnly : filteredRouteArrivals;
                    const nextDisplayArrivals = buildDisplayedArrivals(candidateArrivals, 3);
                    if (
                        nextDisplayArrivals.length > 1 &&
                        document.getElementById(div.id) === div &&
                        String(div.getAttribute('data-stop-id') || '') === String(stopId)
                    ) {
                        item.displayArrivals = nextDisplayArrivals;
                        const currentBottomEl = document.getElementById(bottomBarId);
                        const firstScheduledMinutes = currentBottomEl?.dataset.firstScheduledMinutes;
                        const lastScheduledMinutes = currentBottomEl?.dataset.lastScheduledMinutes;
                        const lateWarnings = getLateWarningEntries(item, lastScheduledMinutes, firstScheduledMinutes, { isMetroCard: isMetroStop });
                        const lateWarningIndices = getLateWarningIndices(item, lastScheduledMinutes, firstScheduledMinutes, { isMetroCard: isMetroStop });
                        logLateWarningDebug('route-fetch-update', {
                            route: item?.data?.shortName,
                            routeId: item?.data?.id,
                            cardId: stableId,
                            firstScheduledMinutes,
                            lastScheduledMinutes,
                            nextDisplayArrivals,
                            lateWarningIndices
                        });
                        if (currentBottomEl) {
                            currentBottomEl.dataset.lateWarningIndices = lateWarningIndices.join(',');
                            const baseHtml = currentBottomEl.dataset.baseHtml || currentBottomEl.innerHTML;
                            currentBottomEl.innerHTML = buildArrivalBottomHtml(baseHtml, item, lastScheduledMinutes, firstScheduledMinutes, {
                                isMetroCard: isMetroStop,
                                lateWarningIndices
                            });
                        }
                        div.setAttribute('data-late-warning-indices', lateWarningIndices.join(','));
                        applyLateWarningClasses(div, lateWarningIndices);
                        updateCardDisplayArrivals(div, timeElId, nextDisplayArrivals, nextDisplayArrivals[0].minutes, {
                            isMetroCard: isMetroStop,
                            lateWarningIndices
                        });
                    }
                    div.setAttribute('data-live-route-arrivals-fetch', 'done');
                }).catch(err => {
                    console.warn('[Arrivals] Route-specific live arrivals fetch failed', err);
                    div.setAttribute('data-live-route-arrivals-fetch', 'error');
                });
            }
        } else if (item.type !== 'live' || displayArrivals.length >= 3) {
            div.removeAttribute('data-live-route-arrivals-fetch');
        }

        // Insert at correct position
        // Order: Chips (0 or 1) -> Cards
        const chips = listEl.querySelector('.all-routes-container');
        let offset = 0;
        if (chips) offset++;

        const targetIndex = index + offset;
        const currentItems = Array.from(listEl.children);
        if (currentItems[targetIndex] !== div) {
            listEl.insertBefore(div, currentItems[targetIndex] || null);
        }

        if (isNew) {
            requestAnimationFrame(() => {
                div.style.opacity = '1';
            });
        }

        // -- Async Fetch Hook for Schedule Info (First/Last) --
        // We do this for BOTH live and scheduled items to get the first/last info
        // (For live items, we ignore the 'next' schedule times, but want first/last)
        if (item.data.shortName && item.data.shortName !== 'undefined') {
            // Check if we already have this info in the DOM to avoid redundant fetches
            const bottomEl = document.getElementById(bottomBarId);
            const hasInfo = bottomEl && bottomEl.innerHTML.trim() !== '&nbsp;' && bottomEl.innerHTML.trim() !== '';

            if (!hasInfo || item.needsFetch) {
                getV3Schedule(item.data.shortName, stopId, item.data.id).then(res => {
                    if (String(div.getAttribute('data-stop-id') || '') !== String(stopId)) return;
                    if (!res) return;
                    const { nextArrivals, firstTime, lastTime, serviceWindows, firstScheduledMinutes, lastScheduledMinutes, sparseTripSummary } = res;

                    // 1. Update Bottom Bar (First/Last + Interval Description)
                    const currentBottomEl = document.getElementById(bottomBarId);
                    if (!currentBottomEl || String(div.getAttribute('data-stop-id') || '') !== String(stopId)) return;

                    // Route 174 uses serviceWindows instead of firstTime/lastTime
                    if (currentBottomEl && (serviceWindows || (firstTime && lastTime))) {
                        // Resolve the full Route ID (some live items only have shortName)
                        let routeId = item.data.id;
                        if (!routeId || !routeId.includes(':')) {
                            const matchingRoute = deps.allRoutes().find(r => String(r.shortName) === String(item.data.shortName));
                            if (matchingRoute) routeId = matchingRoute.id;
                        }

                        const intervalDesc = sparseTripSummary || getIntervalDescription(routeId)?.trim();

                        let bottomHTML;
                        if (serviceWindows) {
                            bottomHTML = `<span class="schedule-times">${serviceWindows}</span>`;
                            const cleanInterval = intervalDesc?.replace('__FULL__', '').trim();
                            if (cleanInterval) {
                                bottomHTML += `,<span class="interval-desc">&nbsp;${cleanInterval}</span>`;
                            }
                        } else if (intervalDesc && intervalDesc.startsWith('__FULL__')) {
                            bottomHTML = intervalDesc.slice(8);
                        } else {
                            bottomHTML = `<span class="schedule-times">${firstTime.trim()} – ${lastTime.trim()}</span>`;
                            if (intervalDesc) {
                                bottomHTML += `,<span class="interval-desc">&nbsp;${intervalDesc}</span>`;
                            }
                        }

                        currentBottomEl.dataset.baseHtml = bottomHTML;
                        const lateWarningIndices = getLateWarningIndices(item, lastScheduledMinutes, firstScheduledMinutes, { isMetroCard: isMetroStop });
                        logLateWarningDebug('schedule-bottom-update', {
                            route: item?.data?.shortName,
                            routeId: item?.data?.id,
                            cardId: stableId,
                            firstScheduledMinutes,
                            lastScheduledMinutes,
                            lateWarningIndices
                        });
                        currentBottomEl.dataset.lateWarningIndices = lateWarningIndices.join(',');
                        if (firstScheduledMinutes !== undefined && firstScheduledMinutes !== null) {
                            currentBottomEl.dataset.firstScheduledMinutes = String(firstScheduledMinutes);
                        } else {
                            delete currentBottomEl.dataset.firstScheduledMinutes;
                        }
                        if (lastScheduledMinutes !== undefined && lastScheduledMinutes !== null) {
                            currentBottomEl.dataset.lastScheduledMinutes = String(lastScheduledMinutes);
                        } else {
                            delete currentBottomEl.dataset.lastScheduledMinutes;
                        }

                        currentBottomEl.innerHTML = buildArrivalBottomHtml(bottomHTML, item, lastScheduledMinutes, firstScheduledMinutes, {
                            isMetroCard: isMetroStop,
                            lateWarningIndices
                        });
                        div.setAttribute('data-late-warning-indices', lateWarningIndices.join(','));
                        applyLateWarningClasses(div, lateWarningIndices);
                        const displayEntries = Array.isArray(item.displayArrivals) ? item.displayArrivals.slice(0, 3) : [];
                        if (displayEntries.length > 0) {
                            updateCardDisplayArrivals(div, timeElId, displayEntries, item.minutes, { isMetroCard: isMetroStop, lateWarningIndices });
                        }
                    }

                    // 2. Update Primary Time (ONLY if item needed fetch i.e. was partial scheduled)
                    if (item.needsFetch && nextArrivals && nextArrivals.length > 0) {
                        const displayEntries = buildScheduleDisplayEntries(nextArrivals, 3);
                        const firstArrival = displayEntries[0];
                        const timeEl = document.getElementById(timeElId);
                        if (String(div.getAttribute('data-stop-id') || '') !== String(stopId)) return;
                        if (timeEl && firstArrival) {
                            const currentType = div.getAttribute('data-item-type');
                            const isStillScheduled = currentType === 'scheduled' || timeEl.classList.contains('scheduled-time');
                            if (!isStillScheduled) return;
                            const minsFromNow = firstArrival.minutes;
                            item.displayArrivals = displayEntries;
                            const warningItem = { ...item, displayArrivals: displayEntries };
                            const lateWarningIndices = getLateWarningIndices(warningItem, lastScheduledMinutes, firstScheduledMinutes, { isMetroCard: isMetroStop });
                            logLateWarningDebug('schedule-primary-update', {
                                route: item?.data?.shortName,
                                routeId: item?.data?.id,
                                cardId: stableId,
                                firstScheduledMinutes,
                                lastScheduledMinutes,
                                displayEntries,
                                lateWarningIndices
                            });
                            div.setAttribute('data-late-warning-indices', lateWarningIndices.join(','));
                            applyLateWarningClasses(div, lateWarningIndices);
                            updateCardDisplayArrivals(div, timeElId, displayEntries, minsFromNow, { isMetroCard: isMetroStop, lateWarningIndices });
                            const cacheKey = `${stopId}|${item.data.id || item.data.shortName}|${item.directionIndex || 0}`;
                            scheduledArrivalsCache.set(cacheKey, {
                                minutes: minsFromNow,
                                timeDisplay: firstArrival.text
                            });
                            if (stopId) {
                                if (!scheduledArrivalsByStop.has(stopId)) {
                                    scheduledArrivalsByStop.set(stopId, new Map());
                                }
                                const stopMap = scheduledArrivalsByStop.get(stopId);
                                const groupKey = `${item.data.id || item.data.shortName}_${item.directionIndex || 0}`;
                                stopMap.set(groupKey, {
                                    route: {
                                        id: item.data.id || item.data.shortName,
                                        shortName: item.data.shortName,
                                        longName: item.data.longName,
                                        customShortName: item.data.displayShortName
                                    },
                                    headsign: item.headsign,
                                    directionIndex: item.directionIndex || 0,
                                    minutes: minsFromNow,
                                    timeDisplay: firstArrival.text
                                });
                            }
                        }
                        scheduleArrivalsSort();
                    }
                }).catch(err => {
                    console.warn('[V3] Schedule Fetch Error', err);
                });
            }
        }
    });

    // Instead of removing obsolete items, we keep them visible but dimmed, 
    // showing their scheduled time while waiting for fresh live data.
    // They are only removed when the stop ID changes (handled at top of renderArrivals).
    listEl.querySelectorAll('.arrival-item').forEach(el => {
        if (!activeIds.has(el.id)) {
            // IMMEDIATE CLEANUP: If the item belongs to an invalid direction for this stop, remove it NOW.
            // This prevents "opposite direction" ghosts from appearing as dimmed items.
            const routeId = el.getAttribute('data-route-id');
            if (routeId) {
                const validDirs = getValidDirectionsForRoute(routeId, stopId);
                const itemDir = parseInt(el.getAttribute('data-direction') || '0');
                if (!validDirs.includes(itemDir)) {
                    el.style.opacity = '0';
                    el.style.transform = 'scale(0.95)';
                    setTimeout(() => el.remove(), 400);
                    return;
                }
            }

            // Expiration Logic: If it's been dimmed for > 15 seconds, remove it.
            const lastActive = parseInt(el.getAttribute('data-last-active') || '0');
            const age = Date.now() - lastActive;
            if (age > 15000) {
                el.style.opacity = '0';
                el.style.transform = 'scale(0.95)';
                setTimeout(() => el.remove(), 400);
                return;
            }

            // Dim and ensure scheduled time is shown
            const timeEl = el.querySelector('.arrival-time-primary');
            if (timeEl) {
                const currentText = timeEl.textContent;
                // If it was showing live minutes (e.g. 5'), convert to scheduled time
                if (!currentText.includes('˚') && currentText !== '--:--') {
                    const mins = parseInt(el.getAttribute('data-minutes') || '9999');
                    if (mins < 999) {
                        const schedTime = formatScheduledTime(mins);
                        timeEl.textContent = schedTime + '˚';
                        timeEl.classList.add('scheduled-time');
                    } else {
                        timeEl.textContent = '--:--';
                    }
                }
                el.querySelectorAll('.led-text').forEach(led => led.classList.remove('urgent-arrival'));
                el.style.opacity = '0.5';
            }
        } else {
            // Restore opacity if it was dimmed
            if (el.style.opacity === '0.5') {
                el.style.opacity = '1';
                scheduleArrivalsSort();
            }
        }
    });

    // 3. FLIP Play
    const flipEls = [];
    listEl.querySelectorAll('.arrival-item').forEach(el => {
        const oldRect = oldRects.get(el.id);
        if (!oldRect) return;

        const newRect = el.getBoundingClientRect();
        const dy = oldRect.top - newRect.top;
        const dx = oldRect.left - newRect.left;

        if (dy !== 0 || dx !== 0) {
            el.style.transition = 'none';
            el.style.transform = `translate(${dx}px, ${dy}px)`;
            flipEls.push(el);
        }
    });

    if (flipEls.length > 0) {
        requestAnimationFrame(() => {
            flipEls.forEach(el => {
                el.style.transition = '';
                el.style.transform = '';
            });
        });
    }

}

// Initial Sort
sortArrivalsList();

// --- COUNTDOWN TIMER ---
// Update displayed times every 10 seconds based on elapsed time since fetch
if (window.arrivalsCountdownTimer) {
    clearInterval(window.arrivalsCountdownTimer);
}

export function startArrivalsCountdown() {
    if (window.arrivalsCountdownTimer) clearInterval(window.arrivalsCountdownTimer);
    window.arrivalsCountdownTimer = setInterval(() => {
        if (document.hidden) return;

        const fetchTime = window.arrivalsDataTimestamp || Date.now();
        const elapsedMinutes = (Date.now() - fetchTime) / 60000;

        const arrivalItems = document.querySelectorAll('.arrival-item');
        let needsResort = false;

        arrivalItems.forEach(item => {
            const originalMinutes = parseInt(item.getAttribute('data-minutes-original') || item.getAttribute('data-minutes') || '9999');
            const displayMinutes = (item.getAttribute('data-display-arrival-minutes') || '')
                .split(',')
                .filter(Boolean)
                .map(v => parseInt(v, 10));
            const displayScheduled = (item.getAttribute('data-display-arrival-scheduled') || '').split(',');
            const lateWarningIndices = (item.getAttribute('data-late-warning-indices') || '')
                .split(',')
                .filter(Boolean)
                .map(v => parseInt(v, 10))
                .filter(v => Number.isFinite(v));

            // Store original if not already stored
            if (!item.hasAttribute('data-minutes-original')) {
                item.setAttribute('data-minutes-original', originalMinutes);
            }

            // Calculate adjusted minutes (rounded down at X:30)
            const adjustedRaw = originalMinutes - elapsedMinutes;
            const adjustedMinutes = Math.max(0, Math.round(adjustedRaw));

            // Only update if changed
            const currentMinutes = parseInt(item.getAttribute('data-minutes') || '9999');
            if (adjustedMinutes !== currentMinutes && adjustedMinutes >= 0) {
                item.setAttribute('data-minutes', adjustedMinutes);

                // Update primary time display
                const timeEl = item.querySelector('.arrival-time-primary');
                if (timeEl) {
                    const isScheduledItem = timeEl.classList.contains('scheduled-time');
                    // Only update to minutes format for live (non-scheduled) arrivals
                    if (adjustedMinutes < 30 && !isScheduledItem) {
                        timeEl.textContent = `${adjustedMinutes}'`;
                    }

                    // Add urgent fading animation for ≤2 min live arrivals (not scheduled)
                    if (adjustedMinutes <= 2 && !isScheduledItem) {
                        timeEl.classList.add('urgent-arrival');
                    } else {
                        timeEl.classList.remove('urgent-arrival');
                    }
                }

                const secondaryEls = item.querySelectorAll('.led-text-secondary');
                secondaryEls.forEach((secondaryEl, index) => {
                    const originalSecondaryMinutes = displayMinutes[index + 1];
                    const isScheduledSecondary = displayScheduled[index + 1] === '1' || secondaryEl.classList.contains('scheduled-time');
                    if (!Number.isFinite(originalSecondaryMinutes) || isScheduledSecondary) return;
                    const adjustedSecondary = Math.max(0, Math.round(originalSecondaryMinutes - elapsedMinutes));
                    if (adjustedSecondary < 30) {
                        secondaryEl.textContent = `${adjustedSecondary}'`;
                    }
                    if (adjustedSecondary <= 2) {
                        secondaryEl.classList.add('urgent-arrival');
                    } else {
                        secondaryEl.classList.remove('urgent-arrival');
                    }
                });

                applyLateWarningClasses(item, lateWarningIndices);
                logLateWarningDebug('countdown-refresh', {
                    cardId: item.id,
                    adjustedMinutes,
                    displayMinutes,
                    displayScheduled,
                    lateWarningIndices
                });

                needsResort = true;
            }
        });

        if (needsResort) {
            sortArrivalsList();
        }
    }, 10000); // Update every 10 seconds
}

export function stopArrivalsCountdown() {
    if (window.arrivalsCountdownTimer) {
        clearInterval(window.arrivalsCountdownTimer);
        window.arrivalsCountdownTimer = null;
    }
}

startArrivalsCountdown();
// --- LOADING INDICATOR HELPERS ---

let loadingStatusTimeout = null;
window._arrivalsLoadingCount = 0;

export function updateArrivalsLoadingState(visible) {
    if (visible) window._arrivalsLoadingCount++;
    else window._arrivalsLoadingCount = Math.max(0, window._arrivalsLoadingCount - 1);

    const isCurrentlyLoading = window._arrivalsLoadingCount > 0;
    window.arrivalsLoading = isCurrentlyLoading;

    const handles = document.querySelectorAll('.drag-handle');

    if (isCurrentlyLoading) {
        handles.forEach(h => h.classList.add('loading'));

        // Show "Refreshing..." after 1.5s
        if (loadingStatusTimeout) clearTimeout(loadingStatusTimeout);
        loadingStatusTimeout = setTimeout(() => {
            if (window.arrivalsLoading) {
                handles.forEach(h => {
                    let status = h.parentElement.querySelector('.loading-status-text');
                    if (!status) {
                        status = document.createElement('div');
                        status.className = 'loading-status-text';
                        status.textContent = 'Refreshing...';
                        h.after(status);
                    }
                    setTimeout(() => status.classList.add('visible'), 10);
                });
            }
        }, 1500);
    } else {
        if (loadingStatusTimeout) clearTimeout(loadingStatusTimeout);
        handles.forEach(h => {
            h.classList.remove('loading');
            const status = h.parentElement.querySelector('.loading-status-text');
            if (status) {
                status.classList.remove('visible');
                // Remove after fade
                setTimeout(() => {
                    if (!window.arrivalsLoading && status.parentElement) {
                        status.remove();
                    }
                }, 300);
            }
        });
    }
}
