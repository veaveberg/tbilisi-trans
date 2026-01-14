/**
 * Arrivals Module
 * Handles fetching, processing, and rendering bus arrival data
 */

import * as api from './api.js';
import { db } from './db.js';
import { simplifyNumber, shouldShowRoute } from './settings.js';
import { loadIntervalData, getIntervalDescription } from './intervals.js';

// --- Module State ---
let v3RoutesMap = null;
let v3RoutesPromise = null;
const V3_ROUTES_CACHE_KEY = 'v3_routes_map_cache';
const V3_CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours

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
    v3RoutesMap: null
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

/**
 * Initialize the arrivals module with dependencies from main.js
 */
export function initArrivals(dependencies) {
    deps = { ...deps, ...dependencies };
    // Load interval pattern data for schedule descriptions
    loadIntervalData().catch(e => console.warn('Failed to load interval data:', e));
}

// === UTILITY FUNCTIONS ===

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
        const minA = parseInt(a.getAttribute('data-minutes') || '99999');
        const minB = parseInt(b.getAttribute('data-minutes') || '99999');

        const diff = minA - minB;
        if (diff !== 0) return diff;

        const nameA = a.querySelector('.route-number')?.textContent?.trim() || '';
        const nameB = b.querySelector('.route-number')?.textContent?.trim() || '';
        return nameA.localeCompare(nameB, undefined, { numeric: true });
    });

    nonSorted.forEach(item => listEl.appendChild(item));
    items.forEach(item => listEl.appendChild(item));
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
        console.warn(`[V3 Debug] Invalid schedule format`, schedule);
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
                            time: `${h}:${String(m).padStart(2, '0')}`,
                            minutes: mins,
                            hour: h,
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
                // Try tomorrow? (Reuse logic roughly or just look at first departures of current day schedule effectively acting as tomorrow if schedule is same)
                // For simplified "Day View", usually if no future deps today, we can say "Done for today".
                // But typically we look at tomorrow. 
                // Let's just return empty next for now to avoid complexity, but we HAVE first/last.
            }
        }
        const result = {
            nextArrivals: nextTimes || [],
            firstTime: firstTimeStr,
            lastTime: lastTimeStr
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
export async function getV3Schedule(routeShortName, stopId, explicitRouteId = null, explicitSuffix = null) {
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

    const result = await api.fetchScheduleForStop(routeId, stopIds, explicitSuffix);
    if (!result) {
        console.warn(`[V3 Debug] No schedule returned from API for ${routeId}`);
        return null;
    }

    const { schedule, patternSuffix } = result;
    return parseSchedule(schedule, stopIds, patternSuffix, routeShortName);
}

/**
 * Get full schedule grouped by hour for a specific route at a stop
 * @returns {Promise<Object|null>} Map of hour -> array of minutes
 */
export async function getFullScheduleGrouped(routeShortName, stopId, explicitRouteId = null, explicitSuffix = null) {
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

    const result = await api.fetchScheduleForStop(routeId, stopIds, explicitSuffix);
    if (!result || !result.schedule) return null;

    const { schedule } = result;
    const tbilisiNow = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Tbilisi' });
    let daySchedule = schedule.find(s => s.serviceDates.includes(tbilisiNow));
    if (!daySchedule && schedule.length > 0) daySchedule = schedule[0];
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
                const hour = h.padStart(2, '0');
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

    return grouped;
}

// Legacy sync version (returns null)
export function getV3ScheduleSync(routeShortName, stopId) {
    return null;
}

// === ARRIVALS FETCHING ===

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

    let combined = await api.fetchArrivalsForStopIds(Array.from(idsToCheck));

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

    combined = filtered;

    // Deduplicate
    const unique = [];
    const seen = new Set();
    combined.forEach(a => {
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

// === RENDER ARRIVALS ===
export function renderArrivals(arrivalsData, currentStopId = null) {
    const listEl = document.getElementById('arrivals-list');
    listEl.innerHTML = '';

    const stopId = currentStopId || window.currentStopId;

    // --- STALENESS CHECK ---
    // Check if data is stale based on earliest arrival time
    const fetchTimestamp = window.arrivalsDataTimestamp || 0;
    const now = Date.now();
    const dataAge = (now - fetchTimestamp) / 1000; // seconds

    // Find earliest arrival to determine staleness threshold
    let earliestMins = 9999;
    if (arrivalsData && arrivalsData.length > 0) {
        for (const a of arrivalsData) {
            const mins = a.realtimeArrivalMinutes ?? a.scheduledArrivalMinutes ?? 9999;
            if (mins < earliestMins) earliestMins = mins;
        }
    }

    // Tiered staleness: <10min → 15s, <90min → 1min, >90min → 10min
    let staleThreshold = 600; // 10 min default
    if (earliestMins < 10) {
        staleThreshold = 15;
    } else if (earliestMins < 90) {
        staleThreshold = 60;
    }

    const isStale = dataAge > staleThreshold;

    if (isStale && stopId && !window.arrivalsRefreshing) {
        console.log(`[Stale Check] Data is ${Math.round(dataAge)}s old, threshold ${staleThreshold}s for ${earliestMins}' arrival. Refreshing...`);
        window.arrivalsRefreshing = true;

        // Trigger async refresh
        fetchArrivals(stopId).then(freshArrivals => {
            window.arrivalsDataTimestamp = Date.now();
            window.lastArrivals = freshArrivals;
            window.arrivalsRefreshing = false;
            renderArrivals(freshArrivals, stopId);
        }).catch(err => {
            console.warn('[Stale Check] Refresh failed:', err.message);
            window.arrivalsRefreshing = false;
        });

        // Still render current data while refreshing (don't return, just continue)
    }

    // 0. Prepend All Routes (Chips)
    if (window.lastRoutes) {
        const tiles = deps.renderAllRoutes(window.lastRoutes, arrivalsData);
        if (tiles) listEl.appendChild(tiles);
    }

    // 1. Identify "Missing" Routes
    let extraRoutes = [];
    if (stopId) {
        const equivalentIds = deps.getEquivalentStops(stopId, false);
        const uniqueRoutesMap = new Map();

        equivalentIds.forEach(eqId => {
            const routes = deps.stopToRoutesMap.get(eqId) || [];
            routes.forEach(r => {
                // Deduplicate by shortName + key attributes
                // User requirement: Keep routes that "stop twice" (loops/pseudo-twins).
                // These often have same Number and same Destination, but distinct Route IDs (different directions in DB).
                // So we MUST distinguish by Route ID (`r.id`).
                // This might re-introduce "Rustavi duplicates" if they are distinct IDs but effectively same route.
                // But hiding a valid loop stop is worse than showing a technical duplicate.
                const key = `${r.shortName}_${r.longName || ''}_${r.id} `;

                if (stopId === '1354' && String(r.shortName) === '329') {
                    // console.log(`[Dedup Debug]1354 / 329: Key = "${key}", ID = ${ r.id }, Source LongName = "${r.longName}"`);
                }

                if (!uniqueRoutesMap.has(key)) {
                    uniqueRoutesMap.set(key, r);
                } else if (stopId === '1354' && String(r.shortName) === '329') {
                    // console.log(`[Dedup Debug]1354 / 329: DROPPED duplicate for key "${key}"(ID = ${ r.id })`);
                }
            });
        });

        const arrivalRouteShortNames = new Set(arrivalsData.map(a => String(a.shortName)));

        // Filter out routes that are already in arrivals
        extraRoutes = Array.from(uniqueRoutesMap.values()).filter(r => !arrivalRouteShortNames.has(String(r.shortName)));
    }

    // 2. Filter Logic (User Route Filter)
    if (deps.filterManager.state.active) {
        arrivalsData = arrivalsData.filter(a => {
            const r = deps.allRoutes().find(route => String(route.shortName) === String(a.shortName));
            return r && deps.filterManager.state.filteredRoutes.includes(r.id);
        });
        extraRoutes = extraRoutes.filter(r => deps.filterManager.state.filteredRoutes.includes(r.id));
    }

    // 2.5 Show Minibuses Filter
    /* console.log(`[Arrivals Debug] ExtraRoutes before filter: ${ extraRoutes.length } `); */
    arrivalsData = arrivalsData.filter(a => {
        // Precise matching: exact ID, normalized ID, then shortName
        const r = deps.allRoutes().find(route => String(route.id) === String(a.id)) ||
            deps.allRoutes().find(route => normalizeRouteId(route.id) === normalizeRouteId(a.id)) ||
            deps.allRoutes().find(route => String(route.shortName) === String(a.shortName));
        return shouldShowRoute(a.shortName, r);
    });
    extraRoutes = extraRoutes.filter(r => {
        const show = shouldShowRoute(r.shortName, r);
        /* if (!show) console.log(`[Arrivals Debug] Filtered out extraRoute: ${ r.shortName } `); */
        return show;
    });
    console.log(`[Arrivals Debug] ExtraRoutes after filter: ${extraRoutes.length} `);

    // 3. Unified List Creation with Cache Lookup
    let renderList = [];

    // --- LIVE ARRIVALS GROUPING LOGIC ---
    // User wants multiple arrivals (e.g. 5', 12') for the same route to be grouped.
    // Group by: ShortName + Direction (Headsign/PatternSuffix)
    const liveGroups = new Map(); // Key -> { primary: arrival, secondaries: [arrival] }

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

        // Logic to Determine Grouping Key & Direction
        let directionIndex = 0;
        if (a.patternSuffix) {
            const part = a.patternSuffix.split(':')[0];
            directionIndex = parseInt(part) || 0;
        }

        // Match by ID first (exact), then normalized ID (handles 1:R835 vs rR835), then shortName
        const matchedRouteForColor = deps.allRoutes().find(r => String(r.id) === String(a.id)) ||
            deps.allRoutes().find(r => normalizeRouteId(r.id) === normalizeRouteId(a.id)) ||
            deps.allRoutes().find(r => r.shortName === a.shortName);
        const invertDirection = matchedRouteForColor?._overrides?.invertDirection === true;
        if (invertDirection) {
            directionIndex = directionIndex === 0 ? 1 : 0;
        }

        // Debug Rustavi routes
        if (a.id && /^1:R\d/.test(a.id) && !window._rustaviHeadsignDebugDone) {
            console.log('[Rustavi Debug] Arrival:', { id: a.id, shortName: a.shortName, headsign: a.headsign, patternSuffix: a.patternSuffix });
            console.log('[Rustavi Debug] Matched route:', matchedRouteForColor?.id, 'Has overrides:', !!matchedRouteForColor?._overrides);
            console.log('[Rustavi Debug] Destinations:', matchedRouteForColor?._overrides?.destinations);
            console.log('[Rustavi Debug] Direction index:', directionIndex);
            window._rustaviHeadsignDebugDone = true;
        }

        const displayHeadsign = deps.getPatternHeadsign(matchedRouteForColor, directionIndex, a.headsign);

        // Group Key: ShortName + Direction Index (or Headsign if fuzzy)
        // We use DirectionIndex as primary differentiator for grouped rows.
        const groupKey = `${a.shortName}_${directionIndex}`;

        if (!liveGroups.has(groupKey)) {
            liveGroups.set(groupKey, {
                primary: a,
                headsign: displayHeadsign,
                directionIndex: directionIndex,
                color: deps.getRouteDisplayColor(matchedRouteForColor || { ...a, id: a.id }),
                arrivals: []
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
            allArrivals: group.arrivals
        });
    });

    // Add Extra Routes (Try Sync Cache)
    extraRoutes.forEach(r => {
        // Try to get time from cache synchronously
        // Logic changed: Always async
        const cachedTimeStr = null; // No sync cache access

        // Calculate minutes if cached
        let minutes = 99999;
        let timeDisplay = '...';
        let secondaryTimes = [];

        if (cachedTimeStr) {
            // Basic cache support (legacy string)
            minutes = getMinutesFromNow(cachedTimeStr);
            if (minutes < 30 && minutes >= 0) {
                timeDisplay = `${minutes}'`;
            } else {
                timeDisplay = cachedTimeStr;
            }
        }

        renderList.push({
            type: 'scheduled',
            data: r,
            minutes: minutes,
            color: deps.getRouteDisplayColor(r),
            needsFetch: !cachedTimeStr
        });
    });

    // 4. Sort EVERYTHING
    renderList.sort((a, b) => {
        const minDiff = a.minutes - b.minutes;
        if (minDiff !== 0) return minDiff; // Sort by Time

        // Secondary Sort: Route Number
        const nameA = String(a.data.shortName || '');
        const nameB = String(b.data.shortName || '');
        return nameA.localeCompare(nameB, undefined, { numeric: true });
    });

    if (renderList.length === 0) {
        const div = document.createElement('div');
        div.className = 'empty';
        div.textContent = deps.filterManager.state.active ? 'No arrivals for selected destination' : 'No upcoming arrivals';
        listEl.appendChild(div);
        return;
    }

    // 5. Render Unified List
    renderList.forEach(item => {
        const div = document.createElement('div');
        div.className = 'arrival-item'; // Unified class
        div.style.borderLeftColor = item.color;
        div.setAttribute('data-minutes', item.minutes);

        // -- Data Prep --
        let routeShortName, headsign, timeDisplay, isScheduled, needsDisclaimer, routeIdForClick;
        let routeColor = item.color;

        if (item.type === 'live') {
            const a = item.data;
            routeShortName = a.displayShortName || a.shortName;
            headsign = item.headsign; // Pre-calculated
            isScheduled = !a.realtime;
            routeIdForClick = a.id; // Use specific ID if available

            // Time Display Logic
            const rawMins = item.minutes;
            if (rawMins === 999 || rawMins === null || rawMins === undefined) {
                timeDisplay = '--:--';
            } else if (isScheduled) {
                // Scheduled times always show h:mm format
                timeDisplay = formatScheduledTime(rawMins);
            } else {
                // Live/realtime shows minutes
                timeDisplay = `${rawMins}'`;
            }
            if (isScheduled && timeDisplay !== '--:--' && !timeDisplay.includes('˚')) {
                timeDisplay += '˚';
            }

            needsDisclaimer = isScheduled;

            // Resolve proper route object for overrides if possible (re-using logic from prep)
            // Simplified: we already calculated displayShortName in loop if we could.
            // But we need routeObj for click handler.
        } else {
            // Scheduled
            const r = item.data;
            routeShortName = r.customShortName || r.shortName;

            // Heuristic Naming: Match LoopUtils logic
            // User Feedback: Don't parse non-loop routes if headsign is available.
            // Priority: Override > API Headsign > Parsed Destination (Heuristic) > Full LongName

            // 0. CHECK OVERRIDES
            // Resolve fresh route object from allRoutes to ensure we have the latest _overrides
            // Fuzzy match ID just in case
            const freshRoute = deps.allRoutes().find(route =>
                String(route.id) === String(r.id) ||
                String(route.id) === `1:${r.id} ` ||
                `1:${route.id} ` === String(r.id)
            ) || r;

            let overrideHeadsign = null;
            if (freshRoute._overrides && freshRoute._overrides.destinations) {
                // Skip defaulting to Dir 0
            }

            if (overrideHeadsign) {
                headsign = overrideHeadsign;
            } else if (freshRoute._overrides && freshRoute._overrides.longName) {
                const lng = 'en'; // fallback
                headsign = freshRoute._overrides.longName[lng] || freshRoute._overrides.longName.en || freshRoute._overrides.longName.ka || r.longName;
            } else if (item.headsign) {
                headsign = item.headsign;
            } else {
                const parsed = deps.RouteGeometry.parseRouteName(r.longName);
                if (parsed.destination) {
                    headsign = parsed.destination;
                } else {
                    headsign = r.longName || '';
                }
            }

            isScheduled = true;
            needsDisclaimer = true;
            timeDisplay = item.timeDisplay || '--:--';
            // Scheduled times always show h:mm format (no minutes override)

            routeIdForClick = r.id;
        }

        // -- Fallbacks --
        if (!headsign || headsign === 'undefined') {
            headsign = 'Destination Unknown';
        }

        // -- HTML Generation (Unified) --
        const scheduledClass = isScheduled ? 'scheduled-time' : '';

        // Special ID for async update
        const timeElId = `time-${item.data.shortName}-${stopId}`;
        const timeElAttr = `id="${timeElId}"`;

        // -- Bottom Bar Content --
        // Default content (will be replaced by async schedule fetch)
        let bottomContent = '&nbsp;';
        const bottomBarId = `bottom-${item.data.shortName}-${stopId}`;
        const bottomBarAttr = `id="${bottomBarId}"`;

        // Render - Two-column layout: left (info) + right (time spanning both rows)
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
                <div class="time-container">
                    <div ${timeElAttr} class="led-text ${scheduledClass}">${timeDisplay}</div>
                </div>
            </div>
        `;

        div.innerHTML = innerContent;

        // -- Click Handlers --
        let routeObj = deps.allRoutes().find(r => r.id === routeIdForClick);
        if (!routeObj && routeIdForClick) {
            // Try normalized ID match (handles 1:R835 vs rR835)
            routeObj = deps.allRoutes().find(r => normalizeRouteId(r.id) === normalizeRouteId(routeIdForClick));
        }
        if (!routeObj && item.data.shortName) {
            routeObj = deps.allRoutes().find(r => r.shortName === item.data.shortName);
        }

        if (routeObj) {
            div.addEventListener('click', () => {
                deps.showRouteOnMap(routeObj, true, {
                    preserveBounds: true,
                    fromStopId: stopId,
                    targetHeadsign: headsign,
                    initialDirectionIndex: item.directionIndex
                });
            });
        }

        // Append to list
        listEl.appendChild(div);

        // -- Async Fetch Hook for Schedule Info (First/Last) --
        // We do this for BOTH live and scheduled items to get the first/last info
        // (For live items, we ignore the 'next' schedule times, but want first/last)
        if (item.data.shortName && item.data.shortName !== 'undefined') {
            getV3Schedule(item.data.shortName, stopId, item.data.id).then(res => {
                if (!res) return;
                const { nextArrivals, firstTime, lastTime, serviceWindows } = res;

                // 1. Update Bottom Bar (First/Last + Interval Description)
                const bottomEl = document.getElementById(bottomBarId);

                // Route 174 uses serviceWindows instead of firstTime/lastTime
                if (bottomEl && (serviceWindows || (firstTime && lastTime))) {
                    // Resolve the full Route ID (some live items only have shortName)
                    let routeId = item.data.id;
                    if (!routeId || !routeId.includes(':')) {
                        // Find matching route in global list to get full ID
                        const matchingRoute = deps.allRoutes().find(r => String(r.shortName) === String(item.data.shortName));
                        if (matchingRoute) routeId = matchingRoute.id;
                    }

                    const intervalDesc = getIntervalDescription(routeId)?.trim();

                    let bottomHTML;
                    // Use serviceWindows for route 174
                    if (serviceWindows) {
                        bottomHTML = `<span class="schedule-times">${serviceWindows}</span>`;
                        // Add interval (skip __FULL__ handling since we're using serviceWindows)
                        const cleanInterval = intervalDesc?.replace('__FULL__', '').trim();
                        if (cleanInterval) {
                            bottomHTML += `,<span class="interval-desc">&nbsp;${cleanInterval}</span>`;
                        }
                    } else if (intervalDesc && intervalDesc.startsWith('__FULL__')) {
                        // Check for __FULL__ prefix which means replace entire bottom text
                        bottomHTML = intervalDesc.slice(8); // Remove __FULL__ prefix
                    } else {
                        bottomHTML = `<span class="schedule-times">${firstTime.trim()} – ${lastTime.trim()}</span>`;
                        if (intervalDesc) {
                            bottomHTML += `,<span class="interval-desc">&nbsp;${intervalDesc}</span>`;
                        }
                    }
                    bottomEl.innerHTML = bottomHTML;
                }

                // 2. Update Primary Time (ONLY if item needed fetch i.e. was partial scheduled)
                if (item.needsFetch && nextArrivals && nextArrivals.length > 0) {
                    const firstArrival = nextArrivals[0];
                    const timeEl = document.getElementById(timeElId);
                    if (timeEl) {
                        const timeStr = firstArrival.time;
                        const minsFromNow = getMinutesFromNow(timeStr);
                        div.setAttribute('data-minutes', minsFromNow);
                        // Scheduled items always show h:mm format with ˚
                        timeEl.textContent = timeStr.includes('˚') ? timeStr : timeStr + '˚';
                    }
                    setTimeout(() => sortArrivalsList(), 50);
                }
            }).catch(err => {
                console.warn('[V3] Schedule Fetch Error', err);
            });
        }
    });

    // Initial Sort
    sortArrivalsList();

    // --- COUNTDOWN TIMER ---
    // Update displayed times every 10 seconds based on elapsed time since fetch
    if (window.arrivalsCountdownTimer) {
        clearInterval(window.arrivalsCountdownTimer);
    }

    window.arrivalsCountdownTimer = setInterval(() => {
        const fetchTime = window.arrivalsDataTimestamp || Date.now();
        const elapsedMinutes = (Date.now() - fetchTime) / 60000;

        const arrivalItems = document.querySelectorAll('.arrival-item');
        let needsResort = false;

        arrivalItems.forEach(item => {
            const originalMinutes = parseInt(item.getAttribute('data-minutes-original') || item.getAttribute('data-minutes') || '9999');

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
                const timeEl = item.querySelector('.led-text');
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

                needsResort = true;
            }
        });

        if (needsResort) {
            sortArrivalsList();
        }
    }, 10000); // Update every 10 seconds
}

