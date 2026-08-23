/**
 * Arrivals Module
 * Handles fetching, processing, and rendering bus arrival data
 */

import * as api from './api.js';
import { getStaticRouteDetails } from './api.js';
import { db } from './db.js';
import { simplifyNumber, shouldShowRoute } from './settings.js';
import { loadIntervalData, getIntervalDescription } from './intervals.js';
import { formatRouteFare, loadFareData } from './fares.js';
import { getCurrentStopNamesLanguage, t } from './i18n.ts';

// --- Module State ---
let v3RoutesMap = null;
let v3RoutesPromise = null;
const V3_ROUTES_CACHE_KEY = 'v3_routes_map_cache';
const V3_CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours
const scheduledArrivalsCache = new Map(); // key -> { minutes, timeDisplay }
const scheduledArrivalsByStop = new Map(); // stopId -> Map(key -> { route, headsign, directionIndex, minutes, timeDisplay })
// A loop can visit the same physical stop twice while still being represented
// by one API pattern. Keep the two schedule occurrences separate so each one
// can have its own destination and arrivals card.
const loopScheduleDirections = new Map();
const loopScheduleDirectionsInFlight = new Map();
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
    getVirtualPatterns: null,
    updateStopRouteChipLiveBuses: null
};

/**
 * Normalize a route ID for comparison across different formats.
 * Handles: "1:R835" -> "R835", "rR835" -> "R835", "2:R835" -> "R835"
 */
