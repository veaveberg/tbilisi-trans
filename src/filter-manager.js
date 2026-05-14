import mapboxgl from 'mapbox-gl';
import { RouteFilterColorManager } from './color-manager.js';
import { addToHistory } from './history.js';
import * as api from './api.js';
import { hydrateRouteDetails } from './fetch.js';
import { shouldShowRoute } from './settings.js';
// We need these icons. Assuming Vite setup allows importing them here too.
import iconFilterOutline from './assets/icons/line.3.horizontal.decrease.circle.svg';
import iconFilterFill from './assets/icons/line.3.horizontal.decrease.circle.fill.svg';

// Shared Helper for Path Signature Generation
export function generatePathSignature(segmentStops, redirectMap, hubMap) {
    if (!segmentStops || segmentStops.length < 2) return null;

    return segmentStops
        .map(s => {
            let id = s.id || s;
            // Normalize Redirects first
            if (redirectMap) id = redirectMap.get(id) || id;
            // Normalize Hubs
            if (hubMap) return hubMap.get(id) || id;
            return id;
        })
        .filter((id, i, arr) => i === 0 || id !== arr[i - 1]) // Dedup adjacent
        .join('|');
}

export class FilterManager {
    constructor({ map, router, dataProvider, uiCallbacks }) {
        this.map = map;
        this.router = router;
        this.dataProvider = dataProvider;
        this.uiCallbacks = uiCallbacks;

        this.state = {
            active: false,
            picking: false,
            originId: null,
            context: null,
            originIdsOverride: null,
            originIdsFallback: null,
            targetIds: new Set(),
            reachableStopIds: new Set(),
            filteredRoutes: [], // Array of route IDs
            filteredRoutePatterns: null, // Optional Map of routeId -> Set(patternSuffix)
            allowedPatternSuffixes: null, // Optional Map of routeId -> Set(patternSuffix) to constrain segment direction
            allowedRouteIds: null // Optional Set of route IDs to constrain filtering
        };

        this.destinationMarkers = new Map(); // Map<stopId, Marker>
    }

    getEquivalentStops(id) {
        // Re-implementing helper from main.js using dataProvider
        const hubMap = this.dataProvider.getHubMap();
        const hubSourcesMap = this.dataProvider.getHubSourcesMap();
        const redirectMap = this.dataProvider.getRedirectMap();
        const mergeSourcesMap = this.dataProvider.getMergeSourcesMap();

        // 1. Check Hubs
        const parent = hubMap.get(id) || id;
        const children = hubSourcesMap.get(parent);
        if (children) {
            return Array.from(children);
        }

        // 2. Check Redirects
        const set = new Set();
        set.add(id);
        if (redirectMap.has(id)) set.add(redirectMap.get(id));
        if (mergeSourcesMap.has(id)) mergeSourcesMap.get(id).forEach(s => set.add(s));
        return Array.from(set);
    }

    async toggleFilterMode(currentStopId, isPickModeActive, setEditPickMode, options = {}) {
        const { forceEnable = false, skipFlyTo = false, allowedRouteIds = null, originIdsOverride = null, originIdsFallback = null, context = null } = options;
        // console.log('[FilterManager] toggleFilterMode. Active:', this.state.active, 'Picking:', this.state.picking, 'Stop:', currentStopId, 'forceEnable:', forceEnable);

        if (isPickModeActive && setEditPickMode) setEditPickMode(null);

        if (this.state.active || this.state.picking) {
            // If forceEnable is true and we're already filtering the same origin, don't toggle off
            if (forceEnable && this.state.originId === currentStopId) {
                console.log('[FilterManager] forceEnable: Already active for same origin, skipping toggle-off');
                return;
            }
            // Normal toggle behavior - turn off
            if (!forceEnable) {
                const restoreStop = this.state.context !== 'segment';
                this.clearFilter(currentStopId, { restoreStop });
                const btn = document.getElementById('filter-routes-toggle');
                if (btn) btn.classList.remove('active');
                return;
            }
            // forceEnable but different origin - clear and re-enable for new origin
            const restoreStop = this.state.context !== 'segment';
            this.clearFilter(currentStopId, { restoreStop });
        }

        if (!currentStopId) {
            console.warn('[FilterManager] No currentStopId, cannot filter');
            return;
        }

        this.state.picking = true;
        this.state.originId = currentStopId;
        if (context) this.state.context = context;
        if (Array.isArray(originIdsOverride)) {
            const originSet = originIdsOverride.map(id => String(id)).filter(Boolean);
            this.state.originIdsOverride = originSet.length > 0 ? new Set(originSet) : null;
        } else {
            this.state.originIdsOverride = null;
        }
        if (Array.isArray(originIdsFallback)) {
            const originSet = originIdsFallback.map(id => String(id)).filter(Boolean);
            this.state.originIdsFallback = originSet.length > 0 ? new Set(originSet) : null;
        } else {
            this.state.originIdsFallback = null;
        }
        if (Array.isArray(allowedRouteIds)) {
            this.state.allowedRouteIds = allowedRouteIds.length > 0 ? new Set(allowedRouteIds.map(id => String(id))) : null;
        }

        // UI Update
        const btn = document.getElementById('filter-routes-toggle');
        if (btn) {
            btn.classList.add('active');
            btn.querySelector('.filter-icon').src = iconFilterFill;
            btn.querySelector('.filter-text').textContent = t('selectDestinationStops');
        }

        // Camera
        const panel = document.getElementById('info-panel');
        if (panel) this.uiCallbacks.setSheetState(panel, 'peek');

        // Only fly to stop if not skipped (deep links handle camera with fitBounds)
        if (!skipFlyTo) {
            const hasMultipleOrigins = this.state.context === 'segment' &&
                this.state.originIdsOverride &&
                this.state.originIdsOverride.size > 1;
            if (hasMultipleOrigins) {
                const targetZoom = 13;
                const currentZoom = this.map.getZoom();
                const zoom = currentZoom > targetZoom ? targetZoom : currentZoom;
                this.map.flyTo({
                    center: this.map.getCenter(),
                    zoom,
                    duration: 900,
                    essential: true
                });
            } else {
            const allStops = this.dataProvider.getAllStops();
            const stop = allStops.find(s => s.id === currentStopId);
            if (stop) {
                const currentZoom = this.map.getZoom();

                // Enforce Zoom 14 for filter view to provide context, unless user is manually deeper?
                // User requested "zoom out somewhat", implying a standard context view.
                const targetZoom = 14;

                // Calculate Pan Offset
                const rotation = (stop.rotation || 0) * (Math.PI / 180);
                const R = 6371e3;
                const lat1 = stop.lat * (Math.PI / 180);
                const lon1 = stop.lon * (Math.PI / 180);
                const distance = 500; // Increased to 500m per request
                const lat2 = Math.asin(Math.sin(lat1) * Math.cos(distance / R) + Math.cos(lat1) * Math.sin(distance / R) * Math.cos(rotation));
                const lon2 = lon1 + Math.atan2(Math.sin(rotation) * Math.sin(distance / R) * Math.cos(lat1), Math.cos(distance / R) - Math.sin(lat1) * Math.sin(lat2));

                this.map.flyTo({
                    center: [lon2 * (180 / Math.PI), lat2 * (180 / Math.PI)],
                    zoom: targetZoom,
                    duration: 1500,
                    essential: true
                });
            }
            }
        }

        // Reachability Logic
        await this.updateReachableStops();
        if (this.state.context === 'segment' && this.state.allowedRouteIds && this.state.allowedRouteIds.size > 0 && this.state.reachableStopIds.size === 0) {
            // Try once more after hydrating route details from cache
            try {
                const allRoutes = this.dataProvider.getAllRoutes() || [];
                const routesToHydrate = allRoutes.filter(r => this.state.allowedRouteIds.has(String(r.id)));
                if (routesToHydrate.length > 0) {
                    await hydrateRouteDetails(routesToHydrate, { strategy: 'cache-only' });
                }
            } catch (e) { }
            await this.updateReachableStops();
        }

        // console.log(`[FilterManager] Pick Mode. Reachable: ${this.state.reachableStopIds.size}`);

        if (this.state.reachableStopIds.size === 0) {
            const hasRouteConstraint = this.state.allowedRouteIds && this.state.allowedRouteIds.size > 0;
            if (!hasRouteConstraint) {
                alert("No route data available for filtering (Stops list empty).");
            } else {
                console.warn('[FilterManager] No reachable stops for constrained routes.');
            }
            this.clearFilter(currentStopId, { restoreStop: !hasRouteConstraint });
            return;
        }

        this.updateMapFilterState();
    }

