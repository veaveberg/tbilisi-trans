import { db } from './db.js';
import { sources } from './data/sources.js';
import { RouteGeometry } from './route-geometry.js';

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
    stopPatterns: new Map(), // routeId -> patterns (lightweight, with stops)
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
    // Avoid marking "Offline" for transient 500s that might be rate limits or temporary instability
    if (!ok && code >= 500 && code < 600) {
        // Just log, don't kill the green dot yet unless it persists
        console.warn(`[API] Transient Server Error ${code}: ${text}`);
    }

    if (apiStatus.ok === ok && apiStatus.code === code) return;

    apiStatus = { ok, code, text };
    apiStatusListeners.forEach(cb => cb(apiStatus));
}

export function getApiStatusColor(code) {
    if (code === 200) return 'green';
    if (code >= 500) return 'yellow'; // Show warning for server errors
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

export function invalidateRouteCache(routeId) {
    if (routeId) {
        staticRouteDetails.delete(routeId);
        // Also clear v3Cache entries if any
        v3Cache.patterns.delete(routeId);
        v3Cache.stopPatterns.delete(routeId);
        console.log(`[API] Invalidated cache for route: ${routeId}`);
    } else {
        staticRouteDetails.clear();
        v3Cache.patterns.clear();
        v3Cache.stopPatterns.clear();
    }
}

export async function clearAllCaches() {
    console.log('[API] Clearing all IndexedDB caches...');
    try {
        await db.clear();
        invalidateRouteCache();
        console.log('[API] Caches cleared successfully.');
        return true;
    } catch (e) {
        console.error('[API] Failed to clear caches:', e);
        return false;
    }
}

// Expose to window for manual debugging
window.clearAppCaches = clearAllCaches;
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
        window.dispatchEvent(new CustomEvent('static-routes-loaded')); // Trigger UI update if needed
        if (staticRouteDetails.size > 0) {
            const sampleKey = Array.from(staticRouteDetails.keys())[0];
            console.log(`[API] Sample Route ID in index: ${sampleKey}`);
        }
    })();

    return preloadPromise;
}

/**
 * Returns a list of route IDs that pass through the given stop, using the preloaded static index.
 */
export function getRoutesForStopStatic(stopId) {
    if (!stopId) return [];

    // Normalize stopId just in case
    const tbilisiSource = sources.find(s => s.id === 'tbilisi');
    const normId = processId(stopId, tbilisiSource);

    const routeIds = staticStopToRoutes.get(normId) || staticStopToRoutes.get(stopId);
    if (!routeIds) return [];

    return Array.from(routeIds);
}

/**
 * Get cached static route details by ID (e.g. 1:123 or 123)
 */
