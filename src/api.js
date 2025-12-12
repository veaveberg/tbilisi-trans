import { db } from './db.js';

// Configuration
export const MAPBOX_TOKEN = 'pk.eyJ1IjoidHRjYXpyeSIsImEiOiJjam5sZWU2NHgxNmVnM3F0ZGN2N2lwaGF2In0.00TvUGr9Qu4Q4fc_Jb9wjw';
export const API_KEY = 'c0a2f304-551a-4d08-b8df-2c53ecd57f9f';
// For local development, we use the Vite proxy.
export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || (import.meta.env.DEV
    ? '/pis-gateway/api/v2'
    : 'https://transit.ttc.com.ge/pis-gateway/api/v2'); // Corrected fallback for production if needed

// Helper: V3 Base URL
export const API_V3_BASE_URL = API_BASE_URL.replace('/v2', '/v3');

const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours

const pendingRequests = new Map(); // Global in-flight deduplication

const v3Cache = {
    patterns: new Map(), // routeId -> patterns
    schedules: new Map(), // routeId:suffix:date -> schedule
    polylines: new Map() // routeId:suffix -> polyline data
};

// Queue for V3 requests to prevent 500 errors
const MAX_CONCURRENT_V3_REQUESTS = 3;
let activeV3Requests = 0;
const v3RequestQueue = [];

function processV3Queue() {
    if (activeV3Requests >= MAX_CONCURRENT_V3_REQUESTS || v3RequestQueue.length === 0) return;

    activeV3Requests++;
    const { task, resolve, reject } = v3RequestQueue.shift();

    task().then(resolve).catch(reject).finally(() => {
        activeV3Requests--;
        processV3Queue();
    });
}

function enqueueV3Request(task) {
    return new Promise((resolve, reject) => {
        v3RequestQueue.push({ task, resolve, reject });
        processV3Queue();
    });
}

// --- Offline & Caching Logic ---

// API Status Observability
export let apiStatus = {
    ok: true,
    code: 200,
    text: 'OK'
};
const apiStatusListeners = new Set();

export function onApiStatusChange(callback) {
    apiStatusListeners.add(callback);
    callback(apiStatus); // immediate firing
    return () => apiStatusListeners.delete(callback);
}

function updateApiStatus(ok, code, text) {
    // Only fire if changed significantly (success vs fail)
    // Or maybe just always update so UI freshness is visible?
    // Let's debounce slightly or check equality
    if (apiStatus.ok === ok && apiStatus.code === code) return;

    apiStatus = { ok, code, text };
    apiStatusListeners.forEach(cb => cb(apiStatus));
}

// Helper to determine status color/text from code
export function getApiStatusColor(code) {
    if (code === 200) return 'green'; // All Good
    if (code >= 500) return 'yellow'; // Server Error
    if (code === 0 || code === 'offline') return 'red'; // Network Error
    return 'yellow'; // Unknown?
}


async function fetchStaticFallback(endpoint) {
    try {
        console.log(`[Fallback] Attempting to load static data for ${endpoint}`);
        // Map API endpoint to static file
        // e.g. /stops -> /data/fallback_stops.json
        // 1. Stop Routes (Dynamic Computation)
        // Endpoint: /stops/1%3A1234/routes
        const stopRoutesMatch = endpoint.match(/\/stops\/([^\/]+)\/routes/);
        if (stopRoutesMatch) {
            const stopId = decodeURIComponent(stopRoutesMatch[1]);
            try {
                const masterRoutesRes = await fetch(`./data/fallback_routes.json`);
                if (!masterRoutesRes.ok) throw new Error('Master routes missing');
                const masterRoutes = await masterRoutesRes.json();

                // Filter routes that serve this stop
                return masterRoutes.filter(r => r.stops && r.stops.includes(stopId));
            } catch (err) {
                console.warn(`[Fallback] Failed to compute stop routes: ${err}`);
                return [];
            }
        }

        let filename = '';
        if (endpoint.endsWith('/routes')) filename = 'fallback_routes.json';
        else if (endpoint.endsWith('/stops')) filename = 'fallback_stops.json';
        else {
            // Check for V3 Metro calls
            // 1. Route Details: .../routes/123
            const detailsMatch = endpoint.match(/\/routes\/(\d+)$/);
            if (detailsMatch) {
                filename = `fallback_route_details_${detailsMatch[1]}.json`;
            }
            // 2. Schedule: .../routes/123/schedule?patternSuffix=0:01...
            const scheduleMatch = endpoint.match(/\/routes\/(\d+)\/schedule/);
            if (scheduleMatch) {
                const urlObj = new URL('http://dummy.com' + endpoint); // parse query params
                const suffix = urlObj.searchParams.get('patternSuffix');
                if (suffix) {
                    const safeSuffix = suffix.replace(/:/g, '_');
                    filename = `fallback_schedule_${scheduleMatch[1]}_${safeSuffix}.json`;
                }
            }
        }

        if (!filename) return null;

        const res = await fetch(`./data/${filename}`);
        if (!res.ok) throw new Error('Static file not found');
        return await res.json();
    } catch (e) {
        console.warn(`[Fallback] Failed to load static data: ${e.message}`);
        return null;
    }
}

