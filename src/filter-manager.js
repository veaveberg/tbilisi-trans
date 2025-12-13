import mapboxgl from 'mapbox-gl';
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
        this.uiCallbacks = uiCallbacks;

        this.state = {
            active: false,
            picking: false,
            originId: null,
            targetIds: new Set(),
            reachableStopIds: new Set(),
            filteredRoutes: [] // Array of route IDs
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
                            return true;
                        }
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

        // Clear Markers
        this.destinationMarkers.forEach(marker => marker.remove());
        this.destinationMarkers.clear();

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

        // Reset Circles (Restore normal radius)
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

        if (!this.state.picking && !this.state.active) return;

        const reachableArray = Array.from(this.state.reachableStopIds || []);
        const selectedArray = Array.from(this.state.targetIds || []);
        const originId = this.state.originId;

        const highOpacityIds = new Set(reachableArray);
        // Exclude selected (targets) from highOpacityIds because they have their own 0-opacity rule
        // (Mapbox match expression requires unique branch labels)
        selectedArray.forEach(id => {
            highOpacityIds.delete(id);
        });

        if (originId) highOpacityIds.add(originId);

        // Exclude editId from highOpacityIds as well, as it has its own priority branch
        if (editId && highOpacityIds.has(editId)) {
            highOpacityIds.delete(editId);
        }

        const opacityExpression = ['match', ['get', 'id']];
        if (editId) opacityExpression.push([editId], 0);
        if (selectedArray.length > 0) opacityExpression.push(selectedArray, 0); // Hide selected from base layer
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
            const circleOpacityExpression = ['match', ['get', 'id']];
            if (editId) circleOpacityExpression.push([editId], 0);

            // Targets -> 0 opacity (handled by markers)
            if (selectedArray.length > 0) circleOpacityExpression.push(selectedArray, 0);

            // Others -> High/Low
            // High opacity for reachable (but not selected)
            circleOpacityExpression.push(Array.from(highOpacityIds), 1.0, 0.1);

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

        if (this.map.getLayer('stops-label-selected')) {
            if (selectedArray.length > 0) {
                this.map.setFilter('stops-label-selected', ['in', ['get', 'id'], ['literal', selectedArray]]);
            } else {
                this.map.setFilter('stops-label-selected', ['in', ['get', 'id'], ['literal', []]]);
            }
        }

        if (this.map.getLayer('metro-layer-circle')) {
            const finalOpacity = [
                'case',
                ['in', ['get', 'id'], ['literal', selectedArray]], 0,
                ['in', ['get', 'id'], ['literal', reachableArray]], 1,
                ['==', ['get', 'id'], originId], 1,
                0.1
            ];
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

            // Click Handler for Destination Markers
            this.map.on('click', 'destination-markers-layer', (e) => {
                const feature = e.features[0];
                if (feature) {
                    const targetId = feature.properties.id;
                    // Trigger Unselect (Apply Filter toggles logic)
                    window.applyFilter(targetId);
                }
            });

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
            routes.forEach(r => originRoutesSet.add(r));
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
                    return idxT !== -1;
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
        const ids = segmentStops
            .map(s => {
                let id = s.id || s;
                // Normalize Redirects first (matching main.js logic)
                id = redirectMap.get(id) || id;
                // Normalize Hubs
                return hubMap.get(id) || id;
            })
            .filter((id, i, arr) => i === 0 || id !== arr[i - 1]) // Dedup adjacent
            .join('|');

        return ids;
    }

    getGradientColors(routes, originId, targetId) {
        if (!routes || routes.length === 0) return ['#888'];

        const colors = routes.map(r => {
            let c = RouteFilterColorManager.pathColors.get(this.getPathSignature(r, originId, targetId));

            // Removed fallback to getColorForRoute(r.id) because it persists old colors
            // even after pathColors GC, causing mismatch with main.js logic which wants fresh colors.

            if (!c) {
                console.warn('[FilterManager] Color not found for signature:', this.getPathSignature(r, originId, targetId), 'Assigning new.');
                c = RouteFilterColorManager.assignNextColor(this.getPathSignature(r, originId, targetId), [r.id]);
            }
            return c;
        });

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