export function getStaticRouteDetails(routeId) {
    if (!routeId) return null;
    // Try provided ID
    if (staticRouteDetails.has(String(routeId))) return staticRouteDetails.get(String(routeId));

    // Try finding normalized
    // If routeId is 'R835' but map has '1:R835' or vice versa
    for (const key of staticRouteDetails.keys()) {
        const normKey = key.replace(/^\d+:/, '').replace(/^r/, '');
        const normId = String(routeId).replace(/^\d+:/, '').replace(/^r/, '');
        if (normKey === normId) return staticRouteDetails.get(key);
    }
    return null;
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
        const urlObj = new URL(endpoint, 'http://dummy.com');
        const pathname = urlObj.pathname;
        const basePath = import.meta.env.BASE_URL.endsWith('/') ? import.meta.env.BASE_URL : `${import.meta.env.BASE_URL}/`;
        const locale = urlObj.searchParams.get('locale') || 'en'; // Detect Source
        // Explicitly check for Rustavi in URL or ID prefix
        let isRustavi = pathname.includes('rustavi') || endpoint.includes('rustavi');

        // Secondary check: ID prefix if available
        const stopMatch = pathname.match(/\/stops\/([^\/]+)/);
        const idRouteMatch = pathname.match(/\/routes\/([^\/]+)/);
        const idInUrl = (stopMatch ? stopMatch[1] : (idRouteMatch ? idRouteMatch[1] : ''));
        if (decodeURIComponent(idInUrl).startsWith('r')) isRustavi = true;

        const sourceId = isRustavi ? 'rustavi' : 'tbilisi';
        const sourceConfig = sources.find(s => s.id === sourceId);

        const stopRoutesMatch = pathname.match(/\/stops\/([^\/]+)\/routes/);
        if (stopRoutesMatch) {
            const requestedStopId = decodeURIComponent(stopRoutesMatch[1]);
            // For normalized local data, use the app ID directly
            // Also try API format for backwards compatibility
            const appStopId = processId(requestedStopId, sourceConfig);
            const apiStopId = restoreApiId(requestedStopId, sourceConfig);

            try {
                const masterRoutesRes = await fetch(`${basePath}data/${sourceId}_routes_${locale}.json`);
                if (!masterRoutesRes.ok) {
                    if (locale !== 'en') {
                        const fallbackEn = await fetch(`${basePath}data/${sourceId}_routes_en.json`);
                        if (fallbackEn.ok) {
                            const enRoutes = await fallbackEn.json();
                            const res = enRoutes.filter(r => r.stops && (
                                r.stops.includes(appStopId) ||
                                r.stops.includes(apiStopId) ||
                                r.stops.includes(requestedStopId)
                            )).map(r => processRoute(r, sourceConfig));
                            res._sourceId = sourceId;
                            return res;
                        }
                    }
                    throw new Error(`${sourceId} routes missing`);
                }
                const masterRoutes = await masterRoutesRes.json();
                const res = masterRoutes.filter(r => r.stops && (
                    r.stops.includes(appStopId) ||
                    r.stops.includes(apiStopId) ||
                    r.stops.includes(requestedStopId)
                )).map(r => processRoute(r, sourceConfig));
                res._sourceId = sourceId;
                return res;

            } catch (err) {
                console.warn(`[Fallback] Failed to compute stop routes: ${err}`);
                return [];
            }
        }

        const parts = pathname.split('/').filter(Boolean);
        const lastPart = parts[parts.length - 1];
        const isTopLevel = parts.length <= 3;

        if (lastPart === 'routes' && isTopLevel) {
            const res = await fetch(`${basePath}data/${sourceId}_routes_${locale}.json`);
            if (!res.ok && locale !== 'en') {
                const enRes = await fetch(`${basePath}data/${sourceId}_routes_en.json`);
                if (enRes.ok) {
                    const data = await enRes.json();
                    const result = data.map(i => processRoute(i, sourceConfig));
                    result._sourceId = sourceId;
                    return result;
                }
                return null;
            }
            if (res.ok) {
                const data = await res.json();
                const result = data.map(i => processRoute(i, sourceConfig));
                result._sourceId = sourceId;
                return result;
            }
            return null;
        }

        if (lastPart === 'stops' && isTopLevel) {
            const res = await fetch(`${basePath}data/${sourceId}_stops_${locale}.json`);
            if (!res.ok && locale !== 'en') {
                const enRes = await fetch(`${basePath}data/${sourceId}_stops_en.json`);
                if (enRes.ok) {
                    const data = await enRes.json();
                    const result = data.map(i => processStop(i, sourceConfig));
                    result._sourceId = sourceId;
                    return result;
                }
                return null;
            }
            if (res.ok) {
                const data = await res.json();
                const result = data.map(i => processStop(i, sourceConfig));
                result._sourceId = sourceId;
                return result;
            }
            return null;
        }

        const routeMatch = pathname.match(/\/routes\/([^\/]+)(?:(\/.*)|$)/);
        if (routeMatch) {
            const rawRouteId = decodeURIComponent(routeMatch[1]);
            const appRouteId = processId(rawRouteId, sourceConfig); // Normalized format for local data
            const subPath = routeMatch[2] || '';

            if (subPath.startsWith('/schedule')) {
                const suffix = urlObj.searchParams.get('patternSuffix');
                if (suffix) {
                    const safeSuffix = suffix.replace(/:/g, '_').replace(/,/g, '-');
                    const appKey = `${appRouteId}_${safeSuffix}`;
                    const rawKey = `${rawRouteId}_${safeSuffix}`;
                    // Fix: Also try with restored API ID for Rustavi routes (app uses rR835, data has 1:R835)
                    const apiRouteId = restoreApiId(appRouteId, sourceConfig);
                    const apiKey = `${apiRouteId}_${safeSuffix}`;
                    const cache = await getStaticCache(sourceId, 'schedules');
                    if (cache) {
                        const lookup = cache[appKey] || cache[rawKey] || cache[apiKey] || cache[rawKey.replace('1:', '')];
                        return lookup || null;
                    }
                }
                return null;
            }

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
                            const appKey = `${appRouteId}_${safeSuffix}`;
                            const rawKey = `${rawRouteId}_${safeSuffix}`;
                            // Fix: Also try with restored API ID for Rustavi routes
                            const apiRouteId = restoreApiId(appRouteId, sourceConfig);
                            const apiKey = `${apiRouteId}_${safeSuffix}`;
                            const lookup = cache[appKey] || cache[rawKey] || cache[apiKey] || cache[rawKey.replace('1:', '')];
                            if (lookup) {
                                Object.assign(result, lookup);
                                foundAny = true;
                            }
                        }
                        return foundAny ? result : null;
                    }
                }
                return null;
            }

            if (subPath.startsWith('/stops-of-patterns')) {
                const filename = `${sourceId}_routes_details_${locale}.json`;
                const cache = await getStaticCache(sourceId, filename);
                if (cache) {
                    // Fix: Also try with restored API ID for Rustavi routes
                    const apiRouteId = restoreApiId(appRouteId, sourceConfig);
                    const routeData = cache[appRouteId] || cache[rawRouteId] || cache[apiRouteId] || cache[rawRouteId.replace('1:', '')];
                    if (routeData && routeData._stopsOfPatterns) {
                        const rawPatterns = routeData._stopsOfPatterns;
                        if (Array.isArray(rawPatterns)) {
                            return rawPatterns.map(p => ({
                                ...p,
                                stop: processStop(p.stop, sourceConfig)
                            }));
                        }
                        const processed = {};
                        Object.keys(rawPatterns).forEach(key => {
                            processed[key] = rawPatterns[key].map(sid => processId(sid, sourceConfig));
                        });
                        return processed;
                    }
                }
                return null;
            }

            if (subPath.startsWith('/stops')) {
                const filename = `${sourceId}_routes_details_${locale}.json`;
                const cache = await getStaticCache(sourceId, filename);
                if (cache) {
                    // Fix: Also try with restored API ID for Rustavi routes
                    const apiRouteId = restoreApiId(appRouteId, sourceConfig);
                    const routeData = cache[appRouteId] || cache[rawRouteId] || cache[apiRouteId] || cache[rawRouteId.replace('1:', '')];

                    // Static data uses _stopsOfPatterns format, not stops array
                    if (routeData && routeData._stopsOfPatterns) {
                        const patternSuffix = urlObj.searchParams.get('patternSuffix');
                        // Filter stops that belong to the requested pattern suffix
                        const stopsForPattern = routeData._stopsOfPatterns
                            .filter(entry => !patternSuffix || entry.patternSuffixes?.includes(patternSuffix))
                            .map(entry => entry.stop);

                        if (stopsForPattern.length > 0) {
                            const result = stopsForPattern.map(s => processStop(s, sourceConfig));
                            result._sourceId = sourceId;
                            return result;
                        }
                    }

                    // Fallback: check for legacy stops array
                    if (routeData && routeData.stops) {
                        return routeData.stops.map(sid => processId(sid, sourceConfig));
                    }
                }
                return null;
            }

            if (!subPath || subPath === '/') {
                const filename = `${sourceId}_routes_details_${locale}.json`;
                const cache = await getStaticCache(sourceId, filename);
                if (cache) {
                    const routeData = cache[appRouteId] || cache[rawRouteId] || cache[rawRouteId.replace('1:', '')];
                    if (routeData) {
                        return processRoute(routeData, sourceConfig);
                    }
                }
                return null;
            }
            return null;
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
            console.warn(`[API] 500 Error on ${url}. Retrying... (${retries} left)`);
            updateApiStatus(false, res.status, res.statusText);
            await new Promise(r => setTimeout(r, backoff));
            return fetchWithRetry(url, options, retries - 1, backoff * 2);
        }
        updateApiStatus(res.ok, res.status, res.statusText);
        return res;
    } catch (err) {
        if (retries > 0) {
            console.warn(`[API] Network Error on ${url}. Retrying... (${retries} left)`, err.message);
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
    // 1. Strip internal prefixes (e.g. "1:", "2:")
    if (source.stripPrefixes && Array.isArray(source.stripPrefixes)) {
        for (const prefix of source.stripPrefixes) {
            if (finalId.startsWith(prefix)) {
                finalId = finalId.slice(prefix.length);
                break;
            }
        }
    } else if (source.stripPrefix && finalId.startsWith(source.stripPrefix)) {
        finalId = finalId.slice(source.stripPrefix.length);
    }
    // 2. Add source prefix (e.g. "r")
    if (source.prefix) {
        const sep = getSeparator(source);
        const prefixMatch = source.prefix + sep;
        // Use case-sensitive matching when separator is empty to avoid
        // confusing 'R826' with 'r'-prefixed IDs
        const hasPrefix = sep === ''
            ? finalId.startsWith(prefixMatch)
            : finalId.toLowerCase().startsWith(prefixMatch.toLowerCase());
        if (!hasPrefix) {
            finalId = source.prefix + sep + finalId;
        }
    }
    return finalId;
}

export function restoreApiId(id, source) {
    if (!id || typeof id !== 'string') return id;
    let apiId = id;
    // 1. Remove source prefix (e.g. 'r' from 'r123')
    if (source.prefix) {
        const sep = getSeparator(source);
        const prefixMatch = source.prefix.toLowerCase() + sep;
        if (apiId.toLowerCase().startsWith(prefixMatch)) {
            apiId = apiId.slice(prefixMatch.length);
        }
    }

    // 2. Strip ANY existing internal prefixes (e.g. '1:', '2:') before re-adding primary
    if (source.stripPrefixes && Array.isArray(source.stripPrefixes)) {
        for (const prefix of source.stripPrefixes) {
            if (apiId.startsWith(prefix)) {
                apiId = apiId.slice(prefix.length);
                break;
            }
        }
    } else if (source.stripPrefix && apiId.startsWith(source.stripPrefix)) {
        apiId = apiId.slice(source.stripPrefix.length);
    }

    // 3. Re-add primary internal prefix
    if (source.stripPrefixes && Array.isArray(source.stripPrefixes) && source.stripPrefixes.length > 0) {
        const primaryPrefix = source.stripPrefixes[0];
        if (!apiId.startsWith(primaryPrefix)) {
            apiId = primaryPrefix + apiId;
        }
    } else if (source.stripPrefix) {
        if (!apiId.startsWith(source.stripPrefix)) {
            apiId = source.stripPrefix + apiId;
        }
    }
    return apiId;
}


/**
 * Restores a "fully qualified" API ID from an internal app ID.
 * e.g. "r123" -> "2:123", "811" -> "1:811"
 */
export function getApiId(id) {
    if (!id || typeof id !== 'string') return id;

    // Check if it already has a known API prefix
    for (const source of sources) {
        if (source.stripPrefixes) {
            for (const p of source.stripPrefixes) {
                if (id.startsWith(p)) return id;
            }
        }
    }

    // Try finding the source that matches this internal ID
    for (const source of sources) {
        const sep = source.separator !== undefined ? source.separator : ':';
        if (source.prefix && id.startsWith(source.prefix + sep)) {
            return restoreApiId(id, source);
        }
    }

    // Fallback: if no source prefix, try Tbilisi primary
    const tbilisi = sources.find(s => s.id === 'tbilisi');
    if (tbilisi) return restoreApiId(id, tbilisi);

    return id;
}

function processStop(stop, source) {
    if (!stop) return stop;
    stop.id = processId(stop.id, source);
    stop._source = source.id;
    return stop;
}

function processRoute(route, source) {
    if (!route) return route;

    if (route.shortName === '497' || route.id === 'minibusR24335' || route.id === '497') {
        console.log('[API DEBUG] processRoute 497 input:', { id: route.id, hasOv: !!route._overrides, fromConvex: !!route._debug });
    }

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
import { ConvexClient } from "convex/browser";

// ... (existing imports)

// Initialize Convex Client
export const convex = new ConvexClient(import.meta.env.VITE_CONVEX_URL);

// ...

/**
 * Fetches stops from ALL sources via Convex, tags them with `_source`, and merges results.
 */
export async function fetchStops(options = {}) {
    console.log('[API DEBUG] fetchStops called with options:', options);
    const promises = sources.map(async (source) => {
        const cacheKey = `convex_stops_${source.id}`;
        let data = null;

        // 1. Try Cache
        try {
            const cached = await db.get(cacheKey);
            if (cached) {
                const age = Date.now() - cached.timestamp;
                if (age < CACHE_DURATION && options.strategy !== 'network-only') {
                    data = cached.data;
                }
                // If stale, we'll fetch in background if not cache-only? 
                // Creating simplified logic for now: Cache First if available and valid.
                // Or Stale-While-Revalidate? 
                // Let's stick to "If cache good, return it. If cache old or missing, fetch."
                // But options.strategy='cache-only' MUST be respected for fast load.
                if (options.strategy === 'cache-only' && cached) return cached.data.map(item => processStop(item, source));
            }
        } catch (e) { console.warn('Cache Read Error', e); }

        // 2. Fetch Network (if needed)
        if (!data && options.strategy !== 'cache-only') {
            try {
                console.log(`[API DEBUG] fetchStops: Calling Convex for ${source.id}...`);
                data = await convex.query("transit:getStops", { sourceId: source.id, locale: 'en' });
                console.log(`[API DEBUG] fetchStops: Got ${data?.length || 0} stops from Convex for ${source.id}`);
                // Save to Cache
                await db.set(cacheKey, { timestamp: Date.now(), data });
            } catch (e) {
                console.warn(`[API] Failed to fetch stops from Convex (${source.id}):`, e);
                // Fallback to cache even if stale?
                if (!data) {
                    const fallback = await db.get(cacheKey);
                    if (fallback) data = fallback.data;
                }
            }
        }

        if (!Array.isArray(data)) return [];
        return data.map(item => processStop(item, source));
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
 * Fetches routes from ALL sources via Convex, tags them with `_source`, and merges results.
 */
export async function fetchRoutes(options = {}) {
    console.log('[API DEBUG] fetchRoutes called with options:', options);
    const promises = sources.map(async (source) => {
        const cacheKey = `convex_routes_${source.id}`;
        let data = null;

        // 1. Try Cache
        try {
            const cached = await db.get(cacheKey);
            if (cached) {
                const age = Date.now() - cached.timestamp;
                const forceRefresh = import.meta.env.DEV && options.strategy !== 'cache-only';

                if (age < CACHE_DURATION && options.strategy !== 'network-only' && !forceRefresh) {
                    data = cached.data;
                }

                if (options.strategy === 'cache-only' && cached) return cached.data.map(item => processRoute(item, source));
            }
        } catch (e) { console.warn('Cache Read Error', e); }

        // 2. Fetch Network
        if (!data && options.strategy !== 'cache-only') {
            try {
                // Fetch EN for now, usually structural data is shared or EN is primary. 
                // Overrides logic in backend handles localization merging if we passed locale?
                // Backend 'getRoutes' takes locale.
                // Validated overrides were fetched with 'en'.
                // Ideally we should pass the current locale? 
                // But the app might switch locales partially?
                // Static Data usually preload EN.
                // Let's stick to 'en' for structural data as per previous static files.
                console.log(`[API DEBUG] fetchRoutes: Calling Convex for ${source.id}...`);
                const response = await convex.query("transit:getRoutes", { sourceId: source.id, locale: 'en' });

                if (response && response._convex_meta) {
                    console.log(`[API DEBUG] fetchRoutes: Got response from Convex at ${new Date(response._convex_meta.timestamp).toLocaleTimeString()}. Overrides in DB: ${response._convex_meta.totalOverrides}`);
                    data = response.routes;
                } else {
                    console.warn(`[API DEBUG] fetchRoutes: Convex returned unexpected format or no meta for ${source.id}`, response);
                    data = Array.isArray(response) ? response : [];
                }

                console.log(`[API DEBUG] fetchRoutes: Got ${data?.length || 0} routes from Convex for ${source.id}`);

                const r497 = data.find(r => r.id === 'minibusR24335' || r.id === '497' || r.shortName === '497');
                if (r497) {
                    console.log(`[API DEBUG] Route 497 raw data from Convex:`, JSON.stringify(r497));
                }

                await db.set(cacheKey, { timestamp: Date.now(), data });
            } catch (e) {
                console.warn(`[API] Failed to fetch routes from Convex (${source.id}):`, e);
                // Fallback to cache even if stale?
                if (!data) {
                    const fallback = await db.get(cacheKey);
                    if (fallback) data = fallback.data;
                }
            }
        }

        if (!Array.isArray(data)) return [];
        return data.map(item => processRoute(item, source));
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
        const prefixMatch = s.prefix.toLowerCase() + sep;
        return typeof id === 'string' && id.toLowerCase().startsWith(prefixMatch);
    });

    if (explicitSource) {
        attemptOrder = [explicitSource, ...sources.filter(s => s.id !== explicitSource.id)];
    }

    // Try sources in order
    for (const source of attemptOrder) {
        // Strict Source Check:
        // 1. If ID has a known prefix of ANOTHER source, skip this one.
        const idStr = String(id);
        const idPrefix = idStr.includes(':') ? idStr.split(':')[0] : (idStr.startsWith('r') ? 'r' : null);

        // If ID has NO prefix, it's implicitly Tbilisi (numeric).
        if (!idPrefix) {
            if (source.id !== defaultSource.id) {
                // console.log(`[SmartFetch] Skipping ${source.id} for numeric ID ${id} (Assumed Tbilisi)`);
                continue;
            }
        }
        // If ID HAS a prefix, ensure it matches the current source
        else {
            const idSep = idPrefix === 'r' ? '' : ':';
            const matchedSource = sources.find(s => {
                if (s.prefix === idPrefix) return true;
                if (s.stripPrefixes && Array.isArray(s.stripPrefixes)) {
                    return s.stripPrefixes.some(p => p === idPrefix + idSep);
                }
                return s.stripPrefix === idPrefix + idSep;
            });
            if (matchedSource && matchedSource.id !== source.id) {
                // console.log(`[SmartFetch] Skipping ${source.id} for ID ${id} (Expected ${matchedSource.id})`);
                continue;
            }
        }

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
    // Note: Routes from Convex getRoutes don't include stops arrays.
    // We must use the V2 API endpoint which returns routes for a specific stop.
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

// V3 Routes List - Now uses Convex-backed fetchRoutes
export async function fetchV3Routes() {
    console.log('[API DEBUG] fetchV3Routes: Delegating to fetchRoutes()');
    return fetchRoutes({ strategy: 'cache-first' });
}

export async function fetchRouteDetailsV3(routeId, options = {}) {
    if (!routeId) return null;

    // console.log(`[API DEBUG] fetchRouteDetailsV3: ${routeId}`);

    // Try Convex first (contains live overrides)
    try {
        // Determine source from options or infer from ID prefix
        let sourceId = options.sourceId || 'tbilisi';
        if (String(routeId).startsWith('r') && String(routeId).length > 1 && String(routeId)[1] === 'R') {
            sourceId = 'rustavi';
        }

        const source = sources.find(s => s.id === sourceId) || sources[0];

        // Convert frontend ID to DB format using restoreApiId
        const dbRouteId = restoreApiId(String(routeId), source);

        // Query Convex
        // console.log(`[API DEBUG] fetchRouteDetailsV3: Calling Convex for ${routeId} (db: ${dbRouteId}, source: ${sourceId})...`);
        const data = await convex.query("transit:getRouteDetails", {
            sourceId: sourceId,
            locale: options.locale || 'en',
            routeId: dbRouteId
        });

        console.log(`[API Debug] fetchRouteDetailsV3(${routeId}) Convex data:`, data);
        if (data && data._overrides) {
            console.log(`[API Debug] fetchRouteDetailsV3(${routeId}) Found _overrides:`, data._overrides);
        }

        if (data) {
            // Tag with source
            data._source = sourceId;

            // Populate Side-Loaded Data into v3Cache
            if (data._schedules) {
                data._schedules.forEach(s => {
                    const key = `${routeId}:${s.suffix}`;
                    v3Cache.schedules.set(key, s.data);
                });
            }
            // Note: Polylines are loaded from static files, not Convex (better for caching)

            // Inject Stops into Patterns if available
            if (data.patterns && data._stopsOfPatterns) {
                const stopsMap = new Map();
                if (Array.isArray(data._stopsOfPatterns)) {
                    data._stopsOfPatterns.forEach(item => {
                        if (item.patternSuffix) stopsMap.set(item.patternSuffix, item.stops);
                    });
                }
                data.patterns.forEach(p => {
                    if (stopsMap.has(p.patternSuffix)) {
                        p.stops = stopsMap.get(p.patternSuffix);
                    }
                });
            }

            const procSource = sources.find(s => s.id === (data._source || 'tbilisi'));
            const route = processRoute(data, procSource);

            // --- Loop Virtualization Integration ---
            if (route.patterns && route.patterns.length === 1) {
                const originalPattern = route.patterns[0];
                try {
                    // Start with injected stops if available
                    let stops = originalPattern.stops;

                    // If no injected stops, maybe fetch them? (Recursive call to fetchRouteStopsV3)
                    if (!stops) {
                        stops = await fetchRouteStopsV3(route.id, originalPattern.patternSuffix, options);
                    } else {
                        // Ensure stops are processed (IDs etc)
                        stops = stops.map(s => processStop(s, procSource));
                    }

                    if (stops && RouteGeometry.isLoop(stops, route.shortName)) {
                        const virtualPatterns = RouteGeometry.generateVirtualPatterns(
                            originalPattern,
                            stops,
                            route.longName
                        );
                        route.patterns = virtualPatterns;
                        v3Cache.patterns.set(route.id, virtualPatterns);
                    }
                } catch (e) {
                    console.warn(`[API] Failed to check loop status for ${route.id}`, e);
                }
            }

            // Cache full details for future calls
            staticRouteDetails.set(routeId, route);
            return route;
        }
    } catch (e) {
        console.warn(`[API] Convex fetchRouteDetailsV3 failed for ${routeId}`, e);
    }

    // 2. Fallback to Memory/Static Cache (Preloaded Details)
    if (staticRouteDetails.has(routeId)) {
        // console.log(`[API] fetchRouteDetailsV3 fallback to static for ${routeId}`);
        return staticRouteDetails.get(routeId);
    }

    return null;
}

export async function fetchRouteStopsV3(routeId, patternSuffix, options = {}) {
    if (!routeId) return [];



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
    let raw;
    try {
        if (options.strategy === 'cache-only') {
            raw = await fetchStaticFallback(urlGen(defaultSource, routeId));
        } else {
            raw = await fetchFromSmartSource(urlGen, routeId, options);
        }
    } catch (e) {
        // API failed - try static fallback
        console.warn(`[API] Route stops API failed for ${routeId}, falling back to static data`);
        if (staticRouteDetails.has(routeId)) {
            const details = staticRouteDetails.get(routeId);
            if (details.patterns) {
                const pattern = details.patterns.find(p => p.patternSuffix === realSuffix);
                if (pattern && pattern.stops) {
                    const source = sources.find(s => s.id === details._sourceId);
                    return pattern.stops.map(s => processStop(s, source));
                }
            }
        }
        throw e; // Re-throw if no static fallback available
    }

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
        return RouteGeometry.sliceStops(stops, patternSuffix, sliceRange);
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

    let polylineData = null;

    // 1. Try local static cache first (preferred for better caching/performance)
    try {
        const sourceId = routeId.startsWith('r') ? 'rustavi' : 'tbilisi';
        const sourceConfig = sources.find(s => s.id === sourceId);
        const appRouteId = processId(routeId, sourceConfig);

        const cache = await getStaticCache(sourceId, 'polylines');
        if (cache) {
            const tempPolylineData = {};
            const primaryPrefix = sourceConfig.stripPrefixes ? sourceConfig.stripPrefixes[0] : (sourceConfig.stripPrefix || '');

            for (const suffix of realSuffixesSet) {
                const safeSuffix = suffix.replace(/:/g, '_').replace(/,/g, '-');
                const key = `${primaryPrefix}${appRouteId}_${safeSuffix}`;
                if (cache[key]) {
                    Object.assign(tempPolylineData, cache[key]);
                } else if (cache[`${appRouteId}_${safeSuffix}`]) {
                    // Fallback for keys without prefix
                    Object.assign(tempPolylineData, cache[`${appRouteId}_${safeSuffix}`]);
                }
            }
            if (Object.keys(tempPolylineData).length > 0) {
                polylineData = tempPolylineData;
                console.log(`[API] Loaded polylines from local cache for ${routeId}`);
            }
        }
    } catch (e) {
        console.warn(`[API] Local polyline cache check failed for ${routeId}:`, e);
    }

    // 2. Fallback to legacy API if not found in local cache
    if (!polylineData) {
        try {
            if (options.strategy === 'cache-only') {
                polylineData = await fetchStaticFallback(urlGen(defaultSource, routeId));
            } else {
                polylineData = await fetchFromSmartSource(urlGen, routeId, options);
            }
        } catch (e) {
            console.error(`[API] Polyline API fetch failed for ${routeId}:`, e);
        }
    }

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
                    polylineData[virtual] = RouteGeometry.slicePolyline(fullPolylinePoints, virtual, splitPoint);
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

// Cache for stop arrivals (30 second TTL)
const arrivalsCache = new Map();
const ARRIVALS_CACHE_TTL = 30000; // 30 seconds

function getCachedArrivals(stopId) {
    const cached = arrivalsCache.get(stopId);
    if (cached && Date.now() - cached.timestamp < ARRIVALS_CACHE_TTL) {
        return cached.data;
    }
    return null;
}

function setCachedArrivals(stopId, data) {
    arrivalsCache.set(stopId, { data, timestamp: Date.now() });
}

/**
 * Fetch arrivals for a list of stop IDs in parallel.
 * UPDATED: Uses 30-second cache to reduce API requests.
 * @param {string[]} ids
 * @returns {Promise<Array>} Combined flat list of arrivals
 */
export async function fetchArrivalsForStopIds(ids) {
    console.log(`[fetchArrivalsForStopIds] Input IDs:`, ids);
    const promises = ids.map(async (id) => {
        // Check cache first
        const cached = getCachedArrivals(id);
        if (cached) {
            console.log(`[fetchArrivalsForStopIds] Cache HIT for ${id}`);
            return cached;
        }

        // Use smart source fetch logic
        // We need a custom url generator for arrivals
        const urlGen = (s, i) => `${getApiBaseUrl(s)}/stops/${encodeURIComponent(i)}/arrival-times?locale=en&ignoreScheduledArrivalTimes=false`;
        try {
            // Custom Smart Fetch for Live Data
            async function tryFetch(source) {
                const apiId = restoreApiId(id, source);
                const url = urlGen(source, apiId);
                console.log(`[fetchArrivalsForStopIds] Trying ${source.id}: id=${id} -> apiId=${apiId}, URL=${url}`);
                const res = await fetch(url, { headers: { 'x-api-key': API_KEY } });
                console.log(`[fetchArrivalsForStopIds] Response for ${apiId}: status=${res.status}`);
                if (!res.ok) throw new Error(`Fail: ${res.status}`);
                const arrivals = await res.json();
                // Tag each arrival with the source stop ID so we know which stop it came from
                const taggedArrivals = Array.isArray(arrivals) ? arrivals.map(a => ({ ...a, _sourceStopId: id })) : [];
                // Cache the result
                setCachedArrivals(id, taggedArrivals);
                return taggedArrivals;
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

export async function fetchScheduleForStop(routeId, stopIds, explicitSuffix = null, options = {}) {
    if (!routeId || !stopIds || stopIds.length === 0) return null;

    // 1. Get Patterns with Stops (Association Data)
    // Use separate cache key to avoid collision with full route details patterns
    let patterns = v3Cache.stopPatterns.get(routeId);
    let routeDataForPrioritization = null;

    if (!patterns) {
        const lsKey = `v3_stop_patterns_${routeId}`;
        try {
            const cached = await db.get(lsKey);
            if (cached && (Date.now() - cached.timestamp < 7 * 24 * 60 * 60 * 1000)) {
                patterns = cached.data;
                v3Cache.stopPatterns.set(routeId, patterns);
            }
        } catch (e) { }
    }

    if (!patterns) {
        // Fetch patterns if not in cache
        patterns = await (async () => {
            try {
                const routeData = await fetchRouteDetailsV3(routeId, { strategy: options.strategy === 'cache-only' ? 'cache-only' : 'cache-first' });
                // console.log(`[Debug] details for ${routeId}:`, routeData ? 'Found' : 'Null');
                routeDataForPrioritization = routeData;
                if (routeData) {
                    // Optimization: Use Side-Loaded stops of patterns if available (from Convex)
                    if (routeData._stopsOfPatterns && Array.isArray(routeData._stopsOfPatterns) && routeData._stopsOfPatterns.length > 0) {
                        const source = sources.find(s => s.id === (routeData._source || 'tbilisi'));
                        return routeData._stopsOfPatterns.map(p => ({
                            ...p,
                            stop: processStop(p.stop, source)
                        }));
                    }

                    if (routeData.patterns) {
                        const suffixes = routeData.patterns.map(p => p.patternSuffix).join(',');
                        const urlGen = (s, id) => `${getApiV3BaseUrl(s)}/routes/${id}/stops-of-patterns?patternSuffixes=${suffixes}&locale=en`;
                        const res = await fetchFromSmartSource(urlGen, routeId);

                        // console.log(`[Debug] StopsOfPatterns for ${routeId}:`, res ? (Array.isArray(res) ? `Array(${res.length})` : typeof res) : 'Null');

                        if (res && Array.isArray(res) && res.length > 0) {
                            const source = sources.find(s => s.id === (res._sourceId || 'tbilisi')) || sources.find(s => s.id === 'tbilisi');
                            return res.map(p => ({
                                ...p,
                                stop: processStop(p.stop, source)
                            }));
                        } else {
                            // Empty API result, try static fallback
                            throw new Error('Empty API result, trying fallback');
                        }
                    }
                }
                return [];
            } catch (e) {
                // Fallback to static cache
                try {
                    const isRustavi = /^r/.test(routeId) || routeId.startsWith('rustavi:');
                    const sourceId = isRustavi ? 'rustavi' : 'tbilisi';
                    const sourceConfig = sources.find(s => s.id === sourceId);
                    const cache = await getStaticCache(sourceId, `${sourceId}_routes_details_en.json`);
                    if (cache) {
                        const appRouteId = processId(routeId, sourceConfig);
                        const apiRouteId = restoreApiId(appRouteId, sourceConfig);
                        // Try multiple ID formats to hit cache
                        const routeDataVal = cache[appRouteId] || cache[apiRouteId] || cache[routeId] || cache[`1:${appRouteId}`];

                        if (routeDataVal && routeDataVal._stopsOfPatterns) {
                            if (Array.isArray(routeDataVal._stopsOfPatterns)) {
                                return routeDataVal._stopsOfPatterns.map(p => {
                                    if (!p.stop) return p; // Guard against malformed cache
                                    return {
                                        ...p,
                                        stop: processStop(p.stop, sourceConfig)
                                    };
                                });
                            }
                            return routeDataVal._stopsOfPatterns;
                        }
                    }
                } catch (fallbackErr) { }
                return [];
                // End of Fallback Logic
            }
        })();

        if (patterns && patterns.length > 0) { // Only cache if we actually found something
            v3Cache.stopPatterns.set(routeId, patterns);
            try {
                await db.set(`v3_stop_patterns_${routeId}`, {
                    timestamp: Date.now(),
                    data: patterns
                });
            } catch (e) { console.warn('LS Write Failed (StopPatterns)', e); }
        }
    }

    if (!patterns) return null;

    const stopEntry = patterns.find((p, idx) => {
        if (!p || !p.stop) return false;
        const pId = String(p.stop.id);
        const pCode = String(p.stop.code || '');
        const normalize = (id) => String(id).replace(/^[rR]/, '').replace(/^\d+:/, '');
        return stopIds.some(targetId => {
            const targetStr = String(targetId);
            if (targetStr === pId) return true;
            if (normalize(targetStr) === normalize(pId)) return true;
            if (pCode && normalize(pCode) === normalize(targetStr)) return true;
            return false;
        });
    });

    if (!stopEntry || !stopEntry.patternSuffixes.length) return null;

    // --- Suffix Selection ---
    let suffix = explicitSuffix;
    if (!suffix || !stopEntry.patternSuffixes.includes(suffix)) {
        suffix = stopEntry.patternSuffixes[0];

        // Prioritize non-terminus suffix
        if (stopEntry.patternSuffixes.length > 1) {
            if (!routeDataForPrioritization) {
                routeDataForPrioritization = await fetchRouteDetailsV3(routeId, { strategy: 'cache-first' });
            }
            if (routeDataForPrioritization && routeDataForPrioritization.patterns) {
                const nonTerminus = stopEntry.patternSuffixes.find(sfx => {
                    const p = routeDataForPrioritization.patterns.find(pat => pat.patternSuffix === sfx);
                    if (!p || !p.lastStop) return true;
                    const normalize = (id) => String(id).replace(/^\d+:/, '').replace(/^[rR]/, '');
                    const isLast = stopIds.some(sid => normalize(sid) === normalize(p.lastStop.id));
                    return !isLast;
                });
                if (nonTerminus) suffix = nonTerminus;
            }
        }
    }

    const cacheKey = `${routeId}:${suffix}`;
    let schedule = v3Cache.schedules.get(cacheKey);

    if (!schedule) {
        const keySafe = cacheKey.replace(/:/g, '_');
        const lsKey = `v3_sched_${keySafe}`;
        try {
            const cached = await db.get(lsKey);
            if (cached && (Date.now() - cached.timestamp < 24 * 60 * 60 * 1000)) {
                schedule = cached.data;
                v3Cache.schedules.set(cacheKey, schedule);
            }
        } catch (e) { }
    }

    if (!schedule) {
        if (options.strategy === 'cache-only') {
            // Check static cache directly
            const isRustavi = /^[rR]/.test(routeId) || routeId.toLowerCase().startsWith('rustavi:');
            const sourceId = isRustavi ? 'rustavi' : 'tbilisi';
            const sourceConfig = sources.find(s => s.id === sourceId);
            try {
                const cache = await getStaticCache(sourceId, 'schedules');
                if (cache) {
                    const safeSuffix = suffix.replace(/:/g, '_').replace(/,/g, '-');
                    const appRouteId = processId(routeId, sourceConfig);
                    const apiRouteId = restoreApiId(appRouteId, sourceConfig);
                    const keys = [`${appRouteId}_${safeSuffix}`, `${apiRouteId}_${safeSuffix}`, `${routeId}_${safeSuffix}`];
                    for (const key of keys) {
                        if (cache[key]) return cache[key];
                    }
                }
            } catch (err) { }
            return null;
        }

        if (v3InFlight.schedules.has(cacheKey)) {
            schedule = await v3InFlight.schedules.get(cacheKey);
        } else {
            const promise = (async () => {
                const urlGen = (s, id) => `${getApiV3BaseUrl(s)}/routes/${id}/schedule?patternSuffix=${suffix}&locale=en`;
                try {
                    const schRes = await fetchFromSmartSource(urlGen, routeId);
                    if (!schRes) throw new Error(`Schedule fetch failed`);
                    return schRes;
                } catch (e) {
                    const isRustavi = /^[rR]/.test(routeId) || routeId.toLowerCase().startsWith('rustavi:');
                    const sourceId = isRustavi ? 'rustavi' : 'tbilisi';
                    const sourceConfig = sources.find(s => s.id === sourceId);
                    try {
                        const cache = await getStaticCache(sourceId, 'schedules');
                        if (cache) {
                            const safeSuffix = suffix.replace(/:/g, '_').replace(/,/g, '-');
                            const appRouteId = processId(routeId, sourceConfig);
                            const apiRouteId = restoreApiId(appRouteId, sourceConfig);
                            const keys = [`${appRouteId}_${safeSuffix}`, `${apiRouteId}_${safeSuffix}`, `${routeId}_${safeSuffix}`];
                            for (const key of keys) {
                                if (cache[key]) return cache[key];
                            }
                        }
                    } catch (err) { }
                    return null;
                }
            })();
            v3InFlight.schedules.set(cacheKey, promise);
            try {
                schedule = await promise;
                if (schedule) {
                    v3Cache.schedules.set(cacheKey, schedule);
                    try {
                        const keySafe = cacheKey.replace(/:/g, '_');
                        await db.set(`v3_sched_${keySafe}`, { timestamp: Date.now(), data: schedule });
                    } catch (e) { }
                }
            } catch (e) {
            } finally {
                v3InFlight.schedules.delete(cacheKey);
            }
        }
    }

    return schedule ? { schedule, patternSuffix: suffix } : null;
}

/**
 * Calculate ETAs for buses approaching a target stop.
 * Uses arrivals from upstream stops + scheduled inter-stop travel times.
 * 
 * @param {string} routeId - Route identifier
 * @param {string} patternSuffix - Direction/pattern suffix  
 * @param {string} targetStopId - Target stop ID
 * @param {Object} options - { primaryArrivalMins: number } for smart stop selection
 * @returns {Promise<Array<{minutes: number, source: 'live'|'scheduled'}>>}
 */
export async function calculateBusETAs(routeId, patternSuffix, targetStopId, options = {}) {
    try {
        const { primaryArrivalMins = 15, routeShortName: passedShortName } = options;

        // 1. Get schedule to find route stops and inter-stop times
        const scheduleResult = await fetchScheduleForStop(routeId, [targetStopId]);

        if (!scheduleResult || !scheduleResult.schedule) {
            console.log(`[ETA Calc] No schedule data for ${routeId}`);
            return [];
        }

        const { schedule, patternSuffix: actualSuffix } = scheduleResult;

        // 2. Find today's schedule
        const now = new Date();
        const tbilisiOffset = 4 * 60; // UTC+4
        const localOffset = now.getTimezoneOffset();
        const tbilisiTime = new Date(now.getTime() + (tbilisiOffset + localOffset) * 60000);
        const todayStr = tbilisiTime.toISOString().split('T')[0];

        let daySchedule = schedule.find(s => s.serviceDates?.includes(todayStr));
        if (!daySchedule && schedule.length > 0) {
            daySchedule = schedule[0];
        }

        if (!daySchedule || !daySchedule.stops || daySchedule.stops.length < 3) {
            console.log(`[ETA Calc] Insufficient schedule data for ${routeId}`);
            return [];
        }

        const stops = daySchedule.stops;

        // 3. Find target stop index
        const normalize = (id) => String(id).replace(/^\d+:/, '').replace(/^[rR]/, '');
        const targetNorm = normalize(targetStopId);

        const targetIndex = stops.findIndex(s =>
            normalize(s.id) === targetNorm ||
            normalize(s.code || '') === targetNorm
        );

        if (targetIndex <= 0) {
            const sampleIds = stops.slice(0, 5).map(s => s.id);
            console.log(`[ETA Calc] Target stop ${targetStopId} (normalized: ${targetNorm}) not found or at start. Sample stop IDs:`, sampleIds);
            return [];
        }

        // 4. Calculate average inter-stop time
        let totalInterStopTime = 0;
        let interStopCount = 0;

        for (let i = 0; i < stops.length - 1; i++) {
            const fromTimes = (stops[i].arrivalTimes || '').split(',').filter(Boolean);
            const toTimes = (stops[i + 1].arrivalTimes || '').split(',').filter(Boolean);

            if (fromTimes.length > 0 && toTimes.length > 0) {
                const [fh, fm] = fromTimes[0].split(':').map(Number);
                const [th, tm] = toTimes[0].split(':').map(Number);
                const diff = (th * 60 + tm) - (fh * 60 + fm);

                if (diff > 0 && diff < 15) {
                    totalInterStopTime += diff;
                    interStopCount++;
                }
            }
        }

        const avgInterStopMins = interStopCount > 0 ? totalInterStopTime / interStopCount : 2;

        // 5. SMART STOP SELECTION: Estimate bus position from primary arrival
        const estimatedStopsAway = Math.ceil(primaryArrivalMins / avgInterStopMins);
        const bufferStops = 2;

        // Query stops around estimated position
        const startIdx = Math.max(0, targetIndex - estimatedStopsAway - bufferStops);
        const endIdx = Math.max(0, targetIndex - Math.max(1, estimatedStopsAway - bufferStops));

        // Get upstream stop IDs (limit to 3-4 stops)
        const upstreamStops = [];
        for (let i = startIdx; i <= endIdx && upstreamStops.length < 4; i++) {
            if (stops[i] && stops[i].id) {
                upstreamStops.push({
                    id: stops[i].id,
                    index: i,
                    travelTimeToTarget: 0
                });
            }
        }

        if (upstreamStops.length === 0) {
            console.log(`[ETA Calc] No upstream stops identified for ${routeId}`);
            return [];
        }

        // 6. Calculate travel time from each upstream stop to target
        for (const upstream of upstreamStops) {
            let travelTime = 0;
            for (let i = upstream.index; i < targetIndex; i++) {
                const fromTimes = (stops[i].arrivalTimes || '').split(',').filter(Boolean);
                const toTimes = (stops[i + 1]?.arrivalTimes || '').split(',').filter(Boolean);

                if (fromTimes.length > 0 && toTimes.length > 0) {
                    const [fh, fm] = fromTimes[0].split(':').map(Number);
                    const [th, tm] = toTimes[0].split(':').map(Number);
                    const diff = (th * 60 + tm) - (fh * 60 + fm);
                    travelTime += (diff > 0 && diff < 15) ? diff : avgInterStopMins;
                } else {
                    travelTime += avgInterStopMins;
                }
            }
            upstream.travelTimeToTarget = Math.round(travelTime);
        }

        console.log(`[ETA Calc] ${routeId}: Querying ${upstreamStops.length} upstream stops (${startIdx}-${endIdx}), avg inter-stop: ${avgInterStopMins.toFixed(1)}min`);

        // 7. Fetch arrivals for upstream stops
        const upstreamIds = upstreamStops.map(s => s.id);
        console.log(`[ETA Calc] Upstream stop IDs to fetch:`, upstreamIds);
        let upstreamArrivals;

        try {
            upstreamArrivals = await fetchArrivalsForStopIds(upstreamIds);
            console.log(`[ETA Calc] Received ${upstreamArrivals?.length || 0} upstream arrivals`);
        } catch (e) {
            console.warn(`[ETA Calc] Failed to fetch upstream arrivals:`, e.message);
            return [];
        }

        if (!upstreamArrivals || upstreamArrivals.length === 0) {
            console.log(`[ETA Calc] No upstream arrivals found for ${routeId}`);
            return [];
        }

        // 8. Filter arrivals for this route and calculate ETAs
        // Use passed shortName if available, otherwise try to derive from routeId (fallback)
        const routeShortName = passedShortName || routeId.replace(/^[rR]/, '').replace(/^\d+:/, '');

        // Debug: Log what routes are in the arrivals
        const uniqueRoutes = [...new Set(upstreamArrivals.map(a => a.shortName))];
        const matchingCount = upstreamArrivals.filter(a => String(a.shortName || '').replace(/^[rR]/, '') === routeShortName).length;
        const realtimeCount = upstreamArrivals.filter(a => a.realtime).length;
        console.log(`[ETA Calc] Matching for "${routeShortName}": ${matchingCount} name-match, ${realtimeCount} realtime, routes in arrivals: [${uniqueRoutes.slice(0, 10).join(', ')}${uniqueRoutes.length > 10 ? '...' : ''}]`);

        // Debug: Log sample arrival structure to find correct stop ID property
        if (upstreamArrivals.length > 0) {
            const sample = upstreamArrivals[0];
            console.log(`[ETA Calc] Sample arrival structure:`, Object.keys(sample), `_sourceStopId=${sample._sourceStopId}`);
        }

        const etas = [];

        for (const arrival of upstreamArrivals) {
            // Match route - compare shortNames
            const arrivalRouteName = String(arrival.shortName || '').replace(/^[rR]/, '');
            if (arrivalRouteName !== routeShortName) continue;

            // Only use live arrivals (realtime)
            if (!arrival.realtime) continue;

            // Find which upstream stop this arrival is for
            const arrivalStopId = arrival._sourceStopId;
            const upstreamStop = upstreamStops.find(u =>
                normalize(u.id) === normalize(arrivalStopId)
            );

            // Debug: Log matching attempt for route matches
            if (!upstreamStop) {
                const upstreamIds = upstreamStops.map(u => `${u.id}→${normalize(u.id)}`);
                console.log(`[ETA Calc] STOP MISMATCH: arrival._sourceStopId="${arrivalStopId}" (norm: ${normalize(arrivalStopId)}), upstream: [${upstreamIds.join(', ')}]`);
                continue;
            }

            // Calculate ETA at target = arrival minutes + travel time
            const arrivalMins = arrival.realtimeArrivalMinutes ?? arrival.scheduledArrivalMinutes ?? 0;
            const etaAtTarget = arrivalMins + upstreamStop.travelTimeToTarget;

            etas.push({
                minutes: Math.round(etaAtTarget),
                source: 'live',
                upstreamStopId: upstreamStop.id,
                upstreamArrivalMins: arrivalMins,
                travelTime: upstreamStop.travelTimeToTarget
            });
        }

        // 9. Deduplicate (same bus might appear at multiple upstream stops)
        const uniqueEtas = [];
        const seenMinutes = new Set();

        etas.sort((a, b) => a.minutes - b.minutes);

        for (const eta of etas) {
            // Skip if within 2 mins of an existing ETA (likely same bus)
            let isDupe = false;
            for (const m of seenMinutes) {
                if (Math.abs(m - eta.minutes) <= 2) {
                    isDupe = true;
                    break;
                }
            }

            if (!isDupe) {
                uniqueEtas.push(eta);
                seenMinutes.add(eta.minutes);
            }

            if (uniqueEtas.length >= 3) break;
        }

        console.log(`[ETA Calc] ${routeId}: Found ${uniqueEtas.length} ETAs:`, uniqueEtas.map(e => `${e.minutes}'`));

        return uniqueEtas;

    } catch (err) {
        console.warn(`[ETA Calc] Error for ${routeId}:`, err.message);
        return [];
    }
}