    async ensureLazyRoutesForStop(stopId, equivalentStopIdsSet) {
        const stopToRoutesMap = this.dataProvider.getStopToRoutesMap();
        const hydratedStops = this.dataProvider.getHydratedStops();
        const redirectMap = this.dataProvider.getRedirectMap();
        const allRoutes = this.dataProvider.getAllRoutes();

        let isAllHydrated = true;
        equivalentStopIdsSet.forEach(oid => {
            if (!hydratedStops.has(oid)) isAllHydrated = false;
        });

        if (!isAllHydrated) {
            // console.log(`[FilterManager] Stop ${stopId} (or equivalents) not fully hydrated. Fetching...`);
            try {
                // Fetch for ALL equivalent IDs that are not hydrated
                const fetchPromises = Array.from(equivalentStopIdsSet).map(async oid => {
                    if (hydratedStops.has(oid)) return;

                    const fetchedRoutes = await api.fetchStopRoutes(oid, null, { strategy: 'cache-only' });
                    if (fetchedRoutes && Array.isArray(fetchedRoutes)) {
                        if (!stopToRoutesMap.has(oid)) stopToRoutesMap.set(oid, []);
                        const currentList = stopToRoutesMap.get(oid);

                        fetchedRoutes.forEach(fr => {
                            const canonical = allRoutes.find(r => String(r.shortName) === String(fr.shortName));
                            const routeToAdd = canonical || fr;
                            if (!currentList.includes(routeToAdd)) currentList.push(routeToAdd);
                        });
                        hydratedStops.add(oid);
                    }
                });
                await Promise.all(fetchPromises);
            } catch (e) { console.warn('[FilterManager] Lazy fetch error', e); }
        }
    }

    applyFilter(targetId, currentStopId, lastArrivals, lastRoutes) {
        if (!this.state.picking || !this.state.originId) return;

        const redirectMap = this.dataProvider.getRedirectMap();
        const normTargetId = redirectMap.get(targetId) || targetId;
        const equivalentStops = this.getEquivalentStops(normTargetId);

        if (this.state.context === 'segment' && this.state.reachableStopIds && this.state.reachableStopIds.size > 0) {
            const isReachable = equivalentStops.some(id => this.state.reachableStopIds.has(id));
            if (!isReachable) return;
        }

        let isAnySelected = false;
        equivalentStops.forEach(id => {
            if (this.state.targetIds.has(id)) isAnySelected = true;
        });

        if (isAnySelected) {
            equivalentStops.forEach(id => this.state.targetIds.delete(id));
        } else {
            equivalentStops.forEach(id => this.state.targetIds.add(id));
        }

        this.refreshRouteFilter(currentStopId, lastArrivals, lastRoutes);
    }

