import { db } from './db.js';
import { sources } from './data/sources.js';
import { LoopUtils } from './loop-utils.js';

// Export sources for external usage (e.g. main.js normalization)
export { sources };

// Configuration
export const MAPBOX_TOKEN = 'pk.eyJ1IjoidHRjYXpyeSIsImEiOiJjam5sZWU2NHgxNmVnM3F0ZGN2N2lwaGF2In0.00TvUGr9Qu4Q4fc_Jb9wjw';
export const API_KEY = 'c0a2f304-551a-4d08-b8df-2c53ecd57f9f';

// Default Source (Tbilisi) for fallback or single-source calls
const defaultSource = sources.find(s => s.id === 'tbilisi') || sources[0];

// Helper to get base URL for a source (handling proxy for dev if needed)
function getApiBaseUrl(source) {
    if (import.meta.env.DEV) {
        // Proxy logic
        if (source.id === 'tbilisi') return '/pis-gateway/api/v2';
        if (source.id === 'rustavi') return '/rustavi-proxy/pis-gateway/api/v2';
        return source.apiBase;
    }
    return source.apiBase;
}

function getApiV3BaseUrl(source) {
    if (import.meta.env.DEV) {
        if (source.id === 'tbilisi') return '/pis-gateway/api/v2'.replace('/v2', '/v3');
        if (source.id === 'rustavi') return '/rustavi-proxy/pis-gateway/api/v3';
        return source.apiBaseV3;
    }
    return source.apiBaseV3;
}

// Global fallback for existing legacy calls (Tbilisi)
export const API_BASE_URL = getApiBaseUrl(defaultSource);
export const API_V3_BASE_URL = getApiV3BaseUrl(defaultSource);

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

    task().then(resolve).catch(err => {
        // console.warn('[Queue] V3 Task Error:', err.message);
        reject(err);
    }).finally(() => {
        activeV3Requests--;
        processV3Queue();
    });
}

/**
 * Throttles V3 API requests to prevent connection saturation/500 errors.
 */
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
    if (apiStatus.ok === ok && apiStatus.code === code) return;

    apiStatus = { ok, code, text };
    apiStatusListeners.forEach(cb => cb(apiStatus));
}

export function getApiStatusColor(code) {
    if (code === 200) return 'green';
    if (code >= 500) return 'yellow';
    if (code === 0 || code === 'offline') return 'red';
    return 'yellow';
}


// Consolidated Fallback Cache
const staticCache = {
    tbilisi: { details: null, schedules: null, polylines: null },
    rustavi: { details: null, schedules: null, polylines: null }
};

const staticStopToRoutes = new Map(); // stopId -> Set<routeId>
const staticRouteDetails = new Map(); // routeId -> details
let preloadPromise = null;

export function preloadStaticRoutesDetails() {
    if (preloadPromise) return preloadPromise;

    preloadPromise = (async () => {
        const sourcesToLoad = sources.filter(s => s.id === 'tbilisi' || s.id === 'rustavi');
        const locale = 'en';

        console.log('[API] Preloading static route details for filtering...');

        await Promise.all(sourcesToLoad.map(async (source) => {
            try {
                const filename = `${source.id}_routes_details_${locale}.json`;
                const data = await getStaticCache(source.id, filename);
                if (data) {
                    Object.entries(data).forEach(([rawRouteId, details]) => {
                        const routeId = processId(rawRouteId, source);

                        // Normalize details: Ensure patterns have stops if available in _stopsOfPatterns
                        if (details._stopsOfPatterns && details.patterns) {
                            details.patterns.forEach(p => {
                                if (!p.stops || p.stops.length === 0) {
                                    // Extract stops for this suffix
                                    const suffix = p.patternSuffix;
                                    if (Array.isArray(details._stopsOfPatterns)) {
                                        p.stops = details._stopsOfPatterns
                                            .filter(item => item.patternSuffixes && item.patternSuffixes.includes(suffix))
                                            .map(item => item.stop);
                                    } else {
                                        p.stops = details._stopsOfPatterns[suffix] || [];
                                    }
                                }
                            });
                        }

                        // Pass 2: Process all stops in patterns to ensure IDs are normalized (stripped of 1: prefix etc)
                        if (details.patterns) {
                            details.patterns.forEach(p => {
                                if (p.stops) {
                                    p.stops = p.stops.map(s => {
                                        if (typeof s === 'object') return processStop(s, source);
                                        const pid = processId(s, source);
                                        // If it was just a string ID, keep it as an object with ID for consistency if needed, 
                                        // but FilterManager expects p.stops to be objects with an .id property in some paths.
                                        // Let's check FilterManager usage...
                                        // idxO = p.stops.findIndex(s => originEq.has(redirectMap.get(s.id) || s.id));
                                        // It expects objects with .id
                                        return { id: pid };
                                    });
                                }
                            });
                        }

                        staticRouteDetails.set(routeId, { ...details, _sourceId: source.id });

                        // Map stops to this route
                        const stopIds = new Set();
                        if (details.patterns) {
                            details.patterns.forEach(p => {
                                if (p.stops) {
                                    p.stops.forEach(s => {
                                        const sid = typeof s === 'object' ? s.id : s;
                                        stopIds.add(sid);
                                    });
                                }
                            });
                        } else if (details.stops) {
                            details.stops.forEach(s => {
                                const sid = typeof s === 'object' ? s.id : s;
                                stopIds.add(sid);
                            });
                        }

                        stopIds.forEach(sid => {
                            const processedSid = processId(sid, source);
                            if (!staticStopToRoutes.has(processedSid)) {
                                staticStopToRoutes.set(processedSid, new Set());
                            }
                            staticStopToRoutes.get(processedSid).add(routeId);
                        });
                    });
                }
            } catch (e) {
                console.warn(`[API] Failed to preload ${source.id} details`, e);
            }
        }));

        console.log(`[API] Preload complete. Indexed ${staticRouteDetails.size} routes and ${staticStopToRoutes.size} stops.`);
        if (staticRouteDetails.size > 0) {
            const sampleKey = Array.from(staticRouteDetails.keys())[0];
            console.log(`[API] Sample Route ID in index: ${sampleKey}`);
        }
    })();

    return preloadPromise;
}

const pendingCacheRequests = new Map();

