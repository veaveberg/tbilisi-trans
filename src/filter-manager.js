import { RouteFilterColorManager } from './color-manager.js';
import * as api from './api.js';
import { hydrateRouteDetails } from './fetch.js';
// We need these icons. Assuming Vite setup allows importing them here too.
import iconFilterOutline from './assets/icons/line.3.horizontal.decrease.circle.svg';
import iconFilterFill from './assets/icons/line.3.horizontal.decrease.circle.fill.svg';

export class FilterManager {
    constructor({ map, router, dataProvider, uiCallbacks }) {
        this.map = map;
        this.router = router;
        this.dataProvider = dataProvider;
        // Expected dataProvider:
        // { 
        //   getAllStops: () => [],
        //   getAllRoutes: () => [],
        //   getRedirectMap: () => Map,
        //   getHubMap: () => Map,
        //   getHubSourcesMap: () => Map,
        //   getMergeSourcesMap: () => Map,
        //   getStopToRoutesMap: () => Map,
        //   getEditState: () => Object
        // }

        this.uiCallbacks = uiCallbacks;
        // Expected uiCallbacks:
        // {
        //   renderArrivals: (arrivals, id) => {},
        //   renderAllRoutes: (routes, arrivals) => {},
        //   setSheetState: (el, state) => {},
        //   updateConnectionLine: (origin, targets, isEdit) => {},
        //   showStopInfo: (stop, addToStack, flyTo) => {},
        //   getCircleRadiusExpression: (scale) => [] // Helper from main/map-setup? Actually it's local in main usually.
        // }

        this.state = {
            active: false,
            picking: false,
            originId: null,
            targetIds: new Set(),
            reachableStopIds: new Set(),
            filteredRoutes: [] // Array of route IDs
        };
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

    async toggleFilterMode(currentStopId, isPickModeActive, setEditPickMode) {
        console.log('[FilterManager] toggleFilterMode. Active:', this.state.active, 'Picking:', this.state.picking, 'Stop:', currentStopId);

        if (isPickModeActive) setEditPickMode(null);

        if (this.state.active || this.state.picking) {
            this.clearFilter(currentStopId);
            const btn = document.getElementById('filter-routes-toggle');
            if (btn) btn.classList.remove('active');
            return;
        }

        if (!currentStopId) {
            console.warn('[FilterManager] No currentStopId, cannot filter');
            return;
        }

        this.state.picking = true;
        this.state.originId = currentStopId;

        // UI Update
        const btn = document.getElementById('filter-routes-toggle');
        if (btn) {
            btn.classList.add('active');
            btn.querySelector('.filter-icon').src = iconFilterFill;
            btn.querySelector('.filter-text').textContent = 'Select destination stops...';
        }

        // Camera
        const panel = document.getElementById('info-panel');
        if (panel) this.uiCallbacks.setSheetState(panel, 'peek');

        const allStops = this.dataProvider.getAllStops();
        const stop = allStops.find(s => s.id === currentStopId);
        if (stop) {
            const currentZoom = this.map.getZoom();

            // Enforce Zoom 14 for filter view to provide context, unless user is manually deeper?
            // User requested "zoom out somewhat", implying a standard context view.
            const targetZoom = 14;

            // Calculate Pan Offset
            const bearing = (stop.bearing || 0) * (Math.PI / 180);
            const distance = 500; // Increased to 500m per request
            const R = 6371e3;
            const lat1 = stop.lat * (Math.PI / 180);
            const lon1 = stop.lon * (Math.PI / 180);
            const lat2 = Math.asin(Math.sin(lat1) * Math.cos(distance / R) + Math.cos(lat1) * Math.sin(distance / R) * Math.cos(bearing));
            const lon2 = lon1 + Math.atan2(Math.sin(bearing) * Math.sin(distance / R) * Math.cos(lat1), Math.cos(distance / R) - Math.sin(lat1) * Math.sin(lat2));

            this.map.flyTo({
                center: [lon2 * (180 / Math.PI), lat2 * (180 / Math.PI)],
                zoom: targetZoom,
                duration: 1500,
                essential: true
            });
        }

        // Reachability Logic
        const originEq = new Set(this.getEquivalentStops(currentStopId));
        await this.ensureLazyRoutesForStop(currentStopId, originEq);

        const stopToRoutesMap = this.dataProvider.getStopToRoutesMap();
        const routes = new Set();
        originEq.forEach(oid => {
            const r = stopToRoutesMap.get(oid) || [];
            r.forEach(route => routes.add(route));
        });
        const originRoutes = Array.from(routes);

        const reachableStopIds = new Set();

        // Fetch Missing Details (using fetch.js helper)
        const routesNeedingFetch = originRoutes.filter(r => !r._details || !r._details.patterns);
        if (routesNeedingFetch.length > 0) {
            console.log(`[FilterManager] Fetching details for ${routesNeedingFetch.length} routes...`);
            document.body.style.cursor = 'wait';
            const btn = document.getElementById('filter-routes-toggle'); // ID might be different in button itself vs wrapper? main.js used filter-routes
            if (btn) btn.style.opacity = '0.5';

            try {
                await hydrateRouteDetails(routesNeedingFetch);
            } catch (err) {
                console.error('[FilterManager] Hydration error', err);
            } finally {
                document.body.style.cursor = 'default';
                if (btn) btn.style.opacity = '1';
            }
        }

        // Calculate Reachability
        const redirectMap = this.dataProvider.getRedirectMap();

        originRoutes.forEach(r => {
            // Logic extracted from main.js
            if (r._details && r._details.patterns) {
                r._details.patterns.forEach(p => {
                    if (p.stops) {
                        const idx = p.stops.findIndex(s => originEq.has(redirectMap.get(s.id) || s.id));
                        if (idx !== -1 && idx < p.stops.length - 1) {
                            p.stops.slice(idx + 1).forEach(s => {
                                const normId = redirectMap.get(s.id) || s.id;
                                this.getEquivalentStops(normId).forEach(eqId => reachableStopIds.add(eqId));
                            });
                        }
                    }
                });
            } else if (r._details && r._details.stops) {
                r._details.stops.forEach(s => {
                    const normId = redirectMap.get(s.id) || s.id;
                    if (!originEq.has(normId)) {
                        this.getEquivalentStops(normId).forEach(eqId => reachableStopIds.add(eqId));
                    }
                });
            }
        });

        this.state.reachableStopIds = reachableStopIds;
        console.log(`[FilterManager] Pick Mode. Reachable: ${reachableStopIds.size}`);

        if (reachableStopIds.size === 0) {
            alert("No route data available for filtering (Stops list empty).");
            this.clearFilter(currentStopId);
            return;
        }

        this.updateMapFilterState();
    }

    async ensureLazyRoutesForStop(stopId, equivalentStopIdsSet) {
        const stopToRoutesMap = this.dataProvider.getStopToRoutesMap();
        const redirectMap = this.dataProvider.getRedirectMap();
        const allRoutes = this.dataProvider.getAllRoutes();

        let hasKnownRoutes = false;
        equivalentStopIdsSet.forEach(oid => {
            if (stopToRoutesMap.has(oid) && stopToRoutesMap.get(oid).length > 0) hasKnownRoutes = true;
        });

        if (!hasKnownRoutes) {
            console.log(`[FilterManager] No local routes for ${stopId}. Fetching...`);
            try {
                const fetchedRoutes = await api.fetchStopRoutes(stopId);
                if (fetchedRoutes && Array.isArray(fetchedRoutes)) {
                    const normId = redirectMap.get(stopId) || stopId;
                    if (!stopToRoutesMap.has(normId)) stopToRoutesMap.set(normId, []);
                    const currentList = stopToRoutesMap.get(normId);

                    fetchedRoutes.forEach(fr => {
                        const canonical = allRoutes.find(r => String(r.shortName) === String(fr.shortName));
                        const routeToAdd = canonical || fr;
                        if (!currentList.includes(routeToAdd)) currentList.push(routeToAdd);
                    });
                }
            } catch (e) { console.warn('[FilterManager] Lazy fetch error', e); }
        }
    }

    applyFilter(targetId, currentStopId, lastArrivals, lastRoutes) {
        if (!this.state.picking || !this.state.originId) return;

        const redirectMap = this.dataProvider.getRedirectMap();
        const normTargetId = redirectMap.get(targetId) || targetId;
        const equivalentStops = this.getEquivalentStops(normTargetId);

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
        const originEq = new Set(this.getEquivalentStops(this.state.originId));
        await this.ensureLazyRoutesForStop(this.state.originId, originEq);

        const stopToRoutesMap = this.dataProvider.getStopToRoutesMap();
        const redirectMap = this.dataProvider.getRedirectMap();

        const originRoutesSet = new Set();
        originEq.forEach(oid => {
            const routes = stopToRoutesMap.get(oid) || [];
            routes.forEach(r => originRoutesSet.add(r));
        });
        const originRoutes = Array.from(originRoutesSet);

        // Ensure Hydration (Critical for Fresh Data reload)
        const routesNeedingFetch = originRoutes.filter(r => !r._details || !r._details.patterns);
        if (routesNeedingFetch.length > 0) {
            console.log(`[FilterManager] Refreshing detected ${routesNeedingFetch.length} unhydrated routes. Hydrating...`);
            try {
                await hydrateRouteDetails(routesNeedingFetch);
            } catch (err) { console.error('[FilterManager] Refresh hydration error', err); }
        }

        console.log(`[FilterManager] Refreshing. Origin: ${this.state.originId}, Targets: ${Array.from(this.state.targetIds).join(',')}. Routes to check: ${originRoutes.length}`);

        const commonRoutes = originRoutes.filter(r => {
            let routeStopsNormalized = null;
            let globalMatch = false;

            for (const tid of this.state.targetIds) {
                const targetEq = new Set(this.getEquivalentStops(tid));
                let matches = false;

                if (r._details && r._details.patterns) {
                    matches = r._details.patterns.some(p => {
                        if (!p.stops) return false;
                        const idxO = p.stops.findIndex(s => originEq.has(redirectMap.get(s.id) || s.id));
                        if (idxO === -1) return false;
                        const idxT = p.stops.findIndex((s, i) => i > idxO && targetEq.has(redirectMap.get(s.id) || s.id));
                        if (idxT !== -1) {
                            // console.log(`[FilterManager] Match found! Route ${r.shortName} connects to ${tid}`);
                            return true;
                        }
                        // Debugging only:
                        // if (this.state.targetIds.size > 0 && r.shortName === '333') { // Example hook
                        //    console.log(`[DebugMatch] Failed. Route ${r.shortName}. O-Index: ${idxO}. Target ${tid} not found after O.`);
                        // }
                        return false;
                    });
                } else if (r.stops) {
                    if (!routeStopsNormalized) routeStopsNormalized = r.stops.map(sid => redirectMap.get(sid) || sid);
                    const stops = routeStopsNormalized;
                    const idxO = stops.findIndex(sid => originEq.has(sid));
                    if (idxO !== -1) {
                        const idxT = stops.findIndex((sid, i) => i > idxO && targetEq.has(sid));
                        matches = (idxT !== -1);
                    }
                }
                if (matches) {
                    globalMatch = true;
                    return true;
                }
            }
            if (!globalMatch) {
                // Detailed debug for 0 results case (Failure)
                // Assuming we failed for ALL targets (since globalMatch is false)
                if (originRoutes.length <= 15) {
                    // Only log heavily if the list is small enough to be readable
                    // Debug specific route failure details
                    const debugTid = Array.from(this.state.targetIds)[0];
                    const debugTName = (this.dataProvider.getAllStops().find(s => s.id === debugTid) || {}).name || debugTid;

                    // Retrieve patterns if available
                    const patterns = r._details && r._details.patterns ? r._details.patterns.length : 'no-patterns';

                    console.log(`[FilterDebug] Fail: Route ${r.shortName} (${r.id}) has ${patterns} patterns. Stops: ${r.stops ? r.stops.length : '0'}. Target: ${debugTName} (${debugTid})`);
                }
            }
            return globalMatch;
        });

        console.log(`[FilterManager] Filtered Result: ${commonRoutes.length} routes.`);

        this.state.filteredRoutes = commonRoutes.map(r => r.id);
        this.state.active = true;

        this.updateMapFilterState();

        this.uiCallbacks.updateConnectionLine(this.state.originId, this.state.targetIds, false);

        // UI Updates
        if (currentStopId === this.state.originId) {
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

        this.router.updateStop(this.state.originId, true, Array.from(this.state.targetIds));
    }

    clearFilter(currentStopId) {
        this.state.active = false;
        this.state.picking = false;
        this.state.originId = null;
        this.state.targetIds = new Set();
        this.state.filteredRoutes = [];
        RouteFilterColorManager.reset();

        // Clear Map connection
        if (this.map.getSource('filter-connection')) {
            this.map.getSource('filter-connection').setData({ type: 'FeatureCollection', features: [] });
        }

        // Reset UI Button
        const btn = document.getElementById('filter-routes-toggle');
        if (btn) {
            btn.classList.remove('active');
            btn.querySelector('.filter-icon').src = iconFilterOutline;
            btn.querySelector('.filter-text').textContent = 'Filter routes...';
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

        // Reset Circles
        if (this.map.getLayer('stops-layer-circle')) {
            this.map.setPaintProperty('stops-layer-circle', 'circle-opacity', 1);
            this.map.setPaintProperty('stops-layer-circle', 'circle-stroke-opacity', 1);
            this.map.setPaintProperty('stops-layer-circle', 'circle-radius', this.uiCallbacks.getCircleRadiusExpression(1));
        }

        // Refresh View
        if (currentStopId) {
            const allStops = this.dataProvider.getAllStops();
            const stop = allStops.find(s => s.id === currentStopId);
            if (stop) this.uiCallbacks.showStopInfo(stop, false, true); // Restore zoom
        }
    }

    updateMapFilterState() {
        // Need to know if we are editing.
        const editState = this.dataProvider.getEditState();
        const editId = editState && editState.stopId ? editState.stopId : null;

        if (!this.state.picking && !this.state.active) {
            // Reset (Handling only the Edit Mode Opacity case here if Clear didn't catch it?)
            // Actually clearFilter handles the full reset usually. 
            // This method is mostly for applying the filter state.
            return;
        }

        const reachableArray = Array.from(this.state.reachableStopIds || []);
        const selectedArray = Array.from(this.state.targetIds || []);
        const originId = this.state.originId;

        const highOpacityIds = new Set(reachableArray);
        selectedArray.forEach(id => highOpacityIds.add(id));
        if (originId) highOpacityIds.add(originId);

        const opacityExpression = ['match', ['get', 'id']];
        if (editId) opacityExpression.push([editId], 0);
        opacityExpression.push(Array.from(highOpacityIds), 1.0, 0.1);

        const caseExpression = [
            'case',
            ['in', ['get', 'id'], ['literal', selectedArray]], 1000,
            ['==', ['get', 'id'], originId], 900,
            ['in', ['get', 'id'], ['literal', reachableArray]], 100,
            0
        ];

        if (this.map.getLayer('stops-layer')) {
            this.map.setPaintProperty('stops-layer', 'icon-opacity', opacityExpression);
            this.map.setLayoutProperty('stops-layer', 'symbol-sort-key', caseExpression);
        }

        if (this.map.getLayer('stops-layer-circle')) {
            this.map.setPaintProperty('stops-layer-circle', 'circle-opacity', opacityExpression);
            this.map.setPaintProperty('stops-layer-circle', 'circle-stroke-opacity', opacityExpression);

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

        if (this.map.getLayer('stops-label-selected')) {
            if (selectedArray.length > 0) {
                this.map.setFilter('stops-label-selected', ['in', ['get', 'id'], ['literal', selectedArray]]);
            } else {
                this.map.setFilter('stops-label-selected', ['in', ['get', 'id'], ['literal', []]]);
            }
        }

        if (this.map.getLayer('metro-layer-circle')) {
            this.map.setPaintProperty('metro-layer-circle', 'circle-opacity', opacityExpression);
            this.map.setPaintProperty('metro-layer-circle', 'circle-stroke-opacity', opacityExpression);
        }

        if (this.map.getLayer('stops-highlight')) {
            this.map.setPaintProperty('stops-highlight', 'icon-opacity', opacityExpression);
        }
    }
}