    async refreshRouteFilter(currentStopId, lastArrivals, lastRoutes) {
        const redirectMap = this.dataProvider.getRedirectMap();
        const mergeSourcesMap = this.dataProvider.getMergeSourcesMap();

        const buildOriginContext = (baseOrigins) => {
            const originEqForExclusion = new Set();
            const originIdsForRoutes = new Set();
            baseOrigins.forEach((baseId) => {
                if (!baseId) return;
                const base = String(baseId);
                this.getEquivalentStops(base).forEach(id => originEqForExclusion.add(id));
                originIdsForRoutes.add(base);
                if (redirectMap.has(base)) {
                    originIdsForRoutes.add(redirectMap.get(base));
                }
                if (mergeSourcesMap.has(base)) {
                    mergeSourcesMap.get(base).forEach(s => originIdsForRoutes.add(s));
                }
            });
            return { originEqForExclusion, originIdsForRoutes };
        };

        const baseOriginsPrimary = (this.state.originIdsOverride && this.state.originIdsOverride.size > 0)
            ? Array.from(this.state.originIdsOverride)
            : [this.state.originId];
        let { originEqForExclusion, originIdsForRoutes } = buildOriginContext(baseOriginsPrimary);

        const stopToRoutesMap = this.dataProvider.getStopToRoutesMap();

        const buildOriginRoutes = (originIds) => {
            const originRoutesSet = new Set();
            originIds.forEach(oid => {
                const routes = stopToRoutesMap.get(oid) || [];
                routes.forEach(r => originRoutesSet.add(r));
            });
            let routes = Array.from(originRoutesSet).filter(r => shouldShowRoute(r.shortName, r));
            if (this.state.allowedRouteIds && this.state.allowedRouteIds.size > 0) {
                routes = routes.filter(r => this.state.allowedRouteIds.has(String(r.id)));
            }
            if (routes.length === 0 && this.state.allowedRouteIds && this.state.allowedRouteIds.size > 0) {
                const allRoutes = this.dataProvider.getAllRoutes() || [];
                routes = allRoutes
                    .filter(r => this.state.allowedRouteIds.has(String(r.id)))
                    .filter(r => shouldShowRoute(r.shortName, r));
            }
            return routes;
        };

        let originRoutes = buildOriginRoutes(originIdsForRoutes);

        const computeCommonRoutes = (originIds, routes) => {
            const matchedPatterns = new Map();
            const filtered = routes.filter(r => {
                let routeStopsNormalized = null;
                let globalMatch = false;
                const allowedSuffixes = (this.state.context === 'segment' && this.state.allowedPatternSuffixes instanceof Map)
                    ? this.state.allowedPatternSuffixes.get(String(r.id))
                    : null;

                for (const tid of this.state.targetIds) {
                    const targetEq = new Set(this.getEquivalentStops(tid));
                    let matches = false;

                    if (r._details && r._details.patterns) {
                        matches = r._details.patterns.some(p => {
                            if (!p.stops) return false;
                            if (allowedSuffixes && allowedSuffixes.size > 0 && p.patternSuffix && !allowedSuffixes.has(p.patternSuffix)) {
                                return false;
                            }
                            const idxO = p.stops.findIndex(s => originIds.has(redirectMap.get(s.id) || s.id));
                            if (idxO === -1) return false;

                            if (this.state.context === 'segment') {
                                const originNormId = redirectMap.get(p.stops[idxO].id) || p.stops[idxO].id;
                                if (targetEq.has(originNormId)) {
                                    if (!matchedPatterns.has(String(r.id))) matchedPatterns.set(String(r.id), new Set());
                                    if (p.patternSuffix) matchedPatterns.get(String(r.id)).add(p.patternSuffix);
                                    return true;
                                }
                            }

                            // Check if this is a loop route:
                            // 1. CSV override flag isLoop
                            // 2. Virtual split pattern (has _PART in suffix)
                            const isLoopRoute = r._overrides?.isLoop === true ||
                                r._overrides?.isLoop === 'true' ||
                                (p.patternSuffix && p.patternSuffix.includes('_PART'));

                            // Normal case: target after origin
                            const idxT = p.stops.findIndex((s, i) => i > idxO && targetEq.has(redirectMap.get(s.id) || s.id));
                            if (idxT !== -1) {
                                // Fix: If it's a virtual pattern (_PART), it's already sliced linearly. Treat as standard.
                                if (isLoopRoute && !p.patternSuffix.includes('_PART')) {
                                    // Find terminus index: prefer CSV override, fall back to midpoint
                                    let terminusIdx = -1;
                                    const terminusStopId = r._overrides?.terminusStopIdOverride || r._overrides?.terminusStopId;
                                    if (terminusStopId) {
                                        terminusIdx = p.stops.findIndex(s => {
                                            const normId = redirectMap.get(s.id) || s.id;
                                            return normId === terminusStopId || s.id === terminusStopId;
                                        });
                                    }
                                    if (terminusIdx === -1) {
                                        terminusIdx = Math.ceil(p.stops.length * 0.5) - 1;
                                    }

                                    // If origin is before terminus, target must be at or before terminus + 1
                                    if (idxO <= terminusIdx) {
                                        if (idxT > terminusIdx + 1) {
                                            return false; // Target is past terminus - not reachable via this route
                                        }
                                    }
                                    // If origin is on return leg (after terminus), target must be after origin
                                    // (which is already satisfied by idxT > idxO check above)
                                }
                                if (!matchedPatterns.has(String(r.id))) matchedPatterns.set(String(r.id), new Set());
                                if (p.patternSuffix) matchedPatterns.get(String(r.id)).add(p.patternSuffix);
                                return true;
                            }

                            // Wrapped route case: target is at index 0 (first stop)
                            // Special case for circular routes 387/397: bus continues from last to first stop
                            const CIRCULAR_ROUTES = ['387', '397'];
                            if (CIRCULAR_ROUTES.includes(String(r.shortName)) && idxO > 0 && p.stops.length >= 5) {
                                const firstStop = p.stops[0];
                                const firstNormId = redirectMap.get(firstStop.id) || firstStop.id;
                                if (targetEq.has(firstNormId)) {
                                    if (!matchedPatterns.has(String(r.id))) matchedPatterns.set(String(r.id), new Set());
                                    if (p.patternSuffix) matchedPatterns.get(String(r.id)).add(p.patternSuffix);
                                    return true;
                                }
                            }

                            return false;
                        });
                    } else if (r.stops) {
                        if (!routeStopsNormalized) routeStopsNormalized = r.stops.map(sid => redirectMap.get(sid) || sid);
                        const stops = routeStopsNormalized;
                        const idxO = stops.findIndex(sid => originIds.has(sid));
                        if (idxO !== -1) {
                            if (this.state.context === 'segment' && targetEq.has(stops[idxO])) {
                                matches = true;
                            } else {
                                const idxT = stops.findIndex((sid, i) => i > idxO && targetEq.has(sid));
                                matches = (idxT !== -1);
                            }
                        }
                    } else if (r._details && Array.isArray(r._details.stops)) {
                        if (!routeStopsNormalized) routeStopsNormalized = r._details.stops.map(s => redirectMap.get(s.id) || s.id);
                        const stops = routeStopsNormalized;
                        const idxO = stops.findIndex(sid => originIds.has(sid));
                        if (idxO !== -1) {
                            if (this.state.context === 'segment' && targetEq.has(stops[idxO])) {
                                matches = true;
                            } else {
                                const idxT = stops.findIndex((sid, i) => i > idxO && targetEq.has(sid));
                                matches = (idxT !== -1);
                            }
                        }
                    }
                    if (matches) {
                        globalMatch = true;
                        if (!matchedPatterns.has(String(r.id))) matchedPatterns.set(String(r.id), new Set());
                        return true;
                    }
                }
                if (!globalMatch) {
                    // Detailed debug for 0 results case (Failure)
                }
                return globalMatch;
            });
            return { routes: filtered, patternMap: matchedPatterns };
        };

        const applyFilteredRoutes = (commonRoutes, patternMap, updateRouter = false) => {
            this.state.filteredRoutes = commonRoutes.map(r => r.id);
            this.state.filteredRoutePatterns = patternMap || null;
            this.state.active = true;

            this.updateMapFilterState();
            this.uiCallbacks.updateConnectionLine(this.state.originId, this.state.targetIds, false);
            if (this.state.context === 'stop' && typeof this.uiCallbacks.updateFilterLiveBuses === 'function') {
                this.uiCallbacks.updateFilterLiveBuses(this.state.filteredRoutes, this.state.filteredRoutePatterns);
            }

            // UI Updates
            if (this.state.context === 'segment') {
                if (typeof this.uiCallbacks.applySegmentFilter === 'function') {
                    this.uiCallbacks.applySegmentFilter(this.state.filteredRoutes, this.state.filteredRoutePatterns);
                }
            } else if (currentStopId === this.state.originId) {
                if (lastArrivals) {
                    this.uiCallbacks.renderArrivals(lastArrivals, this.state.originId);
                    if (lastRoutes) this.uiCallbacks.renderAllRoutes(lastRoutes, lastArrivals);
                } else {
                    // Fallback: reload
                    const allStops = this.dataProvider.getAllStops();
                    const stop = allStops.find(s => s.id === this.state.originId);
                    if (stop) this.uiCallbacks.showStopInfo(stop, false, false, false);
                }
            }

            if (updateRouter && this.state.context === 'stop') {
                const routeFilterShortNames = typeof window.getSelectedStopRouteFilterShortNames === 'function'
                    ? window.getSelectedStopRouteFilterShortNames(this.state.originId)
                    : [];
                this.router.updateStop(this.state.originId, true, Array.from(this.state.targetIds), '', routeFilterShortNames);
            }

            if (currentStopId === this.state.originId && this.state.context === 'stop') {
                const allStops = this.dataProvider.getAllStops();
                const stop = allStops.find(s => String(s.id) === String(this.state.originId));
                if (stop) {
                    const routeChipFilterIds = typeof window.getSelectedStopRouteFilterIds === 'function'
                        ? Array.from(window.getSelectedStopRouteFilterIds(this.state.originId) || [])
                        : [];
                    addToHistory('stop', {
                        ...stop,
                        _filterState: {
                            active: true,
                            originId: this.state.originId,
                            targetIds: Array.from(this.state.targetIds || [])
                        },
                        _routeChipFilterIds: routeChipFilterIds
                    });
                }
            }
        };

        // Fast path: apply filter using whatever data is already available.
        const fast = computeCommonRoutes(originIdsForRoutes, originRoutes);
        applyFilteredRoutes(fast.routes, fast.patternMap, false);

        // Fill in missing routes for the origin (cache-only). This can be slow, so do it after the fast pass.
        await this.ensureLazyRoutesForStop(this.state.originId, originIdsForRoutes);

        // Recompute origin routes after lazy hydration.
        originRoutes = buildOriginRoutes(originIdsForRoutes);

        // Ensure Hydration (Critical for Fresh Data reload)
        const routesNeedingFetch = originRoutes.filter(r => !r._details || !r._details.patterns);
        if (routesNeedingFetch.length > 0) {
            // console.log(`[FilterManager] Refreshing detected ${routesNeedingFetch.length} unhydrated routes (Cache-Only). Hydrating...`);
            try {
                await hydrateRouteDetails(routesNeedingFetch, { strategy: 'cache-only' });
            } catch (err) { console.error('[FilterManager] Refresh hydration error', err); }
        }

        // Recompute with hydrated details (if any) and update UI/router.
        let common = computeCommonRoutes(originIdsForRoutes, originRoutes);

        if (common.routes.length === 0 && this.state.context === 'segment' && this.state.originIdsFallback && this.state.originIdsFallback.size > 0) {
            const baseOriginsFallback = Array.from(this.state.originIdsFallback);
            ({ originEqForExclusion, originIdsForRoutes } = buildOriginContext(baseOriginsFallback));
            originRoutes = buildOriginRoutes(originIdsForRoutes);
            common = computeCommonRoutes(originIdsForRoutes, originRoutes);
        }

        applyFilteredRoutes(common.routes, common.patternMap, true);
    }

