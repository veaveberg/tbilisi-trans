import { db } from './db.js';
import { sources } from './data/sources.js';
import {
    getSourceSeparator,
    namespaceVehicleId,
    sourceForAppId,
    staticRouteResourceKeys,
    toApiId,
    toAppId
} from './data/source-identity.js';
import { RouteGeometry } from './route-geometry.js';
import { getTransitDataLocale } from './i18n.ts';
import { getOtaDataFileJson, getOtaDataFileText } from './ota-data.js';

// Export sources for external usage (e.g. main.js normalization)
export { sources };

// Configuration
export const MAPBOX_TOKEN = (import.meta.env.VITE_MAPBOX_TOKEN || '').trim();
export const API_KEY = 'c0a2f304-551a-4d08-b8df-2c53ecd57f9f';

// Default Source (Tbilisi) for fallback or single-source calls
const defaultSource = sources.find(s => s.id === 'tbilisi') || sources[0];

export function getSourceForId(id) {
    return sourceForAppId(id, sources, defaultSource);
}

// Helper to get base URL for a source (handling proxy for dev if needed)
function getApiBaseUrl(source) {
    return source.apiBase;
}

function getApiV3BaseUrl(source) {
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

const V3_SCHEDULE_KEYS_KEY = 'v3_sched_keys';
const V3_SCHEDULE_REFRESH_KEY = 'v3_sched_last_refresh';
const V3_SCHEDULE_REFRESH_SUCCESS_KEY = 'v3_sched_last_refresh_success';
const V3_SCHEDULE_REFRESH_INTERVAL = 3 * 24 * 60 * 60 * 1000; // 3 days
const V3_SCHEDULE_CACHE_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days
const V3_SCHEDULE_REFRESH_MAX = 50;

function getActiveLocale() {
    return getTransitDataLocale();
}

function isLocalProxyEnvironment() {
    if (typeof window === 'undefined') return false;
    if (!import.meta.env.DEV) return false;
    const host = window.location.hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

async function rememberScheduleCacheKey(routeId, suffix) {
    try {
        const existing = await db.get(V3_SCHEDULE_KEYS_KEY);
        const list = Array.isArray(existing) ? existing : [];
        const entry = { routeId, suffix };
        const already = list.some(k => k && k.routeId === routeId && k.suffix === suffix);
        if (!already) {
            list.push(entry);
            await db.set(V3_SCHEDULE_KEYS_KEY, list);
        }
    } catch (e) { }
}

function parseScheduleKey(key) {
    if (key && typeof key === 'object' && key.routeId && key.suffix) return key;
    if (typeof key !== 'string') return null;
    const parts = key.split(':');
    if (parts.length < 2) return null;
    const suffix = parts.slice(-2).join(':');
    const routeId = parts.slice(0, -2).join(':');
    if (!routeId || !suffix) return null;
    return { routeId, suffix };
}

async function refreshScheduleCacheEntry(routeId, suffix) {
    const cacheKey = `${routeId}:${suffix}`;
    const urlGen = (s, id) => `${getApiV3BaseUrl(s)}/routes/${id}/schedule?patternSuffix=${suffix}&locale=${getActiveLocale()}`;
    const schedule = await fetchFromSmartSource(urlGen, routeId);
    if (schedule) {
        v3Cache.schedules.set(cacheKey, schedule);
        try {
            const keySafe = cacheKey.replace(/:/g, '_');
            await db.set(`v3_sched_${keySafe}`, { timestamp: Date.now(), data: schedule });
        } catch (e) { }
    }
}

export async function maybeRefreshScheduleCache() {
    if (!isLocalProxyEnvironment()) {
        console.log('[Schedule Refresh] Skipped: not local dev proxy environment');
        return;
    }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        console.log('[Schedule Refresh] Skipped: offline');
        return;
    }

    let last = null;
    let lastSuccess = null;
    try {
        last = await db.get(V3_SCHEDULE_REFRESH_KEY);
        lastSuccess = await db.get(V3_SCHEDULE_REFRESH_SUCCESS_KEY);
    } catch (e) { }
    const gateTimestamp = lastSuccess || last;
    if (gateTimestamp && Date.now() - gateTimestamp < V3_SCHEDULE_REFRESH_INTERVAL) {
        const hours = Math.round((Date.now() - last) / (1000 * 60 * 60));
        console.log(`[Schedule Refresh] Skipped: last refresh ${hours}h ago`);
        return;
    }

    let keys = [];
    try {
        const stored = await db.get(V3_SCHEDULE_KEYS_KEY);
        keys = Array.isArray(stored) ? stored : [];
    } catch (e) { }
    if (!keys.length) {
        console.log('[Schedule Refresh] Skipped: no cached schedule keys');
        return;
    }

    const toRefresh = keys.slice(0, V3_SCHEDULE_REFRESH_MAX).map(parseScheduleKey).filter(Boolean);
    console.log(`[Schedule Refresh] Refreshing ${toRefresh.length} schedule(s)`);
    for (const entry of toRefresh) {
        try {
            await refreshScheduleCacheEntry(entry.routeId, entry.suffix);
        } catch (e) { }
        // Gentle pacing to avoid upstream throttling
        await new Promise(r => setTimeout(r, 150));
    }

    try {
        await db.set(V3_SCHEDULE_REFRESH_KEY, Date.now());
        await db.set(V3_SCHEDULE_REFRESH_SUCCESS_KEY, Date.now());
    } catch (e) { }
    console.log('[Schedule Refresh] Done');
}

// Manual force refresh (dev helper)
export async function forceRefreshScheduleCache() {
    try {
        await db.del(V3_SCHEDULE_REFRESH_KEY);
        await db.del(V3_SCHEDULE_REFRESH_SUCCESS_KEY);
    } catch (e) { }
    await maybeRefreshScheduleCache();
}

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
    rustavi: { details: null, schedules: null, polylines: null },
    kutaisi: { details: null, schedules: null, polylines: null },
    batumi: { details: null, schedules: null, polylines: null }
};

const staticStopToRoutes = new Map(); // stopId -> Set<routeId>
const staticRouteDetails = new Map(); // routeId -> details

export function invalidateStaticTransitDataCaches() {
    Object.keys(staticCache).forEach(sourceId => {
        staticCache[sourceId] = {};
    });
    pendingCacheRequests.clear();
    preloadPromise = null;
    preloadLocale = null;
    staticStopToRoutes.clear();
    staticRouteDetails.clear();
    v3Cache.patterns.clear();
    v3Cache.stopPatterns.clear();
    v3Cache.schedules.clear();
    v3Cache.polylines.clear();
    invalidateRouteOverridesCache();
}

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