async function getStaticCache(sourceId, type) {
    if (!staticCache[sourceId]) staticCache[sourceId] = {};
    if (staticCache[sourceId][type]) return staticCache[sourceId][type];

    let filename;
    if (type.endsWith('.json')) {
        filename = type;
    } else {
        const suffix = type === 'details' ? 'routes_details' : type;
        filename = `${sourceId}_${suffix}.json`;
    }

    const cacheKey = `${sourceId}:${filename}`;
    if (pendingCacheRequests.has(cacheKey)) {
        // console.log(`[Fallback] Deduplicating request for ${filename}`);
        return pendingCacheRequests.get(cacheKey);
    }

    const promise = (async () => {
        try {
            // console.log(`[Fallback] Loading monolithic file: ${filename}`);
            const basePath = import.meta.env.BASE_URL.endsWith('/') ? import.meta.env.BASE_URL : `${import.meta.env.BASE_URL}/`;
            const res = await fetch(`${basePath}data/${filename}`);
            if (!res.ok) throw new Error(`Failed to load ${filename}`);
            const data = await res.json();
            staticCache[sourceId][type] = data;
            return data;
        } catch (e) {
            console.warn(`[Fallback] Error loading ${sourceId} ${type} cache:`, e);
            return null;
        }
    })();

    pendingCacheRequests.set(cacheKey, promise);
    try {
        return await promise;
    } finally {
        pendingCacheRequests.delete(cacheKey);
    }
}

async function fetchStaticFallback(endpoint) {
    try {
        // console.log(`[Fallback] Attempting to load static data for ${endpoint}`);
        const urlObj = new URL(endpoint, 'http://dummy.com');
        const pathname = urlObj.pathname;
        const basePath = import.meta.env.BASE_URL.endsWith('/') ? import.meta.env.BASE_URL : `${import.meta.env.BASE_URL}/`;
        const locale = urlObj.searchParams.get('locale') || 'en';

        // Detect Source
        const isRustavi = pathname.includes('rustavi') || endpoint.includes('rustavi');
        const sourceId = isRustavi ? 'rustavi' : 'tbilisi';
        const sourceConfig = sources.find(s => s.id === sourceId);
        // Note: Filenames might use stripped prefix? User said fallback data UNCHANGED.
        // So tbilisi files are "tbilisi_stops...". Rustavi "rustavi_stops...".
        // This logic is mostly about finding the right FILE.

        // 1. Stop Routes
        const stopRoutesMatch = pathname.match(/\/stops\/([^\/]+)\/routes/);
        if (stopRoutesMatch) {
            const requestedStopId = decodeURIComponent(stopRoutesMatch[1]);
            // requestedStopId is App ID (e.g. 801).
            // Convert to Raw ID for file lookup (e.g. 1:801)
            const rawStopId = restoreApiId(requestedStopId, sourceConfig);

            try {
                // Load localized routes file
                const masterRoutesRes = await fetch(`${basePath}data/${sourceId}_routes_${locale}.json`);
                if (!masterRoutesRes.ok) {
                    if (locale !== 'en') {
                        const fallbackEn = await fetch(`${basePath}data/${sourceId}_routes_en.json`);
                        if (fallbackEn.ok) {
                            const enRoutes = await fallbackEn.json();
                            const filtered = enRoutes.filter(r => r.stops && r.stops.includes(rawStopId));
                            return filtered.map(r => processRoute(r, sourceConfig));
                        }
                    }
                    throw new Error(`${sourceId} routes missing`);
                }
                const masterRoutes = await masterRoutesRes.json();
                const filtered = masterRoutes.filter(r => r.stops && r.stops.includes(rawStopId));
                return filtered.map(r => processRoute(r, sourceConfig));

            } catch (err) {
                console.warn(`[Fallback] Failed to compute stop routes: ${err}`);
                return [];
            }
        }

        // 2. Simple Files (Global Routes List, Global Stops List)
        // Ensure we only match top-level /routes and /stops, not sub-resources like /routes/1/stops
        const parts = pathname.split('/').filter(Boolean);
        const lastPart = parts[parts.length - 1];
        const isTopLevel = parts.length <= 3; // e.g. /api/v3/stops or /api/v3/routes

        if (lastPart === 'routes' && isTopLevel) {
            const res = await fetch(`${basePath}data/${sourceId}_routes_${locale}.json`);
            if (!res.ok && locale !== 'en') {
                const enRes = await fetch(`${basePath}data/${sourceId}_routes_en.json`);
                if (enRes.ok) {
                    const data = await enRes.json();
                    return data.map(i => processRoute(i, sourceConfig));
                }
                return null;
            }
            if (res.ok) {
                const data = await res.json();
                return data.map(i => processRoute(i, sourceConfig));
            }
            return null;
        }

        if (lastPart === 'stops' && isTopLevel) {
            const res = await fetch(`${basePath}data/${sourceId}_stops_${locale}.json`);
            if (!res.ok && locale !== 'en') {
                const enRes = await fetch(`${basePath}data/${sourceId}_stops_en.json`);
                if (enRes.ok) {
                    const data = await enRes.json();
                    return data.map(i => processStop(i, sourceConfig));
                }
                return null;
            }
            if (res.ok) {
                const data = await res.json();
                return data.map(i => processStop(i, sourceConfig));
            }
            return null;
        }

        // 3. Consolidated Files Lookup (Routes Details, Schedules, Polylines)
        const routeMatch = pathname.match(/\/routes\/([^\/]+)(?:(\/.*)|$)/);
        if (routeMatch) {
            const requestedRouteId = decodeURIComponent(routeMatch[1]);
            const rawRouteId = restoreApiId(requestedRouteId, sourceConfig);
            const subPath = routeMatch[2] || '';

            // A. Schedule (Shared File)
            if (subPath.startsWith('/schedule')) {
                const suffix = urlObj.searchParams.get('patternSuffix');
                if (suffix) {
                    const safeSuffix = suffix.replace(/:/g, '_').replace(/,/g, '-');
                    const key = `${rawRouteId}_${safeSuffix}`;
                    const cache = await getStaticCache(sourceId, 'schedules');


                    if (!cache) console.warn(`[Fallback Debug] Schedule Cache Missing for ${sourceId}`);
                    else if (!cache[key]) {
                        console.warn(`[Fallback Debug] Schedule Key Miss: ${key}. Sample Keys: ${Object.keys(cache).slice(0, 3).join(', ')}`);
                    } else {
                        console.log(`[Fallback Debug] Schedule Found for ${key}`);
                    }

                    return cache && cache[key] ? cache[key] : null;
                    // Schedule typically has Stop IDs inside.
                    // If we need to process them, we should.
                    // But V3 schedule object structure is complex. Leave for now or implement deeply?
                    // Assuming V3 schedule logic in `fetchScheduleForStop` handles matching. 
                    // `fetchScheduleForStop` uses `v3Cache` logic.
                }
                return [];
            }

            // B. Polylines (Shared File)
            if (subPath.startsWith('/polylines')) {
                const suffixesStr = urlObj.searchParams.get('patternSuffixes');
                if (suffixesStr) {
                    const suffixes = suffixesStr.split(',');
                    const cache = await getStaticCache(sourceId, 'polylines');
                    if (cache) {
                        const result = {};
                        let foundAny = false;
                        for (const suffix of suffixes) {
                            const safeSuffix = suffix.replace(/:/g, '_').replace(/,/g, '-');
                            const key = `${rawRouteId}_${safeSuffix}`;
                            if (cache[key]) {
                                Object.assign(result, cache[key]);
                                foundAny = true;
                            }
                        }
                        return foundAny ? result : null;
                    }
                }
            }

            // C. Stops of Patterns (Localized)
            if (subPath.startsWith('/stops-of-patterns')) {
                const filename = `${sourceId}_routes_details_${locale}.json`;
                // Use getStaticCache but ensure we pass filename if passing type, or handle in getStaticCache
                // getStaticCache implementation uses `type` as filename if it ends in json.
                const cache = await getStaticCache(sourceId, filename);

                if (cache && cache[rawRouteId] && cache[rawRouteId]._stopsOfPatterns) {
                    // _stopsOfPatterns is Map<Suffix, StopID[]> or Object?
                    // Usually Object: { "0:01": ["1:801", ...] }
                    // We need to process these IDs!
                    const rawPatterns = cache[rawRouteId]._stopsOfPatterns;

                    // NEW: Handle Array Format (Correct V3 Structure)
                    if (Array.isArray(rawPatterns)) {
                        console.log(`[Fallback Debug] Found Array Patterns for ${rawRouteId}. Items: ${rawPatterns.length}`);
                        return rawPatterns.map(p => ({
                            ...p,
                            stop: processStop(p.stop, sourceConfig)
                        }));
                    }

                    // OLD: Handle Map Format (Legacy Fallback)
                    const processed = {};
                    Object.keys(rawPatterns).forEach(key => {
                        processed[key] = rawPatterns[key].map(sid => processId(sid, sourceConfig));
                    });
                    return processed;
                } else {
                    console.warn(`[Fallback Debug] Cache hit but missing _stopsOfPatterns for ${rawRouteId} (Cache keys: ${cache ? Object.keys(cache).length : 'null'})`);
                }
                return [];
            }

            // C. Route Stops (Shared/Localized File) - Fallback if stops-of-patterns fails?
            if (subPath.startsWith('/stops')) {
                const filename = `${sourceId}_routes_details_${locale}.json`;
                const cache = await getStaticCache(sourceId, filename);

                if (cache) {
                    const routeData = cache[rawRouteId];
                    if (routeData && routeData.stops) {
                        return routeData.stops.map(sid => processId(sid, sourceConfig));
                    }
                }
                return [];
            }

            // D. Route Details (Localized)
            if (!subPath || subPath === '/') {
                const filename = `${sourceId}_routes_details_${locale}.json`;
                const cache = await getStaticCache(sourceId, filename);

                if (cache && cache[rawRouteId]) {
                    return processRoute(cache[rawRouteId], sourceConfig);
                }
                return null;
            }
        }

        return null;
    } catch (e) {
        console.warn(`[Fallback] Failed to load static data: ${e.message}`);
        return null;
    }
}