    async updateReachableStops() {
        if (!this.state.originId) return;

        // Ensure static data is loaded before proceeding with reachability calculation
        await api.preloadStaticRoutesDetails();

        const redirectMap = this.dataProvider.getRedirectMap();
        const mergeSourcesMap = this.dataProvider.getMergeSourcesMap();

        const computeReachableStops = async (originIdsForRoutes, originEqForExclusion) => {
            await this.ensureLazyRoutesForStop(this.state.originId, originIdsForRoutes);
            const includeOriginAsReachable = this.state.context === 'segment';

            const stopToRoutesMap = this.dataProvider.getStopToRoutesMap();
            const routes = new Set();
            originIdsForRoutes.forEach(oid => {
                const r = stopToRoutesMap.get(oid) || [];
                r.forEach(route => {
                    if (shouldShowRoute(route.shortName, route)) {
                        routes.add(route);
                    }
                });
            });
            let originRoutes = Array.from(routes);
            if (this.state.allowedRouteIds && this.state.allowedRouteIds.size > 0) {
                originRoutes = originRoutes.filter(r => this.state.allowedRouteIds.has(String(r.id)));
            }
            if (originRoutes.length === 0 && this.state.allowedRouteIds && this.state.allowedRouteIds.size > 0) {
                const allRoutes = this.dataProvider.getAllRoutes() || [];
                originRoutes = allRoutes
                    .filter(r => this.state.allowedRouteIds.has(String(r.id)))
                    .filter(r => shouldShowRoute(r.shortName, r));
            }

            const routesNeedingFetch = originRoutes.filter(r => !r._details || !r._details.patterns);
            if (routesNeedingFetch.length > 0) {
                try {
                    await hydrateRouteDetails(routesNeedingFetch, { strategy: 'cache-only' });
                } catch (err) { console.error('[FilterManager] Hydration error', err); }
            }

            const reachableStopIds = new Set();

            const forwardOnlyPatternMap = (this.state.context === 'segment' && this.state.allowedPatternSuffixes instanceof Map)
                ? this.state.allowedPatternSuffixes
                : null;

            originRoutes.forEach(r => {
                if (r._details && r._details.patterns) {
                    r._details.patterns.forEach(p => {
                        if (p.stops) {
                            if (forwardOnlyPatternMap) {
                                const allowed = forwardOnlyPatternMap.get(String(r.id));
                                if (allowed && allowed.size > 0 && p.patternSuffix && !allowed.has(p.patternSuffix)) {
                                    return;
                                }
                            }
                            const idx = p.stops.findIndex(s => originIdsForRoutes.has(redirectMap.get(s.id) || s.id));

                            if (idx !== -1 && idx < p.stops.length) {
                                const isLoopRoute = r._overrides?.isLoop === true ||
                                    r._overrides?.isLoop === 'true' ||
                                    (p.patternSuffix && p.patternSuffix.includes('_PART'));

                                let stopsToAdd;
                                if (isLoopRoute && !p.patternSuffix.includes('_PART')) {
                                    let terminusIdx = -1;
                                    const terminusStopId = r._overrides?.terminusStopIdOverride || r._overrides?.terminusStopId;
                                    if (terminusStopId) {
                                        terminusIdx = p.stops.findIndex(s => {
                                            const normId = redirectMap.get(s.id) || s.id;
                                            return normId === terminusStopId || s.id === terminusStopId;
                                        });
                                    }
                                    if (terminusIdx === -1) {
                                        terminusIdx = Math.ceil(p.stops.length * 0.5) - 1;
                                    }

                                    if (idx <= terminusIdx) {
                                        const start = includeOriginAsReachable ? idx : idx + 1;
                                        stopsToAdd = p.stops.slice(start, terminusIdx + 2);
                                    } else {
                                        stopsToAdd = p.stops.slice(idx + 1);
                                    }
                                } else {
                                    const start = includeOriginAsReachable ? idx : idx + 1;
                                    stopsToAdd = p.stops.slice(start);

                                    const CIRCULAR_ROUTES = ['387', '397'];
                                    if (CIRCULAR_ROUTES.includes(String(r.shortName)) && p.stops.length >= 5 && idx > 0) {
                                        stopsToAdd = [...stopsToAdd, p.stops[0]];
                                    }
                                }

                                stopsToAdd.forEach(s => {
                                    const normId = redirectMap.get(s.id) || s.id;
                                    this.getEquivalentStops(normId).forEach(eqId => reachableStopIds.add(eqId));
                                });
                            }
                        }
                    });
                } else if (r._details && r._details.stops) {
                    if (this.state.context === 'segment') {
                        const stops = r._details.stops.map(s => redirectMap.get(s.id) || s.id);
                        const idx = stops.findIndex(sid => originIdsForRoutes.has(sid));
                        if (idx !== -1 && idx < stops.length) {
                            const start = includeOriginAsReachable ? idx : idx + 1;
                            let stopsToAdd = stops.slice(start);

                            const CIRCULAR_ROUTES = ['387', '397'];
                            if (CIRCULAR_ROUTES.includes(String(r.shortName)) && stops.length >= 5 && idx > 0) {
                                stopsToAdd = [...stopsToAdd, stops[0]];
                            }

                            stopsToAdd.forEach(sid => {
                                this.getEquivalentStops(sid).forEach(eqId => reachableStopIds.add(eqId));
                            });
                        }
                    } else {
                        r._details.stops.forEach(s => {
                            const normId = redirectMap.get(s.id) || s.id;
                            if (!originEqForExclusion.has(normId)) {
                                this.getEquivalentStops(normId).forEach(eqId => reachableStopIds.add(eqId));
                            }
                        });
                    }
                } else if (Array.isArray(r.stops)) {
                    const stops = r.stops.map(sid => redirectMap.get(sid) || sid);
                    const idx = stops.findIndex(sid => originIdsForRoutes.has(sid));
                    if (idx !== -1 && idx < stops.length) {
                        const start = includeOriginAsReachable ? idx : idx + 1;
                        let stopsToAdd = stops.slice(start);

                        const CIRCULAR_ROUTES = ['387', '397'];
                        if (CIRCULAR_ROUTES.includes(String(r.shortName)) && stops.length >= 5 && idx > 0) {
                            stopsToAdd = [...stopsToAdd, stops[0]];
                        }

                        stopsToAdd.forEach(sid => {
                            this.getEquivalentStops(sid).forEach(eqId => reachableStopIds.add(eqId));
                        });
                    }
                }
            });

            return reachableStopIds;
        };

        const originEqForExclusion = new Set();
        const originIdsForRoutes = new Set();
        const baseOrigins = (this.state.originIdsOverride && this.state.originIdsOverride.size > 0)
            ? Array.from(this.state.originIdsOverride)
            : [this.state.originId];
        baseOrigins.forEach((baseId) => {
            if (!baseId) return;
            const base = String(baseId);
            this.getEquivalentStops(base).forEach(id => originEqForExclusion.add(id));
            originIdsForRoutes.add(base);
            if (redirectMap.has(base)) {
                originIdsForRoutes.add(redirectMap.get(base));
            }
            if (mergeSourcesMap.has(base)) {
                mergeSourcesMap.get(base).forEach(s => originIdsForRoutes.add(s));
            }
        });

        let reachableStopIds = await computeReachableStops(originIdsForRoutes, originEqForExclusion);

        if (reachableStopIds.size === 0 && this.state.allowedRouteIds && this.state.allowedRouteIds.size > 0) {
            const expandedOriginIds = new Set();
            const fallbackBases = (this.state.originIdsOverride && this.state.originIdsOverride.size > 0)
                ? Array.from(this.state.originIdsOverride)
                : [this.state.originId];
            fallbackBases.forEach((baseId) => {
                if (!baseId) return;
                this.getEquivalentStops(String(baseId)).forEach(id => expandedOriginIds.add(id));
            });
            const expandedExclusion = new Set(expandedOriginIds);
            reachableStopIds = await computeReachableStops(expandedOriginIds, expandedExclusion);
        }

        this.state.reachableStopIds = reachableStopIds;
    }