export async function fetchWithCache(url, options = {}) {
    const cacheKey = `cache_${url}`;
    const now = Date.now();
    let cached = null;

    try {
        cached = await db.get(cacheKey);
    } catch (e) {
        console.warn('DB Get Failed', e);
    }

    // 1. STALE-WHILE-REVALIDATE STRATEGY
    if (cached) {
        const { timestamp, data } = cached;
        const age = now - timestamp;

        // If Fresh (< 24h), return immediately (no network)
        if (age < CACHE_DURATION) {
            console.log(`[Cache] Hit (Fresh): ${url}`);
            return data;
        }

        // If Stale but usable (< 7 days), return immediately BUT update in background
        if (age < 7 * 24 * 60 * 60 * 1000) {
            console.log(`[Cache] Hit (Stale): ${url} - Returning data, fetching update in background...`);

            // Background Revalidation
            fetch(url, { ...options, credentials: 'omit' }).then(async (res) => {
                if (res.ok) {
                    const newData = await res.json();
                    await db.set(cacheKey, { timestamp: now, data: newData });
                    console.log(`[Cache] Background Update Success: ${url}`);
                    updateApiStatus(true, res.status, res.statusText);
                } else {
                    console.warn(`[Cache] Background Update Failed (Status ${res.status}): ${url}`);
                    updateApiStatus(false, res.status, res.statusText);
                }
            }).catch(e => {
                console.warn(`[Cache] Background Update Network Error: ${url}`, e);
                updateApiStatus(false, 0, 'Offline');
            });

            return data;
        }

        // If Very Stale (> 7 days), treat as missing (try network, fallback to this if fail)
        console.log(`[Cache] Expired (Very Stale): ${url}`);

        if (options.strategy === 'cache-only') {
            console.log(`[Cache-Only] Returning VERY STALE data for ${url}`);
            return cached.data;
        }
    } else {
        console.log(`[Cache] Miss: ${url}`);
    }

    if (options.strategy === 'cache-only') {
        const cleanUrl = url.split('?')[0];
        console.log(`[Cache-Only] Attempting static fallback for ${cleanUrl}`);
        const fallbackData = await fetchStaticFallback(cleanUrl);
        if (fallbackData) {
            console.log(`[Cache-Only] Returning STATIC fallback for ${url}`);
            return fallbackData;
        }
        return null;
    }

    // 2. NETWORK FETCH
    // Deduplication Logic
    if (pendingRequests.has(url)) {
        return pendingRequests.get(url);
    }

    const fetchOptions = { ...options, credentials: 'omit' };

    const requestPromise = (async () => {
        try {
            const response = await fetchWithRetry(url, fetchOptions); // Use Retry Logic
            if (!response.ok) throw new Error(`Network error: ${response.status}`);
            const data = await response.json();

            // Cache Success
            await db.set(cacheKey, { timestamp: now, data });
            return data;
        } catch (err) {
            console.warn(`[Network] Failed to fetch ${url}: ${err.message}`);

            // 3. FALLBACK STRATEGIES

            // A. Try "Very Stale" Cache if we have it
            if (cached) {
                console.warn(`[Fallback] Using expired cache for ${url}`);
                updateApiStatus(false, 0, 'Offline (Cache)');
                return cached.data;
            }

            // B. Try Static JSON (Day 1 Offline Support)
            // Extract endpoint for mapping
            const cleanUrl = url.split('?')[0];
            const fallbackData = await fetchStaticFallback(cleanUrl);
            if (fallbackData) {
                console.warn(`[Fallback] Used Static Data for ${url}`);
                updateApiStatus(false, 0, 'Offline (Static)');
                // Helper: Cache this so next time strictly offline works faster?
                await db.set(cacheKey, { timestamp: 0, data: fallbackData }); // Timestamp 0 = Always Stale (will try to update next time)
                return fallbackData;
            }

            throw err; // Give up
        } finally {
            pendingRequests.delete(url);
        }
    })();

    pendingRequests.set(url, requestPromise);
    return requestPromise;
}