/**
 * Get cached virtual patterns for a route.
 * Virtual patterns (_PART0, _PART1) are generated for loop routes.
 * @param {string} routeId 
 * @returns {Array|null} Array of virtual pattern objects or null
 */
export function getVirtualPatterns(routeId) {
    return v3Cache.patterns.get(routeId) || null;
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
let preloadLocale = null;

export function preloadStaticRoutesDetails() {
    const locale = getActiveLocale();
    if (preloadPromise && preloadLocale === locale) return preloadPromise;
    if (preloadLocale !== locale) {
        preloadLocale = locale;
        staticRouteDetails.clear();
        staticStopToRoutes.clear();
    }

    preloadPromise = (async () => {
        const sourcesToLoad = sources;

        console.log('[API] Preloading static route details for filtering...');

        await Promise.all(sourcesToLoad.map(async (source) => {
            try {
                const filename = `${source.id}_routes_details_${locale}.json`;
                const stopsFilename = `${source.id}_stops_${locale}.json`;

                // Parallel load
                const [data, stopsData] = await Promise.all([
                    getStaticCache(source.id, filename),
                    getStaticCache(source.id, stopsFilename)
                ]);

                // Create fast lookup for stop names
                const stopNameMap = new Map();
                if (stopsData && Array.isArray(stopsData)) {
                    stopsData.forEach(s => {
                        const pid = processId(s.id, source);
                        stopNameMap.set(pid, s.name);
                        // Also index raw ID just in case
                        stopNameMap.set(s.id, s.name);
                    });
                }

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
                                        if (typeof s === 'object') {
                                            // If object already, ensure it has name
                                            const processed = processStop(s, source);
                                            // If name missing, try lookup? 
                                            // Usually static object stops might be partial.
                                            // But if it is from _stopsOfPatterns, it might be just {id:...}
                                            if (!processed.name && stopNameMap.has(processed.id)) {
                                                processed.name = stopNameMap.get(processed.id);
                                            }
                                            return processed;
                                        }
                                        const pid = processId(s, source);
                                        const name = stopNameMap.get(pid);
                                        return { id: pid, name: name };
                                    });
                                }
                            });
                        }

                        const routeData = { ...details, _sourceId: source.id, id: routeId };

                        // --- Loop Virtualization for Static Routes ---
                        if (details.patterns && details.patterns.length === 1 && RouteGeometry) {
                            const originalPattern = details.patterns[0];
                            const stops = originalPattern.stops;

                            if (stops && RouteGeometry.isLoop(stops, details.shortName || routeId)) {
                                try {
                                    let forcedId = details._overrides?.terminusStopId_override ||
                                        details._overrides?.terminusStopId ||
                                        details._overrides?.virtualTerminusStopId;

                                    const virtualPatterns = RouteGeometry.generateVirtualPatterns(
                                        originalPattern,
                                        stops,
                                        details.longName,
                                        forcedId
                                    );

                                    // Update route patterns and cache them
                                    routeData.patterns = virtualPatterns;
                                    v3Cache.patterns.set(routeId, virtualPatterns);
                                    // console.log(`[API] Virtualized static loop route: ${routeId}`);
                                } catch (e) {
                                    console.warn(`[API] Failed to virtualize static loop route ${routeId}`, e);
                                }
                            }
                        }

                        staticRouteDetails.set(routeId, routeData);

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

async function fetchStaticJsonCandidate(url) {
    const res = await fetch(url, {
        headers: { Accept: 'application/json' }
    });
    if (!res.ok) {
        throw new Error(`${res.status} while loading ${url}`);
    }

    const text = await res.text();
    const trimmed = text.trimStart();
    if (trimmed.startsWith('<!DOCTYPE') || trimmed.startsWith('<html')) {
        throw new Error(`Received HTML instead of JSON from ${url}`);
    }

    try {
        return JSON.parse(text);
    } catch (err) {
        throw new Error(`Invalid JSON from ${url}: ${err.message}`);
    }
}

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
            const otaData = await getOtaDataFileJson(filename);
            if (otaData) {
                staticCache[sourceId][type] = otaData;
                return otaData;
            }

            const basePath = import.meta.env.BASE_URL.endsWith('/') ? import.meta.env.BASE_URL : `${import.meta.env.BASE_URL}/`;
            const candidates = [
                `${basePath}data/${filename}`,
                `${basePath}ota/files/${filename}`
            ];
            const errors = [];

            for (const url of candidates) {
                try {
                    const data = await fetchStaticJsonCandidate(url);
                    staticCache[sourceId][type] = data;
                    return data;
                } catch (err) {
                    errors.push(err.message);
                }
            }

            throw new Error(errors.join('; '));
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
        const locale = urlObj.searchParams.get('locale') || getActiveLocale();
        const stopMatch = pathname.match(/\/stops\/([^\/]+)/);
        const idRouteMatch = pathname.match(/\/routes\/([^\/]+)/);
        const idInUrl = (stopMatch ? stopMatch[1] : (idRouteMatch ? idRouteMatch[1] : ''));
        const decodedId = decodeURIComponent(idInUrl);
        const sourceConfig = sources.find(source =>
            source.proxyPath && pathname.includes(source.proxyPath)
        ) || sourceForAppId(decodedId, sources, defaultSource);
        const sourceId = sourceConfig.id;

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

        // If cache is stale but not older than 7 days, try network first with a 1.5s timeout.
        // This ensures fresh data is shown if online, while maintaining instant load/offline support.
        if (age < 7 * 24 * 60 * 60 * 1000 && options.strategy !== 'cache-only' && options.strategy !== 'cache-first') {
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 1500);
                const res = await fetch(url, { ...options, signal: controller.signal, credentials: 'omit' });
                clearTimeout(timeoutId);
                if (res.ok) {
                    const newData = await res.json();
                    await db.set(cacheKey, { timestamp: now, data: newData });
                    return newData;
                }
            } catch (e) {
                console.warn(`[Cache] Stale refresh failed, falling back to cached data: ${url}`, e);
            }
            return data;
        }

        if (options.strategy === 'cache-only' || options.strategy === 'cache-first' || age < 7 * 24 * 60 * 60 * 1000) {
            return cached.data;
        }
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
    return getSourceSeparator(source);
}

export function processId(id, source) {
    return toAppId(id, source);
}