    async recalculateFilter(currentStopId, lastArrivals, lastRoutes) {
        if (!this.state.picking && !this.state.active) return;
        window.isFilterModeActive = true;

        // console.log('[FilterManager] Recalculating filter due to settings update');

        if (this.state.picking) {
            await this.updateReachableStops();
            // If some targetIds are no longer reachable, should we remove them?
            // User didn't specify, but it's safer to keep them or re-run the whole check.
            // For now, let's keep them but refresh the route filtering.
        }

        if (this.state.active) {
            await this.refreshRouteFilter(currentStopId, lastArrivals, lastRoutes);
        } else {
            this.updateMapFilterState();
        }
    }

    clearFilter(currentStopId, options = {}) {
        const { restoreStop = false } = options;
        if (currentStopId && typeof window.resetStopRouteFilter === 'function') {
            window.resetStopRouteFilter(currentStopId);
        }
        this.state.active = false;
        this.state.picking = false;
        this.state.originId = null;
        this.state.originIdsOverride = null;
        this.state.originIdsFallback = null;
        this.state.targetIds = new Set();
        this.state.filteredRoutes = [];
        this.state.filteredRoutePatterns = null;
        this.state.allowedPatternSuffixes = null;
        this.state.allowedRouteIds = null;
        if (this.state.context === 'segment' && typeof this.uiCallbacks.applySegmentFilter === 'function') {
            this.uiCallbacks.applySegmentFilter(null, null);
        }
        if (typeof this.uiCallbacks.clearFilterLiveBuses === 'function') {
            this.uiCallbacks.clearFilterLiveBuses();
        }
        RouteFilterColorManager.reset();
        window.isFilterModeActive = false;

        if (restoreStop && currentStopId) {
            const allStops = this.dataProvider.getAllStops();
            const stop = allStops.find(s => String(s.id) === String(currentStopId));
            if (stop) {
                addToHistory('stop', stop);
            }
        }

        // Clear Markers (Robust)
        try {
            if (this.destinationMarkers) {
                this.destinationMarkers.forEach(marker => {
                    if (marker && typeof marker.remove === 'function') marker.remove();
                });
                this.destinationMarkers.clear();
            }
        } catch (e) {
            console.warn('[FilterManager] Error clearing legacy markers', e);
        }

        // Clear GL Source
        if (this.map.getSource('destination-markers')) {
            this.map.getSource('destination-markers').setData({ type: 'FeatureCollection', features: [] });
        }

        // Clear Map connection
        if (this.map.getSource('filter-connection')) {
            this.map.getSource('filter-connection').setData({ type: 'FeatureCollection', features: [] });
        }

        // Reset UI Button
        const btn = document.getElementById('filter-routes-toggle');
        if (btn) {
            btn.classList.remove('active');
            const icon = btn.querySelector('.filter-icon');
            if (icon) icon.src = iconFilterOutline;
            const text = btn.querySelector('.filter-text');
            if (text) text.textContent = 'Filter by destination...';
        }

        // Reset Map Layers
        if (this.map.getLayer('stops-layer')) this.map.setPaintProperty('stops-layer', 'icon-opacity', 1);

        if (this.map.getLayer('stops-label-selected')) {
            this.map.setFilter('stops-label-selected', ['in', ['get', 'id'], ['literal', []]]);
        }

        if (this.map.getLayer('metro-layer-circle')) {
            this.map.setPaintProperty('metro-layer-circle', 'circle-opacity', 1);
            this.map.setPaintProperty('metro-layer-circle', 'circle-stroke-opacity', 1);
        }

        // Reset Circles (Restore normal radius)
        if (this.map.getLayer('stops-layer-circle')) {
            this.map.setPaintProperty('stops-layer-circle', 'circle-opacity', 1);
            this.map.setPaintProperty('stops-layer-circle', 'circle-stroke-opacity', 1);
            this.map.setPaintProperty('stops-layer-circle', 'circle-radius', this.uiCallbacks.getCircleRadiusExpression(1));
        }

        // Reset Glow Layer
        if (this.map.getLayer('stops-layer-glow')) {
            this.map.setPaintProperty('stops-layer-glow', 'circle-opacity', 0);
        }

        // Reset Highlight Layer (Opacity back to 1, source determines visibility)
        if (this.map.getLayer('stops-highlight')) {
            this.map.setPaintProperty('stops-highlight', 'icon-opacity', 1);
        }

        // Reset Metro Labels
        if (this.map.getLayer('metro-layer-label')) {
            this.map.setPaintProperty('metro-layer-label', 'text-opacity', 1);
        }
        if (this.map.getLayer('metro-transfer-layer')) {
            this.map.setPaintProperty('metro-transfer-layer', 'text-opacity', 1);
        }

        const shouldRefreshCurrentStopCard = currentStopId && String(window.currentStopId) === String(currentStopId);
        if (shouldRefreshCurrentStopCard) {
            if (window.lastArrivals) {
                this.uiCallbacks.renderArrivals(window.lastArrivals, currentStopId);
            }
            if (window.lastRoutes) {
                this.uiCallbacks.renderAllRoutes(window.lastRoutes, window.lastArrivals || []);
            }
            if (typeof window.updateCurrentStopDeepLink === 'function') {
                window.updateCurrentStopDeepLink();
            }
        }

        // Refresh View
        if (restoreStop && currentStopId) {
            const allStops = this.dataProvider.getAllStops();
            const stop = allStops.find(s => s.id === currentStopId);
            if (stop) {
                this.uiCallbacks.showStopInfo(stop, false, true, true, { forceRoutesRefresh: true });
            }
        }
    }