export async function fetchWithRetry(url, options = {}, retries = 3, backoff = 1000) {
    // Fail Fast if Offline
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
        retries = 0;
    }

    try {
        const res = await fetch(url, options);
        // Retry on 5xx errors
        if (retries > 0 && res.status >= 500 && res.status < 600) {
            console.warn(`[Network] 5xx Error (${res.status}) fetching ${url}. Retrying in ${backoff}ms... (${retries} left)`);
            updateApiStatus(false, res.status, res.statusText); // Report degradation
            await new Promise(r => setTimeout(r, backoff));
            return fetchWithRetry(url, options, retries - 1, backoff * 2);
        }

        // Success (or 4xx which is technically a success for fetch, but handled downstream)
        if (res.ok) {
            updateApiStatus(true, res.status, res.statusText);
        } else {
            // 4xx or 5xx that ran out of retries
            updateApiStatus(false, res.status, res.statusText);
        }

        return res;
    } catch (err) {
        if (retries > 0) {
            console.warn(`[Network] Connection Failed fetching ${url}. Retrying in ${backoff}ms... (${retries} left). Error: ${err.message}`);
            await new Promise(r => setTimeout(r, backoff));
            return fetchWithRetry(url, options, retries - 1, backoff * 2);
        }
        // Final Failure
        updateApiStatus(false, 0, 'Offline');
        throw err;
    }
}

export async function fetchStops(options = {}) {
    return await fetchWithCache(`${API_BASE_URL}/stops`, {
        headers: { 'x-api-key': API_KEY },
        ...options
    });
}

export async function fetchRoutes(options = {}) {
    return await fetchWithCache(`${API_BASE_URL}/routes`, {
        headers: { 'x-api-key': API_KEY },
        ...options
    });
}

export async function fetchStopRoutes(stopId) {
    return await fetchWithCache(`${API_BASE_URL}/stops/${encodeURIComponent(stopId)}/routes?locale=en`, {
        headers: { 'x-api-key': API_KEY }
    });
}

// Metro (PisGateway V3)
export async function fetchMetroSchedule(routeId) {
    return await fetchWithCache(`${API_V3_BASE_URL}/routes/${encodeURIComponent(routeId)}/schedule?patternSuffix=0:01&locale=en`, {
        headers: { 'x-api-key': API_KEY }
    });
}

export async function fetchMetroSchedulePattern(routeId, patternSuffix) {
    return await fetchWithCache(`${API_V3_BASE_URL}/routes/${routeId}/schedule?patternSuffix=${patternSuffix}&locale=en`, {
        headers: { 'x-api-key': API_KEY }
    });
}

export async function fetchV3Routes() {
    // V3 Routes (often needed for full details)
    // Note: The main app uses v2 routes list, but fetches v3 details.
    // If we need a full v3 list, we'd use:
    return await fetchWithCache(`${API_V3_BASE_URL}/routes?locale=en`, {
        headers: { 'x-api-key': API_KEY }
    });
}

export async function fetchRouteDetailsV3(routeId) {
    return await fetchWithCache(`${API_V3_BASE_URL}/routes/${encodeURIComponent(routeId)}`, {
        headers: { 'x-api-key': API_KEY }
    });
}

export async function fetchRouteStopsV3(routeId, patternSuffix) {
    return await fetchWithCache(`${API_V3_BASE_URL}/routes/${encodeURIComponent(routeId)}/stops?patternSuffix=${encodeURIComponent(patternSuffix)}`, {
        headers: { 'x-api-key': API_KEY }
    });
}