export function restoreApiId(id, source) {
    return toApiId(id, source, sources);
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
        // console.debug('[API DEBUG] processRoute 497 input:', { id: route.id, hasOv: !!route._overrides, fromConvex: !!route._debug });
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
 * Fetches stops from bundled/static data files, tags them with `_source`, and merges results.
 */
export async function fetchStops(options = {}) {
    // Keep options for API compatibility with older cache/network callers.
    const locale = getActiveLocale();
    const promises = sources.map(async (source) => {
        let filename = `${source.id}_stops_${locale}.json`;
        let data = await getStaticCache(source.id, filename);

        if (!Array.isArray(data) && locale !== 'en') {
            filename = `${source.id}_stops_en.json`;
            data = await getStaticCache(source.id, filename);
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
 * Fetches routes from bundled/static data files, tags them with `_source`, and merges results.
 */
export async function fetchRoutes(options = {}) {
    // Keep options for API compatibility with older cache/network callers.
    const locale = getActiveLocale();
    const promises = sources.map(async (source) => {
        let filename = `${source.id}_routes_${locale}.json`;
        let data = await getStaticCache(source.id, filename);

        if (!Array.isArray(data) && locale !== 'en') {
            filename = `${source.id}_routes_en.json`;
            data = await getStaticCache(source.id, filename);
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

    const explicitSource = sourceForAppId(id, sources, null);
    // A namespaced app ID belongs to exactly one provider. Ambiguous legacy/raw
    // IDs retain the old Tbilisi-first fallback order.
    const attemptOrder = explicitSource
        ? [explicitSource]
        : [defaultSource, ...sources.filter(s => s.id !== defaultSource.id)];

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
    // Non-default sources prefer the validated static route graph. This preserves
    // local corrections and prevents an ID from falling through to another city.
    const inferredSource = sources.find(source => source.id === sourceId)
        || sourceForAppId(stopId, sources, defaultSource);
    if (inferredSource.id !== defaultSource.id) {
        await preloadStaticRoutesDetails();
        if (staticStopToRoutes.has(stopId)) {
            const routeIds = Array.from(staticStopToRoutes.get(stopId));
            if (routeIds.length > 0) {
                const routes = routeIds
                    .map(rid => staticRouteDetails.get(rid))
                    .filter(Boolean)
                    .map(rd => processRoute(rd, inferredSource));
                routes._sourceId = inferredSource.id;
                return routes;
            }
        }
        return [];
    }

    // Note: Routes from Convex getRoutes don't include stops arrays.
    // We must use the V2 API endpoint which returns routes for a specific stop.
    const urlGen = (s, id) => `${getApiBaseUrl(s)}/stops/${encodeURIComponent(id)}/routes?locale=${getActiveLocale()}`;
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
    const urlGen = (s, id) => `${getApiV3BaseUrl(s)}/routes/${encodeURIComponent(id)}/schedule?patternSuffix=0:01&locale=${getActiveLocale()}`;
    return fetchFromSmartSource(urlGen, routeId);
}

export async function fetchMetroSchedulePattern(routeId, patternSuffix) {
    const urlGen = (s, id) => `${getApiV3BaseUrl(s)}/routes/${id}/schedule?patternSuffix=${patternSuffix}&locale=${getActiveLocale()}`;
    return fetchFromSmartSource(urlGen, routeId);
}

// V3 Routes List - uses file-backed fetchRoutes
export async function fetchV3Routes() {
    // console.debug('[API DEBUG] fetchV3Routes: Delegating to fetchRoutes()');
    return fetchRoutes({ strategy: 'cache-first' });
}
// --- Global Overrides Cache ---
let globalOverridesCache = null;
let overridesPromise = null;

export function invalidateRouteOverridesCache() {
    globalOverridesCache = null;
    overridesPromise = null;
}

export async function fetchAllOverrides() {
    if (globalOverridesCache) return globalOverridesCache;
    if (overridesPromise) return overridesPromise;

    overridesPromise = (async () => {
        try {
            console.log('[API] Fetching route overrides from CSV...');
            let csvText = await getOtaDataFileText('routes_overrides.csv');
            if (!csvText) {
                const basePath = import.meta.env.BASE_URL.endsWith('/') ? import.meta.env.BASE_URL : `${import.meta.env.BASE_URL}/`;
                const response = await fetch(`${basePath}data/routes_overrides.csv`);
                if (!response.ok) {
                    if (response.status === 404) {
                        globalOverridesCache = new Map();
                        return globalOverridesCache;
                    }
                    throw new Error(`Failed to load routes_overrides.csv: ${response.status}`);
                }
                csvText = await response.text();
            }
            const { parseCSV, extractOverrides } = await import('./csv-parser.js');
            const overrides = extractOverrides(parseCSV(csvText), 'id');
            globalOverridesCache = new Map(Object.entries(overrides));
            console.log(`[API] Loaded ${globalOverridesCache.size} overrides.`);
            return globalOverridesCache;
        } catch (e) {
            console.warn('[API] Failed to fetch route overrides CSV', e);
            globalOverridesCache = new Map();
            return globalOverridesCache;
        } finally {
            overridesPromise = null;
        }
    })();
    return overridesPromise;
}

function formatRouteOverrides(overrides) {
    if (!overrides) return null;
    return {
        isLoop: overrides.isLoop,
        invertDirection: overrides.invertDirection,
        destinations: [
            {
                headsign: {
                    en: overrides.dest0EnOverride || overrides.dest0En || overrides.destinations?.[0]?.headsign?.en,
                    ka: overrides.dest0KaOverride || overrides.dest0Ka || overrides.destinations?.[0]?.headsign?.ka,
                    ru: overrides.dest0RuOverride || overrides.dest0Ru || overrides.destinations?.[0]?.headsign?.ru
                }
            },
            {
                headsign: {
                    en: overrides.dest1EnOverride || overrides.dest1En || overrides.destinations?.[1]?.headsign?.en,
                    ka: overrides.dest1KaOverride || overrides.dest1Ka || overrides.destinations?.[1]?.headsign?.ka,
                    ru: overrides.dest1RuOverride || overrides.dest1Ru || overrides.destinations?.[1]?.headsign?.ru
                }
            }
        ],
        terminusStopId: overrides.terminusStopId,
        terminusStopId_override: overrides.terminusStopIdOverride || overrides.terminusStopId_override,
        terminusStopIdOverride: overrides.terminusStopIdOverride || overrides.terminusStopId_override,
        virtualTerminusStopId: overrides.virtualTerminusStopId
    };
}

function matchOverride(routeId) {
    if (!globalOverridesCache) return null;

    // Exact match
    if (globalOverridesCache.has(routeId)) return globalOverridesCache.get(routeId);

    const stripped = String(routeId).replace(/^[12]:/, '').replace(/^r(?=R)/, '');
    const variations = [
        stripped,
        `1:${stripped}`,
        `2:${stripped}`,
        `r${stripped}`
    ];

    for (const v of variations) {
        if (globalOverridesCache.has(v)) return globalOverridesCache.get(v);
    }
    return null;
}

export async function fetchRouteDetailsV3(routeId, options = {}) {
    if (!routeId) return null;

    // console.log(`[API DEBUG] fetchRouteDetailsV3: ${routeId}`);

    // 2. Fetch Overrides (Lazy Load Global Cache)
    if (!globalOverridesCache) {
        try {
            await fetchAllOverrides();
        } catch (e) {
            console.warn('[API] Failed to load global overrides, proceeding with static data only', e);
        }
    }

    // 3. Get Base Static Data
    // Ensure static routes are loaded
    await preloadStaticRoutesDetails();

    let route = getStaticRouteDetails(routeId);
    if (!route) {
        // console.warn(`[API] fetchRouteDetailsV3: Route ${routeId} not found in static index.`);
        return null;
    }

    // Clone to avoid mutating shared static cache
    // Deep clone needed because we might modify patterns/stops
    route = JSON.parse(JSON.stringify(route));

    // 4. Apply Overrides
    if (globalOverridesCache) {
        const overrides = matchOverride(routeId);
        if (overrides) {
            // console.log(`[API] Applied overrides for ${routeId}`, overrides);
            if (overrides.shortName) route.shortName = overrides.shortName;
            if (overrides.isLoop !== undefined) route.isLoop = overrides.isLoop;
            if (overrides.invertDirection !== undefined) route.invertDirection = overrides.invertDirection;

            // Locale specific names
            const locale = options.locale || getActiveLocale();
            if (locale === 'en' && overrides.longNameEnOverride) route.longName = overrides.longNameEnOverride;
            else if (locale === 'ka' && overrides.longNameKaOverride) route.longName = overrides.longNameKaOverride;
            else if (locale === 'ru' && overrides.longNameRuOverride) route.longName = overrides.longNameRuOverride;

            route._overrides = formatRouteOverrides(overrides);
        }
    }

    // 5. Loop Virtualization (Client-Side Logic)
    if (route.patterns && route.patterns.length === 1) {
        const originalPattern = route.patterns[0];
        try {
            // Ensure stops are processed
            let stops = originalPattern.stops;

            // Unloop if geometry detects loop OR if override explicitly says so
            if (stops && (RouteGeometry.isLoop(stops, route.shortName) || route._overrides?.isLoop === true)) {
                let forcedId = null;
                if (route._overrides) {
                    forcedId = route._overrides.terminusStopId_override ||
                        route._overrides.terminusStopId ||
                        route._overrides.virtualTerminusStopId;
                }
                const virtualPatterns = RouteGeometry.generateVirtualPatterns(
                    originalPattern,
                    stops,
                    route.longName,
                    forcedId
                );
                route.patterns = virtualPatterns;
                v3Cache.patterns.set(route.id, virtualPatterns);
            } else {
                if (stops && stops.length > 5 && route._overrides?.isLoop) {
                    console.warn(`[API] Loop Detection FAILED for ${route.id} despite override saying isLoop=true. Stops: ${stops.length}, First: ${stops[0]?.id}, Last: ${stops[stops.length - 1]?.id}`);
                }
            }
        } catch (e) {
            console.warn(`[API] Failed to check loop status for ${route.id}`, e);
        }
    }

    return route;



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
        if (details._stopsOfPatterns && Array.isArray(details._stopsOfPatterns)) {
            const source = sources.find(s => s.id === details._sourceId);
            const stopsForPattern = details._stopsOfPatterns
                .filter(entry => !realSuffix || entry.patternSuffixes?.includes(realSuffix))
                .map(entry => processStop(entry.stop, source))
                .filter(Boolean);
            if (stopsForPattern.length > 0) {
                return stopsForPattern;
            }
        }
    }

    // 2b. For non-default sources, validated pattern stops are authoritative.
    const routeSource = sourceForAppId(routeId, sources, defaultSource);
    if (routeSource.id !== defaultSource.id && staticRouteDetails.has(routeId)) {
        const details = staticRouteDetails.get(routeId);
        if (details._stopsOfPatterns && Array.isArray(details._stopsOfPatterns)) {
            const source = sources.find(s => s.id === (details._sourceId || routeSource.id));
            const stopsForPattern = details._stopsOfPatterns
                .filter(entry => !realSuffix || entry.patternSuffixes?.includes(realSuffix))
                .map(entry => processStop(entry.stop, source));
            if (stopsForPattern.length > 0) {
                return stopsForPattern;
            }
        }
    }

    const urlGen = (s, id) => `${getApiV3BaseUrl(s)}/routes/${encodeURIComponent(id)}/stops?patternSuffix=${encodeURIComponent(realSuffix)}`;
    let raw;
    try {
        if (options.strategy === 'cache-only') {
            raw = await fetchStaticFallback(urlGen(routeSource, routeId));
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

const batumiPositionsCache = new Map();
const BATUMI_POSITIONS_TTL = 4000;

async function fetchBatumiPositions(routeId, source) {
    const apiRouteId = restoreApiId(routeId, source);
    const cacheKey = `${source.id}:${apiRouteId}`;
    const cached = batumiPositionsCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < BATUMI_POSITIONS_TTL) return cached.data;

    const url = `${getApiBaseUrl(source)}/api/getBusLocsOnRoute?routeId=${encodeURIComponent(apiRouteId)}`;
    const response = await fetch(url, {
        headers: { accept: 'application/json, text/plain, */*' },
        credentials: 'omit',
        mode: 'cors'
    });
    if (!response.ok) throw new Error(`Batumi positions failed: ${response.status}`);
    const payload = await response.json();
    const positions = (Array.isArray(payload?.data) ? payload.data : []).map(bus => ({
        lat: Number(bus.Lat ?? bus.lat),
        lon: Number(bus.Lon ?? bus.lon),
        heading: Number.isFinite(Number(bus.Heading ?? bus.heading)) ? Number(bus.Heading ?? bus.heading) : 0,
        vehicleId: namespaceVehicleId(bus.Name || bus.id || '', source),
        _batumiStatus: Number(bus.Status),
        _source: source.id
    })).filter(bus => Number.isFinite(bus.lat) && Number.isFinite(bus.lon));
    batumiPositionsCache.set(cacheKey, { data: positions, timestamp: Date.now() });
    return positions;
}

function groupBatumiPositionsBySuffix(positions, suffixes) {
    const output = {};
    for (const suffix of suffixes) {
        const realSuffix = suffix.includes('_PART') ? suffix.split('_PART')[0] : suffix;
        output[suffix] = positions.filter(bus =>
            bus._batumiStatus > 0 && batumiPatternSuffix(bus._batumiStatus) === realSuffix
        );
    }
    return output;
}

export async function fetchBusPositionsV3(routeId, patternSuffix) {
    // Handle virtual suffix for positions too?
    // Buses don't have virtual patterns. They are on the global route.
    // We should map virtual suffix to real suffix.
    const realSuffix = patternSuffix.includes('_PART') ? patternSuffix.split('_PART')[0] : patternSuffix;

    const routeSource = sourceForAppId(routeId, sources, defaultSource);
    if (routeSource?.adapter === 'batumi') {
        try {
            return groupBatumiPositionsBySuffix(await fetchBatumiPositions(routeId, routeSource), [patternSuffix]);
        } catch (error) {
            console.warn(`[Batumi] Positions failed for ${routeId}`, error);
            return { [patternSuffix]: [] };
        }
    }

    const urlGen = (s, id) => `${getApiV3BaseUrl(s)}/routes/${encodeURIComponent(id)}/positions?patternSuffixes=${encodeURIComponent(realSuffix)}`;

    async function tryFetch(source) {
        // Use restoreApiId!!!!
        const apiId = restoreApiId(routeId, source);
        const url = urlGen(source, apiId);
        const res = await fetch(url, { headers: { 'x-api-key': API_KEY } });
        if (!res.ok) throw new Error('Not OK');
        const data = await res.json();
        Object.values(data || {}).forEach(positions => {
            if (!Array.isArray(positions)) return;
            positions.forEach(position => {
                position._source = source.id;
                position.vehicleId = namespaceVehicleId(position.vehicleId, source);
                if (position.nextStopId) position.nextStopId = processId(position.nextStopId, source);
            });
        });

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
        return await tryFetch(routeSource);
    } catch (e) {
        // Explicitly namespaced IDs must never leak into another provider.
        if (routeSource !== defaultSource) return [];
    }
    return [];
}

export async function fetchBusPositionsV3Multi(routeId, patternSuffixes = []) {
    const requested = Array.isArray(patternSuffixes) ? patternSuffixes.filter(Boolean) : [];
    if (requested.length === 0) return {};

    const routeSource = sourceForAppId(routeId, sources, defaultSource);
    if (routeSource?.adapter === 'batumi') {
        try {
            return groupBatumiPositionsBySuffix(await fetchBatumiPositions(routeId, routeSource), requested);
        } catch (error) {
            console.warn(`[Batumi] Positions failed for ${routeId}`, error);
            return Object.fromEntries(requested.map(suffix => [suffix, []]));
        }
    }

    const aliases = {};
    const realSuffixesSet = new Set();
    requested.forEach((s) => {
        if (s.includes('_PART')) {
            const real = s.split('_PART')[0];
            aliases[s] = real;
            realSuffixesSet.add(real);
        } else {
            realSuffixesSet.add(s);
        }
    });

    const realSuffixesStr = Array.from(realSuffixesSet).join(',');
    const urlGen = (s, id) => `${getApiV3BaseUrl(s)}/routes/${encodeURIComponent(id)}/positions?patternSuffixes=${encodeURIComponent(realSuffixesStr)}`;

    async function tryFetch(source) {
        const apiId = restoreApiId(routeId, source);
        const url = urlGen(source, apiId);
        const res = await fetch(url, { headers: { 'x-api-key': API_KEY } });
        if (!res.ok) throw new Error('Not OK');
        const data = await res.json();
        Object.values(data || {}).forEach(positions => {
            if (!Array.isArray(positions)) return;
            positions.forEach(position => {
                position._source = source.id;
                position.vehicleId = namespaceVehicleId(position.vehicleId, source);
                if (position.nextStopId) position.nextStopId = processId(position.nextStopId, source);
            });
        });
        const out = { ...data };
        Object.keys(aliases).forEach((virtual) => {
            const real = aliases[virtual];
            if (out[real] && !out[virtual]) out[virtual] = out[real];
        });
        return out;
    }

    try {
        return await tryFetch(routeSource);
    } catch (e) {
        if (routeSource !== defaultSource) return {};
    }
    return {};
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
        const sourceConfig = sourceForAppId(routeId, sources, defaultSource);
        const sourceId = sourceConfig.id;
        const appRouteId = processId(routeId, sourceConfig);

        const cache = await getStaticCache(sourceId, 'polylines');
        if (cache) {
            const tempPolylineData = {};
            for (const suffix of realSuffixesSet) {
                const candidateKeys = staticRouteResourceKeys(routeId, suffix, sourceConfig, sources);
                const matchedKey = candidateKeys.find(key => cache[key]);
                if (matchedKey) {
                    Object.assign(tempPolylineData, cache[matchedKey]);
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
                polylineData = await fetchStaticFallback(urlGen(sourceForAppId(routeId, sources, defaultSource), routeId));
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

                    // Look for split point: explicit option > cache
                    let splitPoint = null;
                    if (options.splitPoint) {
                        splitPoint = options.splitPoint;
                        console.log(`[API] Using explicit split point for ${virtual}:`, splitPoint);
                    } else if (cachedPatterns) {
                        const p = cachedPatterns.find(pat => pat.patternSuffix === virtual);
                        if (p && p._splitPoint) {
                            splitPoint = p._splitPoint;
                            console.log(`[API] Using cached split point for ${virtual}:`, splitPoint.id);
                        }
                    }

                    // Slice using simple geometry midpoint (no stops needed currently)
                    const sliced = RouteGeometry.slicePolyline(fullPolylinePoints, virtual, splitPoint);
                    console.log(`[API] Sliced ${virtual}: ${sliced ? sliced.length : 'null'} points (Original: ${fullPolylinePoints.length})`);
                    polylineData[virtual] = sliced;
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
const ARRIVALS_REQUEST_HEADERS = {
    'accept': 'application/json, text/plain, */*',
    'accept-language': 'en-US,en;q=0.9',
    'x-api-key': API_KEY
};

function getCachedArrivals(cacheKey) {
    const cached = arrivalsCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < ARRIVALS_CACHE_TTL) {
        return cached.data;
    }
    return null;
}

function setCachedArrivals(cacheKey, data) {
    arrivalsCache.set(cacheKey, { data, timestamp: Date.now() });
}

function buildArrivalsFetchOptions() {
    return {
        headers: ARRIVALS_REQUEST_HEADERS,
        // Proxy deployments return wildcard ACAO, so browser arrivals requests
        // must remain non-credentialed.
        credentials: 'omit',
        mode: 'cors'
    };
}

async function fetchArrivalTimesJson(url) {
    const res = await fetch(url, buildArrivalsFetchOptions());
    return res;
}

const batumiLiveRouteCache = new Map();
const BATUMI_LIVE_ROUTE_TTL = 30000;

function batumiPatternSuffix(status) {
    const numericStatus = Number(status);
    return `${Number.isFinite(numericStatus) ? Math.max(0, numericStatus - 1) : 0}:01`;
}

async function fetchBatumiRouteLive(source, routeId) {
    const apiRouteId = restoreApiId(routeId, source);
    const cacheKey = `${source.id}:${apiRouteId}`;
    const cached = batumiLiveRouteCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < BATUMI_LIVE_ROUTE_TTL) return cached.data;

    const url = `${getApiBaseUrl(source)}/api/getLiveData?routeId=${encodeURIComponent(apiRouteId)}`;
    const response = await fetch(url, {
        headers: { accept: 'application/json, text/plain, */*' },
        credentials: 'omit',
        mode: 'cors'
    });
    if (!response.ok) throw new Error(`Batumi live route failed: ${response.status}`);
    const payload = await response.json();
    const data = payload?.data || {};
    batumiLiveRouteCache.set(cacheKey, { data, timestamp: Date.now() });
    return data;
}

async function fetchBatumiArrivalsForStop(stopId, source, routeId = null, limit = 30) {
    await preloadStaticRoutesDetails();
    const routeIds = routeId
        ? [processId(routeId, source)]
        : Array.from(staticStopToRoutes.get(stopId) || []);
    const upstreamStopId = restoreApiId(stopId, source);

    const results = await Promise.all(routeIds.map(async appRouteId => {
        try {
            const details = getStaticRouteDetails(appRouteId);
            const live = await fetchBatumiRouteLive(source, appRouteId);
            const arrivalEntries = Array.isArray(live.arrivalTime)
                ? live.arrivalTime
                : Object.values(live.arrivalTime || {});
            const stopArrival = arrivalEntries.find(entry => String(entry?.stop_id) === String(upstreamStopId));
            if (!stopArrival?.arrival_times) return [];

            const stopEntry = details?._stopsOfPatterns?.find(entry =>
                String(restoreApiId(entry?.stop?.id || '', source)) === String(upstreamStopId)
            );
            const fallbackSuffix = stopEntry?.patternSuffixes?.[0] || '0:01';
            const busesById = new Map((Array.isArray(live.buses) ? live.buses : Object.values(live.buses || {}))
                .filter(Boolean)
                .map(bus => [String(bus.id || bus._id || bus.name || ''), bus]));

            return Object.values(stopArrival.arrival_times).flatMap(value => {
                if (!value || !Number.isFinite(Number(value.minute))) return [];
                const bus = busesById.get(String(value.bus_id || ''));
                const suffix = bus?.bus_info?.status !== undefined
                    ? batumiPatternSuffix(bus.bus_info.status)
                    : fallbackSuffix;
                const pattern = details?.patterns?.find(candidate => candidate.patternSuffix === suffix);
                return [{
                    id: appRouteId,
                    routeId: appRouteId,
                    shortName: details?.shortName || '',
                    longName: details?.longName || '',
                    headsign: pattern?.headsign || details?.longName || '',
                    patternSuffix: suffix,
                    vehicleMode: 'BUS',
                    realtime: true,
                    realtimeArrivalMinutes: Number(value.minute),
                    scheduledArrivalMinutes: Number(value.minute),
                    vehicleId: namespaceVehicleId(value.bus_id || value.bus_name || '', source),
                    _sourceStopId: stopId,
                    _source: source.id
                }];
            });
        } catch (error) {
            console.warn(`[Batumi] Live arrivals failed for ${appRouteId}`, error);
            return [];
        }
    }));

    return results.flat()
        .sort((a, b) => a.realtimeArrivalMinutes - b.realtimeArrivalMinutes)
        .slice(0, limit);
}

export async function fetchRouteArrivalsForStop(stopId, routeId) {
    if (!stopId || !routeId) return [];

    const cacheKey = `${stopId}|${routeId}`;
    const cached = getCachedArrivals(cacheKey);
    if (cached) return cached;

    const routedSource = sourceForAppId(stopId, sources, defaultSource);
    if (routedSource?.adapter === 'batumi') {
        const arrivals = await fetchBatumiArrivalsForStop(stopId, routedSource, routeId, 5);
        setCachedArrivals(cacheKey, arrivals);
        return arrivals;
    }

    async function tryFetch(source) {
        const apiStopId = restoreApiId(stopId, source);
        const apiRouteId = restoreApiId(routeId, source);
        const url = `${getApiBaseUrl(source)}/stops/${encodeURIComponent(apiStopId)}/arrival-times?routeId=${encodeURIComponent(apiRouteId)}&maxNumberOfArrivalTimes=5&locale=${getActiveLocale()}&ignoreScheduledArrivalTimes=false`;
        const res = await fetchArrivalTimesJson(url);
        if (!res.ok) throw new Error(`Fail: ${res.status}`);
        const arrivals = await res.json();
        const taggedArrivals = Array.isArray(arrivals) ? arrivals.map(a => ({ ...a, _sourceStopId: stopId })) : [];
        setCachedArrivals(cacheKey, taggedArrivals);
        return taggedArrivals;
    }

    const bestSource = sourceForAppId(stopId, sources, defaultSource);

    try {
        return await tryFetch(bestSource);
    } catch (e) {
        if (bestSource !== defaultSource) throw e;
        for (const source of sources) {
            if (source.id === bestSource.id) continue;
            try {
                return await tryFetch(source);
            } catch (_) { }
        }
        throw e;
    }
}

/**
 * Fetch arrivals for a list of stop IDs in parallel.
 * UPDATED: Uses 30-second cache to reduce API requests.
 * @param {string[]} ids
 * @returns {Promise<Array>} Combined flat list of arrivals
 */
export async function fetchArrivalsForStopIds(ids, options = {}) {
    console.log(`[fetchArrivalsForStopIds] Input IDs:`, ids);
    const requestedMaxArrivalTimes = Number(options.maxNumberOfArrivalTimes);
    const maxNumberOfArrivalTimes = Number.isFinite(requestedMaxArrivalTimes) && requestedMaxArrivalTimes > 0
        ? Math.round(requestedMaxArrivalTimes)
        : 30;
    const promises = ids.map(async (id) => {
        // Check cache first
        const stopCacheKey = `${id}|stop|${maxNumberOfArrivalTimes}`;
        const cached = getCachedArrivals(stopCacheKey);
        if (cached) {
            console.log(`[fetchArrivalsForStopIds] Cache HIT for ${id}`);
            return cached;
        }

        const routedSource = sourceForAppId(id, sources, defaultSource);
        if (routedSource?.adapter === 'batumi') {
            try {
                const arrivals = await fetchBatumiArrivalsForStop(id, routedSource, null, maxNumberOfArrivalTimes);
                setCachedArrivals(stopCacheKey, arrivals);
                return arrivals;
            } catch (error) {
                console.warn(`[Batumi] Failed to fetch arrivals for ${id}`, error);
                return [];
            }
        }

        // Use smart source fetch logic
        // We need a custom url generator for arrivals
        const urlGen = (s, i) => `${getApiBaseUrl(s)}/stops/${encodeURIComponent(i)}/arrival-times?locale=${getActiveLocale()}&ignoreScheduledArrivalTimes=false&maxNumberOfArrivalTimes=${maxNumberOfArrivalTimes}`;
        try {
            // Custom Smart Fetch for Live Data
            async function tryFetch(source) {
                const apiId = restoreApiId(id, source);
                const url = urlGen(source, apiId);
                console.log(`[fetchArrivalsForStopIds] Trying ${source.id}: id=${id} -> apiId=${apiId}, URL=${url}`);
                const res = await fetchArrivalTimesJson(url);
                console.log(`[fetchArrivalsForStopIds] Response for ${apiId}: status=${res.status}`);
                if (!res.ok) throw new Error(`Fail: ${res.status}`);
                const arrivals = await res.json();
                // Tag each arrival with the source stop ID so we know which stop it came from
                const taggedArrivals = Array.isArray(arrivals) ? arrivals.map(a => ({ ...a, _sourceStopId: id })) : [];
                // Cache the result
                setCachedArrivals(stopCacheKey, taggedArrivals);
                return taggedArrivals;
            }

            // Source Detection Logic:
            // Find the best source to try first based on ID prefix
            const bestSource = sourceForAppId(id, sources, defaultSource);

            try {
                return await tryFetch(bestSource);
            } catch (e) {
                if (bestSource !== defaultSource) throw e;
                // Try others
                for (const source of sources) {
                    if (source.id === bestSource.id) continue;
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
    const flat = results.flat();

    // --- Arrivals Blocklist ---
    // Filter out live arrivals for (stop, route) combos that have been manually
    // removed from the schedule in static data. The live Rustavi API will still
    // report real-time positions for these buses, but we suppress them here.
    const arrivalsBlocklist = getArrivalsBlocklist();
    if (arrivalsBlocklist.size > 0) {
        return flat.filter(arrival => {
            const stopId = arrival._sourceStopId;
            if (!stopId) return true;
            const blockedRoutes = arrivalsBlocklist.get(stopId) ||
                arrivalsBlocklist.get(processId(stopId, sources.find(s => s.id === 'rustavi')));
            if (!blockedRoutes) return true;
            const shortName = arrival.shortName || arrival.routeShortName;
            return !blockedRoutes.has(shortName);
        });
    }

    return flat;
}

/**
 * Returns a Map<stopId, Set<shortName>> of route arrivals to suppress.
 * Built from staticStopToRoutes: if a stop no longer has a route in the
 * static index, any live arrivals for that route at that stop are blocked.
 * Also contains hardcoded overrides for manually removed route-stop pairs.
 */
export function getArrivalsBlocklist() {
    // Hardcoded blocklist: Rustavi bus 23 (shortName '23') and bus 24 (shortName '24')
    // stops that were manually removed from their schedules.
    // Stop IDs in normalized 'r...' format (prefix stripped from '1:XXXXX').
    // Each entry: stopId -> Set of route short names to suppress at that stop.
    const blocklist = new Map([
        // ოპერის თეატრი — two IDs exist for this name
        ['r17017', new Set(['23', '24'])],
        ['r17025', new Set(['23', '24'])],
        // მ/ს "თავისუფლების მოედანი" / თავისუფლების მოედანი
        ['r17042', new Set(['23', '24'])],
        ['r17102', new Set(['23', '24'])],
        // მ/ს "რუსთაველი" — two IDs
        ['r17068', new Set(['23', '24'])],
        ['r17107', new Set(['23', '24'])],
        // ფილარმონია — three IDs
        ['r17024', new Set(['23', '24'])],
        ['r17098', new Set(['23', '24'])],
        ['r17106', new Set(['23', '24'])],
        // პირველი კლასიკური გიმნაზია — two IDs
        ['r17087', new Set(['23', '24'])],
        ['r17100', new Set(['23', '24'])],
        // სიმონ ჯანაშიას ქუჩა — two IDs (Bus 24 only)
        ['r17099', new Set(['24'])],
        ['r17112', new Set(['24'])],
    ]);
    return blocklist;

}

// Helper to manage V3 in-flight promises
const v3InFlight = {
    patterns: new Map(),
    schedules: new Map()
};

function getRouteSourceCandidates(routeId) {
    const candidates = [];
    const addSource = (sourceId) => {
        const source = sources.find(s => s.id === sourceId);
        if (source && !candidates.some(existing => existing.id === source.id)) {
            candidates.push(source);
        }
    };

    const staticDetails = getStaticRouteDetails(routeId);
    if (staticDetails?._sourceId) {
        addSource(staticDetails._sourceId);
    }

    addSource(sourceForAppId(routeId, sources, defaultSource)?.id);

    sources.forEach(source => addSource(source.id));
    return candidates;
}

export async function getStaticScheduleForRouteSuffix(routeId, suffix) {
    const sourceCandidates = getRouteSourceCandidates(routeId);
    const misses = [];

    for (const sourceConfig of sourceCandidates) {
        const cache = await getStaticCache(sourceConfig.id, 'schedules');
        if (!cache) {
            misses.push({ sourceId: sourceConfig.id, reason: 'cache-missing' });
            continue;
        }

        const safeSuffix = suffix.replace(/:/g, '_').replace(/,/g, '-');
        const appRouteId = processId(routeId, sourceConfig);
        const apiRouteId = restoreApiId(appRouteId, sourceConfig);
        const keys = [`${appRouteId}_${safeSuffix}`, `${apiRouteId}_${safeSuffix}`, `${routeId}_${safeSuffix}`];
        for (const key of keys) {
            if (cache[key]) {
                console.log('[ScheduleDebug] Static schedule hit', {
                    routeId,
                    suffix,
                    sourceId: sourceConfig.id,
                    key,
                    entries: Array.isArray(cache[key]) ? cache[key].length : null
                });
                return cache[key];
            }
        }

        misses.push({
            sourceId: sourceConfig.id,
            keys,
            sampleKeys: Object.keys(cache).filter(key => key.includes(String(routeId).replace(/^1:/, ''))).slice(0, 10)
        });
    }

    console.warn('[ScheduleDebug] Static schedule miss', {
        routeId,
        suffix,
        sourceCandidates: sourceCandidates.map(source => source.id),
        misses
    });
    return null;
}

export async function fetchScheduleForStop(routeId, stopIds, explicitSuffix = null, options = {}) {
    if (!routeId || !stopIds || stopIds.length === 0) return null;
    const routeSource = sourceForAppId(routeId, sources, defaultSource);
    const normalizeForRoute = (id) => processId(String(id || ''), routeSource);

    // 1. Get Patterns with Stops (Association Data)
    // Use separate cache key to avoid collision with full route details patterns
    let patterns = v3Cache.stopPatterns.get(routeId);
    let routeDataForPrioritization = null;

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
                        const source = sources.find(s => s.id === (routeData._sourceId || routeData._source || 'tbilisi'));
                        return routeData._stopsOfPatterns.map(p => ({
                            ...p,
                            stop: processStop(p.stop, source)
                        }));
                    }

                    if (routeData.patterns) {
                        const suffixes = routeData.patterns.map(p => p.patternSuffix).join(',');
                        const urlGen = (s, id) => `${getApiV3BaseUrl(s)}/routes/${id}/stops-of-patterns?patternSuffixes=${suffixes}&locale=${getActiveLocale()}`;
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
                    for (const sourceConfig of getRouteSourceCandidates(routeId)) {
                        const sourceId = sourceConfig.id;
                        const locale = getActiveLocale();
                        let cache = await getStaticCache(sourceId, `${sourceId}_routes_details_${locale}.json`);
                        if (!cache && locale !== 'en') {
                            cache = await getStaticCache(sourceId, `${sourceId}_routes_details_en.json`);
                        }
                        if (!cache) continue;

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
        }
    }

    if (!patterns) {
        console.warn('[ScheduleDebug] No stop-pattern data', { routeId, stopIds, explicitSuffix, strategy: options.strategy });
        return null;
    }

    const stopEntry = patterns.find((p, idx) => {
        if (!p || !p.stop) return false;
        const pId = String(p.stop.id);
        const pCode = String(p.stop.code || '');
        return stopIds.some(targetId => {
            const targetStr = String(targetId);
            if (targetStr === pId) return true;
            if (normalizeForRoute(targetStr) === normalizeForRoute(pId)) return true;
            if (pCode && normalizeForRoute(pCode) === normalizeForRoute(targetStr)) return true;
            return false;
        });
    });

    if (!stopEntry || !stopEntry.patternSuffixes.length) {
        console.warn('[ScheduleDebug] Stop not found in pattern associations', {
            routeId,
            stopIds,
            explicitSuffix,
            strategy: options.strategy,
            patternCount: patterns.length,
            sampleStops: patterns.slice(0, 8).map(p => ({
                id: p?.stop?.id,
                code: p?.stop?.code,
                suffixes: p?.patternSuffixes
            }))
        });
        return null;
    }

    // --- Suffix Selection ---
    let suffix = explicitSuffix;
    if (!suffix || !stopEntry.patternSuffixes.includes(suffix)) {
        if (explicitSuffix) {
            console.warn('[ScheduleDebug] Explicit suffix not valid for stop; falling back', {
                routeId,
                stopIds,
                explicitSuffix,
                stopSuffixes: stopEntry.patternSuffixes
            });
        }
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
                    const isLast = stopIds.some(sid => normalizeForRoute(sid) === normalizeForRoute(p.lastStop.id));
                    return !isLast;
                });
                if (nonTerminus) suffix = nonTerminus;
            }
        }
    }

    const cacheKey = `${routeId}:${suffix}`;
    let schedule = v3Cache.schedules.get(cacheKey);

    if (!schedule) {
        try {
            schedule = await getStaticScheduleForRouteSuffix(routeId, suffix);
            if (schedule) {
                v3Cache.schedules.set(cacheKey, schedule);
            }
        } catch (e) { }
    }

    if (!schedule) {
        const keySafe = cacheKey.replace(/:/g, '_');
        const lsKey = `v3_sched_${keySafe}`;
        try {
            const cached = await db.get(lsKey);
            if (cached && (Date.now() - cached.timestamp < V3_SCHEDULE_CACHE_TTL)) {
                schedule = cached.data;
                v3Cache.schedules.set(cacheKey, schedule);
            }
        } catch (e) { }
    }

    if (!schedule) {
        if (options.strategy === 'cache-only') {
            return null;
        }

        if (v3InFlight.schedules.has(cacheKey)) {
            schedule = await v3InFlight.schedules.get(cacheKey);
        } else {
            const promise = (async () => {
                const urlGen = (s, id) => `${getApiV3BaseUrl(s)}/routes/${id}/schedule?patternSuffix=${suffix}&locale=${getActiveLocale()}`;
                try {
                    const schRes = await fetchFromSmartSource(urlGen, routeId);
                    if (!schRes) throw new Error(`Schedule fetch failed`);
                    return schRes;
                } catch (e) {
                    try {
                        const staticSchedule = await getStaticScheduleForRouteSuffix(routeId, suffix);
                        if (staticSchedule) return staticSchedule;
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
                        await rememberScheduleCacheKey(routeId, suffix);
                    } catch (e) { }
                }
            } catch (e) {
            } finally {
                v3InFlight.schedules.delete(cacheKey);
            }
        }
    }

    if (!schedule) {
        console.warn('[ScheduleDebug] No schedule resolved', { routeId, stopIds, explicitSuffix, selectedSuffix: suffix, strategy: options.strategy });
        return null;
    }

    return { schedule, patternSuffix: suffix };
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
        const routeSource = sourceForAppId(routeId, sources, defaultSource);
        const normalize = (id) => processId(String(id || ''), routeSource);
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
                    id: processId(String(stops[i].id), routeSource),
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