    updateMapFilterState() {
        // Need to know if we are editing.
        const editState = this.dataProvider.getEditState();
        const editId = editState && editState.stopId ? editState.stopId : null;

        if (!this.state.picking && !this.state.active) return;

        const reachableArray = Array.from(this.state.reachableStopIds || []);
        const selectedArray = Array.from(this.state.targetIds || []);
        const originId = this.state.originId;
        const useOriginHighlight = this.state.context !== 'segment';

        const highOpacityIds = new Set(reachableArray);
        // Exclude selected (targets) from highOpacityIds because they have their own 0-opacity rule
        // (Mapbox match expression requires unique branch labels)
        selectedArray.forEach(id => {
            highOpacityIds.delete(id);
        });

        if (originId && useOriginHighlight) highOpacityIds.add(originId);

        // Exclude editId from highOpacityIds as well, as it has its own priority branch
        if (editId && highOpacityIds.has(editId)) {
            highOpacityIds.delete(editId);
        }

        const isDark = document.body.classList.contains('dark-mode');
        const dimmedOpacity = isDark ? 0.1 : 0.3; // Light mode needs higher opacity to be visible (black fill)

        const opacityExpression = ['match', ['get', 'id']];
        if (editId) opacityExpression.push([editId], 0);
        if (selectedArray.length > 0) opacityExpression.push(selectedArray, 0); // Hide selected from base layer
        if (highOpacityIds.size > 0) {
            opacityExpression.push(Array.from(highOpacityIds), 1.0);
        }
        opacityExpression.push(dimmedOpacity);

        const caseExpression = [
            'case',
            ['in', ['get', 'id'], ['literal', selectedArray]], 1000,
            ['in', ['get', 'id'], ['literal', reachableArray]], 100,
            0
        ];
        if (useOriginHighlight) {
            caseExpression.splice(3, 0, ['==', ['get', 'id'], originId], 900);
        }

        if (this.map.getLayer('stops-layer')) {
            this.map.setPaintProperty('stops-layer', 'icon-opacity', opacityExpression);
            this.map.setLayoutProperty('stops-layer', 'symbol-sort-key', caseExpression);
        }

        if (this.map.getLayer('stops-layer-circle')) {
            const circleOpacityExpression = ['match', ['get', 'id']];
            if (editId) circleOpacityExpression.push([editId], 0);

            // Targets -> 0 opacity (handled by markers)
            if (selectedArray.length > 0) circleOpacityExpression.push(selectedArray, 0);

            // Others -> High/Low
            // High opacity for reachable (but not selected)
            if (highOpacityIds.size > 0) {
                circleOpacityExpression.push(Array.from(highOpacityIds), 1.0);
            }
            circleOpacityExpression.push(dimmedOpacity);

            this.map.setPaintProperty('stops-layer-circle', 'circle-opacity', circleOpacityExpression);
            this.map.setPaintProperty('stops-layer-circle', 'circle-stroke-opacity', circleOpacityExpression);

            // Radius Logic
            const radiusExpression = [
                'interpolate', ['linear'], ['zoom'],
                12.5, [
                    'case',
                    ['match', ['get', 'id'], Array.from(highOpacityIds), true, false],
                    1.2 * 1.5, 1.2
                ],
                16, [
                    'case',
                    ['match', ['get', 'id'], Array.from(highOpacityIds), true, false],
                    4.8 * 1.5, 4.8
                ]
            ];
            this.map.setPaintProperty('stops-layer-circle', 'circle-radius', radiusExpression);
        }

        // Handle Glow Layer specifically
        if (this.map.getLayer('stops-layer-glow')) {
            // If picking/active, hide glow for dimmed stops
            // High opacity IDs get subtle glow (0.15 if dark mode to avoid blobby effect, else 0)
            // Dimmed IDs get 0
            const glowOpacity = isDark ? 0.15 : 0;

            const glowExpression = ['match', ['get', 'id']];
            if (editId) glowExpression.push([editId], 0);
            if (selectedArray.length > 0) glowExpression.push(selectedArray, 0); // Hide selected
            if (highOpacityIds.size > 0) {
                glowExpression.push(Array.from(highOpacityIds), glowOpacity);
            }
            // Default (Dimmed) -> 0 glow
            glowExpression.push(0);

            this.map.setPaintProperty('stops-layer-glow', 'circle-opacity', glowExpression);
        }

        if (this.map.getLayer('stops-label-selected')) {
            if (selectedArray.length > 0) {
                this.map.setFilter('stops-label-selected', ['in', ['get', 'id'], ['literal', selectedArray]]);
            } else {
                this.map.setFilter('stops-label-selected', ['in', ['get', 'id'], ['literal', []]]);
            }
            // Ensure selected labels are not dimmed in filter mode
            this.map.setPaintProperty('stops-label-selected', 'text-opacity', 1.0);
        }

        if (this.map.getLayer('metro-layer-label')) {
            this.map.setPaintProperty('metro-layer-label', 'text-opacity', dimmedOpacity);
        }
        if (this.map.getLayer('metro-transfer-layer')) {
            this.map.setPaintProperty('metro-transfer-layer', 'text-opacity', dimmedOpacity);
        }

        if (this.map.getLayer('metro-layer-circle')) {
            const finalOpacity = [
                'case',
                ['in', ['get', 'id'], ['literal', selectedArray]], 0,
                ['in', ['get', 'id'], ['literal', reachableArray]], 1,
                dimmedOpacity
            ];
            if (useOriginHighlight) {
                finalOpacity.splice(5, 0, ['==', ['get', 'id'], originId], 1);
            }
            this.map.setPaintProperty('metro-layer-circle', 'circle-opacity', finalOpacity);
            this.map.setPaintProperty('metro-layer-circle', 'circle-stroke-opacity', finalOpacity);
        }

        if (this.map.getLayer('stops-highlight')) {
            this.map.setPaintProperty('stops-highlight', 'icon-opacity', opacityExpression);
        }

        // Add Destination Markers Layer if not exists
        if (!this.map.getSource('destination-markers')) {
            this.map.addSource('destination-markers', {
                type: 'geojson',
                data: { type: 'FeatureCollection', features: [] }
            });
        }
        if (!this.map.getLayer('destination-markers-layer')) {
            this.map.addLayer({
                id: 'destination-markers-layer',
                type: 'symbol',
                source: 'destination-markers',
                layout: {
                    'icon-image': ['get', 'icon'],
                    'icon-allow-overlap': true,
                    'icon-ignore-placement': true
                    // 'icon-size': 0.5 // Removed to allow full size (approx 48px)
                }
            });

            // Click Handler for Destination Markers: REMOVED
            // Now handled by Unified Click Handler in main.js via proximity sorting.
            // This ensures click targets exactly match hover targets.

            // Cursor
            this.map.on('mouseenter', 'destination-markers-layer', () => {
                this.map.getCanvas().style.cursor = 'pointer';
            });
            this.map.on('mouseleave', 'destination-markers-layer', () => {
                this.map.getCanvas().style.cursor = '';
            });
        }

        this.updateDestinationMarkers();
    }