export async function fetchBusPositionsV3(routeId, patternSuffix) {
    const response = await fetch(`${API_V3_BASE_URL}/routes/${encodeURIComponent(routeId)}/positions?patternSuffixes=${encodeURIComponent(patternSuffix)}`, {
        headers: { 'x-api-key': API_KEY }
    });
    if (!response.ok) throw new Error('Network response was not ok');
    return await response.json();
}

/**
 * Fetch polyline from V3 API
 * @param {string} routeId
 * @param {string} patternSuffixes - comma separated
 */
export async function fetchRoutePolylineV3(routeId, patternSuffixes) {
    const cacheKey = `/pis-gateway/api/v3/routes/${routeId}/polylines?patternSuffixes=${patternSuffixes}`;
    if (v3Cache.polylines.has(cacheKey)) {
        console.log('[Cache] Hit:', cacheKey);
        return v3Cache.polylines.get(cacheKey);
    }

    return enqueueV3Request(async () => {
        try {
            console.log('[Cache] Miss:', cacheKey);
            const res = await fetchWithRetry(`${API_V3_BASE_URL}/routes/${encodeURIComponent(routeId)}/polylines?patternSuffixes=${encodeURIComponent(patternSuffixes)}`, {
                headers: { 'x-api-key': API_KEY },
                credentials: 'omit'
            });

            if (!res.ok) throw new Error(`Polyline fetch failed: ${res.status}`);
            const data = await res.json();

            v3Cache.polylines.set(cacheKey, data);
            return data;
        } catch (error) {
            console.error('Failed to fetch polyline', error);
            throw error;
        }
    });
}

// Decodes Google Polyline Algorithm
export function decodePolyline(encoded) {
    let points = [];
    let index = 0, len = encoded.length;
    let lat = 0, lng = 0;

    while (index < len) {
        let b, shift = 0, result = 0;
        do {
            b = encoded.charCodeAt(index++) - 63;
            result |= (b & 0x1f) << shift;
            shift += 5;
        } while (b >= 0x20);
        let dlat = ((result & 1) ? ~(result >> 1) : (result >> 1));
        lat += dlat;

        shift = 0;
        result = 0;
        do {
            b = encoded.charCodeAt(index++) - 63;
            result |= (b & 0x1f) << shift;
            shift += 5;
        } while (b >= 0x20);
        let dlng = ((result & 1) ? ~(result >> 1) : (result >> 1));
        lng += dlng;

        points.push([lng * 1e-5, lat * 1e-5]);
    }
    return points;
}

/**
 * Fetch arrivals for a list of stop IDs in parallel.
 * @param {string[]} ids
 * @returns {Promise<Array>} Combined flat list of arrivals
 */
export async function fetchArrivalsForStopIds(ids) {
    const promises = ids.map(id =>
        fetch(`${API_BASE_URL}/stops/${encodeURIComponent(id)}/arrival-times?locale=en&ignoreScheduledArrivalTimes=false`, {
            headers: { 'x-api-key': API_KEY }
        }).then(res => {
            if (!res.ok) return [];
            return res.json();
        }).catch(err => {
            console.warn(`Failed to fetch arrivals for equivalent ID ${id}:`, err);
            return [];
        })
    );

    const results = await Promise.all(promises);
    return results.flat();
}

// Helper to manage V3 in-flight promises
const v3InFlight = {
    patterns: new Map(),
    schedules: new Map()
};

/**
 * Fetch V3 Schedule for a specific route and stop context
 * @param {string} routeId
 * @param {string[]} stopIds - List of equivalent stop IDs to match against patterns
 */