export function normalizeRouteId(id) {
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
        if (options.preferredSource) {
            score += c._source === options.preferredSource ? 80 : -80;
        }
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

function getArrivalShortName(arrival) {
    return String(
        arrival?.shortName ??
        arrival?.routeShortName ??
        arrival?.routeNumber ??
        ''
    ).trim();
}

function getArrivalRouteId(arrival) {
    return String(
        arrival?.id ??
        arrival?.routeId ??
        arrival?.route_id ??
        ''
    ).trim();
}

function resolveRouteForStop(routeLike, stopId, options = {}) {
    if (!routeLike) return null;
    const allRoutes = typeof deps.allRoutes === 'function' ? deps.allRoutes() : [];
    const routeId = getArrivalRouteId(routeLike);
    const shortName = getArrivalShortName(routeLike);

    // Route IDs overlap between the Tbilisi and Rustavi feeds.  An arrival is
    // tagged with its physical stop, so use that source before comparing the
    // normalized IDs; otherwise a Rustavi live arrival can be attached to a
    // similarly named Tbilisi route and lose its real-time data on refresh.
    const sourceId = api.getSourceForId(stopId)?.id || 'tbilisi';
    const sourceRoutes = allRoutes.filter(route => route?._source === sourceId);
    const candidates = sourceRoutes.length > 0 ? sourceRoutes : allRoutes;

    return candidates.find(route => String(route.id) === routeId) ||
        candidates.find(route => normalizeRouteId(route.id) === normalizeRouteId(routeId)) ||
        resolveRouteByShortName(shortName, {
            preferredStopId: stopId,
            preferredSource: sourceId,
            preferBus: options.preferBus !== false
        });
}

function getRouteArrivalSourceStopId(route, stopId) {
    if (route?._sourceStopId) return route._sourceStopId;
    const candidates = new Set([stopId]);
    if (typeof deps.getEquivalentStops === 'function') {
        deps.getEquivalentStops(stopId, false).forEach(id => candidates.add(id));
    }
    if (deps.mergeSourcesMap?.has(stopId)) {
        deps.mergeSourcesMap.get(stopId).forEach(id => candidates.add(id));
    }
    const routeStops = Array.isArray(route?.stops) ? route.stops : [];
    return Array.from(candidates).find(candidateId =>
        routeStops.some(routeStopId => normalizeRouteId(routeStopId) === normalizeRouteId(candidateId))
    ) || stopId;
}

function normalizeArrivalRouteFields(arrival, stopId) {
    if (!arrival) return arrival;
    // TTC's sources do not always serialize this field the same way. Normalize
    // it before grouping so a string value such as "false" cannot be treated
    // as live merely because it is truthy, and Rustavi's isRealtime variant is
    // preserved as a real-time arrival.
    const realtimeValue = arrival.realtime ?? arrival.isRealtime ?? arrival.realTime ?? arrival.isRealTime;
    if (realtimeValue !== undefined) arrival.realtime = isRealtimeArrival(realtimeValue);
    const shortName = getArrivalShortName(arrival);
    if (shortName && !arrival.shortName) arrival.shortName = shortName;

    const matchedRoute = resolveRouteForStop(arrival, stopId, { preferBus: true });
    if (matchedRoute) {
        arrival.id = matchedRoute.id;
        arrival.shortName = matchedRoute.shortName;
        arrival.displayShortName = matchedRoute.customShortName || matchedRoute.shortName;
        if (!arrival.longName) arrival.longName = matchedRoute.longName;
        if (!arrival.color) arrival.color = matchedRoute.color;
    }
    return arrival;
}

function getHeadsignVariants(route, directionIndex, fallbackHeadsign = '') {
    const fallback = String(fallbackHeadsign || '').trim();
    const routeId = String(route?.id || '').trim();
    const shortName = String(route?.shortName || '').trim();
    const matchedRoute = Array.isArray(deps.allRoutes?.())
        ? (
            deps.allRoutes().find(r => String(r.id) === routeId) ||
            deps.allRoutes().find(r => normalizeRouteId(r.id) === normalizeRouteId(routeId)) ||
            (shortName ? resolveRouteByShortName(shortName, {
                preferredSource: route?._source,
                preferredId: route?.id,
                preferBus: !isRailLikeMode(route?.mode)
            }) : null)
        )
        : null;
    const overrides = matchedRoute?._overrides || route?._overrides;
    const destObj = overrides?.destinations?.[directionIndex];
    if (!destObj?.headsign) {
        return { en: fallback, ka: fallback };
    }
    if (typeof destObj.headsign === 'string') {
        return { en: destObj.headsign || fallback, ka: destObj.headsign || fallback };
    }
    return {
        en: String(destObj.headsign.en || destObj.headsign.ka || fallback),
        ka: String(destObj.headsign.ka || destObj.headsign.en || fallback)
    };
}

/**
 * Initialize the arrivals module with dependencies from main.js
 */
export function initArrivals(dependencies) {
    deps = { ...deps, ...dependencies };
    // Load interval pattern data for schedule descriptions
    loadIntervalData().catch(e => console.warn('Failed to load interval data:', e));
    loadFareData();

    // Listen for static data preload to refresh arrivals (fixes direction logic on first load)
    window.addEventListener('static-routes-loaded', () => {
        // The controller owns the first deep-link render. Re-rendering while
        // that request is still in flight briefly combines stale associations
        // with the partial live response.
        if (window.arrivalsLoading) return;

        if (window.currentStopId && window.lastArrivals) {
            renderArrivals(window.lastArrivals, window.currentStopId);
        }
    });
}

export function invalidateArrivalBottomInfo() {
    scheduledArrivalsCache.clear();
    scheduledArrivalsByStop.clear();

    document.querySelectorAll('.arrival-card-bottom').forEach((bottomEl) => {
        bottomEl.innerHTML = '&nbsp;';
        delete bottomEl.dataset.baseHtml;
        delete bottomEl.dataset.lateWarningIndices;
        delete bottomEl.dataset.schedulePatternSuffix;
        delete bottomEl.dataset.firstScheduledMinutes;
        delete bottomEl.dataset.lastScheduledMinutes;
    });
}

export function resetStopRouteFilter(stopId = null) {
    console.log(`[ArrivalsFilter] resetStopRouteFilter called for stopId: ${stopId}`);
    selectedStopRouteIds = new Set();
    selectedStopRouteFilterStopId = stopId ? String(stopId) : null;
    syncStopRouteChipLiveBuses(selectedStopRouteFilterStopId);
}

export function setStopRouteFilterIds(routeIds = [], stopId = null) {
    console.log(`[ArrivalsFilter] setStopRouteFilterIds called with routeIds:`, routeIds, `for stopId: ${stopId}`);
    selectedStopRouteIds = new Set(
        Array.isArray(routeIds)
            ? routeIds.map(id => String(id).trim()).filter(Boolean)
            : []
    );
    selectedStopRouteFilterStopId = stopId ? String(stopId) : null;
    syncStopRouteChipLiveBuses(selectedStopRouteFilterStopId);
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
    syncStopRouteChipLiveBuses(selectedStopRouteFilterStopId);
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

    syncStopRouteChipLiveBuses(selectedStopRouteFilterStopId);
    return getSelectedStopRouteFilterIds(normalizedStopId);
}

function syncStopRouteChipLiveBuses(stopId = null) {
    if (typeof deps.updateStopRouteChipLiveBuses !== 'function') return;
    deps.updateStopRouteChipLiveBuses(
        stopId ? String(stopId) : null,
        Array.from(getSelectedStopRouteFilterIds(stopId))
    );
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
        const destinations = Array.isArray(overrides.destinations)
            ? overrides.destinations
            : Object.values(overrides.destinations);
        destinations.forEach((dest, idx) => {
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

function getPatternSuffixForDirection(route, stopId, directionIndex) {
    const details = getStaticRouteDetails(route?.id);
    if (!details?._stopsOfPatterns || !stopId) return null;

    const sourceStopId = getRouteArrivalSourceStopId(route, stopId);
    const stopEntry = details._stopsOfPatterns.find(entry => {
        const entryStopId = String(entry?.stop?.id || entry?.stop || '');
        return entryStopId === String(sourceStopId) ||
            normalizeRouteId(entryStopId) === normalizeRouteId(sourceStopId);
    });
    const suffixes = Array.isArray(stopEntry?.patternSuffixes) ? stopEntry.patternSuffixes : [];
    return suffixes.find(suffix =>
        resolveDirectionInfo({ patternSuffix: suffix }, route, sourceStopId).directionIndex === directionIndex
    ) || suffixes[0] || null;
}

// Public wrapper to match stop-card direction resolution behavior.
export function getValidDirectionsForStop(routeId, stopIds) {
    return getValidDirectionsForRoute(routeId, stopIds);
}

function getSchedulePatternSuffixForItem(item, stopId) {
    const routeId = item?.data?.id || item?.data?.routeId;
    if (!routeId || !stopId) return null;

    const explicitPatternSuffix = item?.data?.patternSuffix;
    if (explicitPatternSuffix) return explicitPatternSuffix;

    const matchedRoute = deps.allRoutes().find(r => String(r.id) === String(routeId)) ||
        deps.allRoutes().find(r => normalizeRouteId(r.id) === normalizeRouteId(routeId)) ||
        resolveRouteByShortName(item?.data?.shortName, { preferredStopId: stopId, preferBus: true }) ||
        item?.data;

    const staticDetails = getStaticRouteDetails(routeId);
    // A merged card can be opened from its display stop while the route and
    // its timetable belong to the paired physical stop. Prefer the source
    // reported by the arrivals API, then consider all equivalent IDs.
    const stopIds = new Set([item?.data?._sourceStopId, stopId].filter(Boolean).map(String));
    if (typeof deps.getEquivalentStops === 'function') {
        deps.getEquivalentStops(stopId, false).forEach(id => stopIds.add(String(id)));
    }
    if (deps.mergeSourcesMap?.has(stopId)) {
        deps.mergeSourcesMap.get(stopId).forEach(id => stopIds.add(String(id)));
    }
    const stopEntry = staticDetails?._stopsOfPatterns?.find(s => {
        const sId = String(s?.stop?.id || s?.stop || '');
        return Array.from(stopIds).some(id =>
            sId === id || normalizeRouteId(sId) === normalizeRouteId(id)
        );
    });

    const suffixes = Array.isArray(stopEntry?.patternSuffixes) ? stopEntry.patternSuffixes.filter(Boolean) : [];
    if (suffixes.length === 0) return null;
    if (suffixes.length === 1) return suffixes[0];

    const targetDirectionIndex = Number.isFinite(item?.directionIndex) ? item.directionIndex : null;
    if (targetDirectionIndex === null) return suffixes[0];

    const matchingSuffixes = suffixes.filter(suffix => {
        const info = resolveDirectionInfo({ patternSuffix: suffix }, matchedRoute, stopId);
        return info.directionIndex === targetDirectionIndex;
    });

    if (matchingSuffixes.length === 1) return matchingSuffixes[0];
    if (matchingSuffixes.length > 1) {
        const routePatterns = Array.isArray(staticDetails?.patterns) ? staticDetails.patterns : [];
        const nonTerminusSuffix = matchingSuffixes.find(suffix => {
            const pattern = routePatterns.find(p => p.patternSuffix === suffix);
            if (!pattern?.lastStop?.id) return true;
            return normalizeRouteId(pattern.lastStop.id) !== normalizeRouteId(stopId);
        });
        return nonTerminusSuffix || matchingSuffixes[0];
    }

    return suffixes[0];
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
    // Keep the midnight hour attached to the service day that just ended:
    // some routes still have final scheduled departures after 00:00.  From
    // 01:00 onward, an earlier clock time belongs to tomorrow's schedule.
    if (diff < 0 && currH >= 1) {
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

export function shouldShowLateDepotWarning(etaMinutes, lastScheduledMinutes, firstScheduledMinutes) {
    const eta = Number(etaMinutes);
    const lastScheduled = Number(lastScheduledMinutes);
    const firstScheduled = Number(firstScheduledMinutes);

    if (!Number.isFinite(eta) || !Number.isFinite(lastScheduled)) return false;
    if (eta < 0 || eta === 999) return false;

    let currentMinutes = getCurrentTbilisiMinutes();

    // A live vehicle that remains after the final trip belongs to the
    // service day that just ended, even once the wall clock has passed 1 a.m.
    // Keep that extended-day frame until this route's first trip starts. This
    // lets a 2–4 a.m. ETA still be compared to the previous evening's final
    // scheduled arrival instead of looking like an early-morning ETA.
    if (
        Number.isFinite(firstScheduled) &&
        (firstScheduled >= 24 * 60 || currentMinutes < firstScheduled)
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

function getLateWarningIndices(item, lastScheduledMinutes, firstScheduledMinutes, options = {}) {
    if (options.isMetroCard === true) return [];
    if (item.type !== 'live') return [];
    // TTC's loop-route feed deliberately cannot distinguish the two visits to
    // this stop. Its copied arrival list is already shown in yellow with a
    // direction warning, so it must not also be judged against one side's
    // schedule and reported as an unscheduled late bus.
    if (item.loopSharedLive) return [];

    const displayArrivals = Array.isArray(item.displayArrivals) ? item.displayArrivals.slice(0, 3) : [];
    if (displayArrivals.length === 0) return [];

    const lateIndices = displayArrivals.flatMap((entry, index) => {
        if (entry.isScheduled) return [];
        const isLate = shouldShowLateDepotWarning(entry.minutes, lastScheduledMinutes, firstScheduledMinutes);
        if (!isLate) return [];
        return [index];
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
    const lateWarningsHtml = warnings.map(warning => `<div class="arrival-warning">${warning.message}</div>`).join('');
    const sharedLoopLiveWarning = item.loopSharedLive
        ? `<div class="arrival-warning">${t('loopRouteLiveDataWarning')}</div>`
        : '';
    return `${lateWarningsHtml}${sharedLoopLiveWarning}`;
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
export function parseSchedule(schedule, potentialIds, patternSuffix = null, routeShortName = null, routeId = null) {
    if (!schedule || !Array.isArray(schedule)) {
        if (schedule !== null && schedule !== undefined) {
            console.warn(`[V3 Debug] Invalid schedule format`, schedule);
        }
        return null;
    }

    try {
        const { todayStr, todayName, todayIdx } = getTbilisiDayInfo();
        // The midnight hour still belongs to the departing service day so
        // final 00:xx trips remain visible.  Start tomorrow's schedule at 1am.
        const OVERNIGHT_CUTOFF_HOUR = 1;
        const toServiceDayMinutes = (timeStr) => {
            const [rawH, rawM] = String(timeStr || '').split(':').map(Number);
            if (!Number.isFinite(rawH) || !Number.isFinite(rawM)) return null;
            let h = rawH;
            if (h < OVERNIGHT_CUTOFF_HOUR) h += 24;
            return h * 60 + rawM;
        };
        const formatServiceDayTime = (minutesValue) => {
            if (!Number.isFinite(minutesValue)) return null;
            const total = ((minutesValue % (24 * 60)) + (24 * 60)) % (24 * 60);
            const h = Math.floor(total / 60);
            const m = total % 60;
            return `${h}:${String(m).padStart(2, '0')}`;
        };

        const selectedSchedule = selectScheduleForTbilisiToday(schedule, { todayStr, todayName, todayIdx });
        const daySchedule = selectedSchedule?.entry;
        if (!daySchedule) return null;

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
                    const sCode = String(s.code || '');
                    return scheduleStopIdMatches(sId, pIdStr, routeId) ||
                        (sCode && scheduleStopIdMatches(sCode, pIdStr, routeId));
                });
            });

            matchedStops.forEach((stop, idx) => {
                if (stop.arrivalTimes) {
                    stop.arrivalTimes.split(',').forEach(t => {
                        const mins = toServiceDayMinutes(t);
                        if (!Number.isFinite(mins)) return;
                        allDepartures.push({
                            time: formatServiceDayTime(mins),
                            minutes: mins,
                            hour: Math.floor((((mins % (24 * 60)) + (24 * 60)) % (24 * 60)) / 60),
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
            const formatTime = (dep) => formatServiceDayTime(dep.minutes);

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
                    let h = parseInt(tbilisiParts.find(p => p.type === 'hour').value);
                    const m = parseInt(tbilisiParts.find(p => p.type === 'minute').value);
                    if (h < OVERNIGHT_CUTOFF_HOUR) h += 24;
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
            let h = parseInt(tbilisiParts.find(p => p.type === 'hour').value);
            const m = parseInt(tbilisiParts.find(p => p.type === 'minute').value);
            if (h < OVERNIGHT_CUTOFF_HOUR) h += 24;
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
    return parseSchedule(schedule, stopIds, patternSuffix, routeShortName, routeId);
}

function isLoopRoute(route) {
    const value = route?._overrides?.isLoop ?? route?.isLoop;
    if (value === true || value === 1 || String(value).toLowerCase() === 'true') return true;
    const pattern = getStaticRouteDetails(route?.id)?.patterns?.[0];
    return !!(pattern?.firstStop?.id && pattern?.lastStop?.id &&
        stopIdsMatch(pattern.firstStop.id, pattern.lastStop.id, route?.id));
}

function stopIdsMatch(first, second, routeId = null) {
    return scheduleStopIdMatches(first, second, routeId);
}

function getLoopScheduleDirectionsKey(routeId, stopIds) {
    const normalizedIds = (stopIds || []).map(normalizeRouteId).sort().join(',');
    return `${normalizeRouteId(routeId)}|${normalizedIds}`;
}

function getLoopScheduleDirectionsForRoute(routeId, stopIds) {
    return loopScheduleDirections.get(getLoopScheduleDirectionsKey(routeId, stopIds)) || [];
}

async function loadLoopScheduleDirections(route, stopIds) {
    if (!route?.id) return [];

    const key = getLoopScheduleDirectionsKey(route.id, stopIds);
    if (loopScheduleDirections.has(key)) return loopScheduleDirections.get(key);
    if (loopScheduleDirectionsInFlight.has(key)) return loopScheduleDirectionsInFlight.get(key);

    const promise = (async () => {
        const scheduleResult = await api.fetchScheduleForStop(route.id, stopIds, null, { strategy: 'cache-only' });
        const schedule = scheduleResult?.schedule;
        const suffix = scheduleResult?.patternSuffix;
        const details = getStaticRouteDetails(route.id);
        if (!schedule || !suffix) return [];
        const selected = selectScheduleForTbilisiToday(schedule);
        const stops = selected?.entry?.stops || [];
        // An on-map marker can merge two adjacent physical platforms.  They
        // are both valid schedule lookup IDs, but they must not be treated as
        // two visits to one loop stop: that produces duplicate, opposite-side
        // cards with exactly the same timetable.  Split a loop only when one
        // physical stop itself occurs twice in its schedule.
        const matchingIndexesByStop = new Map();
        stops.forEach((stop, index) => {
            const scheduleStopId = stop?.id || stop?.code;
            if (!scheduleStopId || !stopIds.some(stopId => stopIdsMatch(scheduleStopId, stopId, route.id))) return;
            const key = normalizeRouteId(scheduleStopId);
            const indexes = matchingIndexesByStop.get(key) || [];
            indexes.push(index);
            matchingIndexesByStop.set(key, indexes);
        });
        const matchingIndexes = Array.from(matchingIndexesByStop.values())
            .find(indexes => indexes.length >= 2) || [];

        // One occurrence is a normal loop stop. Two internal occurrences mean
        // passengers can board there on each side of the loop. A repeated
        // terminus (such as route 505 at stop 1354) remains one direction.
        if (matchingIndexes.length < 2) return [];
        if (matchingIndexes.some(index => index === 0 || index === stops.length - 1)) return [];

        const directions = matchingIndexes.slice(0, 2).map((occurrenceIndex, directionIndex) => {
            // Keep only this visit to the stop when parsing the schedule. The
            // dummy final item ensures the parser does not treat it as a terminus.
            const occurrenceSchedule = schedule.map(entry => ({
                ...entry,
                stops: [entry.stops?.[matchingIndexes[directionIndex]], { id: '__loop_schedule_end__' }]
            }));
            const parsed = parseSchedule(occurrenceSchedule, stopIds, suffix, route.shortName, route.id);
            const fallbackHeadsign = directionIndex === 0
                ? route.longName
                : details?.patterns?.[0]?.firstStop?.name || route.longName;
            return {
                directionIndex,
                headsign: deps.getPatternHeadsign(route, directionIndex, fallbackHeadsign),
                schedule: parsed,
                patternSuffix: suffix,
                targetIndex: occurrenceIndex,
                scheduleStops: stops
            };
        }).filter(direction => direction.schedule?.nextArrivals?.length);
        return directions;
    })().catch((error) => {
        console.warn('[Arrivals] Failed to derive loop directions from schedule', { routeId: route.id, error });
        return [];
    }).then((directions) => {
        loopScheduleDirections.set(key, directions);
        return directions;
    }).finally(() => {
        loopScheduleDirectionsInFlight.delete(key);
    });

    loopScheduleDirectionsInFlight.set(key, promise);
    return promise;
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

function getTbilisiDayInfo() {
    const now = new Date();
    const hour = Number(new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Tbilisi',
        hour: 'numeric',
        hourCycle: 'h23'
    }).format(now));
    // Keep 00:xx attached to the service day that is ending.  This matters at
    // the Sunday/Monday boundary: late Sunday trains must keep the weekend
    // schedule until 1:00 a.m., rather than switching to weekday service at
    // midnight.
    const serviceDay = hour < 1 ? new Date(now.getTime() - 24 * 60 * 60 * 1000) : now;
    const todayStr = serviceDay.toLocaleDateString('en-CA', { timeZone: 'Asia/Tbilisi' });
    const weekday = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Tbilisi',
        weekday: 'long'
    }).format(serviceDay).toUpperCase();
    const dayNames = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
    return {
        todayStr,
        todayName: weekday,
        todayIdx: dayNames.indexOf(weekday)
    };
}

function matchesServiceDayRange(entry, todayIdx) {
    if (!entry?.fromDay || !entry?.toDay || todayIdx < 0) return false;
    const dayNames = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
    const fromIdx = dayNames.indexOf(entry.fromDay);
    const toIdx = dayNames.indexOf(entry.toDay);
    if (fromIdx === -1 || toIdx === -1) return false;
    if (fromIdx <= toIdx) return todayIdx >= fromIdx && todayIdx <= toIdx;
    return todayIdx >= fromIdx || todayIdx <= toIdx;
}

function selectScheduleForTbilisiToday(schedule, info = getTbilisiDayInfo()) {
    if (!Array.isArray(schedule) || schedule.length === 0) return null;
    const { todayStr, todayName, todayIdx } = info;

    const exactDateMatch = schedule.find(entry => Array.isArray(entry?.serviceDates) && entry.serviceDates.includes(todayStr));
    if (exactDateMatch) return { entry: exactDateMatch, reason: 'exact-service-date', label: formatDayLabel(exactDateMatch.fromDay, exactDateMatch.toDay) };

    const weekdayRangeMatch = schedule.find(entry => matchesServiceDayRange(entry, todayIdx));
    if (weekdayRangeMatch) {
        console.warn(`[V3 Debug] No exact service date for ${todayStr}; using ${todayName} weekday schedule.`);
        return { entry: weekdayRangeMatch, reason: 'weekday-range-fallback', label: formatDayLabel(weekdayRangeMatch.fromDay, weekdayRangeMatch.toDay) };
    }

    console.warn(`[V3 Debug] No schedule found for ${todayStr}/${todayName}. Using first available.`);
    const first = schedule[0] || null;
    return first ? { entry: first, reason: 'first-available-fallback', label: formatDayLabel(first.fromDay, first.toDay) } : null;
}

function scheduleStopIdMatches(scheduleStopId, candidateId, routeId = null) {
    const scheduleValue = String(scheduleStopId || '');
    const candidateValue = String(candidateId || '');
    if (!scheduleValue || !candidateValue) return false;
    if (scheduleValue === candidateValue) return true;

    const source = api.getSourceForId(routeId || candidateValue);
    if (!source) return normalizeRouteId(scheduleValue) === normalizeRouteId(candidateValue);
    return api.processId(scheduleValue, source) === api.processId(candidateValue, source);
}

function getScheduleStopsForDirection(scheduleEntry, stopIds, explicitSuffix = null, routeId = null) {
    const stops = Array.isArray(scheduleEntry?.stops) ? scheduleEntry.stops : [];
    const matchedStops = stops.filter((stop, index) => {
        if (index === stops.length - 1) return false;
        const stopId = String(stop?.id || '');
        const stopCode = String(stop?.code || '');
        return stopIds.some(candidateId => {
            const candidate = String(candidateId);
            return scheduleStopIdMatches(stopId, candidate, routeId) ||
                (stopCode && scheduleStopIdMatches(stopCode, candidate, routeId));
        });
    });

    const virtualMatch = String(explicitSuffix || '').match(/_PART([01])$/);
    if (virtualMatch && matchedStops.length > 1) {
        return [matchedStops[Number(virtualMatch[1])]].filter(Boolean);
    }
    return matchedStops;
}

/**
 * Get schedule entries metadata for tab UI
 * @param {Array} schedule - Raw schedule array from API
 * @returns {Array} Array of { label, index, isToday }
 */
export function getScheduleEntries(schedule) {
    if (!schedule || !Array.isArray(schedule)) return [];

    const { todayStr, todayIdx } = getTbilisiDayInfo();

    return schedule.map((entry, index) => {
        let isToday = entry.serviceDates?.includes(todayStr) || false;
        if (!isToday) isToday = matchesServiceDayRange(entry, todayIdx);
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

    if (!routeId) {
        console.warn('[ScheduleDebug] Full schedule route ID missing', { routeShortName, stopId, explicitRouteId, explicitSuffix, options });
        return null;
    }

    const stopIds = deps.getEquivalentStops ? deps.getEquivalentStops(stopId) : [stopId];
    if (deps.mergeSourcesMap?.has(stopId)) {
        deps.mergeSourcesMap.get(stopId).forEach(s => stopIds.push(s));
    }

    const result = await api.fetchScheduleForStop(routeId, stopIds, explicitSuffix, options);
    let schedule = result?.schedule || null;
    if (!schedule && explicitSuffix) {
        console.warn('[ScheduleDebug] Full schedule association lookup failed; trying direct static lookup', {
            routeShortName,
            routeId,
            stopId,
            stopIds,
            explicitSuffix,
            options
        });
        schedule = await api.getStaticScheduleForRouteSuffix(routeId, explicitSuffix);
    }
    if (!schedule) {
        console.warn('[ScheduleDebug] Full schedule missing', { routeShortName, routeId, stopId, stopIds, explicitSuffix, options });
        return null;
    }

    const { todayStr, todayIdx } = getTbilisiDayInfo();

    // Build entries for tabs
    const entries = schedule.map((entry, index) => {
        const label = formatDayLabel(entry.fromDay, entry.toDay);

        // Calculate isToday
        let isToday = entry.serviceDates?.includes(todayStr) || false;
        if (!isToday) isToday = matchesServiceDayRange(entry, todayIdx);

        // Calculate summary (First - Last, Interval)
        let summaryTimes = '';
        let summaryInterval = '';
        const matchedStops = getScheduleStopsForDirection(entry, stopIds, explicitSuffix, routeId);

        if (matchedStops.length > 0) {
            const allTimes = [];
            matchedStops.forEach(s => {
                if (s.arrivalTimes) allTimes.push(...s.arrivalTimes.split(','));
            });
            if (allTimes.length > 0) {
                const toMins = t => {
                    let [h, m] = t.split(':').map(Number);
                    if (h < 1) h += 24;
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
        activeIndex = schedule.findIndex(s => s.serviceDates?.includes(todayStr));
        if (activeIndex === -1) {
            activeIndex = schedule.findIndex(s => matchesServiceDayRange(s, todayIdx));
        }
        if (activeIndex === -1 && schedule.length > 0) activeIndex = 0;
    }

    const daySchedule = schedule[activeIndex];
    if (!daySchedule || !daySchedule.stops) {
        console.warn('[ScheduleDebug] Full schedule active entry missing stops', {
            routeShortName,
            routeId,
            stopId,
            stopIds,
            explicitSuffix,
            activeIndex,
            scheduleEntries: Array.isArray(schedule) ? schedule.length : null,
            todayStr,
            todayIdx
        });
        return null;
    }

    const matchedStops = getScheduleStopsForDirection(daySchedule, stopIds, explicitSuffix, routeId);

    if (matchedStops.length === 0) {
        console.warn('[ScheduleDebug] Full schedule stop match failed', {
            routeShortName,
            routeId,
            stopId,
            stopIds,
            explicitSuffix,
            activeIndex,
            activeEntry: {
                fromDay: daySchedule.fromDay,
                toDay: daySchedule.toDay,
                serviceDates: daySchedule.serviceDates?.slice?.(0, 5),
                stopCount: daySchedule.stops.length
            },
            sampleStops: daySchedule.stops.slice(0, 12).map(s => ({
                id: s.id,
                code: s.code,
                name: s.name
            }))
        });
        return null;
    }

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

    if (Object.keys(grouped).length === 0) {
        console.warn('[ScheduleDebug] Full schedule matched stop but grouped output empty', {
            routeShortName,
            routeId,
            stopId,
            stopIds,
            explicitSuffix,
            activeIndex,
            matchedStops: matchedStops.map(s => ({
                id: s.id,
                code: s.code,
                hasArrivalTimes: !!s.arrivalTimes,
                arrivalTimesPreview: s.arrivalTimes?.slice?.(0, 80)
            }))
        });
    } else {
        console.log('[ScheduleDebug] Full schedule grouped', {
            routeShortName,
            routeId,
            stopId,
            explicitSuffix,
            activeIndex,
            hours: Object.keys(grouped),
            matchedStops: matchedStops.map(s => s.id)
        });
    }

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
    // Static route associations populate shortly after a cold deep-link load.
    // Until then routeCount is zero; requesting only five arrivals makes the
    // first card visibly incomplete and forces a later refresh to fill it in.
    const maxNumberOfArrivalTimes = routeCount > 0
        ? Math.min(150, Math.max(5, routeCount * 5))
        : 150;

    // Note: Loading state is managed by ArrivalsController
    const combined = await api.fetchArrivalsForStopIds(Array.from(idsToCheck), { maxNumberOfArrivalTimes });
    console.debug(`[ArrivalLoad] stop response stop=${stopId} count=${combined.length} max=${maxNumberOfArrivalTimes}`);

    const normalizedCombined = combined.map(a => {
        const actualStopId = a?._sourceStopId || stopId;
        return normalizeArrivalRouteFields({ ...a }, actualStopId);
    });
    const arrivalsBySource = normalizedCombined.reduce((summary, arrival) => {
        const source = api.getSourceForId(arrival?._sourceStopId)?.id || 'tbilisi';
        if (!summary[source]) summary[source] = { total: 0, live: 0, unresolved: 0 };
        summary[source].total += 1;
        if (arrival.realtime === true || arrival.realtime === 1 || arrival.realtime === 'true') summary[source].live += 1;
        if (!resolveRouteForStop(arrival, arrival?._sourceStopId || stopId, { preferBus: true })) summary[source].unresolved += 1;
        return summary;
    }, {});
    console.debug('[ArrivalLoad] arrivals by source', { stopId, sources: arrivalsBySource });

    // Group by canonical route, prefer live over scheduled
    const arrivalsByRoute = new Map();
    normalizedCombined.forEach(a => {
        const routeKey = a.id || a.shortName || getArrivalShortName(a);
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
        const key = `${a.id || a.shortName}_${time}_${a.headsign}`;
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

    console.debug(`[ArrivalLoad] normalized live stop=${stopId} count=${unique.length}`);

    return unique;
}

export function getArrivalMinutesValue(arrival) {
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

export function formatArrivalDisplayValue(minutes, isScheduled) {
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
    const scheduledOnly = !isMetroCard && entries.length > 0 && entries.every(entry => entry.isScheduled);
    const staleLive = options.staleLive === true;
    const loopSharedLive = options.loopSharedLive === true;
    const lateWarningIndices = new Set(Array.isArray(options.lateWarningIndices) ? options.lateWarningIndices : []);
    const lateStyleAttr = ` style="color:#fbbf24 !important; text-shadow:0 0 5px rgba(251, 191, 36, 0.28) !important;"`;
    const primaryClasses = ['led-text', 'arrival-time-primary'];
    if (primary.isScheduled) primaryClasses.push('scheduled-time');
    if (staleLive && !primary.isScheduled) primaryClasses.push('stale-live-time');
    if (lateWarningIndices.has(0) || (loopSharedLive && !primary.isScheduled)) primaryClasses.push('late-depot-time');
    const primaryText = isMetroCard && primary.isScheduled ? String(primary.text || '').replace(/˚$/, '') : primary.text;
    const primaryMarkup = isMetroCard && primary.isScheduled
        ? `
            <div class="metro-scheduled-time-stack">
                <div id="${timeElId}" class="${primaryClasses.join(' ')}"${lateWarningIndices.has(0) || (loopSharedLive && !primary.isScheduled) ? lateStyleAttr : ''}>${primaryText}</div>
                <div class="scheduled-disclaimer">${t('scheduled')}</div>
            </div>
        `
        : `<div id="${timeElId}" class="${primaryClasses.join(' ')}"${lateWarningIndices.has(0) || (loopSharedLive && !primary.isScheduled) ? lateStyleAttr : ''}>${primaryText}</div>`;

    const secondaryEntries = scheduledOnly ? entries.slice(1, 3) : entries.slice(1, 3);
    const secondaryMarkup = secondaryEntries.length > 0 ? `
        <div class="time-secondary-stack">
            ${secondaryEntries.map((entry, index) => {
                const classes = ['led-text', 'led-text-secondary'];
                if (entry.isScheduled) classes.push('scheduled-time');
                if (staleLive && !entry.isScheduled) classes.push('stale-live-time');
                if (lateWarningIndices.has(index + 1) || (loopSharedLive && !entry.isScheduled)) classes.push('late-depot-time');
                return `<div class="${classes.join(' ')}" data-secondary-index="${index + 1}"${lateWarningIndices.has(index + 1) || (loopSharedLive && !entry.isScheduled) ? lateStyleAttr : ''}>${entry.text}</div>`;
            }).join('')}
        </div>
    ` : '';

    // Scheduled arrivals are estimates shown as clock times. Reserve the
    // primary display for live arrivals and use the second and third scheduled
    // times in the compact stack to free width for route details.
    if (scheduledOnly) {
        return `
            <div class="time-container time-container-scheduled-only">
                ${secondaryMarkup}
            </div>
        `;
    }

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

export function isArrivalsLiveDataStale() {
    return window.arrivalsLiveDataStale === true;
}

function shouldCardShowStaleLiveState(cardEl) {
    if (!cardEl || !isArrivalsLiveDataStale()) return false;
    return (cardEl.getAttribute('data-display-arrival-scheduled') || '')
        .split(',')
        .some(flag => flag === '0');
}

function applyStaleLiveTimeState(cardEl, force = null) {
    if (!cardEl) return;
    const isStale = typeof force === 'boolean' ? force : shouldCardShowStaleLiveState(cardEl);
    const primaryEl = cardEl.querySelector('.arrival-time-primary');
    if (primaryEl && !primaryEl.classList.contains('scheduled-time')) {
        primaryEl.classList.toggle('stale-live-time', isStale);
    }
    const secondaryEls = cardEl.querySelectorAll('.led-text-secondary');
    secondaryEls.forEach((secondaryEl) => {
        if (!secondaryEl.classList.contains('scheduled-time')) {
            secondaryEl.classList.toggle('stale-live-time', isStale);
        }
    });
}

export function setArrivalsLiveDataStale(isStale) {
    window.arrivalsLiveDataStale = isStale === true;
    document.querySelectorAll('.arrival-item').forEach(cardEl => {
        applyStaleLiveTimeState(cardEl, shouldCardShowStaleLiveState(cardEl));
    });
}

export function markArrivalsLiveDataStale() {
    setArrivalsLiveDataStale(true);
}

function isCardRenderCurrent(cardId, stopId) {
    const cardEl = document.getElementById(cardId);
    if (!cardEl) return false;
    // A list-wide render version changes whenever any card updates. Schedule
    // fetches for sibling cards must not be invalidated by that unrelated
    // render; the card id plus stop identity is the actual safety boundary.
    return String(cardEl.getAttribute('data-stop-id') || '') === String(stopId);
}

function escapeHtmlAttribute(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
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

    // Metro cards have their own service-state renderer. Never let cached bus
    // arrivals replace it during a language, settings, or data refresh.
    if (isMetroStop) return;

    // --- CROSS-STOP PROTECTION ---
    // If this render is for a stop that is no longer the current one, ignore it.
    // This prevents async results from previous stops from overwriting the current UI.
    if (stopId && window.currentStopId && String(stopId) !== String(window.currentStopId)) {
        return;
    }

    // --- ARRIVALS BLOCKLIST ---
    // Filter out any arrivals (live or scheduled, cached or fresh) for (stop, route)
    // pairs that have been manually removed from the schedule. Applied here so that
    // all downstream caches (scheduledArrivalsByStop, scheduledArrivalsCache) are clean.
    if (Array.isArray(arrivalsData) && arrivalsData.length > 0) {
        const blocklist = api.getArrivalsBlocklist ? api.getArrivalsBlocklist() : null;
        if (blocklist && blocklist.size > 0) {
            arrivalsData = arrivalsData.filter(arrival => {
                const srcStopId = arrival._sourceStopId;
                if (!srcStopId) return true;
                const blockedRoutes = blocklist.get(srcStopId);
                if (!blockedRoutes) return true;
                const sn = arrival.shortName || arrival.routeShortName;
                return !blockedRoutes.has(sn);
            });
        }
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
    const renderVersion = (Number(window._arrivalsRenderVersion) || 0) + 1;
    window._arrivalsRenderVersion = renderVersion;
    console.debug('[ArrivalLoad] render requested', {
        stopId,
        renderVersion,
        count: Array.isArray(arrivalsData) ? arrivalsData.length : 0,
        source: arrivalsData === window.lastArrivals ? 'current' : 'stale-or-intermediate'
    });


    // NOTE: Staleness-based refresh is now handled by ArrivalsController
    // renderArrivals is now a pure render function - no fetching



    // --- RENDER LOGIC ---
    if (Array.isArray(arrivalsData) && arrivalsData.length > 0) {
        arrivalsData = arrivalsData.map(arrival => {
            const actualStopId = arrival?._sourceStopId || stopId;
            return normalizeArrivalRouteFields(arrival, actualStopId);
        });

    }

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
            const resolvedRoute = resolveRouteForStop(arrival, stopId, { preferBus: true });
            return resolvedRoute?.id || arrival.id || null;
        })
    ]
        .filter(Boolean)
        .map(id => String(id));
    const selectedRouteIds = pruneStopRouteFilterIds(validRouteIdsForStop, stopId);

    // Route details deduplicate a loop's repeated stop, while the schedule
    // retains both visits. Prime that extra direction data and re-render once
    // it is available; normal routes do not take this path.
    uniqueRoutesMap.forEach((route) => {
        if (!isLoopRoute(route)) return;
        const cacheKey = getLoopScheduleDirectionsKey(route.id, equivalentIds);
        if (loopScheduleDirections.has(cacheKey) || loopScheduleDirectionsInFlight.has(cacheKey)) return;
        void loadLoopScheduleDirections(route, equivalentIds).then(() => {
            // The static schedule request can finish after the controller has
            // upgraded this card from scheduled data to live data. Re-render
            // to add its split-direction information, but always use the
            // controller's current array rather than this older closure.
            if (String(window.currentStopId) !== String(stopId)) return;
            renderArrivals(window.lastArrivals || arrivalsData, stopId);
        });
    });

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
        const r = resolveRouteForStop(a, stopId, { preferBus: true });
        return shouldShowRoute(a.shortName, r);
    });

    const selectedRouteIdsNorm = new Set(Array.from(selectedRouteIds).map(id => normalizeRouteId(id)));
    const isSelectedStopRoute = (routeLike) => {
        if (!routeLike) return false;
        const matchedRoute = resolveRouteForStop(routeLike, stopId, { preferBus: true }) || routeLike;
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
        const matchedRouteForColor = resolveRouteForStop(a, actualStopId, { preferBus: true });

        // Ensure we have a valid ID for this arrival (use matched route if missing in LIVE data)
        if (!a.id && matchedRouteForColor) a.id = matchedRouteForColor.id;
        if (!a.displayShortName && matchedRouteForColor) {
            a.displayShortName = matchedRouteForColor.customShortName || matchedRouteForColor.shortName;
        }

        // Resolve a route's direction using the physical stop which supplied
        // the arrival.  On merged stops (e.g. 3963/3964 for route 397), the
        // selected display ID is not necessarily present in the route pattern.
        const resolveStopId = actualStopId || stopId;
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
                        customShortName: a.displayShortName,
                        color: matchedRouteForColor?.color || a.color
                    },
                    headsign,
                    directionIndex,
                    minutes,
                    timeDisplay
                });
            }
        }

        // Keep the DOM identity independent from route-details hydration. Before
        // static details are available, directionIndex is inferred from the
        // numeric part of the suffix; afterwards it may be the suffix's index
        // in a differently ordered patterns array. The API pattern suffix is
        // stable across both renders, so use it for live-card grouping while
        // retaining the resolved direction index for schedule matching.
        const patternSuffixIdentity = String(a.patternSuffix || '').trim();
        const patternDirectionIdentity = patternSuffixIdentity
            ? patternSuffixIdentity.split(':')[0]
            : '';
        const groupKey = loopAmbiguous
            ? `${routeIdForKey}_loop`
            : `${routeIdForKey}_${patternDirectionIdentity ? `pattern-${patternDirectionIdentity}` : `direction-${directionIndex}`}`;
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
        // Scheduled fallbacks are keyed by resolved direction, so record that
        // logical identity separately from the live card's stable DOM key.
        representedKeys.add(`${routeIdForKey}_${directionIndex}`);
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
        const resolvedRoute = resolveRouteForStop(primaryArrival, stopId, { preferBus: true });
        const loopDirections = resolvedRoute
            ? getLoopScheduleDirectionsForRoute(resolvedRoute.id, equivalentIds)
            : [];
        const loopSharedLive = loopDirections.length >= 2;

        // The loop-specific pass below produces one card per visit to the
        // stop and shares TTC's indistinguishable live arrivals between them.
        // Do not also retain this generic live group, or 387/397 appear as a
        // third duplicate card after the loop schedules have loaded.
        if (loopSharedLive) return;

        renderList.push({
            type: 'live',
            data: primaryArrival,
            minutes: primaryArrival._calculatedMinutes,
            color: group.color,
            headsign: group.headsign,
            directionIndex: group.directionIndex,
            allArrivals: group.arrivals,
            displayArrivals: buildDisplayedArrivals(group.arrivals, 3),
            loopSharedLive,
            key: group.key || `${primaryArrival.shortName}_${group.directionIndex}`
        });
    });

    // A live response can contain only the currently approaching side of a
    // loop. Add the other schedule-derived side directly, rather than waiting
    // for the normal route-pattern fallback (which has already deduplicated
    // the two visits into one stop association).
    uniqueRoutesMap.forEach((route) => {
        const directions = getLoopScheduleDirectionsForRoute(route.id, equivalentIds);
        if (directions.length < 2) return;
        const sharedLiveGroup = Array.from(liveGroups.values()).find(group => {
            const liveRoute = resolveRouteForStop(group.primary, stopId, { preferBus: true });
            return normalizeRouteId(liveRoute?.id || group.primary?.id) === normalizeRouteId(route.id);
        });

        directions.forEach((direction) => {
            const key = `${route.id}_${direction.directionIndex}`;
            if (sharedLiveGroup) {
                const primaryArrival = sharedLiveGroup.arrivals[0];
                renderList.push({
                    type: 'live',
                    data: primaryArrival,
                    minutes: primaryArrival._calculatedMinutes,
                    color: deps.getRouteDisplayColor(route),
                    directionIndex: direction.directionIndex,
                    headsign: direction.headsign,
                    allArrivals: sharedLiveGroup.arrivals,
                    displayArrivals: buildDisplayedArrivals(sharedLiveGroup.arrivals, 3),
                    loopSharedLive: true,
                    key
                });
                representedKeys.add(key);
                return;
            }
            if (representedKeys.has(key)) return;
            const nextArrival = direction.schedule?.nextArrivals?.[0];
            const minutes = nextArrival ? getMinutesFromNow(nextArrival.time) : 99999;
            renderList.push({
                type: 'scheduled',
                data: route,
                minutes: Number.isFinite(minutes) ? minutes : 99999,
                color: deps.getRouteDisplayColor(route),
                directionIndex: direction.directionIndex,
                headsign: direction.headsign,
                needsFetch: true,
                loopSchedule: direction.schedule,
                key
            });
            representedKeys.add(key);
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
        // Skip any routes that are blocklisted for this stop
        const _blocklist = api.getArrivalsBlocklist ? api.getArrivalsBlocklist() : null;
        if (_blocklist && _blocklist.size > 0) {
            const blocked = equivalentIds.some(eqId => {
                const blockedRoutes = _blocklist.get(eqId);
                return blockedRoutes && blockedRoutes.has(String(r.shortName));
            });
            if (blocked) return;
        }

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
        const hasLiveRoute = Array.from(liveRouteKeys).some(liveRouteId =>
            normalizeRouteId(liveRouteId) === normalizeRouteId(routeIdentity)
        );
        const cachedLoopDirections = getLoopScheduleDirectionsForRoute(r.id, equivalentIds);
        const loopDirections = cachedLoopDirections;
        // A merged stop can contain the opposite physical platform. Once a
        // route already has a live card, do not add that platform's scheduled
        // fallback as a second, opposite-direction card. Loop routes are the
        // only exception: their dedicated schedule split adds both visits.
        if (hasLiveRoute && loopDirections.length === 0) return;
        const validDirs = loopDirections.length > 0
            ? loopDirections.map(direction => direction.directionIndex)
            : getValidDirectionsForRoute(r.id, equivalentIds);
        validDirs.forEach(dirIdx => {
            const key = `${routeIdentity}_${dirIdx}`;
            if (!representedKeys.has(key)) {
                const realRoute = deps.allRoutes().find(route => String(route.id) === String(r.id)) ||
                    deps.allRoutes().find(route => normalizeRouteId(route.id) === normalizeRouteId(r.id)) ||
                    resolveRouteByShortName(r.shortName, { preferredStopId: stopId, preferBus: true }) ||
                    r;
                // Preserve the actual pattern suffix that was matched for this
                // physical stop. Passing only directionIndex makes the resolver
                // fall back to zero and can display the opposite direction on
                // the initial scheduled card.
                const directionStopId = getRouteArrivalSourceStopId(realRoute, stopId);
                const directionPatternSuffix = getPatternSuffixForDirection(realRoute, directionStopId, dirIdx);
                const { headsign } = resolveDirectionInfo({
                    id: realRoute.id,
                    shortName: realRoute.shortName,
                    patternSuffix: directionPatternSuffix || undefined
                }, realRoute, directionStopId);
                console.debug('[ArrivalDirection] scheduled direction resolved', {
                    stopId,
                    sourceStopId: directionStopId,
                    routeId: realRoute.id,
                    shortName: realRoute.shortName,
                    directionIndex: dirIdx,
                    patternSuffix: directionPatternSuffix,
                    headsign
                });
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

                const loopDirection = loopDirections.find(direction => direction.directionIndex === dirIdx);
                const loopNextArrival = loopDirection?.schedule?.nextArrivals?.[0];
                const loopMinutes = loopNextArrival ? getMinutesFromNow(loopNextArrival.time) : null;
                const scheduledItem = {
                    type: 'scheduled',
                    data: realRoute,
                    minutes: Number.isFinite(loopMinutes) ? loopMinutes : existingMinutes,
                    color: deps.getRouteDisplayColor(realRoute),
                    directionIndex: dirIdx,
                    headsign: loopDirection?.headsign || headsign,
                    // Once a card already has its schedule metadata, retain it
                    // until static data is explicitly invalidated. Re-fetching
                    // it on each live-data poll needlessly rewrites the card.
                    needsFetch: !existingEl?.querySelector('.arrival-card-bottom')?.dataset.baseHtml,
                    loopSchedule: loopDirection?.schedule || null,
                    timeDisplay: existingTimeDisplay || undefined,
                    key: key
                };

                // If no live data and this stop has multiple patterns for this route, keep only the earliest scheduled item
                if (!hasLiveRoute && sharedStopRoutes.has(routeIdentity)) {
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
            const cachedRoute = resolveRouteForStop(cached.route, stopId, { preferBus: true }) || cached.route;
            const hasLiveRoute = Array.from(liveRouteKeys).some(liveRouteId =>
                normalizeRouteId(liveRouteId) === normalizeRouteId(cachedRoute.id || cached.route?.id || cached.route?.shortName)
            );
            // Cached timetable entries may describe the paired platform of a
            // merged stop. A live card for the route is authoritative unless
            // this is one of the explicitly split loop routes.
            if (hasLiveRoute && !isLoopRoute(cachedRoute)) return;
            const minsFromDisplay = cached.timeDisplay ? getMinutesFromNow(cached.timeDisplay.replace('˚', '')) : cached.minutes;
            renderList.push({
                type: 'scheduled',
                data: cachedRoute,
                minutes: minsFromDisplay,
                color: deps.getRouteDisplayColor(cachedRoute),
                directionIndex: cached.directionIndex,
                headsign: cached.headsign,
                needsFetch: true,
                timeDisplay: cached.timeDisplay || undefined,
                key: key
            });
            representedKeys.add(key);
        });
    }

    // Final reconciliation for merged platforms: cache keys can preserve
    // different source prefixes for the same route, but the visible route
    // number is still the same. For ordinary routes, a live card wins over
    // every scheduled fallback; loop routes retain their explicit split view.
    const getVisibleRouteNumbers = (route) => [
        route?.displayShortName,
        route?.customShortName,
        route?.shortName
    ].filter(Boolean).map(String);
    const liveRouteNumbers = new Set(renderList
        .filter(item => item.type === 'live')
        .flatMap(item => getVisibleRouteNumbers(item.data)));
    renderList = renderList.filter(item => {
        if (item.type !== 'scheduled' || isLoopRoute(item.data)) return true;
        return !getVisibleRouteNumbers(item.data).some(shortName => liveRouteNumbers.has(shortName));
    });

    // A destination is required for a useful arrival card. During deep-link
    // startup, stale static associations can briefly create scheduled cards
    // for a paired platform before its live route list has arrived. Showing
    // them as "Destination unknown" is misleading, so wait until the route
    // details can resolve the destination instead.
    renderList = renderList.filter(item => {
        const headsign = String(item.headsign || '').trim();
        if (headsign && headsign !== 'undefined') return true;
        console.debug('[ArrivalLoad] destinationless card hidden', {
            stopId,
            routeId: item.data?.id,
            shortName: item.data?.shortName,
            sourceStopId: item.data?._sourceStopId
        });
        return false;
    });

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
    const activeRouteIds = new Set(renderList.map(item =>
        String(item.data?.id || item.data?.shortName || 'unknown')
    ));

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
        const equivalentIds = stopId ? deps.getEquivalentStops(stopId, false) : [];
        const blocklist = api.getArrivalsBlocklist ? api.getArrivalsBlocklist() : null;
        const hasAnyRoutesInDb = equivalentIds.some(eqId => {
            const staticRoutes = (api.getRoutesForStopStatic ? api.getRoutesForStopStatic(eqId) : []).filter(rId => {
                const r = deps.allRoutes().find(x => x.id === rId);
                return !blocklist || !blocklist.get(eqId) || !r || !blocklist.get(eqId).has(String(r.shortName));
            });
            const mappedRoutes = (deps.stopToRoutesMap ? (deps.stopToRoutesMap.get(eqId) || []) : []).filter(r => {
                return !blocklist || !blocklist.get(eqId) || !blocklist.get(eqId).has(String(r.shortName));
            });
            return staticRoutes.length > 0 || mappedRoutes.length > 0;
        });

        let msg;
        if (deps.filterManager && deps.filterManager.state.active) {
            msg = t('noArrivalsForSelectedDestination');
        } else if (!hasAnyRoutesInDb) {
            msg = t('stopNotOperatingCurrently');
        } else {
            msg = t('noUpcomingArrivals');
        }
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
        div.setAttribute('data-render-version', String(renderVersion));

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
        let routeShortName, headsign, timeDisplay, isScheduled, needsDisclaimer, routeIdForClick, displayRoute;
        let displayArrivals = Array.isArray(item.displayArrivals) ? item.displayArrivals.slice(0, 3) : [];
        let lateWarningIndices = [];
        let routeColor = item.color;

        if (item.type === 'live') {
            const a = item.data;
            displayRoute = a;
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
            displayRoute = freshRoute;

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
        const staleLive = isArrivalsLiveDataStale() && displayArrivals.some(entry => !entry.isScheduled);

        if (!headsign || headsign === 'undefined') {
            headsign = t('destinationUnknown');
        }
        const headsignVariants = getHeadsignVariants(displayRoute, dirIdx, headsign);

        const timeElId = `time-${stableId}`;
        const bottomBarId = `bottom-${stableId}`;
        let bottomBarDataAttrs = '';

        let bottomContent = buildArrivalBottomHtml('&nbsp;', item, null, null, { isMetroCard: isMetroStop });
        // Preserve bottom content if already exists
        const existingBottom = div.querySelector('.arrival-card-bottom');
        if (existingBottom && existingBottom.innerHTML.trim() !== '&nbsp;') {
            const baseHtml = existingBottom.dataset.baseHtml || extractBaseArrivalBottomHtml(existingBottom.innerHTML);
            const lastScheduledMinutes = existingBottom.dataset.lastScheduledMinutes;
            const firstScheduledMinutes = existingBottom.dataset.firstScheduledMinutes;
            const existingSchedulePatternSuffix = existingBottom.dataset.schedulePatternSuffix || '';
            lateWarningIndices = getLateWarningIndices(item, lastScheduledMinutes, firstScheduledMinutes, {
                isMetroCard: isMetroStop,
                stopId,
                schedulePatternSuffix: existingSchedulePatternSuffix
            });
            if (lateWarningIndices.length === 0) {
                lateWarningIndices = (div.getAttribute('data-late-warning-indices') || '')
                    .split(',')
                    .filter(Boolean)
                    .map(v => parseInt(v, 10))
                    .filter(v => Number.isFinite(v));
            }
            bottomBarDataAttrs = [
                `data-base-html="${escapeHtmlAttribute(baseHtml)}"`,
                `data-late-warning-indices="${escapeHtmlAttribute(lateWarningIndices.join(','))}"`,
                `data-schedule-pattern-suffix="${escapeHtmlAttribute(existingSchedulePatternSuffix)}"`,
                firstScheduledMinutes !== undefined ? `data-first-scheduled-minutes="${escapeHtmlAttribute(firstScheduledMinutes)}"` : '',
                lastScheduledMinutes !== undefined ? `data-last-scheduled-minutes="${escapeHtmlAttribute(lastScheduledMinutes)}"` : ''
            ].filter(Boolean).join(' ');
            bottomContent = buildArrivalBottomHtml(baseHtml, item, lastScheduledMinutes, firstScheduledMinutes, {
                isMetroCard: isMetroStop,
                lateWarningIndices
            });
        }

        const innerContent = `
            <div class="arrival-card-left">
                <div class="arrival-card-top">
                    <div class="route-number" style="color: ${routeColor}">${simplifyNumber(routeShortName)}</div>
                    <div class="destination" title="${escapeHtmlAttribute(headsign)}" data-destination-en="${escapeHtmlAttribute(headsignVariants.en)}" data-destination-ka="${escapeHtmlAttribute(headsignVariants.ka)}">${headsign}</div>
                </div>
                <div class="arrival-card-bottom" id="${bottomBarId}" ${bottomBarDataAttrs}>
                    ${bottomContent}
                </div>
            </div>
            <div class="arrival-card-right">
                ${buildArrivalTimesMarkup(displayArrivals, timeElId, { isMetroCard: isMetroStop, lateWarningIndices, staleLive, loopSharedLive: item.loopSharedLive })}
            </div>
        `;

        if (div.innerHTML !== innerContent) {
            div.innerHTML = innerContent;
        }
        div.setAttribute('data-late-warning-indices', lateWarningIndices.join(','));
        applyLateWarningClasses(div, lateWarningIndices);
        applyStaleLiveTimeState(div, staleLive);

        // Click handler (refresh every time to ensure latest closure)
        let routeObj = resolveRouteForStop({ ...item.data, id: routeIdForClick }, stopId, { preferBus: true });

        if (routeObj) {
            div.onclick = () => {
                console.log('[ScheduleDebug] Arrival card opening route', {
                    routeId: routeObj.id,
                    shortName: routeObj.shortName,
                    stopId,
                    directionIndex: item.directionIndex,
                    headsign
                });
                deps.showRouteOnMap(routeObj, true, {
                    preserveBounds: false,
                    fromStopId: stopId,
                    targetHeadsign: headsign,
                    initialDirectionIndex: item.directionIndex,
                    routeSource: 'stop'
                });
            };
        }

        const shouldFetchRouteLiveArrivals = !!routeIdForClick && (
            (item.type === 'live' && displayArrivals.length < 3) ||
            // The stop-wide TTC request can be slow. While it is pending,
            // let scheduled cards ask their own small route endpoint so they
            // can upgrade to live times without waiting for a later refresh.
            (item.type === 'scheduled' && window.arrivalsLoading)
        );
        if (shouldFetchRouteLiveArrivals) {
            const liveFetchState = div.getAttribute('data-live-route-arrivals-fetch');
            if (liveFetchState !== 'pending') {
                div.setAttribute('data-live-route-arrivals-fetch', 'pending');
                const actualStopId = getRouteArrivalSourceStopId(item.data, stopId);
                api.fetchRouteArrivalsForStop(actualStopId, routeIdForClick).then(routeArrivals => {
                    if (!isCardRenderCurrent(stableId, stopId, renderVersion)) {
                        return;
                    }
                    if (!Array.isArray(routeArrivals) || routeArrivals.length === 0) {
                        const currentDiv = document.getElementById(stableId);
                        if (currentDiv) currentDiv.setAttribute('data-live-route-arrivals-fetch', 'done');
                        return;
                    }

                    const filteredRouteArrivals = routeArrivals.filter(arrival => {
                        normalizeArrivalRouteFields(arrival, actualStopId);
                        const matchedRoute = resolveRouteForStop({ ...arrival, id: routeIdForClick }, actualStopId, { preferBus: true });
                        const directionInfo = resolveDirectionInfo(arrival, matchedRoute, actualStopId);
                        return directionInfo.directionIndex === item.directionIndex;
                    });

                    const liveOnly = filteredRouteArrivals.filter(arrival => arrival.realtime);
                    const candidateArrivals = liveOnly.length > 0 ? liveOnly : filteredRouteArrivals;
                    const nextDisplayArrivals = buildDisplayedArrivals(candidateArrivals, 3);
                    if (
                        liveOnly.length > 0 && nextDisplayArrivals.length > 0 &&
                        isCardRenderCurrent(stableId, stopId, renderVersion)
                    ) {
                        const currentDiv = document.getElementById(stableId);
                        if (!currentDiv) return;
                        const firstLiveArrival = liveOnly[0];
                        const liveRoute = resolveRouteForStop(firstLiveArrival, actualStopId, { preferBus: true });
                        const liveDirection = resolveDirectionInfo(firstLiveArrival, liveRoute, actualStopId);
                        item.type = 'live';
                        item.data = { ...item.data, ...firstLiveArrival, id: liveRoute?.id || routeIdForClick };
                        item.headsign = liveDirection.headsign || item.headsign;
                        item.displayArrivals = nextDisplayArrivals;
                        currentDiv.setAttribute('data-item-type', 'live');
                        if (item.headsign) {
                            const destinationEl = currentDiv.querySelector('.destination');
                            if (destinationEl) {
                                destinationEl.textContent = item.headsign;
                                destinationEl.title = item.headsign;
                            }
                        }
                        const currentBottomEl = document.getElementById(bottomBarId);
                        const firstScheduledMinutes = currentBottomEl?.dataset.firstScheduledMinutes;
                        const lastScheduledMinutes = currentBottomEl?.dataset.lastScheduledMinutes;
                        const lateWarningOptions = {
                            isMetroCard: isMetroStop,
                            stopId,
                            schedulePatternSuffix: currentBottomEl?.dataset.schedulePatternSuffix
                        };
                        const lateWarnings = getLateWarningEntries(item, lastScheduledMinutes, firstScheduledMinutes, lateWarningOptions);
                        const lateWarningIndices = getLateWarningIndices(item, lastScheduledMinutes, firstScheduledMinutes, lateWarningOptions);
                        if (currentBottomEl) {
                            currentBottomEl.dataset.lateWarningIndices = lateWarningIndices.join(',');
                            const baseHtml = currentBottomEl.dataset.baseHtml || currentBottomEl.innerHTML;
                            currentBottomEl.innerHTML = buildArrivalBottomHtml(baseHtml, item, lastScheduledMinutes, firstScheduledMinutes, {
                                isMetroCard: isMetroStop,
                                lateWarningIndices
                            });
                        }
                        currentDiv.setAttribute('data-late-warning-indices', lateWarningIndices.join(','));
                        applyLateWarningClasses(currentDiv, lateWarningIndices);
                        updateCardDisplayArrivals(currentDiv, timeElId, nextDisplayArrivals, nextDisplayArrivals[0].minutes, {
                            isMetroCard: isMetroStop,
                            lateWarningIndices,
                            staleLive: isArrivalsLiveDataStale(),
                            loopSharedLive: item.loopSharedLive
                        });
                    }
                    const currentDiv = document.getElementById(stableId);
                    if (currentDiv && isCardRenderCurrent(stableId, stopId, renderVersion)) {
                        currentDiv.setAttribute('data-live-route-arrivals-fetch', 'done');
                    }
                }).catch(err => {
                    console.warn('[Arrivals] Route-specific live arrivals fetch failed', err);
                    const currentDiv = document.getElementById(stableId);
                    if (currentDiv && isCardRenderCurrent(stableId, stopId, renderVersion)) {
                        currentDiv.setAttribute('data-live-route-arrivals-fetch', 'error');
                    }
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
                const explicitSuffix = getSchedulePatternSuffixForItem(item, stopId);
                const scheduleRequest = item.loopSchedule
                    ? Promise.resolve(item.loopSchedule)
                    : getV3Schedule(item.data.shortName, stopId, item.data.id, explicitSuffix);
                Promise.all([scheduleRequest, loadFareData()]).then(([res]) => {
                    if (!isCardRenderCurrent(stableId, stopId, renderVersion)) return;
                    if (!res) return;
                    const currentDiv = document.getElementById(stableId);
                    if (!currentDiv) return;
                    const {
                        nextArrivals,
                        firstTime,
                        lastTime,
                        serviceWindows,
                        firstScheduledMinutes,
                        lastScheduledMinutes,
                        sparseTripSummary
                    } = res;

                    // 1. Update Bottom Bar (First/Last + Interval Description)
                    const currentBottomEl = document.getElementById(bottomBarId);
                    if (!currentBottomEl || !isCardRenderCurrent(stableId, stopId, renderVersion)) return;

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

                        // Live arrivals do not always carry a source marker. Resolve
                        // against this stop before looking up the fare so overlapping
                        // Tbilisi/Rustavi route IDs cannot select the wrong network.
                        const fareRoute = resolveRouteForStop(displayRoute || item.data, stopId, { preferBus: true }) || displayRoute || item.data;
                        const fare = formatRouteFare(fareRoute);
                        if (fare) {
                            bottomHTML = `<span class="route-fare">${fare}</span>, ${bottomHTML}`;
                        }

                        currentBottomEl.dataset.baseHtml = bottomHTML;
                        const lateWarningOptions = {
                            isMetroCard: isMetroStop,
                            stopId,
                            schedulePatternSuffix: explicitSuffix
                        };
                        const lateWarningIndices = getLateWarningIndices(item, lastScheduledMinutes, firstScheduledMinutes, lateWarningOptions);
                        currentBottomEl.dataset.lateWarningIndices = lateWarningIndices.join(',');
                        currentBottomEl.dataset.schedulePatternSuffix = explicitSuffix || '';
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
                        currentDiv.setAttribute('data-late-warning-indices', lateWarningIndices.join(','));
                        applyLateWarningClasses(currentDiv, lateWarningIndices);
                        const displayEntries = Array.isArray(item.displayArrivals) ? item.displayArrivals.slice(0, 3) : [];
                        if (displayEntries.length > 0) {
                            updateCardDisplayArrivals(currentDiv, timeElId, displayEntries, item.minutes, {
                                isMetroCard: isMetroStop,
                                lateWarningIndices,
                                staleLive: isArrivalsLiveDataStale(),
                                loopSharedLive: item.loopSharedLive
                            });
                        }
                    }

                    // 2. Update Primary Time (ONLY if item needed fetch i.e. was partial scheduled)
                    if (item.needsFetch && nextArrivals && nextArrivals.length > 0) {
                        const displayEntries = buildScheduleDisplayEntries(nextArrivals, 3);
                        const firstArrival = displayEntries[0];
                        const timeEl = document.getElementById(timeElId);
                        if (!isCardRenderCurrent(stableId, stopId, renderVersion)) return;
                        if (firstArrival) {
                            const currentType = currentDiv.getAttribute('data-item-type');
                            // Scheduled-only cards intentionally render no
                            // primary time; they show the second and third
                            // arrivals in the compact stack. Do not require a
                            // primary element before replacing that stack.
                            const isStillScheduled = currentType === 'scheduled' || timeEl?.classList.contains('scheduled-time');
                            if (!isStillScheduled) return;
                            const minsFromNow = firstArrival.minutes;
                            item.displayArrivals = displayEntries;
                            const warningItem = { ...item, displayArrivals: displayEntries };
                            const lateWarningIndices = getLateWarningIndices(warningItem, lastScheduledMinutes, firstScheduledMinutes, {
                                isMetroCard: isMetroStop,
                                stopId,
                                schedulePatternSuffix: explicitSuffix
                            });
                            currentDiv.setAttribute('data-late-warning-indices', lateWarningIndices.join(','));
                            applyLateWarningClasses(currentDiv, lateWarningIndices);
                            updateCardDisplayArrivals(currentDiv, timeElId, displayEntries, minsFromNow, {
                                isMetroCard: isMetroStop,
                                lateWarningIndices,
                                staleLive: isArrivalsLiveDataStale(),
                                loopSharedLive: item.loopSharedLive
                            });
                            const resolvedScheduleRoute = resolveRouteForStop(item.data, stopId, { preferBus: true }) || item.data;
                            const resolvedScheduleRouteId = resolvedScheduleRoute.id || item.data.id || item.data.shortName;
                            const cacheKey = `${stopId}|${resolvedScheduleRouteId}|${item.directionIndex || 0}`;
                            scheduledArrivalsCache.set(cacheKey, {
                                minutes: minsFromNow,
                                timeDisplay: firstArrival.text
                            });
                            if (stopId) {
                                if (!scheduledArrivalsByStop.has(stopId)) {
                                    scheduledArrivalsByStop.set(stopId, new Map());
                                }
                                const stopMap = scheduledArrivalsByStop.get(stopId);
                                const groupKey = `${resolvedScheduleRouteId}_${item.directionIndex || 0}`;
                                stopMap.set(groupKey, {
                                    route: {
                                        id: resolvedScheduleRouteId,
                                        shortName: resolvedScheduleRoute.shortName || item.data.shortName,
                                        longName: resolvedScheduleRoute.longName || item.data.longName,
                                        customShortName: resolvedScheduleRoute.customShortName || item.data.displayShortName,
                                        color: resolvedScheduleRoute.color || item.data.color
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
            // Scheduled-only cards are fallbacks. Keeping one after a live
            // card has replaced it produces an opposite-platform route card.
            if (el.getAttribute('data-item-type') === 'scheduled') {
                el.style.opacity = '0';
                el.style.transform = 'scale(0.95)';
                setTimeout(() => el.remove(), 200);
                return;
            }
            // A live route can acquire richer direction metadata after its
            // first render. If another active card now represents that same
            // canonical route, this element is an obsolete identity—not a
            // disappeared bus—so replace it immediately instead of showing a
            // dimmed duplicate for the normal 15-second expiry window.
            const obsoleteRouteId = el.getAttribute('data-route-id');
            if (obsoleteRouteId && activeRouteIds.has(String(obsoleteRouteId))) {
                el.style.opacity = '0';
                el.style.transform = 'scale(0.95)';
                const removalToken = `${Date.now()}-${Math.random()}`;
                el.dataset.removalToken = removalToken;
                setTimeout(() => {
                    if (el.dataset.removalToken === removalToken) el.remove();
                }, 200);
                return;
            }
            // IMMEDIATE CLEANUP: If the item belongs to an invalid direction for this stop, remove it NOW.
            // This prevents "opposite direction" ghosts from appearing as dimmed items.
            const routeId = el.getAttribute('data-route-id');
            if (routeId) {
                const loopDirections = getLoopScheduleDirectionsForRoute(routeId, equivalentIds);
                const validDirs = loopDirections.length > 0
                    ? loopDirections.map(direction => direction.directionIndex)
                    : getValidDirectionsForRoute(routeId, stopId);
                const itemDir = parseInt(el.getAttribute('data-direction') || '0');
                if (!validDirs.includes(itemDir)) {
                    el.style.opacity = '0';
                    el.style.transform = 'scale(0.95)';
                    const removalToken = `${Date.now()}-${Math.random()}`;
                    el.dataset.removalToken = removalToken;
                    setTimeout(() => {
                        if (el.dataset.removalToken === removalToken) el.remove();
                    }, 400);
                    return;
                }
            }

            // Expiration Logic: If it's been dimmed for > 15 seconds, remove it.
            const lastActive = parseInt(el.getAttribute('data-last-active') || '0');
            const age = Date.now() - lastActive;
            if (age > 15000) {
                el.style.opacity = '0';
                el.style.transform = 'scale(0.95)';
                const removalToken = `${Date.now()}-${Math.random()}`;
                el.dataset.removalToken = removalToken;
                setTimeout(() => {
                    if (el.dataset.removalToken === removalToken) el.remove();
                }, 400);
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
            delete el.dataset.removalToken;
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