    updateDestinationMarkers() {
        const selectedTargets = Array.from(this.state.targetIds);
        const map = this.map;
        const allStops = this.dataProvider.getAllStops();

        // 1. Remove Deselected
        // 1. Clear DOM Markers (Migration Cleanup)
        // If we still have legacy markers, remove them once.
        if (this.destinationMarkers.size > 0) {
            this.destinationMarkers.forEach(m => m.remove());
            this.destinationMarkers.clear();
        }

        // Update GeoJSON Source
        const features = [];
        selectedTargets.forEach(targetId => {
            const stop = allStops.find(s => s.id === targetId);
            if (!stop) return;

            const connectingRoutes = this.getConnectingRoutes(this.state.originId, targetId);
            const colors = this.getGradientColors(connectingRoutes, this.state.originId, targetId);

            // Generate Signature for Icon Cache
            // We use colors join as the signature for the ICON itself, to reuse cached images
            const visualSignature = colors.join('-');

            // Ensure Icon Exists
            DestinationMarkerRenderer.ensureIcon(this.map, visualSignature, colors);

            features.push({
                type: 'Feature',
                geometry: {
                    type: 'Point',
                    coordinates: [parseFloat(stop.lon), parseFloat(stop.lat)]
                },
                properties: {
                    id: targetId,
                    icon: `dest-marker-${visualSignature}`
                }
            });
        });

        const sourceId = 'destination-markers';
        if (this.map.getSource(sourceId)) {
            this.map.getSource(sourceId).setData({
                type: 'FeatureCollection',
                features: features
            });
        }
    }