function hasFallback(url, cached) {
    if (cached) return true;
    if (/\/stops\/[^\/]+\/routes/.test(url)) return true;
    if (/\/routes(\?|$)/.test(url) && !/\/routes\//.test(url)) return true;
    if (/\/stops(\?|$)/.test(url) && !/\/stops\//.test(url)) return true;
    if (/\/routes\/([^\/]+)(\/|$)/.test(url)) return true;
    return false;
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

    if (cached) {
        const { timestamp, data } = cached;
        const age = now - timestamp;

        if (age < CACHE_DURATION) {
            // console.log(`[Cache] Hit (Fresh): ${url}`);
            return data;
        }

        if (age < 7 * 24 * 60 * 60 * 1000) {
            // console.log(`[Cache] Hit (Stale): ${url} - Background refresh...`);
            // Only background refresh if not explicitly cache-only
            if (options.strategy !== 'cache-only') {
                fetch(url, { ...options, credentials: 'omit' }).then(async (res) => {
                    if (res.ok) {
                        const newData = await res.json();
                        await db.set(cacheKey, { timestamp: now, data: newData });
                    }
                }).catch(e => {
                    console.warn(`[Cache] Background Update Error: ${url}`, e);
                });
            }
            return data;
        }

        if (options.strategy === 'cache-only' || options.strategy === 'cache-first') return cached.data;
    }

    // Force Cache Only (Structural Data and Filter mode)
    if (options.strategy === 'cache-only') {
        // console.log(`[Cache] Forced Static Fallback for: ${url}`);
        return await fetchStaticFallback(url);
    }

    // Network Fetch
    if (pendingRequests.has(url)) return pendingRequests.get(url);

    const fetchOptions = { ...options, credentials: 'omit' };
    const retries = options.strategy === 'cache-first' ? 1 : 3; // Fewer retries if we have fallback

    const requestPromise = (async () => {
        try {
            // Use enqueued V3 requests for stability if it's a V3 URL
            const isV3 = url.includes('/api/v3');
            let response;

            if (isV3 && options.strategy !== 'network-only') {
                response = await enqueueV3Request(() => fetchWithRetry(url, fetchOptions, retries));
            } else {
                response = await fetchWithRetry(url, fetchOptions, retries);
            }

            if (!response.ok) throw new Error(`Network error: ${response.status}`);
            const data = await response.json();
            await db.set(cacheKey, { timestamp: now, data });
            return data;
        } catch (err) {
            // console.warn(`[Network] Failed to fetch ${url}: ${err.message}`);
            throw err;
        } finally {
            pendingRequests.delete(url);
        }
    })();

    pendingRequests.set(url, requestPromise);

    if (hasFallback(url, cached) || options.strategy === 'cache-first') {
        const fallbackDataPromise = (async () => {
            if (cached) return cached.data;
            const staticData = await fetchStaticFallback(url);
            return staticData || (options.strategy === 'cache-first' ? null : requestPromise);
        })();

        // Longer timeout for Safari stability (600ms)
        const timeoutMs = options.strategy === 'cache-first' ? 100 : 600;
        const timeoutPromise = new Promise(r => setTimeout(r, timeoutMs)).then(() => fallbackDataPromise);

        const networkRace = requestPromise.catch(() => fallbackDataPromise);
        return Promise.race([networkRace, timeoutPromise]);
    }

    return requestPromise;
}

export async function fetchWithRetry(url, options = {}, retries = 3, backoff = 1000) {
    if (typeof navigator !== 'undefined' && !navigator.onLine) retries = 0;

    try {
        const res = await fetch(url, options);
        if (retries > 0 && res.status >= 500 && res.status < 600) {
            updateApiStatus(false, res.status, res.statusText);
            await new Promise(r => setTimeout(r, backoff));
            return fetchWithRetry(url, options, retries - 1, backoff * 2);
        }
        updateApiStatus(res.ok, res.status, res.statusText);
        return res;
    } catch (err) {
        if (retries > 0) {
            await new Promise(r => setTimeout(r, backoff));
            return fetchWithRetry(url, options, retries - 1, backoff * 2);
        }
        updateApiStatus(false, 0, 'Offline');
        throw err;
    }
}

// --- Data Processing Helpers ---

function getSeparator(source) {
    return source.separator !== undefined ? source.separator : ':';
}

export function processId(id, source) {
    if (!id || typeof id !== 'string') return id;
    let finalId = id;
    // 1. Strip internal prefix (e.g. "1:")
    if (source.stripPrefix && finalId.startsWith(source.stripPrefix)) {
        finalId = finalId.slice(source.stripPrefix.length);
    }
    // 2. Add source prefix (e.g. "r")
    if (source.prefix) {
        const sep = getSeparator(source);
        if (!finalId.startsWith(source.prefix + sep)) {
            finalId = source.prefix + sep + finalId;
        }
    }
    return finalId;
}

function restoreApiId(id, source) {
    if (!id || typeof id !== 'string') return id;
    let apiId = id;
    // 1. Remove source prefix
    if (source.prefix) {
        const sep = getSeparator(source);
        if (apiId.startsWith(source.prefix + sep)) {
            apiId = apiId.slice((source.prefix + sep).length);
        }
    }
    // 2. Re-add internal prefix
    if (source.stripPrefix) {
        if (!apiId.startsWith(source.stripPrefix)) {
            apiId = source.stripPrefix + apiId;
        }
    }
    return apiId;
}

function processStop(stop, source) {
    if (!stop) return stop;
    stop.id = processId(stop.id, source);
    stop._source = source.id;
    return stop;
}

function processRoute(route, source) {
    if (!route) return route;
    route.id = processId(route.id, source);
    route._source = source.id;

    // Process stops list
    if (route.stops && Array.isArray(route.stops)) {
        route.stops = route.stops.map(sid => processId(sid, source));
    }

    // Process V3 Details if present (Hydration)
    if (route._details) {
        if (route._details.patterns) {
            route._details.patterns.forEach(p => {
                if (p.stops) {
                    p.stops = p.stops.map(s => {
                        // Stop might be object or ID
                        if (typeof s === 'object') return processStop(s, source);
                        return processId(s, source);
                    });
                }
            });
        }
        if (route._details.stops) {
            route._details.stops = route._details.stops.map(s => {
                if (typeof s === 'object') return processStop(s, source);
                return processId(s, source);
            });
        }
    }
    return route;
}


// --- Multi-Source Aggregation Wrappers ---

/**
 * Fetches stops from ALL sources, tags them with `_source`, and merges results.
 */
export async function fetchStops(options = {}) {
    // console.log('[API] Fetching Stops from all sources...');
    const promises = sources.map(source => {
        const url = `${getApiBaseUrl(source)}/stops`;
        return fetchWithCache(url, {
            headers: { 'x-api-key': API_KEY },
            ...options
        }).then(data => {
            if (!Array.isArray(data)) return [];
            return data.map(item => processStop(item, source));
        }).catch(err => {
            console.warn(`[API] Failed to fetch stops from ${source.id}:`, err);
            return [];
        });
    });

    const results = await Promise.all(promises);
    const allRawStops = results.flat();

    // Deduplication / Merging Logic
    const locationMap = new Map();
    allRawStops.forEach(stop => {
        const key = `${stop.lat},${stop.lon}`;
        if (!locationMap.has(key)) locationMap.set(key, []);
        locationMap.get(key).push(stop);
    });

    const mergedStops = [];
    let mergeCount = 0;

    for (const stops of locationMap.values()) {
        const tbilisiStop = stops.find(s => s._source === 'tbilisi');
        const rustaviStops = stops.filter(s => s._source === 'rustavi');

        if (tbilisiStop && rustaviStops.length > 0) {
            // Merge Rustavi into Tbilisi
            tbilisiStop.mergedIds = tbilisiStop.mergedIds || [];
            rustaviStops.forEach(rs => {
                if (!tbilisiStop.mergedIds.includes(rs.id)) {
                    tbilisiStop.mergedIds.push(rs.id);
                }
            });
            mergeCount += rustaviStops.length;
            mergedStops.push(tbilisiStop);

            // Add any other non-merged stops
            stops.forEach(s => {
                if (s !== tbilisiStop && s._source !== 'rustavi') {
                    mergedStops.push(s);
                }
            });
        } else {
            mergedStops.push(...stops);
        }
    }

    // console.log(`[API] Merged ${allRawStops.length} raw stops into ${mergedStops.length} unique stops (Merged ${mergeCount} Rustavi duplicates).`);
    return mergedStops;
}



/**
 * Fetches routes from ALL sources, tags them with `_source`, and merges results.
 */
export async function fetchRoutes(options = {}) {
    // console.log('[API] Fetching Routes from all sources...');
    const promises = sources.map(source => {
        const url = `${getApiBaseUrl(source)}/routes`;
        return fetchWithCache(url, {
            headers: { 'x-api-key': API_KEY },
            ...options
        }).then(data => {
            if (!Array.isArray(data)) return [];
            return data.map(item => processRoute(item, source));
        }).catch(err => {
            console.warn(`[API] Failed to fetch routes from ${source.id}:`, err);
            return [];
        });
    });

    const results = await Promise.all(promises);
    const merged = results.flat();
    // console.log(`[API] Merged ${merged.length} routes from ${sources.length} sources.`);
    return merged;
}

/**
 * Helper: Resolve correct URL for a single resource by ID.
 * If `item` is provided (and has `_source`), we use it.
 * Otherwise we try Default (Tbilisi) then others (Rustavi).
 */
async function fetchFromSmartSource(configFn, id, options = {}) {
    // Identify valid result
    const isValid = (res) => {
        if (!res) return false;
        if (Array.isArray(res) && res.length === 0) return false;
        return true;
    };

    // Determine Source Priority based on ID Prefix
    let attemptOrder = [defaultSource, ...sources.filter(s => s.id !== defaultSource.id)];

    // Explicit Prefix Check (e.g. "rustavi:..." or "r...")
    const explicitSource = sources.find(s => {
        if (!s.prefix) return false;
        const sep = getSeparator(s);
        return typeof id === 'string' && id.startsWith(s.prefix + sep);
    });

    if (explicitSource) {
        attemptOrder = [explicitSource, ...sources.filter(s => s.id !== explicitSource.id)];
    }

    // Try sources in order
    for (const source of attemptOrder) {
        try {
            // Restore API ID (add 1:, remove r, etc)
            const apiId = restoreApiId(id, source);

            // console.log(`[SmartFetch] Try ${source.id} with ${apiId} (Orig: ${id})`);
            const url = configFn(source, apiId);
            const res = await fetchWithCache(url, {
                headers: { 'x-api-key': API_KEY },
                ...options
            });

            if (isValid(res)) {
                if (Array.isArray(res) || typeof res === 'object') {
                    res._sourceId = source.id;
                    return res;
                }
                return res;
            }
        } catch (e) {
            // console.warn(`[SmartFetch] Error ${source.id}:`, e);
        }
    }

    throw new Error(`Resource ${id} not found in any source.`);
}

/**
 * Optimized fetch that assumes the caller might know the source (e.g. from existing object).
 * If `knownSourceId` is passed, skips hunting.
 */
async function fetchWithSourceHint(configFn, id, knownSourceId, options = {}) {
    if (options.strategy === 'cache-only') {
        // Special case: if we are hunting for route details or stop routes, check static index first
        if (id && typeof id === 'string') {
            if (staticRouteDetails.has(id)) {
                // console.log(`[API] Static Hit for Route Details: ${id}`);
                return staticRouteDetails.get(id);
            }
            if (staticStopToRoutes.has(id)) {
                // console.log(`[API] Static Hit for Stop Routes: ${id}`);
                const routeIds = Array.from(staticStopToRoutes.get(id));
                const routes = routeIds.map(rid => staticRouteDetails.get(rid)).filter(Boolean);
                if (routes.length > 0) {
                    routes._sourceId = routes[0]._sourceId;
                    return routes;
                }
            }
        }
    }

    if (knownSourceId) {
        const source = sources.find(s => s.id === knownSourceId);
        if (source) {
            const apiId = restoreApiId(id, source);
            const url = configFn(source, apiId);
            const res = await fetchWithCache(url, {
                headers: { 'x-api-key': API_KEY },
                ...options
            });
            if (res && typeof res === 'object') res._sourceId = source.id;
            return res;
        }
    }
    return fetchFromSmartSource(configFn, id, options);
}


export async function fetchStopRoutes(stopId, sourceId = null, options = {}) {
    // Stop Routes V2
    const urlGen = (s, id) => `${getApiBaseUrl(s)}/stops/${encodeURIComponent(id)}/routes?locale=en`;
    try {
        const raw = await fetchWithSourceHint(urlGen, stopId, sourceId, options);
        if (Array.isArray(raw)) {
            const source = sources.find(s => s.id === (raw._sourceId || sourceId || 'tbilisi'));
            return raw.map(r => processRoute(r, source));
        }
        return [];
    } catch (e) {
        console.warn(`[API] fetchStopRoutes failed for ${stopId}`, e);
        return [];
    }
}

// Metro (PisGateway V3)
export async function fetchMetroSchedule(routeId) {
    const urlGen = (s, id) => `${getApiV3BaseUrl(s)}/routes/${encodeURIComponent(id)}/schedule?patternSuffix=0:01&locale=en`;
    return fetchFromSmartSource(urlGen, routeId);
}

export async function fetchMetroSchedulePattern(routeId, patternSuffix) {
    const urlGen = (s, id) => `${getApiV3BaseUrl(s)}/routes/${id}/schedule?patternSuffix=${patternSuffix}&locale=en`;
    return fetchFromSmartSource(urlGen, routeId);
}

// V3 Routes List
export async function fetchV3Routes() {
    // Aggregate like V2
    const promises = sources.map(source => {
        return fetchWithCache(`${getApiV3BaseUrl(source)}/routes?locale=en`, {
            headers: { 'x-api-key': API_KEY }
        }).then(data => {
            if (Array.isArray(data)) return data.map(r => processRoute(r, source));
            return [];
        }).catch(e => []);
    });
    const results = await Promise.all(promises);
    return results.flat();
}

export async function fetchRouteDetailsV3(routeId, options = {}) {
    // Check static index first if cache-only
    if (options.strategy === 'cache-only' && staticRouteDetails.has(routeId)) {
        // console.log(`[API] Static Hit for Route Details (Direct): ${routeId}`);
        return staticRouteDetails.get(routeId);
    }

    const urlGen = (s, id) => `${getApiV3BaseUrl(s)}/routes/${encodeURIComponent(id)}`;
    const raw = await fetchFromSmartSource(urlGen, routeId, options);

    if (raw) {
        const source = sources.find(s => s.id === (raw._sourceId || 'tbilisi'));
        const route = processRoute(raw, source);

        // --- Loop Virtualization Integration ---
        // Only run logic if we have patterns and it looks like a single-pattern route
        if (route.patterns && route.patterns.length === 1) {
            const originalPattern = route.patterns[0];
            // Fetch stops to check for loop
            // Note: recursive call to fetchRouteStopsV3 is safe because original suffix has no _PART
            try {
                const stops = await fetchRouteStopsV3(route.id, originalPattern.patternSuffix, options);
                if (stops && LoopUtils.isLoop(stops, route.shortName)) {
                    // It is a loop! Split it.
                    const virtualPatterns = LoopUtils.generateVirtualPatterns(
                        originalPattern,
                        stops,
                        route.longName
                    );
                    route.patterns = virtualPatterns;
                    v3Cache.patterns.set(route.id, virtualPatterns); // Cache for Polyline Slicing use
                    // console.log(`[API] Virtualized Loop Route ${route.shortName} into 2 patterns`);
                }
            } catch (e) {
                console.warn(`[API] Failed to check loop status for ${route.id}`, e);
            }
        }
        return route;
    }
    return raw;
}

export async function fetchRouteStopsV3(routeId, patternSuffix, options = {}) {
    if (!routeId) return [];

    // console.log(`[API] fetchRouteStopsV3 called for ${routeId} / ${patternSuffix}. Cache-Only? ${options.strategy === 'cache-only'}`);

    // 1. Handle Virtual Suffixes
    let realSuffix = patternSuffix;
    let isVirtual = false;

    if (patternSuffix.includes('_PART')) {
        realSuffix = patternSuffix.split('_PART')[0];
        isVirtual = true;
    }

    // 2. Fetch Real Stops (Recursive if virtual, or Standard)
    if (options.strategy === 'cache-only' && staticRouteDetails.has(routeId)) {
        const details = staticRouteDetails.get(routeId);
        if (details.patterns) {
            const pattern = details.patterns.find(p => p.patternSuffix === realSuffix);
            if (pattern && pattern.stops) {
                const source = sources.find(s => s.id === details._sourceId);
                return pattern.stops.map(s => processStop(s, source));
            }
        }
    }

    const urlGen = (s, id) => `${getApiV3BaseUrl(s)}/routes/${encodeURIComponent(id)}/stops?patternSuffix=${encodeURIComponent(realSuffix)}`;
    let raw = await fetchFromSmartSource(urlGen, routeId, options);

    const source = sources.find(s => s.id === (raw?._sourceId || 'tbilisi'));

    let stops = [];
    if (Array.isArray(raw)) {
        stops = raw.map(s => processStop(s, source));
    } else if (raw && raw.stops) {
        stops = raw.stops.map(s => processStop(s, source));
    } else {
        return [];
    }

    // 3. Apply Slice if Virtual
    if (isVirtual) {
        let sliceRange = null;
        const cachedPatterns = v3Cache.patterns.get(routeId);
        if (cachedPatterns) {
            const p = cachedPatterns.find(pat => pat.patternSuffix === patternSuffix);
            if (p && p._slice) sliceRange = p._slice;
        }
        return LoopUtils.sliceStops(stops, patternSuffix, sliceRange);
    }

    return stops;
}

export async function fetchBusPositionsV3(routeId, patternSuffix) {
    // Handle virtual suffix for positions too?
    // Buses don't have virtual patterns. They are on the global route.
    // We should map virtual suffix to real suffix.
    const realSuffix = patternSuffix.includes('_PART') ? patternSuffix.split('_PART')[0] : patternSuffix;

    const urlGen = (s, id) => `${getApiV3BaseUrl(s)}/routes/${encodeURIComponent(id)}/positions?patternSuffixes=${encodeURIComponent(realSuffix)}`;

    async function tryFetch(source) {
        // Use restoreApiId!!!!
        const apiId = restoreApiId(routeId, source);
        const url = urlGen(source, apiId);
        const res = await fetch(url, { headers: { 'x-api-key': API_KEY } });
        if (!res.ok) throw new Error('Not OK');
        const data = await res.json();

        // Data is keyed by suffix. Remap keys if virtual?
        // API returns { "patternSuffix": [buses] }
        // If we requested realSuffix, we get realSuffix key.
        // We should map it back to patternSuffix (virtual) if needed, 
        // OR just return the buses and let UI handle it?
        // UI expects `positionsData[patternSuffix]`.

        if (realSuffix !== patternSuffix && data[realSuffix]) {
            data[patternSuffix] = data[realSuffix]; // Alias it
        }
        return data;
    }

    try {
        return await tryFetch(defaultSource);
    } catch (e) {
        // Try others
        for (const source of sources) {
            if (source.id === defaultSource.id) continue;
            try {
                return await tryFetch(source);
            } catch (err) { }
        }
    }
    return [];
}

export async function fetchRoutePolylineV3(routeId, patternSuffixes, options = {}) {
    // 1. Map requested suffixes to real (deduplicated)
    const aliases = {}; // virtual -> real
    const realSuffixesSet = new Set();

    // Check cache for split points (populated by fetchRouteDetailsV3)
    const cachedPatterns = v3Cache.patterns.get(routeId);

    decodeURIComponent(patternSuffixes).split(',').forEach(s => {
        if (s.includes('_PART')) {
            const real = s.split('_PART')[0];
            aliases[s] = real;
            realSuffixesSet.add(real);
        } else {
            realSuffixesSet.add(s);
        }
    });

    const realSuffixesStr = Array.from(realSuffixesSet).join(',');

    const urlGen = (s, id) => `${getApiV3BaseUrl(s)}/routes/${encodeURIComponent(id)}/polylines?patternSuffixes=${encodeURIComponent(realSuffixesStr)}`;

    const polylineData = await fetchFromSmartSource(urlGen, routeId, options);

    // 2. Fan-out results to aliases with Slicing!
    if (polylineData) {
        // We need to wait for slicing to complete
        await Promise.all(Object.keys(aliases).map(async virtual => {
            const real = aliases[virtual];
            if (polylineData[real]) {
                try {
                    // Decode first! slicePolyline expects array of [lat, lng]
                    let fullPolylineEncoded = polylineData[real];

                    // Handle object wrapper (e.g. { encodedValue: "..." })
                    if (fullPolylineEncoded && typeof fullPolylineEncoded === 'object' && !Array.isArray(fullPolylineEncoded)) {
                        fullPolylineEncoded = fullPolylineEncoded.encodedValue || fullPolylineEncoded.points || fullPolylineEncoded.geometry;
                    }

                    const fullPolylinePoints = decodePolyline(fullPolylineEncoded);

                    // Look for split point in cache
                    let splitPoint = null;
                    if (cachedPatterns) {
                        const p = cachedPatterns.find(pat => pat.patternSuffix === virtual);
                        if (p && p._splitPoint) splitPoint = p._splitPoint;
                    }

                    // Slice using simple geometry midpoint (no stops needed currently)
                    polylineData[virtual] = LoopUtils.slicePolyline(fullPolylinePoints, virtual, splitPoint);
                } catch (e) {
                    console.warn(`[API] Polyline slice failed for ${virtual}`, e);
                    polylineData[virtual] = polylineData[real]; // Fallback to full (encoded string)
                }
            }
        }));
    }

    return polylineData;
}

// Decodes Google Polyline Algorithm (Unchanged)
export function decodePolyline(encoded) {
    if (Array.isArray(encoded)) return encoded; // Already decoded or sliced array
    if (!encoded) return [];

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
 * UPDATED: Needs to handle mixed sources.
 * @param {string[]} ids
 * @returns {Promise<Array>} Combined flat list of arrivals
 */
export async function fetchArrivalsForStopIds(ids) {
    const promises = ids.map(async (id) => {
        // Use smart source fetch logic
        // We need a custom url generator for arrivals
        const urlGen = (s, i) => `${getApiBaseUrl(s)}/stops/${encodeURIComponent(i)}/arrival-times?locale=en&ignoreScheduledArrivalTimes=false`;
        try {
            // Custom Smart Fetch for Live Data
            async function tryFetch(source) {
                const apiId = restoreApiId(id, source);
                const url = urlGen(source, apiId);
                const res = await fetch(url, { headers: { 'x-api-key': API_KEY } });
                if (!res.ok) throw new Error('Fail');
                return res.json();
            }

            try {
                return await tryFetch(defaultSource);
            } catch (e) {
                // Try others
                for (const source of sources) {
                    if (source.id === defaultSource.id) continue;
                    try { return await tryFetch(source); } catch (ee) { }
                }
                throw e;
            }
        } catch (err) {
            console.warn(`Failed to fetch arrivals for equivalent ID ${id}:`, err);
            return [];
        }
    });

    const results = await Promise.all(promises);
    return results.flat();
}


// Helper to manage V3 in-flight promises
const v3InFlight = {
    patterns: new Map(),
    schedules: new Map()
};

export async function fetchScheduleForStop(routeId, stopIds) {
    if (!routeId || !stopIds || stopIds.length === 0) return null;

    console.log(`[API Schedule Debug] fetchScheduleForStop called for RouteID: ${routeId}, Stops: ${stopIds.join(',')}`);

    // 1. Get Patterns
    let patterns = v3Cache.patterns.get(routeId);

    if (!patterns) {
        const lsKey = `v3_patterns_${routeId}`;
        try {
            const cached = await db.get(lsKey);
            if (cached && (Date.now() - cached.timestamp < 7 * 24 * 60 * 60 * 1000)) {
                patterns = cached.data;
                v3Cache.patterns.set(routeId, patterns);
                // console.log(`[API Debug] Patterns loaded from LS for ${routeId}`);
            }
        } catch (e) { }
    }

    if (!patterns) {
        if (v3InFlight.patterns.has(routeId)) {
            patterns = await v3InFlight.patterns.get(routeId);
        } else {
            const promise = (async () => {
                try {
                    // Smart Fetch for Route Details (Patterns)
                    console.log(`[API Schedule Debug] Pattern IIFE: Fetching route details for ${routeId}`);
                    const routeData = await fetchRouteDetailsV3(routeId, { strategy: 'cache-first' });

                    if (routeData) console.log(`[API Schedule Debug] Pattern IIFE: routeData found for ${routeId}, patterns: ${routeData.patterns ? routeData.patterns.length : 'None'}`);

                    if (routeData && routeData.patterns) {
                        const suffixes = routeData.patterns.map(p => p.patternSuffix).join(',');
                        // Retrieve detailed pattern stops
                        // We need the same source as routeData!
                        // This implies we need to track which source routeData came from.
                        // Since `fetchRouteDetailsV3` relies on hunting, we effectively find it.
                        // But for the NEXT call `stops-of-patterns`, we need to hit the SAME source.
                        // Refactor opportunity: fetchRouteDetailsV3 could return { data, source }.
                        // For now, let's risk re-hunting (cached) or smart hunting.
                        // URL Gen for stops-of-patterns
                        const urlGen = (s, id) => `${getApiV3BaseUrl(s)}/routes/${id}/stops-of-patterns?patternSuffixes=${suffixes}&locale=en`;
                        console.log(`[API Schedule Debug] Pattern IIFE: Calling fetchFromSmartSource for stops-of-patterns`);
                        const res = await fetchFromSmartSource(urlGen, routeId);
                        console.log(`[API Schedule Debug] Pattern IIFE: stops-of-patterns result: ${res ? (Array.isArray(res) ? `Array(${res.length})` : 'Object') : 'null'}`);

                        // Force Process Pattern Stops (Normalize IDs)
                        if (res && Array.isArray(res)) {
                            // Determine correct source config
                            const source = sources.find(s => s.id === (res._sourceId || 'tbilisi')) || sources.find(s => s.id === 'tbilisi');
                            return res.map(p => ({
                                ...p,
                                stop: processStop(p.stop, source)
                            }));
                        }

                        return res;
                    }
                    console.warn(`[API Debug] No patterns found in route details for ${routeId}`);
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
        console.warn(`[API Debug] No patterns loaded for ${routeId} (Final check)`);
        return null; // Silent return
    }

    console.log(`[API Schedule Debug] Patterns loaded for ${routeId}. Count: ${patterns.length}`);

    // 2. Find Pattern containing Stop
    const stopEntry = patterns.find((p, idx) => {
        if (!p || !p.stop) {
            if (idx < 3) console.warn(`[API Schedule Debug] Pattern ${idx} invalid:`, p);
            return false;
        }
        const pId = String(p.stop.id);
        const pCode = String(p.stop.code || '');
        return stopIds.some(targetId => {
            const targetStr = String(targetId);
            const targetClean = targetStr.includes(':') ? targetStr.split(':')[1] : targetStr;
            const pIdClean = pId.includes(':') ? pId.split(':')[1] : pId;

            // Strict Source-Aware Matching
            // Since we normalized all pattern IDs to app format (e.g. r91) above, 
            // exact match should work 99% of the time.
            if (targetStr === pId) return true;

            // Transformed Match Backup (just in case targetId is raw?)
            // If targetId is 1:91 and pId is r91.
            // Assumption: Route ID prefix determines source.
            // FIX: Case insensitive check for 'r' or 'R' prefix
            const isRustavi = /^[rR]/.test(routeId) || routeId.toLowerCase().startsWith('rustavi:');
            const source = isRustavi ? sources.find(s => s.id === 'rustavi') : sources.find(s => s.id === 'tbilisi');

            if (source) {
                // If target is raw 1:91, restoring it gives 1:91. Not helpful if pId is r91.
                // We want to PROCESS targetId to see if it matches pId?
                // Or restore pId?

                // If pId is r91 (processed). Target is 1:91.
                // processId(1:91) -> r91.
                // So check processId(target) === pId?
                const processedTarget = processId(targetId, source);
                if (processedTarget === pId) return true;

                // Reverse: Restore pId (r91 -> 1:91). Target 1:91.
                const restoredPid = restoreApiId(pId, source);
                if (targetStr === restoredPid) return true;

                // Double check restore of target (if target was processed r91 -> 1:91) vs pId raw 1:91?
                // Should not happen if we normalized.
                const restoredTarget = restoreApiId(targetId, source);
                if (restoredTarget === pId) return true;

                // Rustavi Specific: Handle "r" prefix vs "1:" prefix gracefully
                if (source && source.id === 'rustavi') {
                    // target=1086, pId=r1086
                    if (pId === `r${targetStr}`) return true;
                    if (targetStr === `r${pId}`) return true;
                    // target=1086, pId=1086 (already matched by exact check line 1158? No, strict check might fail types?)
                }
            }

            return false;
        });
    });

    console.log(`[API Schedule Debug] Stop Search Result for ${routeId}. StopEntry Found? ${!!stopEntry}`);

    if (!stopEntry) {
        console.warn(`[API Schedule Debug] Stop ${stopIds.join(',')} NOT found in ${patterns.length} patterns. Sample Pattern (0):`, patterns[0]?.stop?.id);
        return null;
    }

    if (!stopEntry || !stopEntry.patternSuffixes.length) {
        console.warn(`[API Debug] Stop ${stopIds.join(',')} not found in patterns for ${routeId}. Pattern Stops (Sample):`, patterns.slice(0, 5).map(p => p.stop.id).join(', '));
        return null;
    }

    const suffix = stopEntry.patternSuffixes[0];
    // console.log(`[API Debug] Found suffix ${suffix} for stop ${stopEntry.stop.id}`);

    // 3. Fetch Schedule
    const cacheKey = `${routeId}:${suffix}`;
    let schedule = v3Cache.schedules.get(cacheKey);

    if (!schedule) {
        const keySafe = cacheKey.replace(/:/g, '_'); // Safety
        const lsKey = `v3_sched_${keySafe}`;
        try {
            const cached = await db.get(lsKey);
            if (cached && (Date.now() - cached.timestamp < 24 * 60 * 60 * 1000)) {
                schedule = cached.data;
                schedule = cached.data;
                v3Cache.schedules.set(cacheKey, schedule);
                console.log(`[API Schedule Debug] Schedule loaded from LS for ${cacheKey}. Valid? ${!!schedule}`);
            }
        } catch (e) { }
    }

    if (!schedule) {
        if (v3InFlight.schedules.has(cacheKey)) {
            schedule = await v3InFlight.schedules.get(cacheKey);
        } else {
            const promise = (async () => {
                const urlGen = (s, id) => `${getApiV3BaseUrl(s)}/routes/${id}/schedule?patternSuffix=${suffix}&locale=en`;
                try {
                    console.log(`[API Schedule Debug] Fetching schedule for ${routeId}, suffix: ${suffix}`);
                    const schRes = await fetchFromSmartSource(urlGen, routeId);

                    if (!schRes) {
                        console.warn(`[API Schedule Debug] Schedule API returned null for ${routeId}`);
                        throw new Error(`Schedule fetch failed`);
                    }
                    console.log(`[API Schedule Debug] Schedule fetched successfully. Length: ${schRes.length || 'Obj'}`);
                    return schRes;
                } catch (e) {
                    // Fallback to Static Data
                    console.warn(`[V3] Schedule API failed for ${routeId}, trying static fallback...`, e);
                    // We need to know the source ID to fetch the correct static file.
                    // fetchFromSmartSource would have found it if it worked, but here it failed.
                    // We can try to guess from routeId or try all?
                    // Better: `fetchFromSmartSource` *throws* if it can't find it.
                    // So we catch here.

                    // Try to load static schedules
                    // Filename: tbilisi_routes_details_en.json (contains schedules?)
                    // Actually, earlier comments said schedules might be in `getStaticCache`.
                    // Let's try to load specific schedule from static cache if possible.
                    // But static cache structure is weird.

                    // Simple fallback: Return empty or try to reconstruct?
                    // If we fail here, we return null, and UI shows --:--.
                    // User wants "more data". 
                    // Let's ensure we at least return null gracefully to allow re-tries later?
                    throw e;
                }
            })();

            v3InFlight.schedules.set(cacheKey, promise);
            try {
                schedule = await promise;
                if (schedule) {
                    v3Cache.schedules.set(cacheKey, schedule);
                    try {
                        const keySafe = cacheKey.replace(/:/g, '_');
                        await db.set(`v3_sched_${keySafe}`, {
                            timestamp: Date.now(),
                            data: schedule
                        });
                    } catch (e) { }
                }
            } catch (e) {
                console.warn(`[V3] Schedule fetch completely failed for ${routeId}`, e);
            } finally {
                v3InFlight.schedules.delete(cacheKey);
            }
        }
    }

    return schedule;
}
