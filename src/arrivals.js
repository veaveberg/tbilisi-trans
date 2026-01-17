/**
 * Arrivals Module
 * Handles fetching, processing, and rendering bus arrival data
 */

import * as api from './api.js';
import { getStaticRouteDetails } from './api.js';
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

    // Listen for static data preload to refresh arrivals (fixes direction logic on first load)
    window.addEventListener('static-routes-loaded', () => {
        // console.log('[Arrivals] Static data loaded, refreshing view to apply direction fix...');
        if (window.currentStopId && window.lastArrivals) {
            renderArrivals(window.lastArrivals, window.currentStopId);
        }
    });
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
 * Get full schedule grouped by hour for a specific route at a stop
 * @returns {Promise<Object|null>} Map of hour -> array of minutes
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

    return grouped;
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

    updateArrivalsLoadingState(true);
    let combined;
    try {
        combined = await api.fetchArrivalsForStopIds(Array.from(idsToCheck));
    } finally {
        updateArrivalsLoadingState(false);
    }

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

// === RENDER ARRIVALS
export function renderArrivals(arrivalsData, currentStopId = null) {
    const listEl = document.getElementById('arrivals-list');
    if (!listEl) return;

    const stopId = currentStopId || window.currentStopId;

    // --- CROSS-STOP PROTECTION ---
    // If this render is for a stop that is no longer the current one, ignore it.
    // This prevents async results from previous stops from overwriting the current UI.
    if (stopId && window.currentStopId && String(stopId) !== String(window.currentStopId)) {
        return;
    }

    // --- STOP CHANGE DETECTION ---
    // If we've switched stops, we MUST clear the list immediately to avoid
    // showing old stop's arrivals and to prevent ID collisions.
    if (String(window._lastRenderedStopId) !== String(stopId)) {
        listEl.innerHTML = '';
        window._lastRenderedStopId = String(stopId);
    }



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

        // Show visible feedback for background refresh (at least one sequence)
        updateArrivalsLoadingState(true);
        const minDelay = new Promise(resolve => setTimeout(resolve, 1200));

        // Trigger async refresh
        Promise.all([fetchArrivals(stopId), minDelay]).then(([freshArrivals]) => {
            window.arrivalsDataTimestamp = Date.now();
            window.lastArrivals = freshArrivals;
            renderArrivals(freshArrivals, stopId);
        }).catch(err => {
            console.warn('[Stale Check] Refresh failed:', err.message);
        }).finally(() => {
            window.arrivalsRefreshing = false;
            updateArrivalsLoadingState(false);
        });

        // Still render current data while refreshing (don't return, just continue)
    }

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

        // --- DIRECTION FIX LOGIC (Static Check) ---
        // Check if this stop serves only ONE direction for this route
        const staticDetails = getStaticRouteDetails(matchedRouteForColor ? matchedRouteForColor.id : (a.routeId || a.id));
        if (staticDetails && staticDetails._stopsOfPatterns && stopId) {
            // Find stop entry
            const stopEntry = staticDetails._stopsOfPatterns.find(s => {
                const sId = String(s.stop.id || s.stop); // Handle object or string
                // Normalization for comparison
                const n1 = normalizeRouteId(sId);
                const n2 = normalizeRouteId(stopId);
                return sId === stopId || n1 === n2;
            });

            if (stopEntry && stopEntry.patternSuffixes && stopEntry.patternSuffixes.length === 1) {
                // If stop is EXCLUSIVE to one pattern, trust that pattern's direction
                const uniqueSuffix = stopEntry.patternSuffixes[0];
                const fixedPart = uniqueSuffix.split(':')[0];
                const fixedIdx = parseInt(fixedPart) || 0;

                // Only override if different (and respect invertDirection which is applied AFTER raw parsing)
                // If invertDirection is true, we want the FINAL displayed direction to match the static logic.
                // Static Logic says: This stop is suffix X (Direction Y). 
                // Invert Logic says: Flip whatever Y is.
                // So we set the raw index to Y, then let the invert logic below (already applied? wait, we applied invert above).
                // Let's re-evaluate.

                // We derived `directionIndex` from `a.patternSuffix` (LIVE data).
                // We want to verify `directionIndex` against STATIC data.

                // Static says "This stop uses pattern 1:01".
                // So Static Raw Direction = 1.
                // If Invert is Active, Final Direction = 0.

                // Current logic:
                // 1. Parse Live Suffix -> Live Raw Dir
                // 2. Apply Invert -> Live Final Dir

                // Correct Fix Logic:
                // 1. Get Static Raw Dir (from uniqueSuffix)
                // 2. Trust it absolutely. If the user says "invert is broken", we shouldn't flip this 
                //    authoritative static finding based on a potentially bad flag.
                //    The static suffix (e.g. "1:01") literally defines the pattern the bus is on.

                let staticRawDir = fixedIdx;

                // --- SEMANTIC MATCHING START ---
                // Try to find which Direction Index (0 or 1) actually matches the Static Pattern's Headsign in the Overrides.
                // This bypasses "InvertDirection" flags by looking at the actual text content.
                let semanticDir = -1;
                const patternDef = staticDetails.patterns.find(p => p.patternSuffix === uniqueSuffix);
                const staticHeadsign = patternDef ? patternDef.headsign : null;
                const overrides = matchedRouteForColor?._overrides;

                if (staticHeadsign && overrides && overrides.destinations) {
                    // Helper to extract text
                    const getText = (d) => {
                        if (!d || !d.headsign) return '';
                        if (typeof d.headsign === 'string') return d.headsign;
                        return d.headsign.en || d.headsign.ka || '';
                    };

                    const d0 = getText(overrides.destinations[0]);
                    const d1 = getText(overrides.destinations[1]);

                    // Simple fuzzy include check or exact match
                    const clean = s => String(s || '').toLowerCase().trim();
                    const target = clean(staticHeadsign);

                    // Verify d0 is not empty before matching
                    if (d0 && (clean(d0) === target || clean(d0).includes(target) || target.includes(clean(d0)))) {
                        semanticDir = 0;
                        a._verifiedHeadsign = d0; // Capture text
                    } else if (d1 && (clean(d1) === target || clean(d1).includes(target) || target.includes(clean(d1)))) {
                        semanticDir = 1;
                        a._verifiedHeadsign = d1; // Capture text
                    }

                    // Debug Semantic Match for problem routes
                    if (['305', '306', '311', '378', '541'].includes(a.shortName)) {
                        console.log(`[Semantic Debug] ${a.shortName}:`);
                        console.log(`   Target: "${target}"`);
                        console.log(`   d0: "${clean(d0)}" (Match? ${semanticDir === 0})`);
                        console.log(`   d1: "${clean(d1)}" (Match? ${semanticDir === 1})`);
                    }
                }

                if (semanticDir !== -1) {
                    staticRawDir = semanticDir; // Authoritative match found
                    // console.log(`[Direction Auto] ${a.shortName}: Mapped Pattern ${uniqueSuffix} ("${staticHeadsign}") -> Index ${semanticDir} via Overrides`);
                } else if (invertDirection) {
                    staticRawDir = staticRawDir === 0 ? 1 : 0;
                }
                // --- SEMANTIC MATCHING END ---

                const liveRaw = invertDirection ? (directionIndex === 0 ? 1 : 0) : directionIndex;

                if (directionIndex !== staticRawDir) {
                    console.log(`[Direction Fix] ${a.shortName} at ${stopId}:`);
                    console.log(`   Live Suffix: ${a.patternSuffix} -> Live Index: ${directionIndex}`);
                    console.log(`   Static Suffix: ${uniqueSuffix} ("${staticHeadsign || '?'}") -> Auto-Detected: ${semanticDir !== -1 ? semanticDir : 'N/A'}`);
                    console.log(`   Final Decision: ${staticRawDir}`);

                    directionIndex = staticRawDir;
                    a._fixedDirection = true;
                } else {
                    // Always log for problem routes to see what's happening
                    const problemRoutes = ['305', '306', '311', '378', '541'];
                    if (problemRoutes.includes(a.shortName)) {
                        console.log(`[Direction Debug] ${a.shortName} at ${stopId}:`);
                        console.log(`   InvertDirection: ${invertDirection}`);
                        console.log(`   Static Raw ${fixedIdx} -> Final ${staticRawDir}`);
                        console.log(`   Live Raw ${liveRaw} -> Final ${directionIndex}`);
                        console.log(`   Result: NO FIX (Values Match)`);
                    } else if (Math.random() < 0.01) {
                        console.log(`[Direction Info] ${a.shortName} at ${stopId}: Match (Live ${a.patternSuffix} == Static ${uniqueSuffix})`);
                    }
                }
            } else if (stopEntry && stopEntry.patternSuffixes) {
                // Log why skipped if it's a problematic one (like 305 at 810?)
                if (a.shortName === '305' || a.shortName === '306') {
                    console.log(`[Direction Skip] ${a.shortName} at ${stopId}: Multiple Suffixes [${stopEntry.patternSuffixes.join(', ')}]`);
                }
            } else if (!stopEntry) {
                if (a.shortName === '305' || a.shortName === '306') {
                    const routeId = matchedRouteForColor ? matchedRouteForColor.id : (a.routeId || a.id);
                    console.log(`[Direction Skip] ${a.shortName} at ${stopId}: Stop not found in static details for Route ${routeId}`);
                }
            }
        }

        // Debug Rustavi routes
        if (a.id && /^1:R\d/.test(a.id) && !window._rustaviHeadsignDebugDone) {
            console.log('[Rustavi Debug] Arrival:', { id: a.id, shortName: a.shortName, headsign: a.headsign, patternSuffix: a.patternSuffix });
            console.log('[Rustavi Debug] Matched route:', matchedRouteForColor?.id, 'Has overrides:', !!matchedRouteForColor?._overrides);
            window._rustaviHeadsignDebugDone = true;
        }

        // Check 541/810 specific
        if (String(a.shortName) === '541') {
            const res = a._verifiedHeadsign || deps.getPatternHeadsign(matchedRouteForColor, directionIndex, a.headsign); // Use verified if available
            console.log(`[Headsign Check] 541 at ${stopId}: Index ${directionIndex} -> "${res}" (Forced: ${!!a._verifiedHeadsign})`);
            // console.log(`[Headsign Check] Overrides present?`, !!matchedRouteForColor?._overrides);
        }

        const displayHeadsign = a._verifiedHeadsign || deps.getPatternHeadsign(matchedRouteForColor, directionIndex, a.headsign);

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

    // -- FLIP ANIMATION START --
    // 1. Record positions of existing items
    const oldRects = new Map();
    listEl.querySelectorAll('.arrival-item').forEach(el => {
        oldRects.set(el.id, el.getBoundingClientRect());
    });

    const activeIds = new Set();

    const emptyId = 'arrivals-empty-msg';
    const isActuallyLoading = window.arrivalsLoading;

    if (renderList.length === 0 && !isActuallyLoading) {
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
        const msg = (deps.filterManager && deps.filterManager.state.active) ? 'No arrivals for selected destination' : 'No upcoming arrivals';
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
        const routeId = item.data.id;
        const dirIdx = item.directionIndex !== undefined ? item.directionIndex : 0;
        const stableId = `route-${routeId}-${dirIdx}`;
        activeIds.add(stableId);

        let div = document.getElementById(stableId);
        const isNew = !div;

        if (isNew) {
            div = document.createElement('div');
            div.id = stableId;
            div.className = 'arrival-item';
            div.style.opacity = '0'; // Start invisible
        }

        div.setAttribute('data-minutes', item.minutes);
        div.style.borderLeftColor = item.color;

        // -- Data Prep --
        let routeShortName, headsign, timeDisplay, isScheduled, needsDisclaimer, routeIdForClick;
        let routeColor = item.color;

        if (item.type === 'live') {
            const a = item.data;
            routeShortName = a.displayShortName || a.shortName;
            headsign = item.headsign;
            isScheduled = !a.realtime;
            routeIdForClick = a.id;

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
        } else {
            const r = item.data;
            routeShortName = r.customShortName || r.shortName;

            const freshRoute = deps.allRoutes().find(route =>
                String(route.id) === String(r.id) ||
                String(route.id) === `1:${r.id}` ||
                `1:${route.id}` === String(r.id)
            ) || r;

            let overrideHeadsign = null;
            if (freshRoute._overrides && freshRoute._overrides.destinations) {
                const dirIdx = item.directionIndex !== undefined ? item.directionIndex : 0;
                overrideHeadsign = deps.getPatternHeadsign(freshRoute, dirIdx, null);
            }

            if (overrideHeadsign) {
                headsign = overrideHeadsign;
            } else if (freshRoute._overrides && freshRoute._overrides.longName) {
                const lng = new URLSearchParams(window.location.search).get('locale') || 'en';
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
            routeIdForClick = r.id;
        }

        if (!headsign || headsign === 'undefined') {
            headsign = 'Destination Unknown';
        }

        const scheduledClass = isScheduled ? 'scheduled-time' : '';
        const timeElId = `time-${item.data.shortName}-${stopId}`;
        const timeElAttr = `id="${timeElId}"`;
        const bottomBarId = `bottom-${item.data.shortName}-${stopId}`;
        const bottomBarAttr = `id="${bottomBarId}"`;

        let bottomContent = '&nbsp;';
        // Preserve bottom content if already exists
        const existingBottom = div.querySelector('.arrival-card-bottom');
        if (existingBottom && existingBottom.innerHTML.trim() !== '&nbsp;') {
            bottomContent = existingBottom.innerHTML;
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
                <div class="time-container">
                    <div ${timeElAttr} class="led-text ${scheduledClass}">${timeDisplay}</div>
                </div>
            </div>
        `;

        if (div.innerHTML !== innerContent) {
            div.innerHTML = innerContent;
        }

        // Click handler (refresh every time to ensure latest closure)
        let routeObj = deps.allRoutes().find(r => r.id === routeIdForClick) ||
            deps.allRoutes().find(r => normalizeRouteId(r.id) === normalizeRouteId(routeIdForClick)) ||
            deps.allRoutes().find(r => r.shortName === item.data.shortName);

        if (routeObj) {
            div.onclick = () => {
                deps.showRouteOnMap(routeObj, true, {
                    preserveBounds: true,
                    fromStopId: stopId,
                    targetHeadsign: headsign,
                    initialDirectionIndex: item.directionIndex
                });
            };
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

    // Remove obsolete items
    listEl.querySelectorAll('.arrival-item').forEach(el => {
        if (!activeIds.has(el.id)) {
            el.style.opacity = '0';
            el.style.transform = 'scale(0.95)';
            setTimeout(() => el.remove(), 400);
        }
    });

    // 3. FLIP Play
    requestAnimationFrame(() => {
        listEl.querySelectorAll('.arrival-item').forEach(el => {
            const oldRect = oldRects.get(el.id);
            if (!oldRect) return;

            const newRect = el.getBoundingClientRect();
            const dy = oldRect.top - newRect.top;
            const dx = oldRect.left - newRect.left;

            if (dy !== 0 || dx !== 0) {
                el.style.transition = 'none';
                el.style.transform = `translate(${dx}px, ${dy}px)`;

                requestAnimationFrame(() => {
                    el.style.transition = '';
                    el.style.transform = '';
                });
            }
        });
    });

}

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