    getConnectingRoutes(originId, targetId) {
        const stopToRoutesMap = this.dataProvider.getStopToRoutesMap();
        const redirectMap = this.dataProvider.getRedirectMap();

        const originEq = new Set(this.getEquivalentStops(originId));
        const targetEq = new Set(this.getEquivalentStops(targetId));

        const originRoutesSet = new Set();
        originEq.forEach(oid => {
            const routes = stopToRoutesMap.get(oid) || [];
            routes.forEach(r => {
                if (shouldShowRoute(r.shortName, r)) originRoutesSet.add(r);
            });
        });

        const connecting = [];
        originRoutesSet.forEach(r => {
            // Check if this route connects ANY origin equivalent to ANY target equivalent
            // (Logic simplified from refreshRouteFilter)
            // We need to check exact path for directionality usually.

            let matches = false;
            if (r._details && r._details.patterns) {
                matches = r._details.patterns.some(p => {
                    if (!p.stops) return false;
                    const idxO = p.stops.findIndex(s => originEq.has(redirectMap.get(s.id) || s.id));
                    if (idxO === -1) return false;
                    const idxT = p.stops.findIndex((s, i) => i > idxO && targetEq.has(redirectMap.get(s.id) || s.id));
                    if (idxT === -1) return false;

                    // For loop routes: target must be before the terminus
                    const isLoopRoute = r._overrides?.isLoop === true ||
                        r._overrides?.isLoop === 'true' ||
                        (p.patternSuffix && p.patternSuffix.includes('_PART'));
                    if (isLoopRoute) {
                        let terminusIdx = -1;
                        const terminusStopId = r._overrides?.terminusStopIdOverride || r._overrides?.terminusStopId;
                        if (terminusStopId) {
                            terminusIdx = p.stops.findIndex(s => {
                                const normId = redirectMap.get(s.id) || s.id;
                                return normId === terminusStopId || s.id === terminusStopId;
                            });
                        }
                        if (terminusIdx === -1) {
                            terminusIdx = Math.ceil(p.stops.length * 0.5) - 1;
                        }
                        if (idxO <= terminusIdx && idxT > terminusIdx + 1) {
                            return false; // Target is past terminus
                        }
                    }
                    return true;
                });
            } else if (r.stops) {
                const routeStopsNormalized = r.stops.map(sid => redirectMap.get(sid) || sid);
                const idxO = routeStopsNormalized.findIndex(sid => originEq.has(sid));
                if (idxO !== -1) {
                    const idxT = routeStopsNormalized.findIndex((sid, i) => i > idxO && targetEq.has(sid));
                    matches = (idxT !== -1);
                }
            }

            if (matches) connecting.push(r);
        });
        return connecting;
    }

    // Helper to generate path signature matching main.js updateConnectionLine logic
    getPathSignature(route, originId, targetId) {
        const redirectMap = this.dataProvider.getRedirectMap();
        const hubMap = this.dataProvider.getHubMap();
        // Getting raw stops from route or pattern
        // We need to find the specific pattern segment if possible, or fallback to route stops.

        let segmentStops = null;
        const originEq = new Set(this.getEquivalentStops(originId));
        const targetEq = new Set(this.getEquivalentStops(targetId));

        if (route._details && route._details.patterns) {
            route._details.patterns.some(p => {
                if (!p.stops) return false;
                // Find first O then first T
                let foundO = -1;
                let foundT = -1;

                for (let i = 0; i < p.stops.length; i++) {
                    const sId = p.stops[i].id;
                    const normId = redirectMap.get(sId) || sId;
                    if (foundO === -1 && originEq.has(normId)) {
                        foundO = i;
                    } else if (foundO !== -1 && targetEq.has(normId)) {
                        foundT = i;
                        break;
                    }
                }

                if (foundO !== -1 && foundT !== -1) {
                    segmentStops = p.stops.slice(foundO, foundT + 1);
                    return true;
                }
                return false;
            });
        }

        if (!segmentStops && route.stops) {
            // Fallback for simple routes
            const stops = route.stops;
            let foundO = -1;
            let foundT = -1;

            for (let i = 0; i < stops.length; i++) {
                const sId = stops[i];
                const normId = redirectMap.get(sId) || sId;
                if (foundO === -1 && originEq.has(normId)) {
                    foundO = i;
                } else if (foundO !== -1 && targetEq.has(normId)) {
                    foundT = i;
                    break;
                }
            }
            if (foundO !== -1 && foundT !== -1) {
                segmentStops = stops.slice(foundO, foundT + 1).map(sid => ({ id: sid }));
            }
        }

        if (!segmentStops || segmentStops.length < 2) return route.id; // Fallback

        // Generate Signature: Map to Hubs -> Dedup -> Join
        const signature = generatePathSignature(segmentStops, redirectMap, hubMap);
        return signature || route.id;
    }

    getGradientColors(routes, originId, targetId) {
        if (!routes || routes.length === 0) return ['#888'];

        const routeIdsBySignature = new Map();
        const signatureByRouteId = new Map();

        routes.forEach(r => {
            const signature = this.getPathSignature(r, originId, targetId);
            signatureByRouteId.set(r.id, signature);
            if (!routeIdsBySignature.has(signature)) routeIdsBySignature.set(signature, []);
            routeIdsBySignature.get(signature).push(r.id);
        });

        const colorBySignature = new Map();
        routeIdsBySignature.forEach((routeIds, signature) => {
            // assignNextColor returns existing if already assigned and updates routeColors for routeIds
            const color = RouteFilterColorManager.assignNextColor(signature, routeIds);
            colorBySignature.set(signature, color);
        });

        const colors = routes
            .map(r => colorBySignature.get(signatureByRouteId.get(r.id)))
            .filter(Boolean);

        // Dedup colors
        const uniqueColors = [...new Set(colors)];

        if (uniqueColors.length === 0) return ['#888'];
        return uniqueColors;
    }
}

// Helper Class for generating gradient icons
class DestinationMarkerRenderer {
    static ensureIcon(map, signature, colors) {
        if (!map) return null;
        const iconId = `dest-marker-${signature}`;

        if (map.hasImage(iconId)) return iconId;

        // Create Canvas for Icon
        // Reduced size (was 96 -> now 48, approx 24px rendered)
        const width = 48;
        const height = 48;
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');

        // Draw Circle
        const centerX = width / 2;
        const centerY = height / 2;
        const radius = 18;
        const strokeWidth = 4;

        // Shadow removed per user request

        // Background (Gradient or Solid)
        if (colors.length > 1) {
            const gradient = ctx.createLinearGradient(centerX - radius, centerY, centerX + radius, centerY);
            colors.forEach((c, i) => {
                const stop = i / (colors.length - 1);
                gradient.addColorStop(stop, c);
            });
            ctx.fillStyle = gradient;
        } else {
            ctx.fillStyle = colors[0];
        }

        ctx.beginPath();
        ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
        ctx.fill();

        // Stroke (White border)
        ctx.lineWidth = strokeWidth;
        ctx.strokeStyle = '#ffffff';
        ctx.stroke();

        // Add to Map
        const imageData = ctx.getImageData(0, 0, width, height);
        map.addImage(iconId, imageData, { pixelRatio: 2 }); // HiDPI

        return iconId;
    }
}
import { t } from './i18n.ts';