export async function fetchScheduleForStop(routeId, stopIds) {
    if (!routeId) return null;

    // 1. Get Patterns
    let patterns = v3Cache.patterns.get(routeId);

    // Try Local Storage for Patterns
    if (!patterns) {
        const lsKey = `v3_patterns_${routeId}`;
        try {
            const cached = await db.get(lsKey);
            if (cached) {
                const { timestamp, data } = cached;
                // Cache patterns for 7 days
                if (Date.now() - timestamp < 7 * 24 * 60 * 60 * 1000) {
                    patterns = data;
                    v3Cache.patterns.set(routeId, patterns);
                }
            }
        } catch (e) { /* ignore */ }
    }

    // Fetch if missing (with deduplication)
    if (!patterns) {
        if (v3InFlight.patterns.has(routeId)) {
            patterns = await v3InFlight.patterns.get(routeId);
        } else {
            const promise = (async () => {
                try {
                    // Use cache to support offline fallback
                    const routeData = await fetchWithCache(`${API_V3_BASE_URL}/routes/${routeId}?locale=en`, {
                        headers: { 'x-api-key': API_KEY },
                        credentials: 'omit'
                    });

                    if (routeData && routeData.patterns) {
                        const suffixes = routeData.patterns.map(p => p.patternSuffix).join(',');
                        // Retrieve detailed pattern stops
                        return await fetchWithCache(`${API_V3_BASE_URL}/routes/${routeId}/stops-of-patterns?patternSuffixes=${suffixes}&locale=en`, {
                            headers: { 'x-api-key': API_KEY },
                            credentials: 'omit'
                        });
                    }
                    return [];
                } catch (e) {
                    console.warn(`[Schedule] Failed to load patterns for ${routeId}:`, e);
                    return [];
                }
            })();


            v3InFlight.patterns.set(routeId, promise);
            try {
                patterns = await promise;
                if (patterns) {
                    v3Cache.patterns.set(routeId, patterns);
                    try {
                        await db.set(`v3_patterns_${routeId}`, {
                            timestamp: Date.now(),
                            data: patterns
                        });
                    } catch (e) { console.warn('LS Write Failed (Patterns)', e); }
                }
            } catch (e) {
                console.error(`[V3] Pattern fetch error for ${routeId}`, e);
            } finally {
                v3InFlight.patterns.delete(routeId);
            }
        }
    }

    if (!patterns) {
        console.warn(`[V3] No patterns loaded for ${routeId}`);
        return null;
    }

    // 2. Find Pattern containing Stop
    const stopEntry = patterns.find(p => {
        const pId = String(p.stop.id);
        const pCode = String(p.stop.code);
        return stopIds.some(targetId => {
            const targetStr = String(targetId);
            if (targetStr === pId) return true;
            if (targetStr.split(':')[1] === pCode) return true;
            return false;
        });
    });

    if (!stopEntry || !stopEntry.patternSuffixes.length) {
        console.warn(`[V3] Stop (or equivalents) not found in patterns for route ${routeId}`);
        return null;
    }

    const suffix = stopEntry.patternSuffixes[0];

    // 3. Fetch Schedule
    const cacheKey = `${routeId}:${suffix}`;
    let schedule = v3Cache.schedules.get(cacheKey);

    if (!schedule) {
        const lsKey = `v3_sched_${cacheKey}`;
        try {
            const cached = await db.get(lsKey);
            if (cached && (Date.now() - cached.timestamp < 24 * 60 * 60 * 1000)) {
                schedule = cached.data;
                v3Cache.schedules.set(cacheKey, schedule);
            }
        } catch (e) { /* ignore */ }
    }

    if (!schedule) {
        if (v3InFlight.schedules.has(cacheKey)) {
            schedule = await v3InFlight.schedules.get(cacheKey);
        } else {
            const promise = (async () => {
                const schRes = await fetch(`${API_V3_BASE_URL}/routes/${routeId}/schedule?patternSuffix=${suffix}&locale=en`, {
                    headers: { 'x-api-key': API_KEY },
                    credentials: 'omit'
                });
                if (!schRes.ok) throw new Error(`Schedule fetch failed: ${schRes.status}`);
                return await schRes.json();
            })();

            v3InFlight.schedules.set(cacheKey, promise);
            try {
                schedule = await promise;
                if (schedule) {
                    v3Cache.schedules.set(cacheKey, schedule);
                    try {
                        await db.set(`v3_sched_${cacheKey}`, {
                            timestamp: Date.now(),
                            data: schedule
                        });
                    } catch (e) { console.warn('LS Write Failed (Schedule)', e); }
                }
            } finally {
                v3InFlight.schedules.delete(cacheKey);
            }
        }
    }

    return schedule;
}
