import * as api from './api.js';

/**
 * Ensures a list of routes has full V3 details (patterns and stops).
 * Implements Strategy A (Stops in Patterns) and Strategy B (Fetch Stops by Suffix).
 * Modifies the route objects in-place by adding `_details`.
 * 
 * @param {Array} routes - Array of route objects from V2 API
 * @param {Object} [options] - Optional fetch options (e.g. strategy)
 */
export async function hydrateRouteDetails(routes, options = {}) {
    // Filter routes that need fetching
    const routesNeedingFetch = routes.filter(r => {
        // If it's already got patterns (e.g. from static preload), it's hydrated enough for filtering
        if (r._details && (r._details.patterns || r._details.stops)) return false;
        if (r.patterns && r.patterns.length > 0) return false;
        return true;
    });

    if (routesNeedingFetch.length === 0) return;

    // console.log(`[Fetch] Hydrating details for ${routesNeedingFetch.length} routes...`);

    // We can run these in parallel
    await Promise.all(routesNeedingFetch.map(async (r) => {
        try {
            // Fetch full route object via V3 API which has patterns and stops
            const routeDetails = await api.fetchRouteDetailsV3(r.id, options);
            r._details = routeDetails; // Store for usage

            if (routeDetails && routeDetails.patterns) {
                // Strategy A: Check if stops are already inside patterns (V3 standard)
                let foundStopsInPatterns = false;

                routeDetails.patterns.forEach(p => {
                    if (p.stops && p.stops.length > 0) {
                        foundStopsInPatterns = true;
                    }
                });

                // Strategy B: Fetch Stops by Suffix if A failed (stops missing in pattern object)
                if (!foundStopsInPatterns) {
                    await Promise.all(routeDetails.patterns.map(async (p) => {
                        try {
                            const stopsData = await api.fetchRouteStopsV3(r.id, p.patternSuffix, options);
                            let stopsList = [];
                            if (stopsData && Array.isArray(stopsData)) {
                                stopsList = stopsData;
                            } else if (stopsData && stopsData.stops) {
                                stopsList = stopsData.stops;
                            }

                            // Store back into pattern for uniform access
                            p.stops = stopsList;
                        } catch (err) {
                            console.warn(`[Fetch] Failed to fetch stops for suffix ${p.patternSuffix}`, err);
                        }
                    }));
                }
            } else if (routeDetails && routeDetails.stops) {
                r._details.stops = routeDetails.stops;
            }
        } catch (e) {
            console.warn(`[Fetch] Failed to fetch details for route ${r.id}`, e);
        }
    }));
}
