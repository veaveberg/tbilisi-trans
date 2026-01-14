import './css/base.css';
import './css/map-ui.css';
import './css/search.css';
import './css/panels.css';
import './css/transit.css';
import './css/metro.css';
import './css/editor.css';
import './css/components.css';
import mapboxgl from 'mapbox-gl';

import { Router } from './router.js';
import * as api from './api.js';
import { RouteGeometry } from './route-geometry.js';
import { setSheetState, setPanelState, closeAllPanels, setupPanelDrag } from './panel-manager.js';
import * as metro from './metro.js';
const { handleMetroStop } = metro;
import { setupGeolocation, isTrackingActive, stopTracking, isUserInteractingWithMap, LOCATION_STATES } from './geolocation.js';
import { map, getMapHash } from './map-setup.js';
import { setupVisuals, loadImages, addStopsToMap, updateMapTheme, getCircleRadiusExpression, updateLiveBuses, setMapLightPreset } from './map-visuals.js';
import { setMapFocus, setupHoverHandlers, setupClickHandlers, addMetroHoverLogic } from './map-interactions.js';
import stopRotations from './data/stop_bearings.json';
import { db } from './db.js';
import { historyManager, addToHistory, popHistory, clearHistory, updateBackButtons, peekHistory } from './history.js';
import { hydrateRouteDetails } from './fetch.js';
import { setupEditTools, getEditState, setEditPickMode } from './dev-tools.js';
import * as arrivals from './arrivals.js';

import iconFilterOutline from './assets/icons/line.3.horizontal.decrease.circle.svg';
// import iconFilterFill from './assets/icons/line.3.horizontal.decrease.circle.fill.svg'; // Only used in FilterManager now? No, need check.


import { initSettings, simplifyNumber, shouldShowRoute } from './settings.js';

// --- Global State Declarations (Hoisted) ---
// These must be declared before api.fetchRoutes calls onRoutesLoaded
let allStops = [];
let rawStops = [];
let allRoutes = [];
let stopToRoutesMap = new Map();
const hydratedStops = new Set();
let lastRouteUpdateId = 0;
const redirectMap = new Map();

// --- Mobile Detection & Zoom Adjust ---
const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
window.addEventListener('pageScaleChange', (e) => {
    const scale = e.detail;
    document.documentElement.style.setProperty('--ui-scale', scale);
});
const hubMap = new Map();
const hubSourcesMap = new Map();
const mergeSourcesMap = new Map();

let busUpdateInterval = null;
// State declarations

// Initialize Settings
initSettings({
    onUpdate: () => {
        // Re-render Views
        if (window.currentStopId) {
            // If we have cached lastArrivals, re-render
            if (window.lastArrivals) {
                arrivals.renderArrivals(window.lastArrivals, window.currentStopId);
            }
        }
        if (filterManager) {
            filterManager.recalculateFilter(window.currentStopId, window.lastArrivals, window.lastRoutes);
        }
    }
});

// Setup Map Controls
// Setup Geolocation & Map Interactions
setupGeolocation(map);
setupVisuals();

// Initial Router State Handling
Router.init();
const initialState = Router.parse();

// --- OPTIMIZED INITIALIZATION ---
let isRouterLogicExecuted = false;

function onRoutesLoaded(data) {
    if (!data) return;

    // Deep Check for 497
    const r497 = data.find(r => r.shortName === '497' || r.id.includes('minibusR24335'));
    if (r497) {
        console.log('[API DEBUG] onRoutesLoaded 497 check:', { id: r497.id, hasOv: !!r497._overrides });
    }

    allRoutes = data; // Always update global data
    applyRouteOverrides(); // Apply overrides immediately after loading

    if (isRouterLogicExecuted) return; // Only run initial routing once
    isRouterLogicExecuted = true;

    // console.log('[Init] Router Logic Executing with', data.length, 'routes');

    // 2. Direct Route (Bus only)
    if (initialState.type === 'route' && initialState.shortName) {
        const execute = () => {
            api.fetchV3Routes().then(() => {
                const routeObj = allRoutes.find(r => String(r.shortName) === String(initialState.shortName));
                if (routeObj) {
                    showRouteOnMap(routeObj, true, { initialDirectionIndex: initialState.direction, fitToRoute: true });
                }
            });
        };
        if (map.loaded()) execute(); else map.once('load', execute);
    }

    // 3. Stop / Nested / Filter (Delegated to handleDeepLinks)
    // We delegate all stop-based logic to handleDeepLinks to ensure redirects (merged stops) are processed correctly.
    // Wait for map to be loaded AND stops to be available before processing
    else if (initialState.stopId) {
        const executeStopDeepLink = async () => {
            // Wait until allStops is populated (stops load separately from routes)
            if (allStops.length === 0) {
                // Retry after a short delay - stops might still be loading
                setTimeout(executeStopDeepLink, 100);
                return;
            }
            handleDeepLinks();
        };
        if (map.loaded()) executeStopDeepLink(); else map.once('load', executeStopDeepLink);
    }
}

// Consolidated loading logic is now inside map.on('load') to avoid race conditions.
const staticPreloadPromise = api.preloadStaticRoutesDetails(); // Preload for filtering

// Update URL hash when map movement ends (including inertia)
const updateURLHash = () => {
    // Skip hash updates when a stop or route card is open
    // (the stop/route URL itself leads to the correct location)
    const infoPanel = document.getElementById('info-panel');
    const routePanel = document.getElementById('route-info');
    if ((infoPanel && !infoPanel.classList.contains('hidden')) ||
        (routePanel && !routePanel.classList.contains('hidden'))) {
        return;
    }

    // Throttle updates in follow mode to avoid excessive history changes
    if (isTrackingActive()) {
        const now = Date.now();
        if (now - (window.lastFollowHashUpdate || 0) < 10000) return;
        window.lastFollowHashUpdate = now;
    }
    Router.updateMapLocation(getMapHash());
};

map.on('moveend', updateURLHash);
map.on('dragend', updateURLHash); // Also update on dragend since moveend doesn't always fire

// Initialize Filter Icon
const initialFilterBtn = document.getElementById('filter-routes-toggle');
if (initialFilterBtn) {
    initialFilterBtn.querySelector('.filter-icon').src = iconFilterOutline;
}


// State
// State declarations moved to top to avoid TDZ errors
// (allStops, allRoutes, etc.)

// Bus Interval

// Bus Interval



function getEquivalentStops(id, includeHubs = true) {
    if (includeHubs) {
        const parent = hubMap.get(id) || id;
        const children = hubSourcesMap.get(parent);
        if (children) {
            // If it's a hub, return all children.
            return Array.from(children);
        }
    }
    // Check Redirects
    const set = new Set();
    set.add(id);
    if (redirectMap.has(id)) set.add(redirectMap.get(id));
    if (mergeSourcesMap.has(id)) mergeSourcesMap.get(id).forEach(s => set.add(s));
    return Array.from(set);
}

// --- Navigation History ---
// Moved to history.js

function handleBack() {
    const previous = popHistory();
    if (previous) {
        if (previous.type === 'stop') {
            // Restore map view to stop
            // Restore persistence zoom if available
            if (previous.data.savedZoom) {
                window.savedZoom = previous.data.savedZoom; // Temporary global handoff (or modify showStopInfo)
                // Actually easier to just modify showStopInfo to respect it from the object property
            }
            showStopInfo(previous.data, false, true); // false = no history, true = flyTo
        } else if (previous.type === 'route') {
            showRouteOnMap(previous.data, false, { preserveBounds: true });
        }
    } else {
        // If going back to nothing (empty stack), clear everything
        stopEditing(true); // Persist and Close Edit Mode
        closeAllPanels();
        // Reset Map Focus
        setMapFocus(false);
        // Clear Route
        clearRoute();
        // Clear Highlight
        if (map.getSource('selected-stop')) {
            map.getSource('selected-stop').setData({ type: 'FeatureCollection', features: [] });
        }
        window.currentStopId = null;
    }
}

// --- Filter Manager ---
import { FilterManager, generatePathSignature } from './filter-manager.js';

let filterManager;

const dataProvider = {
    getAllStops: () => allStops,
    getAllRoutes: () => allRoutes,
    getRedirectMap: () => redirectMap,
    getHubMap: () => hubMap,
    getHubSourcesMap: () => hubSourcesMap,
    getMergeSourcesMap: () => mergeSourcesMap,
    getStopToRoutesMap: () => stopToRoutesMap,
    getHydratedStops: () => hydratedStops,
    getEditState: getEditState
};

const ALL_STOP_LAYERS = [
    'stops-layer',
    'stops-layer-circle',
    'stops-layer-hit-target',
    'metro-layer-circle',
    'metro-layer-label',
    'metro-transfer-layer',
    'metro-layer-overlay'
];

// Explicit Metro Hover Logic (Pop Effect / Overlay)
// Moved to map-interactions.js
// Call this after map load or in Setup


const uiCallbacks = {
    renderArrivals: arrivals.renderArrivals,
    renderAllRoutes,
    setSheetState,
    updateConnectionLine,
    showStopInfo,
    getCircleRadiusExpression: (scale) => getCircleRadiusExpression(scale)
};

// Lazy Init to ensure Map is ready? Or just init immediately.
// Map is imported. Router is imported.
filterManager = new FilterManager({ map, router: Router, dataProvider, uiCallbacks });

// Initialize Arrivals Module with dependencies
arrivals.initArrivals({
    getEquivalentStops,
    mergeSourcesMap,
    stopToRoutesMap,
    renderAllRoutes,
    getRouteDisplayColor,
    getPatternHeadsign,
    allRoutes: () => allRoutes,
    // renderArrivals dependencies
    filterManager,
    showRouteOnMap,
    RouteGeometry,
    v3RoutesMap: () => v3RoutesMap
});

// Initialize Hover Handlers
setupHoverHandlers({
    ALL_STOP_LAYERS,
    setFilterOpacity: (dim) => {
        const opacity = dim ? 0.3 : 0.8;
        if (map.getLayer('filter-connection-line')) {
            map.setPaintProperty('filter-connection-line', 'line-opacity', opacity);
        }
        const style = map.getStyle();
        if (style && style.layers) {
            style.layers.forEach(l => {
                if (l.id.startsWith('filter-connection-')) {
                    map.setPaintProperty(l.id, 'line-opacity', opacity);
                }
            });
        }
    },
    filterManager: filterManager, // Pass Manager
    updateConnectionLine: updateConnectionLine // Pass function for hover preview
});

// Init Metro Hover
addMetroHoverLogic(map, filterManager);


// Initialize Click Handlers
setupClickHandlers({
    ALL_STOP_LAYERS,
    filterManager,
    showStopInfo,
    applyFilter: (targetId) => filterManager.applyFilter(targetId, window.currentStopId, window.lastArrivals, window.lastRoutes)
});

// Forwarding functions for UI event handlers
window.toggleFilterMode = () => filterManager.toggleFilterMode(window.currentStopId, window.isPickModeActive, setEditPickMode);
window.applyFilter = (targetId) => filterManager.applyFilter(targetId, window.currentStopId, window.lastArrivals, window.lastRoutes);
window.clearFilter = () => filterManager.clearFilter(window.currentStopId);

import { RouteFilterColorManager } from './color-manager.js';

import { setupSearch } from './search.js';
import { ThemeManager } from './theme.js';

// Global Theme Manager
let themeManager;

// Legacy function cleanup
// toggleFilterMode, updateMapFilterState, ensureLazyRoutesForStop, refreshRouteFilter, applyFilter, clearFilter 
// are now handled by filterManager.
// We need to remove the definitions.

// Re-export specific hook for map updates from filter manager
function updateMapFilterState() {
    filterManager.updateMapFilterState();
}

// Back Button Listeners
document.getElementById('back-panel')?.addEventListener('click', handleBack);
document.getElementById('back-route-info')?.addEventListener('click', handleBack);

// --- Search History ---


// Initialize map data
// --- Map Initialization & Data Loading ---
let isSearchInitialized = false;
let areImagesLoaded = false;
let isDeepLinkHandled = false;

async function initializeMapData(stopsData, routesData) {
    if (!stopsData || !routesData) return;

    // console.log('[Main] Initializing Map Data...');

    // 1. Update Globals
    rawStops = stopsData;
    allRoutes = routesData;
    window.allStops = allStops; // Debug support
    applyRouteOverrides(); // Ensure overrides are applied to fresh data


    // 2. Config & Layers (Populates allStops from rawStops)
    await refreshStopsLayer();

    // 3. Index Routes (Clear and Rebuild)
    stopToRoutesMap.clear();
    hydratedStops.clear();
    allRoutes.forEach(route => {
        if (route.stops) {
            route.stops.forEach(stopId => {
                const targetId = redirectMap.get(stopId) || stopId;
                if (!stopToRoutesMap.has(targetId)) stopToRoutesMap.set(targetId, []);
                if (!stopToRoutesMap.get(targetId).includes(route)) {
                    stopToRoutesMap.get(targetId).push(route);
                }
            });
        }
    });

    // 4. Setup Search (Run Once)
    if (!isSearchInitialized) {
        setupSearch({
            onRouteSelect: (route) => showRouteOnMap(route),
            onStopSelect: (stop) => showStopInfo(stop, true, true)
        }, {
            getAllStops: () => allStops,
            getAllRoutes: () => allRoutes
        });
        isSearchInitialized = true;
    }

    // 5. Map Visuals
    addStopsToMap(allStops, { redirectMap, filterManager, updateConnectionLine });
    if (!areImagesLoaded) {
        await loadImages(map);
        areImagesLoaded = true;
    }

    // 6. Final UI
    document.body.classList.remove('loading');
    setTimeout(() => {
        map.resize();
        // This fixes the issue where "Fresh Load" resets the layer styles, undoing deep link dimming.
        if (window.currentStopId) {
            setMapFocus(true);

            // Also restore stop highlight marker (may have been cleared by addStopsToMap)
            const highlightStop = allStops.find(s => String(s.id) === String(window.currentStopId));
            if (highlightStop && highlightStop.lon && highlightStop.lat && map.getSource('selected-stop')) {
                map.getSource('selected-stop').setData({
                    type: 'FeatureCollection',
                    features: [{
                        type: 'Feature',
                        geometry: { type: 'Point', coordinates: [highlightStop.lon, highlightStop.lat] },
                        properties: highlightStop
                    }]
                });
                if (map.getLayer('stops-highlight')) map.moveLayer('stops-highlight');
            }
        }
    }, 100);

    // 7. Router / Deep Links
    if (!isDeepLinkHandled) {
        const success = await handleDeepLinks();
        if (success) {
            isDeepLinkHandled = true;

            Router.onPopState = (state) => {
                if (state.stopId) {
                    // ... (Router logic handled by handleDeepLinks essentially or showStopInfo)
                    // Actually handleDeepLinks is one-off. Router listeners handle subsequent.
                }
            };
        }
    } else {
        // Deep link already handled (e.g. by Fast Load).
        // If we just reloaded fresh data, we MUST re-apply the filter to the new objects.
        if (filterManager.state.active && filterManager.state.originId) {
            // console.log('[Main] Fresh data loaded while Filter Active. Re-applying...');
            // Use refreshRouteFilter, which now includes hydration logic
            filterManager.refreshRouteFilter(filterManager.state.originId);
        }
    }

    // console.log('[Main] Initialization Complete');
} // End of initializeMapData



// Image Loading Function
// Render at 3x resolution for crispness on Retina/High-DPI screens
// Image Loading Function Moved to map-setup.js

map.on('load', () => {
    // Selected Stop Source
    if (!map.getSource('selected-stop')) {
        map.addSource('selected-stop', {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: [] }
        });
    }

    // Stop Selection State Layer (more prominent)
    if (!map.getLayer('stops-highlight')) {
        map.addLayer({
            id: 'stops-highlight',
            type: 'symbol',
            source: 'selected-stop',
            // filter: ['!=', 'mode', 'SUBWAY'], // Removed to ensure ALL stops highlight
            layout: {
                'icon-image': [
                    'case',
                    ['>', ['get', 'rotation'], 0], 'stop-selected-icon', // Arrow
                    'stop-icon' // Circle fallback
                ],
                'icon-size': [
                    'case',
                    ['==', ['get', 'mode'], 'SUBWAY'], 1.5,
                    1.2
                ],
                'icon-allow-overlap': true,
                'icon-ignore-placement': true,
                'icon-rotate': ['coalesce', ['get', 'rotation'], 0],
                'icon-rotation-alignment': 'map'
            },
            paint: {
                'icon-opacity': 1
            }
        });
    }
});

// Removed pendingRequests (moved to api.js)



// ... (keep this replacement near imports later)

// --- Map Initialization ---
map.on('load', async () => {
    // Initialize Theme Manager FIRST (Before any UI rendering to prevent theme flicker)
    themeManager = new ThemeManager(map);
    themeManager.init();

    // Listen for Manual Changes from Settings
    window.addEventListener('manualThemeChange', (e) => {
        const newTheme = e.detail;
        console.log('[Theme] Manual Switch:', newTheme);
        themeManager.setTheme(newTheme);
    });

    // Unified Loading Path
    const loadAllAtOnce = async () => {
        // 1. FAST PATH
        try {
            const [stops, routes] = await Promise.all([
                api.fetchStops({ strategy: 'cache-only' }),
                api.fetchRoutes({ strategy: 'cache-only' })
            ]);
            if (stops && routes) {
                console.log('[Load] Fast data loaded');
                await initializeMapData(stops, routes);
                onRoutesLoaded(routes);
            }
        } catch (e) { console.warn('Fast Load Failed', e); }

        // 2. FRESH PATH
        try {
            const [stops, routes] = await Promise.all([
                api.fetchStops(),
                api.fetchRoutes()
            ]);
            console.log('[Load] Fresh data loaded');
            await initializeMapData(stops, routes);
            onRoutesLoaded(routes);
        } catch (e) { console.error('Fresh Load Failed', e); }
    };

    loadAllAtOnce();
    loadMinibusSegments();
});

async function loadMinibusSegments() {
    try {
        const basePath = import.meta.env.BASE_URL.endsWith('/') ? import.meta.env.BASE_URL : `${import.meta.env.BASE_URL}/`;
        const response = await fetch(`${basePath}data/long_segments.geojson`);
        if (!response.ok) return;
        const data = await response.json();

        if (map.getSource('minibus-segments')) {
            map.getSource('minibus-segments').setData(data);
        } else {
            map.addSource('minibus-segments', {
                type: 'geojson',
                data: data
            });

            // 1. Check Initial Setting (Default: Hidden)
            const isVisible = localStorage.getItem('showMinibusSegments') === 'true';

            map.addLayer({
                id: 'minibus-segments-layer',
                type: 'line',
                source: 'minibus-segments',
                layout: {
                    'line-join': 'round',
                    'line-cap': 'round',
                    'visibility': isVisible ? 'visible' : 'none'
                },
                paint: {
                    'line-color': '#FF4500', // Orange-Red
                    'line-width': 4,
                    'line-opacity': 0.8
                }
            });

            // Add popup on click
            map.on('click', 'minibus-segments-layer', (e) => {
                const props = e.features[0].properties;
                new mapboxgl.Popup()
                    .setLngLat(e.lngLat)
                    .setHTML(`
                        <div style="color:black">
                            <strong>Route ${props.routeNumber}</strong><br>
                            Gap: ${props.gapLength}m<br>
                            From: ${props.from}<br>
                            To: ${props.to}
                        </div>
                    `)
                    .addTo(map);
            });

            // Change cursor
            map.on('mouseenter', 'minibus-segments-layer', () => {
                map.getCanvas().style.cursor = 'pointer';
            });
            map.on('mouseleave', 'minibus-segments-layer', () => {
                map.getCanvas().style.cursor = '';
            });
        }
        // console.log(`[Map] Loaded ${data.features.length} minibus segments`);
    } catch (e) {
        console.warn('[Map] Failed to load minibus segments:', e);
    }
}

// Listener for Toggle
window.addEventListener('minibusSegmentsChange', (e) => {
    const visible = e.detail;
    if (map.getLayer('minibus-segments-layer')) {
        map.setLayoutProperty('minibus-segments-layer', 'visibility', visible ? 'visible' : 'none');
    }
});

// ---// Theme Switching Listener
window.addEventListener('themeChanged', (e) => {
    const { theme, lightPreset } = e.detail;
    // console.log(`[Theme] Switching to: ${theme} (Preset: ${lightPreset})`);

    // 1. Update the map's light preset
    setMapLightPreset(lightPreset);

    // 2. Update custom label colors (Metro, etc.) after a brief delay
    setTimeout(() => {
        updateMapTheme();

        // 3. Re-apply filter state if active (updateMapTheme resets layer styles)
        if (filterManager && (filterManager.state.active || filterManager.state.picking)) {
            filterManager.updateMapFilterState();
        }
    }, 50);

    // 4. Refresh UI elements if panels are open
    setTimeout(() => {
        const stopPanelVisible = !document.getElementById('info-panel').classList.contains('hidden');
        const routePanelVisible = !document.getElementById('route-info').classList.contains('hidden');

        if (window.currentStopId && window.lastArrivals && stopPanelVisible) {
            arrivals.renderArrivals(window.lastArrivals, window.currentStopId);
        }
        if (window.currentRoute && routePanelVisible) {
            updateRouteView(window.currentRoute, { suppressPanel: true });
        }
    }, 100);
});

function restoreMapLayers() {
    // 1. Restore Images
    // Ensure we await this or handle it synchronously if possible, but loadImages is async
    // Since we are inside an event handler, we can just fire it.
    loadImages(map).then(() => {
        // Redraw layers if needed, but addStopsToMap usually handles source/layer adding.
        // If layers are added before images, they might be blank until images load.
        // Mapbox handles this gracefully usually.
    });

    // 2. Restore Stops & Routes Layers
    if (window.allStops) {
        addStopsToMap(window.allStops, { redirectMap, filterManager, updateConnectionLine });
    }

    // 2.5 Ensure Selected Stop Source & Layer Exist (Critical for Style Reload)
    if (!map.getSource('selected-stop')) {
        map.addSource('selected-stop', {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: [] }
        });
    }
    // Layer is added by addStopsToMap now? No, we need to ensure it's added.
    // Actually, addStopsToMap should handle all static layers including highlight for consistency.
    // Let's modify addStopsToMap to include it, so we don't duplicate logic.
    // But for now, ensuring source exists here is safe.


    // 3. Restore Active Route (Only if actually active/open)
    if (currentRoute) {
        // console.log('[Restore] Re-plotting active route:', currentRoute.shortName);
        // Suppress panel if we have an active stop (Nested view) 
        // OR if we just want to restore the map lines without altering UI state too much
        const hasActiveStop = !!window.currentStopId;
        showRouteOnMap(currentRoute, false, { preserveBounds: true, suppressPanel: hasActiveStop });
    }

    // 4. Restore Active Stop Selection & Focus
    if (window.currentStopId) {
        // console.log('[Restore] Restoring active stop selection:', window.currentStopId);

        // Restore Destination Markers if active filter
        if (filterManager.state.active && filterManager.state.targetIds.size > 0) {
            filterManager.refreshRouteFilter(window.currentStopId);
        }

        // Restore Selection Highlight
        const stop = allStops.find(s => s.id === window.currentStopId);
        if (stop && map.getSource('selected-stop')) {
            map.getSource('selected-stop').setData({
                type: 'FeatureCollection',
                features: [{
                    type: 'Feature',
                    geometry: { type: 'Point', coordinates: [stop.lon, stop.lat] },
                    properties: { ...stop, mode: stop.vehicleMode || 'BUS' }
                }]
            });
        }

        // Restore Dimming/Focus
        // Wait for layers to settle? No, we just added them.
        setMapFocus(true);
    }
}

// Modify fetchWithCache to use db
// API Functions Moved to api.js






const GREEN_LINE_STOPS = [
    'State University', 'Vazha-Pshavela', 'Vazha Pshavela', 'Delisi', 'Medical University', 'Technical University', 'Tsereteli', 'Station Square 2'
];

// Handle Initial URL State (Deep Links)
async function handleDeepLinks() {
    const state = Router.parse();
    if (state.stopId) {
        const rawStopId = state.stopId;
        // Router might force '1:' prefix for nested routes, but internal IDs might be '3955'
        const cleanId = String(rawStopId).replace(/^1:/, '');

        // Check Redirects for both forms
        const normStopId = redirectMap.get(rawStopId) || redirectMap.get(cleanId) || rawStopId;

        // Try finding stop with normalized ID, raw ID, or clean ID
        // This ensures we catch '1:3955' -> '3955' mismatches
        const stop = allStops.find(s =>
            String(s.id) === String(normStopId) ||
            String(s.id) === String(cleanId) ||
            String(s.id) === String(rawStopId)
        );

        // console.log(`[DeepLink] Processing Stop: ${rawStopId} -> ${normStopId}. Found=${!!stop}`);
        if (stop) {
            // Check for Filtered State
            if (state.filterActive && state.targetIds && state.targetIds.length > 0) {
                // console.log('[DeepLink] Applying Filter:', state.targetIds);

                // 2. Show Stop (Suppress URL update, NO FlyTo to avoid conflict with Filter flyTo)
                await showStopInfo(stop, false, false, false);

                // 3. Apply Filter Logic
                // We need to trigger the filter mode fully
                // Use forceEnable to prevent toggle-off if called twice (e.g., Fast Load then Fresh Load)
                // Use skipFlyTo because we'll use fitBounds after targets are set to show the full filtered area
                await filterManager.toggleFilterMode(normStopId, null, null, { forceEnable: true, skipFlyTo: true });

                // Then apply specific targets if any
                if (state.targetIds && state.targetIds.length > 0) {
                    state.targetIds.forEach(tid => {
                        // Normalize Target ID (e.g. '930' -> '1:930')
                        const normTid = redirectMap.get(tid) || tid;
                        // Add all equivalent stops (matching applyFilter behavior)
                        // This ensures merged stops, hub stops, and redirects are all included
                        const equivalentStops = getEquivalentStops(normTid);
                        console.log(`[DeepLink] Target ${tid} -> normalized: ${normTid}, equivalents: [${equivalentStops.join(', ')}]`);
                        equivalentStops.forEach(eqId => filterManager.state.targetIds.add(eqId));
                    });
                    console.log(`[DeepLink] Final targetIds: [${Array.from(filterManager.state.targetIds).join(', ')}]`);
                    // Trigger refresh to apply
                    await filterManager.refreshRouteFilter(normStopId);
                }

                // 4. Update UI Button State
                const filterBtn = document.getElementById('filter-routes-toggle');
                if (filterBtn) filterBtn.classList.add('active');

                // 5. Fit map to show origin and all destination stops
                const bounds = new mapboxgl.LngLatBounds();

                // Add origin stop
                if (stop.lon && stop.lat) {
                    bounds.extend([parseFloat(stop.lon), parseFloat(stop.lat)]);
                    console.log(`[DeepLink] Bounds: Added origin ${stop.id} at [${stop.lon}, ${stop.lat}]`);
                }

                // Add all destination stops
                let targetCount = 0;
                filterManager.state.targetIds.forEach(targetId => {
                    const targetStop = allStops.find(s => s.id === targetId);
                    if (targetStop && targetStop.lon && targetStop.lat) {
                        bounds.extend([parseFloat(targetStop.lon), parseFloat(targetStop.lat)]);
                        console.log(`[DeepLink] Bounds: Added target ${targetId} at [${targetStop.lon}, ${targetStop.lat}]`);
                        targetCount++;
                    } else {
                        console.log(`[DeepLink] Bounds: Target ${targetId} not found or missing coords`);
                    }
                });

                // Fly to fit bounds - store for later execution when map is idle
                if (!bounds.isEmpty() && targetCount > 0) {
                    const boundsArray = bounds.toArray();
                    console.log(`[DeepLink] Calculated bounds: SW=${JSON.stringify(boundsArray[0])}, NE=${JSON.stringify(boundsArray[1])}`);

                    // Store the bounds to fit - only the last one will be used
                    window._pendingFilterBounds = bounds;

                    // Schedule fitBounds to run when map is idle (only once)
                    if (!window._pendingFilterBoundsScheduled) {
                        window._pendingFilterBoundsScheduled = true;

                        // Wait for map to be idle (all tiles loaded, no animations)
                        const fitWhenReady = () => {
                            if (window._pendingFilterBounds) {
                                const b = window._pendingFilterBounds;

                                // Get panel height for bottom padding, but cap it to avoid overflow
                                const panel = document.getElementById('info-panel');
                                const rawPanelHeight = panel ? panel.offsetHeight : 200;
                                // Cap at half screen height or 300px, whichever is smaller
                                const maxPadding = Math.min(window.innerHeight * 0.4, 300);
                                const panelHeight = Math.min(rawPanelHeight, maxPadding);

                                console.log(`[DeepLink] Fitting bounds with padding. Panel: ${rawPanelHeight}px, capped to: ${panelHeight}px`);

                                // Temporarily restore original map methods (fitBounds internally uses flyTo)
                                const origMethods = window._originalMapMethods;
                                if (origMethods) {
                                    map.flyTo = origMethods.flyTo;
                                    map.jumpTo = origMethods.jumpTo;
                                    map.easeTo = origMethods.easeTo;
                                }

                                map.fitBounds(b, {
                                    padding: {
                                        top: 100,
                                        bottom: panelHeight + 60,
                                        left: 50,
                                        right: 50
                                    },
                                    maxZoom: 16,
                                    duration: 1200
                                });

                                // Re-apply no-op overrides so auto-locate doesn't center
                                if (origMethods) {
                                    map.flyTo = () => map;
                                    map.jumpTo = () => map;
                                    map.easeTo = () => map;
                                }

                                window._pendingFilterBounds = null;
                                window._pendingFilterBoundsScheduled = false;
                            }
                        };

                        // Use multiple strategies to ensure we catch the right moment
                        map.once('idle', fitWhenReady);
                        // Also try after a longer delay as backup
                        setTimeout(() => {
                            if (window._pendingFilterBounds) {
                                console.log('[DeepLink] Backup timeout triggered');
                                fitWhenReady();
                            }
                        }, 2000);
                    }
                } else {
                    console.log(`[DeepLink] Bounds empty or no targets found. isEmpty=${bounds.isEmpty()}, targetCount=${targetCount}`);
                }
            } else {
                // Standard Stop View (or nested route - suppress panel if route follows)
                // addToStack=true: Ensure Stop is in internal history so "Back" works
                // updateURL=false: Deep link URL is already set, don't overwrite yet
                // suppressPanel: If we have a nested route, don't show stop panel - only set up state
                await showStopInfo(stop, true, !state.shortName, false, { suppressPanel: !!state.shortName });
            }

            // Handle Nested Route (Bus) found in URL
            if (state.shortName) {
                // Fetch V3 routes and ensure we wait for it
                // We use 'await' here to ensure the Route UI triggers after Stop UI is ready
                // but since api.fetchV3Routes is async, we can just chain it.
                // Note: showRouteOnMap is async too.
                try {
                    await api.fetchV3Routes();
                    const route = allRoutes.find(r => String(r.shortName) === String(state.shortName));
                    if (route) {
                        // Fix for Zoom Out issue:
                        // showStopInfo uses flyTo, so map.getZoom() immediately after is unstable (still zooming).
                        // We must explicitly tell showRouteOnMap what the "previous" (Stop) zoom was intended to be (16 or higher).
                        const intendedStopZoom = map.getZoom() > 16 ? map.getZoom() : 16;

                        // Show Route
                        // addToStack=true: Add Route to history (Stop -> Route)
                        // fromStopId: Helps with direction matching
                        // centerOnStop: Fly to stop location since we're coming from a deep link
                        await showRouteOnMap(route, true, {
                            initialDirectionIndex: state.direction,
                            fromStopId: stop.id,
                            startZoom: intendedStopZoom,
                            centerOnStop: { lat: stop.lat, lon: stop.lon } // Fly to stop on deep link
                        });
                    } else {
                        console.warn(`[DeepLink] Route ${state.shortName} not found in allRoutes.`);
                    }
                } catch (e) {
                    console.error('[DeepLink] Failed to load nested route:', e);
                }
            }
            return true; // Successfully handled
        } else {
            console.warn(`[DeepLink] Stop ${state.stopId} not found in data.`);
            return false; // Failed to find stop (retry later?)
        }
    }
    // Note: Route deep links are handled by onRoutesLoaded logic
    return true; // Nothing to handle
}



// Listen for Theme Changes
window.addEventListener('manualThemeChange', () => {
    if (map && map.getStyle()) {
        updateMapTheme();
        // Re-apply filter state if active (updateMapTheme resets layer styles)
        if (filterManager && (filterManager.state.active || filterManager.state.picking)) {
            filterManager.updateMapFilterState();
        }
    }
});






// Handle touch/drag logic for panels
setupPanelDrag('info-panel');
setupPanelDrag('route-info');


// Zoom Logic for Reset Button
const resetBtn = document.getElementById('reset-view');
resetBtn.addEventListener('click', () => {
    map.flyTo({ center: [44.78, 41.72], zoom: 12 });
});

map.on('moveend', () => {
    const zoom = map.getZoom();
    if (zoom < 10) {
        resetBtn.classList.remove('hidden');
    } else {
        resetBtn.classList.add('hidden');
    }
});


async function showStopInfo(stop, addToStack = true, flyToStop = false, updateURL = true, options = {}) {
    const { suppressPanel = false } = options;

    // Stop location tracking if we are selecting something specific
    stopTracking();
    if (!stop) return;

    if (stop.id) window.currentStopId = stop.id;

    // Enable Focus Mode (Dim others)
    setMapFocus(true);

    if (addToStack) addToHistory('stop', stop);

    // Sync URL (Router)
    if (updateURL) {
        Router.updateStop(stop.id, filterManager.state.active, Array.from(filterManager.state.targetIds));
    }

    // Explicitly clean up any route layers when showing a stop
    if (busUpdateInterval) clearInterval(busUpdateInterval);

    // Robust Layer Cleanup
    const style = map.getStyle();
    if (style && style.layers) {
        const layersToRemove = style.layers
            .filter(layer => layer.id.startsWith('route') || layer.id.startsWith('live-buses'))
            .map(layer => layer.id);

        layersToRemove.forEach(id => {
            if (map.getLayer(id)) map.removeLayer(id);
        });
    }
    // Set sources to empty collections instead of removing them, to avoid "source missing" errors
    ['route', 'route-stops', 'live-buses'].forEach(id => {
        if (map.getSource(id)) map.getSource(id).setData({ type: 'FeatureCollection', features: [] });
    });

    if (stop.id) {
        window.currentStopId = stop.id;
        if (window.selectDevStop) window.selectDevStop(stop.id);

        console.log('[showStopInfo] flyToStop:', flyToStop, 'stop.lon:', stop.lon, 'stop.lat:', stop.lat);
        if (flyToStop && stop.lon && stop.lat) {
            console.log('[showStopInfo] Executing flyTo to:', stop.lon, stop.lat);

            // Restore original map methods if they were overridden by auto-show location marker
            if (window._originalMapMethods) {
                map.flyTo = window._originalMapMethods.flyTo;
                map.jumpTo = window._originalMapMethods.jumpTo;
                map.easeTo = window._originalMapMethods.easeTo;
            }

            const offsetY = -(window.innerHeight * 0.1);
            const currentZoom = map.getZoom();
            const targetZoom = stop.savedZoom || (currentZoom > 16 ? currentZoom : 16);
            map.flyTo({
                center: [stop.lon, stop.lat],
                zoom: targetZoom,
                offset: [0, offsetY]
            });
        }

        if (stop.lon && stop.lat) {
            const feature = {
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [stop.lon, stop.lat] },
                properties: stop
            };

            // Ensure source and layer exist (may not exist yet during early deep link processing)
            if (!map.getSource('selected-stop')) {
                map.addSource('selected-stop', {
                    type: 'geojson',
                    data: { type: 'FeatureCollection', features: [] }
                });
            }
            if (!map.getLayer('stops-highlight')) {
                map.addLayer({
                    id: 'stops-highlight',
                    type: 'symbol',
                    source: 'selected-stop',
                    layout: {
                        'icon-image': [
                            'case',
                            ['>', ['get', 'rotation'], 0], 'stop-selected-icon',
                            'stop-icon'
                        ],
                        'icon-size': [
                            'case',
                            ['==', ['get', 'mode'], 'SUBWAY'], 1.5,
                            1.2
                        ],
                        'icon-allow-overlap': true,
                        'icon-ignore-placement': true,
                        'icon-rotate': ['coalesce', ['get', 'rotation'], 0],
                        'icon-rotation-alignment': 'map'
                    },
                    paint: {
                        'icon-opacity': 1
                    }
                });
            }

            map.getSource('selected-stop').setData({
                type: 'FeatureCollection',
                features: [feature]
            });
            if (map.getLayer('stops-highlight')) map.moveLayer('stops-highlight');
        } else {
            const refreshedStop = allStops.find(s => s.id === stop.id);
            if (refreshedStop && refreshedStop.lat) {
                stop.lat = refreshedStop.lat;
                stop.lon = refreshedStop.lon;
                stop.name = refreshedStop.name;
                return showStopInfo(stop, addToStack, flyToStop, updateURL);
            }
        }
    }

    // If suppressPanel is true, we skip all UI rendering - just set up state and highlight
    if (suppressPanel) {
        return;
    }

    const panel = document.getElementById('info-panel');
    const nameEl = document.getElementById('stop-name');
    const listEl = document.getElementById('arrivals-list');

    setSheetState(document.getElementById('route-info'), 'hidden');
    nameEl.textContent = stop.name || 'Unknown Stop';

    panel.classList.remove('metro-mode');
    listEl.innerHTML = '<div class="loading">Loading arrivals...</div>';

    const existingHeader = panel.querySelector('.metro-header');
    if (existingHeader) existingHeader.remove();

    const headerExtension = document.getElementById('header-extension');
    if (headerExtension) headerExtension.innerHTML = '';

    const isMetro = stop.mode === 'SUBWAY' || (stop.id && (stop.id.startsWith('1:metro') || stop.id.includes('metro') || stop.id.includes('Metro')));

    const editBtn = document.getElementById('btn-edit-stop');
    const filterBtn = document.getElementById('filter-routes-toggle');

    if (isMetro) {
        if (editBtn) editBtn.classList.add('hidden');
        if (filterBtn) filterBtn.classList.add('hidden');
        handleMetroStop(stop, panel, nameEl, listEl, {
            allRoutes,
            stopToRoutesMap,
            setSheetState,
            updateBackButtons
        });
        return;
    } else {
        metro.stopMetroTicker();
        const hasWriteAccess = (location.hostname === 'localhost' || location.hostname.startsWith('192.168.')) && import.meta.env.DEV;
        if (editBtn) {
            editBtn.classList.toggle('hidden', !hasWriteAccess);
        }
        if (filterBtn) {
            filterBtn.classList.remove('hidden');
        }
    }

    setSheetState(panel, 'half');
    updateBackButtons();

    // --- PHASE 1: Optimistic Render (Static/Cached) ---
    try {
        // Fetch routes from static index and schedule in parallel
        const staticIds = api.getRoutesForStopStatic(stop.id);
        const optimisticArrivalsPromise = arrivals.fetchArrivalsOptimistic(stop.id);

        // Reset state for new stop
        window.lastRoutes = [];
        window.lastArrivals = [];

        // If we have static route IDs, we can at least show the chips instantly
        if (staticIds.length > 0) {
            const optRoutes = [];
            const seen = new Set();
            staticIds.forEach(rid => {
                if (!seen.has(rid)) {
                    seen.add(rid);
                    const r = allRoutes.find(route => route.id === rid);
                    if (r) optRoutes.push(r);
                }
            });
            window.lastRoutes = optRoutes;
            arrivals.renderArrivals([], stop.id);
        }

        // Once schedule is ready, re-render optimistically
        const optimisticArrivals = await optimisticArrivalsPromise;
        if (optimisticArrivals && optimisticArrivals.length > 0) {
            window.lastArrivals = optimisticArrivals;
            // Update lastRoutes too if arrivals found new routes (unlikely but possible)
            const seen = new Set(window.lastRoutes.map(r => r.id));
            optimisticArrivals.forEach(a => {
                if (!seen.has(a.id)) {
                    seen.add(a.id);
                    const r = allRoutes.find(route => route.id === a.id);
                    if (r) window.lastRoutes.push(r);
                }
            });
            arrivals.renderArrivals(optimisticArrivals, stop.id);
        }
    } catch (e) {
        console.warn('[Optimistic] Fetch failed:', e);
    }

    // --- PHASE 2: Live Fetch (Network) ---
    try {
        const subIds = mergeSourcesMap.get(stop.id) || [];
        const idsAndParent = [stop.id, ...subIds];
        const routePromises = idsAndParent.map(id => {
            if (hydratedStops.has(id)) {
                return Promise.resolve(stopToRoutesMap.get(id) || []);
            }
            // Detect source per stop ID: Rustavi stops start with 'r' followed by digits
            const isRustaviStop = /^r\d/.test(id);
            const sourceToUse = isRustaviStop ? 'rustavi' : stop._source;

            return api.fetchStopRoutes(id, sourceToUse).then(fetchedRoutes => {
                if (fetchedRoutes && Array.isArray(fetchedRoutes)) {
                    if (!stopToRoutesMap.has(id)) stopToRoutesMap.set(id, []);
                    const currentList = stopToRoutesMap.get(id);

                    fetchedRoutes.forEach(fr => {
                        // Fix: Respect source when finding canonical route (avoids Tbilisi gondola 1,2,3 matching Rustavi bus 1,2,3)
                        const fetchedSource = fr._source || (fr.id && String(fr.id).startsWith('r') ? 'rustavi' : 'tbilisi');
                        let canonical = allRoutes.find(r => String(r.shortName) === String(fr.shortName) && r._source === fetchedSource);
                        // Fallback: match by ID if available
                        if (!canonical && fr.id) {
                            canonical = allRoutes.find(r => r.id === fr.id);
                        }
                        // Final fallback: match by shortName only (original behavior)
                        if (!canonical) {
                            canonical = allRoutes.find(r => String(r.shortName) === String(fr.shortName));
                        }
                        const routeToAdd = canonical || fr;
                        if (!currentList.includes(routeToAdd)) currentList.push(routeToAdd);
                    });
                    hydratedStops.add(id);
                }
                return stopToRoutesMap.get(id) || [];
            }).catch(() => []);
        });

        const [results, arrivalsData] = await Promise.all([
            Promise.all(routePromises),
            arrivals.fetchArrivals(stop.id)
        ]);

        const allFetchedRoutes = results.flat();
        // Debug: check if Rustavi routes are in fetched results
        if (stop.id === '810') {
            console.log(`[Debug 810] Fetched ${allFetchedRoutes.length} routes. Rustavi routes: `,
                allFetchedRoutes.filter(r => ['20', '21', '22', '23', '24', '10'].includes(String(r.shortName))).map(r => r.shortName));
        }
        stopToRoutesMap.set(stop.id, allFetchedRoutes);
        window.lastRoutes = allFetchedRoutes;
        window.lastArrivals = arrivalsData;
        window.arrivalsDataTimestamp = Date.now(); // Track fetch time for staleness check
        arrivals.renderArrivals(arrivalsData, stop.id);
    } catch (error) {
        // If we already have optimistic data, don't show error unless it's a real failure and we have nothing
        if (!window.lastArrivals || window.lastArrivals.length === 0) {
            listEl.innerHTML = '<div class="error">Failed to load arrivals</div>';
        }
        console.error(error);
    }
}

function getRouteDisplayColor(route) {
    if (!route) return 'var(--primary)';
    const isDark = document.body.classList.contains('dark-mode');

    // 1. Filter Manager Priority (Selection/Common Routes)
    if (filterManager && filterManager.state && filterManager.state.active) {
        const routeId = route.id || (allRoutes.find(r => r.shortName === route.shortName) || {}).id;
        if (routeId) {
            const filterColor = RouteFilterColorManager.getColorForRoute(routeId);
            if (filterColor) return filterColor;
        }
    }

    // 2. Identify Rustavi
    const isRustavi = route._source === 'rustavi' || (route.id && (String(route.id).startsWith('r') || String(route.id).startsWith('rustavi:')));
    if (isRustavi) {
        // Rustavi: Distinct Indigo
        if (isDark) return '#818cf8'; // Lighter Indigo
        return '#4f46e5'; // Deep Indigo
    }

    // 3. Identify Minibus (Tbilisi)
    const s = String(route.shortName);
    const isMinibus = (s.startsWith('4') || s.startsWith('5')) && s.length === 3;

    if (isMinibus && isDark) {
        // Brighten minibus blue for dark mode
        return '#0a84ff'; // Vibrant Apple Blue
    }

    const rawColor = route.color || '2563eb';
    if (rawColor === '2563eb') return 'var(--primary)';

    return rawColor.startsWith('#') ? rawColor : `#${rawColor} `;
}

function getPatternHeadsign(route, directionIndex, defaultHeadsign) {
    if (!route) return defaultHeadsign;

    // DEBUG logs
    console.log(`[HeadsignDebug] Route ${route.shortName} (${route.id}) Index ${directionIndex}`);
    console.log(`[HeadsignDebug] Route object has _overrides:`, !!route._overrides);

    if (route.shortName === '497') {
        const global497 = allRoutes.find(r => r.shortName === '497');
        console.log(`[HeadsignDebug] Global 497 found:`, !!global497);
        if (global497) console.log(`[HeadsignDebug] Global 497 has _overrides:`, !!global497._overrides);
    }
    // Priority: 1. Match by full ID 2. Match by normalized ID 3. Match by shortName
    const norm = (id) => String(id || '').replace(/^\d+:/, '').replace(/^[rR]/, '');
    const matchedRoute = allRoutes.find(r => String(r.id) === String(route.id)) ||
        allRoutes.find(r => norm(r.id) === norm(route.id)) ||
        allRoutes.find(r => String(r.shortName) === String(route.shortName));

    const overrides = (matchedRoute && matchedRoute._overrides) ? matchedRoute._overrides : route._overrides;

    if (overrides && overrides.destinations) {
        const destObj = overrides.destinations[directionIndex];
        if (destObj && destObj.headsign) {
            const locale = new URLSearchParams(window.location.search).get('locale') || 'en';
            const res = destObj.headsign[locale] || destObj.headsign.en || destObj.headsign.ka || defaultHeadsign;
            if (res && res !== defaultHeadsign) {
                // console.log(`[HeadsignDebug] Applied override: "${defaultHeadsign}" -> "${res}"`);
            }
            return res;
        }
    }

    // 2. Fallback to parsing from longName if headsign is missing or default
    if (!defaultHeadsign || defaultHeadsign === route.longName) {
        // Use LoopUtils or similar if needed, but for now just return what we have
        return defaultHeadsign;
    }

    return defaultHeadsign;
}

function renderAllRoutes(routesInput, arrivalsInput) {
    // Deduplicate Routes (Prioritize Parent aka first fetched)

    // Deduplicate Routes (Prioritize Parent aka first fetched)
    const uniqueRoutesMap = new Map();

    if (routesInput && Array.isArray(routesInput)) {
        routesInput.forEach(r => {
            if (!r) return;

            // 1. Resolve Real Route (with overrides) from allRoutes
            let realRoute = r;
            if (r.id) {
                // Try to find by ID (handling stripped prefix)
                const cleanId = r.id.includes(':') ? r.id.split(':')[1] : r.id;
                const found = allRoutes.find(x => x.id === cleanId || x.id === r.id);
                if (found) realRoute = found;
            } else if (r.shortName) {
                // Fallback by shortName (risky if overridden, but better than nothing)
                const found = allRoutes.find(x => x.shortName === r.shortName);
                if (found) realRoute = found;
            }

            if (realRoute && realRoute.shortName && !uniqueRoutesMap.has(realRoute.shortName)) {
                uniqueRoutesMap.set(realRoute.shortName, realRoute);
            }
        });
    }


    // Merge with arrivals for robustness
    if (arrivalsInput && arrivalsInput.length > 0) {
        arrivalsInput.forEach(arr => {
            // Resolve Arrival to Real Route Logic (Similar to renderArrivals)
            let resolvedShortName = arr.shortName;
            let resolvedRoute = null;

            if (v3RoutesMap && v3RoutesMap.has(String(arr.shortName))) {
                const mappedId = v3RoutesMap.get(String(arr.shortName));
                const cleanId = mappedId.includes(':') ? mappedId.split(':')[1] : mappedId;
                resolvedRoute = allRoutes.find(x => x.id === cleanId || x.id === mappedId);
                if (resolvedRoute) resolvedShortName = resolvedRoute.shortName;
            }

            if (!uniqueRoutesMap.has(resolvedShortName)) {
                const newRoute = resolvedRoute || { shortName: resolvedShortName, id: null, color: '2563eb' };
                uniqueRoutesMap.set(resolvedShortName, newRoute);
            }
        });
    }

    // Convert back to array
    let routesForStop = Array.from(uniqueRoutesMap.values());

    if (routesForStop.length > 0) {
        // Advanced Sorting:
        // 1. If Filter Active: Matches First
        // 2. Numeric ShortName

        routesForStop.sort((a, b) => {
            if (filterManager.state.active) {
                const idA = a.id || (allRoutes.find(r => r.shortName === a.shortName) || {}).id;
                const idB = b.id || (allRoutes.find(r => r.shortName === b.shortName) || {}).id;

                const matchA = idA && filterManager.state.filteredRoutes.includes(idA);
                const matchB = idB && filterManager.state.filteredRoutes.includes(idB);

                if (matchA && !matchB) return -1; // A comes first
                if (!matchA && matchB) return 1;  // B comes first
            }

            // Source Sort: Rustavi goes to bottom
            const isRustaviA = a._source === 'rustavi' || (a.id && a.id.startsWith('rustavi:'));
            const isRustaviB = b._source === 'rustavi' || (b.id && b.id.startsWith('rustavi:'));

            if (isRustaviA && !isRustaviB) return 1;
            if (!isRustaviA && isRustaviB) return -1;

            // Numeric Sort
            return (parseInt(a.shortName) || 0) - (parseInt(b.shortName) || 0);
        });

        const container = document.createElement('div');
        container.className = 'all-routes-container';

        const tilesContainer = document.createElement('div');
        tilesContainer.className = 'route-tiles-container';

        routesForStop.forEach(route => {
            // Apply Show Minibuses Filter
            if (!shouldShowRoute(route.shortName, route)) return;

            const tile = document.createElement('button');
            tile.className = 'route-tile';

            // Prefer Valid Custom Alias > ShortName
            const displayName = route.customShortName || route.shortName;
            tile.textContent = simplifyNumber(displayName);

            const displayColor = getRouteDisplayColor(route);
            tile.style.backgroundColor = `color-mix(in srgb, ${displayColor}, transparent 88%)`;
            tile.style.color = displayColor;
            tile.style.fontWeight = '700';

            // Apply Dimming (don't hide)
            if (filterManager.state.active) {
                const realId = route.id || (allRoutes.find(r => r.shortName === route.shortName) || {}).id;
                if (!realId || !filterManager.state.filteredRoutes.includes(realId)) {
                    tile.classList.add('dimmed');
                } else {
                    // Apply Filter Color
                    const filterColor = RouteFilterColorManager.getColorForRoute(realId);
                    if (filterColor) {
                        tile.style.backgroundColor = `${filterColor} 20`; // Hex + opacity
                        tile.style.color = filterColor;
                    }
                }
            }

            tile.addEventListener('click', (e) => {
                e.stopPropagation();
                if (route.id) {
                    showRouteOnMap(route, true, { fromStopId: window.currentStopId });
                } else {
                    const real = allRoutes.find(r => r.shortName === route.shortName);
                    if (real) showRouteOnMap(real);
                }
            });
            tilesContainer.appendChild(tile);
        });

        // Add invisible spacers to fill the last row (prevents last row chips from stretching)
        // We add enough spacers to fill a full row (max ~10 items at 42px min-width in 450px container)
        for (let i = 0; i < 10; i++) {
            const spacer = document.createElement('div');
            spacer.className = 'route-tile-spacer';
            spacer.setAttribute('aria-hidden', 'true');
            tilesContainer.appendChild(spacer);
        }

        container.appendChild(tilesContainer);
        return container;
    }
    return null;
}

// --- Arrivals Functions ---
// NOTE: fetchArrivals, fetchV3Routes, getV3Schedule, parseSchedule,
//       formatScheduledTime, getMinutesFromNow, sortArrivalsList
//       moved to arrivals.js module

// V3 Routes Map (populated by arrivals.fetchV3Routes via api.js)
// Used by renderAllRoutes for route resolution
let v3RoutesMap = null;



// --- REUSABLE: Refresh Stops Logic (Apply Overrides/Merges) ---
async function refreshStopsLayer(useLocalConfig = false) {
    if (!rawStops || rawStops.length === 0) return;

    let stopsConfigToUse;

    if (useLocalConfig && window.stopsConfig) {
        // Use the in-memory config (already updated by EditTools)
        stopsConfigToUse = window.stopsConfig;
        console.log('[Main] Refreshing with LOCAL stops config...');
    } else {
        // Reload from files (Standard Load)
        try {
            const basePath = import.meta.env.BASE_URL.endsWith('/') ? import.meta.env.BASE_URL : `${import.meta.env.BASE_URL}/`;
            const file = `${basePath}data/stops_overrides.csv`;

            const res = await fetch(`${file}?t=${Date.now()}`);
            let csvText = null;
            if (res.ok) {
                csvText = await res.text();
                console.log(`[Main] Fetched ${file}: ${csvText.length} chars, Type: ${res.headers.get('content-type')}`);
            } else {
                console.warn(`[Main] Failed to fetch ${file}: ${res.status}`);
            }

            // Parse CSV and extract overrides
            const { parseCSV, extractOverrides } = await import('./csv-parser.js');

            stopsConfigToUse = {
                overrides: {},
                merges: {},
                hubs: {}
            };

            if (csvText) {
                const rows = parseCSV(csvText);
                const fileOverrides = extractOverrides(rows, 'id');

                // Merge into global config
                Object.keys(fileOverrides).forEach(id => {
                    const override = fileOverrides[id];

                    // Handle merges
                    if (override.mergeParent) {
                        stopsConfigToUse.merges[id] = override.mergeParent;
                        delete override.mergeParent;
                    }

                    // Handle hubs
                    if (override.hubTarget) {
                        const hubId = override.hubTarget;
                        if (!stopsConfigToUse.hubs[hubId]) {
                            stopsConfigToUse.hubs[hubId] = [];
                        }
                        if (!stopsConfigToUse.hubs[hubId].includes(id)) {
                            stopsConfigToUse.hubs[hubId].push(id);
                        }
                        delete override.hubTarget;
                    }

                    // Store remaining overrides
                    if (Object.keys(override).length > 0) {
                        stopsConfigToUse.overrides[id] = override;
                    }
                });
            }

            console.log('[Main] Loaded stops config from multiple CSVs:',
                Object.keys(stopsConfigToUse.overrides).length, 'overrides,',
                Object.keys(stopsConfigToUse.merges).length, 'merges,',
                Object.keys(stopsConfigToUse.hubs).length, 'hubs');

            // DEBUG: Log sample data
            const sampleMerges = Object.entries(stopsConfigToUse.merges).slice(0, 5);
            // console.log('[Main DEBUG] Sample merges (pre-norm):', JSON.stringify(sampleMerges));
            const sampleOverrides = Object.entries(stopsConfigToUse.overrides).slice(0, 5);
            // console.log('[Main DEBUG] Sample overrides (pre-norm):', sampleOverrides.map(([k, v]) => `${k}: rot=${v.rotation}`));
        } catch (e) {
            console.error('[Main] Failed to load stops config:', e);
            stopsConfigToUse = { overrides: {}, merges: {}, hubs: {} };
        }
    }

    // Update Global Ref
    window.stopsConfig = stopsConfigToUse;

    // Reset Maps
    redirectMap.clear();
    mergeSourcesMap.clear();
    hubMap.clear();
    hubSourcesMap.clear();

    // --- Normalize Config IDs (Handle new prefix logic) ---
    // Since config file might use '1:' prefix (Tbilisi) or others, and we now use stripped/prefixed IDs (e.g. 801, r43),
    // we must try to match config IDs to the actual loaded IDs in `rawStops`.

    // Create lookup set for valid IDs
    // Note: freshStops isn't defined yet in the original code? 
    // Wait, I need to check where `freshStops` is defined. 
    // It is defined at line 2678: `const freshStops = rawStops.map...`
    // I should move `freshStops` definition UP before this block.
    // Or just use `rawStops`. rawStops is available.

    const validStopIds = new Set(rawStops.map(s => s.id));

    const normalizeConfigId = (rawId) => {
        if (!rawId) return rawId;
        if (validStopIds.has(rawId)) return rawId;

        // Try processing with all known source rules
        // api.sources is array of {id, prefix, stripPrefix...}
        if (api.sources) {
            for (const source of api.sources) {
                const processed = api.processId(rawId, source);
                if (validStopIds.has(processed)) return processed;
            }
        }
        return rawId;
    };

    const rawOverrides = stopsConfigToUse?.overrides || {};
    const overrides = {};
    Object.keys(rawOverrides).forEach(k => {
        overrides[normalizeConfigId(k)] = rawOverrides[k];
    });

    const rawMerges = stopsConfigToUse?.merges || {};
    const merges = {};
    Object.keys(rawMerges).forEach(k => {
        merges[normalizeConfigId(k)] = normalizeConfigId(rawMerges[k]);
    });

    const rawHubs = stopsConfigToUse?.hubs || {};
    const hubs = {};
    Object.keys(rawHubs).forEach(k => {
        const normKey = normalizeConfigId(k);
        const members = rawHubs[k];
        if (Array.isArray(members)) {
            hubs[normKey] = members.map(m => normalizeConfigId(m));
        } else {
            hubs[normKey] = members;
        }
    });

    console.log('[Main] Normalization Complete:',
        Object.keys(overrides).length, 'overrides,',
        Object.keys(merges).length, 'merges');

    // Check for Rustavi matches specifically
    const rustaviOverrides = Object.keys(overrides).filter(id => id.startsWith('r'));
    const rustaviMerges = Object.keys(merges).filter(id => id.startsWith('r'));
    console.log('[Main] Rustavi Matches:', rustaviOverrides.length, 'overrides,', rustaviMerges.length, 'merges');
    // console.log('[Main DEBUG] Normalized merges sample:', JSON.stringify(Object.entries(merges).slice(0, 5)));
    // console.log('[Main DEBUG] RedirectMap size:', redirectMap.size, 'Sample entries:', [...redirectMap.entries()].slice(0, 5));

    // Build merge mappings
    // console.warn('[Main DEBUG] FRESH CODE v3 - Starting merge build...');
    try {
        Object.keys(merges).forEach(source => {
            const target = merges[source];
            redirectMap.set(source, target);
            if (!mergeSourcesMap.has(target)) mergeSourcesMap.set(target, []);
            mergeSourcesMap.get(target).push(source);
        });
        // console.warn('[Main DEBUG] Merge build complete. RedirectMap size:', redirectMap.size);
    } catch (e) {
        // console.error('[Main DEBUG] Error in merge build:', e);
    }

    // Build Hub mappings
    // console.warn('[Main DEBUG] Starting hub build...');
    try {
        Object.keys(hubs).forEach(hubId => {
            const members = hubs[hubId];
            if (Array.isArray(members)) {
                members.forEach(memberId => {
                    hubMap.set(memberId, hubId);
                });
                hubSourcesMap.set(hubId, members);
            }
        });
        // console.warn('[Main DEBUG] Hub build complete. HubMap size:', hubMap.size);
    } catch (e) {
        // console.error('[Main DEBUG] Error in hub build:', e);
    }

    // console.warn('[Main DEBUG] ===== AFTER BUILD =====');
    // console.warn('[Main DEBUG] RedirectMap size:', redirectMap.size, 'MergeSourcesMap size:', mergeSourcesMap.size);
    // console.warn('[Main DEBUG] Sample redirectMap entries:', JSON.stringify([...redirectMap.entries()].slice(0, 5)));
    // console.warn('[Main DEBUG] Sample rawStops IDs:', rawStops.slice(0, 5).map(s => s.id));

    // Filter and Override
    const stops = [];
    const seenCoords = new Set();

    // Deep Clone Raw Stops to avoid mutating the source-of-truth indefinitely?
    // Actually, rawStops objects are mutated in the original loop.
    // Better to clone or reset. Since rawStops is fetching fresh, 
    // we should probably re-clone from a "really raw" source if we mutate property 'lat'/'lon'.
    // `Object.assign(stop, ...)` MUTATES `stop`.
    // If rawStops elements are mutated, subsequent refreshes stack.
    // FIX: Map rawStops to NEW objects.
    // Fix: Ensure stops defined in Config (Overrides/Merges) but missing from API are added.
    // This allows "virtual" or "legacy" stops to exist (e.g. 3954 which is a target).
    // Creates a map of existing API stops for fast lookup.
    const freshStops = rawStops.map(s => ({ ...s }));
    const existingIds = new Set(freshStops.map(s => s.id));

    // 1. Check Overrides for missing stops
    Object.keys(overrides).forEach(id => {
        if (!existingIds.has(id)) {
            // console.log(`[Refresh] Injecting Config Stop (Override): ${id}`);
            // Create minimal skeletal stop
            freshStops.push({
                id: id,
                name: "Unknown Stop", // Will be overwritten by override name if present
                lat: 0,
                lon: 0,
                code: id.replace('1:', '').replace('r', ''),
                _source: 'config' // Marker
            });
            existingIds.add(id);
        }
    });

    // 2. Check Merge Targets for missing stops
    // If A merges to B, and B is missing, we must create B.
    Object.values(merges).forEach(targetId => {
        if (!existingIds.has(targetId)) {
            // console.log(`[Refresh] Injecting Config Stop (Merge Target): ${targetId}`);
            freshStops.push({
                id: targetId,
                name: "Merged Stop",
                lat: 0,
                lon: 0,
                code: targetId.replace('1:', '').replace('r', ''),
                _source: 'config'
            });
            existingIds.add(targetId);
        }
    });

    const busStops = [];
    const metroStops = [];

    // Helper to identify Metro
    const isMetroStop = (s) =>
        (s.vehicleMode === 'SUBWAY') ||
        (s.name && s.name.includes('Metro Station')) ||
        (s.id && typeof s.id === 'string' && s.id.startsWith('M:'));

    // ...
    // Clear dynamic maps before rebuilding
    // mergeSourcesMap (defined globally or at top of scope)
    // redirectMap (defined globally or at top of scope)
    // Note: Assuming mergeSourcesMap and redirectMap are available in this scope.
    // They seem to be module-level constants or let variables.

    // DEBUG: Check if specific stops exist
    const stop806 = freshStops.find(s => s.id === '806' || s.id === '1:806');
    const stop813 = freshStops.find(s => s.id === '813' || s.id === '1:813');
    // console.warn('[Main DEBUG] Stop 806 exists?', !!stop806, stop806?.id);
    // console.warn('[Main DEBUG] Stop 813 exists?', !!stop813, stop813?.id);
    // console.warn('[Main DEBUG] All stop IDs containing "806":', freshStops.filter(s => s.id.includes('806')).map(s => s.id));

    freshStops.forEach(stop => {
        // If this stop is merged INTO another, skip adding it to map list
        if (merges[stop.id]) {
            if (stop.id === '806' || stop.id === '826') {
                // console.warn('[Main DEBUG] Stop', stop.id, 'FILTERED by merge ->', merges[stop.id]);
            }
            return;
        }

        // Populate Merge Maps from API-provided Merges
        if (stop.mergedIds && stop.mergedIds.length > 0) {
            const existing = mergeSourcesMap.get(stop.id) || [];
            const combined = [...new Set([...existing, ...stop.mergedIds])];
            mergeSourcesMap.set(stop.id, combined);

            stop.mergedIds.forEach(mergedId => {
                redirectMap.set(mergedId, stop.id);
            });
        }

        // Apply Default Rotations (Standard Config)
        // Normalize rotations map on first use to match App IDs
        if (!window.normalizedRotations) {
            window.normalizedRotations = {};
            // We need to iterate over stopRotations and process keys
            // Use existing `api.processId` logic via `sources`
            // But simpler: just try to match keys to `validStopIds` locally if possible, 
            // OR use the same `normalizeConfigId` logic.
            // Actually, efficient way:
            // Iterate all keys in stopRotations. 
            // Transform key using `normalizeConfigId` logic (which creates App ID from Raw ID).
            // Assign to new map.
            Object.keys(stopRotations).forEach(rawKey => {
                const appKey = normalizeConfigId(rawKey);
                window.normalizedRotations[appKey] = stopRotations[rawKey];
            });
        }

        if (stop.rotation === undefined) {
            stop.rotation = window.normalizedRotations[stop.id] || 0;
        }

        // Apply Override if exists
        if (overrides[stop.id]) {
            const override = { ...overrides[stop.id] };
            if (stop.id === '813') {
                // console.warn('[Main DEBUG] Applying override to stop 813:', override.rotation, override);
            }

            // Special handling for 'name' override (which is {en, ka})
            if (override.name) {
                // Get active locale
                const urlParams = new URLSearchParams(window.location.search);
                const locale = urlParams.get('locale') || 'en';

                // If we have an override for this locale, use it.
                // Otherwise, leave the original name (which is presumably correct for the *other* locale, or fallback).
                // Actually, if we override, we likely want to replace it.
                // But `stop.name` starts as the pre-fetched string for the *requested* locale (or fallback).
                if (override.name[locale]) {
                    stop.name = override.name[locale];
                }
                // If override exists but is empty for this locale?
                // `startEditing` logic puts `undefined` if empty.

                // Remove 'name' from the object we pass to Object.assign so it doesn't overwrite with {en, ka}
                delete override.name;
            }

            Object.assign(stop, override);
        }

        // Deduplicate
        const coordKey = `${stop.lat.toFixed(6)},${stop.lon.toFixed(6)}`;
        // if (seenCoords.has(coordKey)) return; // Disable deduplication to ensure all ID targets exist
        seenCoords.add(coordKey);

        if (isMetroStop(stop)) {
            metroStops.push(stop);
        } else {
            busStops.push(stop);
        }
        stops.push(stop); // allStops keeps everything for search
    });

    // console.log(`[Refresh] Processed Stops: ${freshStops.length} -> ${stops.length}`);
    allStops = stops;
    window.allStops = allStops;

    // UPDATE MAP SOURCES (Delegated to shared function)
    addStopsToMap(allStops, { redirectMap, filterManager, updateConnectionLine });
}
// Search Logic




// Route Plotting
let currentRoute = null;
let currentPatternIndex = 0;
// busUpdateInterval declared at top scope

async function showRouteOnMap(route, addToStack = true, options = {}) {
    // Stop location tracking if we are selecting something specific
    stopTracking();
    // Snapshot current Zoom into the previous state (the Stop view) 
    // This allows "Back" to restore the exact zoom level.
    const top = peekHistory();
    if (top && top.type === 'stop') {
        // If explicit startZoom provided (e.g. from Deep Link where map is flying), use it.
        // Otherwise capture current zoom.
        top.data.savedZoom = options.startZoom || map.getZoom();
    }

    if (addToStack) addToHistory('route', route);

    currentRoute = route;
    window.currentRoute = route; // Crucial for Edit Tools
    currentPatternIndex = 0; // Reset to default

    // Style wait removed - we're inside map.on('load') so style should be ready

    await updateRouteView(route, options);

    // Update URL
    if (window.currentStopId) {
        Router.updateNested(window.currentStopId, route.shortName, currentPatternIndex);
    } else {
        Router.updateRoute(route.shortName, currentPatternIndex);
    }
}

async function updateRouteView(route, options = {}) {
    try {
        const requestId = ++lastRouteUpdateId; // Start new request

        // Clear previous interval
        if (busUpdateInterval) clearInterval(busUpdateInterval);

        // Close route edit panel if open (to prevent showing stale data)
        const routeEditBtn = document.getElementById('btn-edit-route');
        const routeEditBlock = document.getElementById('route-edit-block');
        if (routeEditBtn && routeEditBtn.classList.contains('active')) {
            routeEditBtn.classList.remove('active');
            if (routeEditBlock) {
                routeEditBlock.classList.add('hidden');
                routeEditBlock.style.display = 'none';
            }
        }

        // Close stop info panel (but preserve stop highlight when coming from stop)
        const infoPanel = document.getElementById('info-panel');
        // Temporarily disable highlight clearing by NOT hiding info-panel through setSheetState
        if (!options.suppressPanel) {
            infoPanel.classList.add('hidden');
            infoPanel.classList.remove('sheet-half', 'sheet-full', 'sheet-collapsed');
        }

        // Route Info Card Setup
        const infoCard = document.getElementById('route-info');
        const numberEl = document.getElementById('route-info-number');
        const displayColor = getRouteDisplayColor(route);

        numberEl.textContent = route.customShortName || route.shortName;
        numberEl.style.color = displayColor;
        numberEl.style.backgroundColor = `color-mix(in srgb, ${displayColor}, transparent 88%)`;

        // Logic to Show Edit Button (Restored)
        const editBtn = document.getElementById('btn-edit-route');
        if (editBtn) {
            const isLocalhost = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
            const isPrivateIP = location.hostname.startsWith('192.168.') || location.hostname.startsWith('10.') || location.hostname.startsWith('172.');
            const hasWriteAccess = (isLocalhost || isPrivateIP) && import.meta.env.DEV;

            if (hasWriteAccess) {
                editBtn.style.display = '';
                editBtn.classList.remove('hidden');
            } else {
                editBtn.style.display = 'none';
                editBtn.classList.add('hidden');
            }
        }
        // Set initial state to avoid flicker while data fetches
        // Optimization: Only show "Loading" if we are actually switching routes OR don't have existing content
        const routeTextEl = document.getElementById('route-info-text');
        const hasValidContent = routeTextEl.querySelector('.route-patterns-list') || routeTextEl.querySelector('.headsign-row');
        if (route.id !== window.lastUpdatedRouteId || !hasValidContent) {
            routeTextEl.innerHTML = '<div class="loading">Loading details...</div>';
            window.lastUpdatedRouteId = route.id;
        }

        if (!options.suppressPanel) {
            setSheetState(infoCard, 'half'); // Default to half open
        }
        updateBackButtons(); // Ensure back button state is correct

        // Clear Filter state before showing route
        if (filterManager.state.active || filterManager.state.picking) {
            filterManager.clearFilter();
        }

        // Clear existing layers robustly (Safe Atomic Removal)
        const style = map.getStyle();
        if (style && style.layers) {
            // Collect IDs first to avoid iteration issues
            const layersToRemove = style.layers
                .filter(layer => layer.id.startsWith('route') || layer.id.startsWith('live-buses'))
                .map(layer => layer.id);

            layersToRemove.forEach(id => {
                if (map.getLayer(id)) map.removeLayer(id);
            });
        }
        // Explicitly remove sources (Dynamic)
        // Note: map.getStyle().sources returns an object { id: sourceDef }
        const sources = style ? style.sources : {};
        Object.keys(sources).forEach(id => {
            if (id.startsWith('route') || id.startsWith('live-buses')) {
                if (map.getSource(id)) map.removeSource(id);
            }
        });

        // Helper to perform the actual rendering based on fetched data
        const renderPhase = async (isOptimistic = false) => {
            const strategy = isOptimistic ? 'cache-only' : 'cache-first';

            // 1. Fetch Route Details (v3) to get patterns
            let routeDetails;
            try {
                routeDetails = await api.fetchRouteDetailsV3(route.id, { strategy });
            } catch (e) {
                if (!isOptimistic) throw e;
                return false;
            }
            if (!routeDetails || requestId !== lastRouteUpdateId) return false;

            const patterns = routeDetails.patterns;

            // --- RESTORED LOOP LOGIC ---
            // Pre-process patterns to split loops into virtual directions
            const processedPatterns = [];
            for (const p of patterns) {
                const stops = await api.fetchRouteStopsV3(route.id, p.patternSuffix, { strategy });
                if (RouteGeometry.isLoop(stops, route.shortName)) {
                    const virtuals = RouteGeometry.generateVirtualPatterns(p, stops, route.longName);
                    processedPatterns.push(...virtuals);
                } else {
                    processedPatterns.push(p);
                }
            }
            routeDetails.patterns = processedPatterns;
            // ---------------------------

            // Auto-Direction Logic:
            let directionFound = false;
            if (options.initialDirectionIndex !== undefined && processedPatterns[options.initialDirectionIndex]) {
                currentPatternIndex = options.initialDirectionIndex;
                directionFound = true;
            } else if (options.targetHeadsign && processedPatterns.length > 0) {
                const normalizedTarget = options.targetHeadsign.toLowerCase().trim();
                const matchedIndex = processedPatterns.findIndex(p =>
                    p.headsign && p.headsign.toLowerCase().trim() === normalizedTarget
                );
                if (matchedIndex !== -1) {
                    currentPatternIndex = matchedIndex;
                    directionFound = true;
                }
            }

            if (!directionFound && options.fromStopId && processedPatterns.length > 0) {
                try {
                    const stopsPromises = processedPatterns.map(p => api.fetchRouteStopsV3(route.id, p.patternSuffix, { strategy }).then(stops => ({
                        suffix: p.patternSuffix,
                        stops: stops
                    })));

                    const allStopsData = await Promise.all(stopsPromises);
                    if (requestId !== lastRouteUpdateId) return false;

                    const matchedIndex = processedPatterns.findIndex(p => {
                        const data = allStopsData.find(d => d.suffix === p.patternSuffix);
                        return data && data.stops.some(s => {
                            const sId = String(s.id || s.stopId);
                            const normId = redirectMap.get(sId) || sId;
                            const equivs = getEquivalentStops(options.fromStopId);
                            return equivs.includes(normId);
                        });
                    });

                    if (matchedIndex !== -1) {
                        currentPatternIndex = matchedIndex;
                        directionFound = true;
                    }
                } catch (e) { }
            }

            if (!processedPatterns[currentPatternIndex]) {
                currentPatternIndex = 0;
            }

            const currentPattern = processedPatterns[currentPatternIndex];
            if (!currentPattern) return false;

            // Fetch stops for current pattern to get origin → destination
            const currentPatternStops = await api.fetchRouteStopsV3(route.id, currentPattern.patternSuffix, { strategy });
            if (requestId !== lastRouteUpdateId) return false;

            const destinationHeadsign = getPatternHeadsign(route, currentPatternIndex, currentPattern.headsign);
            let originHeadsign = '';
            if (processedPatterns.length > 1) {
                const otherIdx = processedPatterns.findIndex((p, idx) => idx !== currentPatternIndex);
                if (otherIdx !== -1) {
                    originHeadsign = getPatternHeadsign(route, otherIdx, processedPatterns[otherIdx].headsign);
                }
            }

            if (originHeadsign && destinationHeadsign && originHeadsign !== destinationHeadsign) {
                document.getElementById('route-info-text').innerHTML = `
                    <div class="origin">${originHeadsign} →</div>
                    <div class="destination">${destinationHeadsign}</div>
                `;
            } else {
                document.getElementById('route-info-text').innerHTML = `
                    <div class="destination">${destinationHeadsign || route.longName}</div>
                `;
            }

            const switchBtn = document.getElementById('switch-direction');
            if (processedPatterns.length > 1) {
                switchBtn.classList.remove('hidden');
                switchBtn.onclick = () => {
                    currentPatternIndex = (currentPatternIndex + 1) % processedPatterns.length;
                    updateRouteView(route, { preserveBounds: true });
                    if (window.currentStopId) {
                        Router.updateNested(window.currentStopId, route.shortName, currentPatternIndex);
                    } else {
                        Router.updateRoute(route.shortName, currentPatternIndex);
                    }
                };
            } else {
                switchBtn.classList.add('hidden');
            }

            // --- FULL SCHEDULE DISPLAY ---
            const routeBodyEl = document.getElementById('route-info-body');
            if (options.fromStopId) {
                const hasStop = currentPatternStops && currentPatternStops.some(s => {
                    const sId = String(s.id);
                    if (sId === String(options.fromStopId)) return true;
                    const normalize = id => String(id).replace(/^[rR]/, '').replace(/^\d+:/, '');
                    return normalize(sId) === normalize(options.fromStopId);
                });

                if (!hasStop) {
                    routeBodyEl.innerHTML = `
                        <div class="empty warning">
                            <div class="icon">⚠️</div>
                            <div>The selected stop is in the other direction.</div>
                            <div class="sub">Switch direction to view schedule.</div>
                        </div>`;
                } else {
                    if (isOptimistic) routeBodyEl.innerHTML = '<div class="loading">Loading schedule...</div>';
                    arrivals.getFullScheduleGrouped(route.shortName, options.fromStopId, route.id, currentPattern.patternSuffix, { strategy }).then(grouped => {
                        if (requestId !== lastRouteUpdateId) return;
                        if (!grouped || Object.keys(grouped).length === 0) {
                            routeBodyEl.innerHTML = '<div class="empty">No schedule data available</div>';
                            return;
                        }
                        const currentHour = new Date().getHours();
                        let html = '<div class="route-full-schedule">';
                        Object.keys(grouped).sort((a, b) => parseInt(a) - parseInt(b)).forEach(hour => {
                            const isCurrentHour = parseInt(hour) === currentHour;
                            html += `
                                <div class="schedule-hour-row${isCurrentHour ? ' current-hour' : ''}">
                                    <div class="hour-label">${hour}:</div>
                                    <div class="minutes-list">${grouped[hour].join(' ')}</div>
                                </div>`;
                        });
                        html += '</div>';
                        routeBodyEl.innerHTML = html;
                    }).catch(err => {
                        if (!isOptimistic) {
                            console.warn('[Schedule] Failed to load full schedule', err);
                            routeBodyEl.innerHTML = '<div class="empty">Failed to load schedule</div>';
                        }
                    });
                }
            } else {
                routeBodyEl.innerHTML = '';
            }

            if (requestId !== lastRouteUpdateId) return false;

            const patternSuffix = currentPattern.patternSuffix;

            // 2. Fetch Polylines (Current & Ghost)
            const allSuffixes = processedPatterns.map(p => p.patternSuffix).join(',');
            const polylineData = await api.fetchRoutePolylineV3(route.id, allSuffixes, { strategy });
            if (!polylineData || requestId !== lastRouteUpdateId) return false;

            // Plot Ghost Route
            processedPatterns.forEach(p => {
                if (p.patternSuffix !== patternSuffix) {
                    const ghostEntry = polylineData[p.patternSuffix];
                    let ghostCoords = null;
                    if (Array.isArray(ghostEntry)) ghostCoords = ghostEntry;
                    else if (ghostEntry && ghostEntry.encodedValue) ghostCoords = api.decodePolyline(ghostEntry.encodedValue);

                    if (ghostCoords) {
                        const ghostId = `route-ghost-${p.patternSuffix}`;
                        if (!map.getSource(ghostId)) {
                            map.addSource(ghostId, {
                                type: 'geojson',
                                data: { type: 'Feature', geometry: { type: 'LineString', coordinates: ghostCoords } }
                            });
                            map.addLayer({
                                id: ghostId, type: 'line', source: ghostId,
                                layout: { 'line-join': 'round', 'line-cap': 'round' },
                                paint: { 'line-color': getRouteDisplayColor(route), 'line-width': 4, 'line-opacity': 0.3, 'line-emissive-strength': 1 }
                            }, 'stops-layer');
                        }
                    }
                }
            });

            // Plot Current Route
            const currEntry = polylineData[patternSuffix];
            let coordinates = null;
            if (Array.isArray(currEntry)) coordinates = currEntry;
            else if (currEntry && currEntry.encodedValue) coordinates = api.decodePolyline(currEntry.encodedValue);

            if (coordinates) {
                if (map.getSource('route')) {
                    map.getSource('route').setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: coordinates } });
                } else {
                    map.addSource('route', { type: 'geojson', data: { type: 'Feature', geometry: { type: 'LineString', coordinates: coordinates } } });
                }

                if (!isOptimistic || !window._routeBoundsFit) {
                    if (options.fitToRoute && coordinates.length > 0) {
                        const bounds = new mapboxgl.LngLatBounds();
                        coordinates.forEach(coord => bounds.extend(coord));
                        const panel = document.getElementById('route-info');
                        const rawPanelHeight = panel ? panel.offsetHeight : 200;
                        const maxPadding = Math.min(window.innerHeight * 0.35, 250);
                        const panelHeight = Math.min(rawPanelHeight, maxPadding);
                        const origMethods = window._originalMapMethods;
                        if (origMethods) { map.flyTo = origMethods.flyTo; map.jumpTo = origMethods.jumpTo; map.easeTo = origMethods.easeTo; }
                        map.fitBounds(bounds, { padding: { top: 80, bottom: panelHeight + 40, left: 40, right: 40 }, maxZoom: 15, duration: 1200 });
                        if (origMethods) { map.flyTo = () => map; map.jumpTo = () => map; map.easeTo = () => map; }
                        window._routeBoundsFit = true;
                    } else if (options.centerOnStop && options.centerOnStop.lat && options.centerOnStop.lon) {
                        const offsetY = -(window.innerHeight * 0.1);
                        map.flyTo({ center: [options.centerOnStop.lon, options.centerOnStop.lat], zoom: 14, offset: [0, offsetY], duration: 1500 });
                        window._routeBoundsFit = true;
                    } else if (map.getZoom() > 14.5) {
                        map.easeTo({ zoom: 14, duration: 800 });
                    }
                }
            }

            // 3. Fetch Stops for "Bumps"
            const stopsData = await api.fetchRouteStopsV3(route.id, patternSuffix, { strategy });
            if (requestId !== lastRouteUpdateId) return false;

            const stopsGeoJSON = {
                type: 'FeatureCollection',
                features: stopsData.map(stop => {
                    const sId = String(stop.id);
                    const normId = redirectMap.get(sId) || sId;
                    const existingStop = allStops.find(s => s.id === normId);
                    const lat = existingStop ? existingStop.lat : stop.lat;
                    const lon = existingStop ? existingStop.lon : stop.lon;
                    return { type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties: { name: stop.name } };
                })
            };

            if (map.getSource('route-stops')) {
                map.getSource('route-stops').setData(stopsGeoJSON);
            } else {
                map.addSource('route-stops', { type: 'geojson', data: stopsGeoJSON });
            }

            // Layers
            if (!map.getLayer('route')) {
                map.addLayer({
                    id: 'route', type: 'line', source: 'route', layout: { 'line-join': 'round', 'line-cap': 'round' },
                    paint: { 'line-color': getRouteDisplayColor(route), 'line-width': 12, 'line-opacity': 0.8, 'line-emissive-strength': 1 }
                });
            }
            if (!map.getLayer('route-stops')) {
                map.addLayer({
                    id: 'route-stops', type: 'circle', source: 'route-stops',
                    paint: { 'circle-color': '#ffffff', 'circle-radius': 3, 'circle-stroke-width': 0, 'circle-opacity': 1, 'circle-emissive-strength': 1 }
                });
            }

            // 4. Start Live Bus Tracking (Only in Phase 2)
            if (!isOptimistic && route.id) {
                const liveColor = getRouteDisplayColor(route);
                updateLiveBuses(route.id, patternSuffix, liveColor);
                busUpdateInterval = setInterval(() => updateLiveBuses(route.id, patternSuffix, liveColor), 5000);
            }

            // 5. Highlight Stop
            if (options.fromStopId) {
                const highlightStop = allStops.find(s => String(s.id) === String(options.fromStopId));
                if (highlightStop && highlightStop.lon && highlightStop.lat) {
                    if (!map.getSource('selected-stop')) {
                        map.addSource('selected-stop', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
                    }
                    map.getSource('selected-stop').setData({
                        type: 'FeatureCollection',
                        features: [{
                            type: 'Feature',
                            geometry: { type: 'Point', coordinates: [highlightStop.lon, highlightStop.lat] },
                            properties: { rotation: highlightStop.rotation || 0, mode: route.mode }
                        }]
                    });
                    if (!map.getLayer('stops-highlight')) {
                        map.addLayer({
                            id: 'stops-highlight', type: 'symbol', source: 'selected-stop', slot: 'top',
                            layout: { 'icon-image': ['case', ['>', ['coalesce', ['get', 'rotation'], 0], 0], 'stop-selected-icon', 'stop-icon'], 'icon-size': ['case', ['==', ['get', 'mode'], 'SUBWAY'], 1.5, 1.2], 'icon-allow-overlap': true, 'icon-ignore-placement': true, 'icon-rotate': ['coalesce', ['get', 'rotation'], 0], 'icon-rotation-alignment': 'map' },
                            paint: { 'icon-opacity': 1, 'icon-emissive-strength': 1 }
                        });
                    }
                    map.moveLayer('stops-highlight');
                }
            } else if (map.getSource('selected-stop')) {
                map.getSource('selected-stop').setData({ type: 'FeatureCollection', features: [] });
            }

            return true;
        };

        // Execution of Phases
        window._routeBoundsFit = false; // Internal flag to prevent double-fit

        // Phase 1: Optimistic (Silent if fails)
        const hitCache = await renderPhase(true);
        if (requestId !== lastRouteUpdateId) return;

        // Phase 2: Live
        await renderPhase(false);

        // Move highlight layer to top
        if (map.getLayer('stops-highlight')) {
            map.moveLayer('stops-highlight');
        }

    } catch (error) {
        console.error('CRITICAL: Failed to plot route:', error);
        // Hide the route info card on error
        const infoCard = document.getElementById('route-info');
        if (infoCard) {
            infoCard.classList.add('hidden');
            infoCard.classList.remove('sheet-half', 'sheet-full', 'sheet-collapsed');
        }
        // Clear currentRoute since it failed to load
        currentRoute = null;
        window.currentRoute = null;
        // Try to go back if there's history
        if (historyStack.length > 0) {
            goBack();
        }
    }
}

// updateLiveBuses moved to map-setup.js

// Helper for Sheet State (Mobile)
// Helper for Sheet State (Mobile) - Moved to panel-manager.js
// Helper to toggle panel state - Moved to panel-manager.js

// Filter Button

const filterBtn = document.getElementById('filter-routes-toggle');
if (filterBtn) {
    filterBtn.addEventListener('click', (e) => {
        console.log('[Debug] Filter button clicked');
        e.stopPropagation();
        toggleFilterMode();
    });
} else {
    // Retry if not found immediately (though defer/module should handle it)
    console.warn('[Debug] Filter button not found at init, checking again in 1s');
    setTimeout(() => {
        const fb = document.getElementById('filter-routes-toggle');
        if (fb) fb.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleFilterMode();
        });
    }, 1000);
}

// Prevent Drag/Map click propagation on Close Buttons
['mousedown', 'touchstart', 'click'].forEach(evt => {
    document.getElementById('close-panel').addEventListener(evt, e => e.stopPropagation(), { passive: false });
    document.getElementById('close-route-info').addEventListener(evt, e => e.stopPropagation(), { passive: false });
    // Also protect copy link buttons
    if (document.getElementById('copy-link-btn')) document.getElementById('copy-link-btn').addEventListener(evt, e => e.stopPropagation(), { passive: false });
    if (document.getElementById('copy-route-link-btn')) document.getElementById('copy-link-btn').addEventListener(evt, e => e.stopPropagation(), { passive: false });
});


// Copy Link Buttons Logic
const handleCopyLink = (btnId) => {
    const btn = document.getElementById(btnId);
    if (!btn) return;

    btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        e.preventDefault();

        const url = window.location.href;
        let success = false;

        try {
            // Context One: Modern API (Secure Contexts)
            if (navigator.clipboard && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(url);
                success = true;
            } else {
                throw new Error('Clipboard API unavailable');
            }
        } catch (err) {
            // Context Two: Fallback (Non-secure / Older Mobile Safari)
            console.warn('[UI] Clipboard API failed, trying fallback:', err);
            try {
                const textArea = document.createElement("textarea");
                textArea.value = url;

                // Ensure it's not visible but part of DOM
                textArea.style.position = "fixed";
                textArea.style.left = "-9999px";
                textArea.style.top = "0";
                document.body.appendChild(textArea);

                textArea.focus();
                textArea.select();

                success = document.execCommand('copy');
                document.body.removeChild(textArea);

                if (!success) console.error('[UI] Fallback copy failed.');
            } catch (fallbackErr) {
                console.error('[UI] Fallback copy error:', fallbackErr);
            }
        }

        if (success) {
            console.log('[UI] URL copied to clipboard:', url);

            // Visual Feedback: Turn black (opacity: 1)
            btn.style.opacity = '1';
            btn.style.transform = 'scale(1.1)';

            setTimeout(() => {
                btn.style.opacity = '';
                btn.style.transform = '';
            }, 1000);
        } else {
            // Optional: Shake animation or error indication?
            // For now, failure remains silent to user to avoid spamming alerts, 
            // but we log critical errors.
            alert('Could not copy link. Using a secure (HTTPS) connection?');
        }
    });
};

handleCopyLink('copy-link-btn');
handleCopyLink('copy-route-link-btn');

// Helper to block map clicks briefly
function triggerMapClickLock() {
    window.ignoreMapClicks = true;
    setTimeout(() => {
        window.ignoreMapClicks = false;
    }, 500); // 500ms safety window
}

// Close panel
// Close panel
document.getElementById('close-panel').addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    triggerMapClickLock();

    console.log('[Debug] Close panel clicked');
    const panel = document.getElementById('info-panel');

    // Close Edit Mode (and persist state)
    if (typeof stopEditing === 'function') stopEditing(true);

    setSheetState(panel, 'hidden');
    metro.stopMetroTicker();

    try {
        window.currentStopId = null; // Clear Global State
        if (window.selectDevStop) window.selectDevStop(null); // Notify DevTools

        try { clearFilter(); } catch (err) { console.error('Clear Filter Error', err); }

        // Always try to reset map focus
        try { setMapFocus(false); } catch (err) { console.error('Reset Focus Error', err); }

        // Remove highlight
        if (map.getSource('selected-stop')) {
            map.getSource('selected-stop').setData({ type: 'FeatureCollection', features: [] });
        }
    } catch (err) {
        console.error('Error during close cleanup', err);
    } finally {
        clearHistory(); // Clear history on close
        Router.update(null, false, [], getMapHash());
        map.flyTo({ pitch: 0 }); // REMOVED ZOOM
    }
});

// Close Route Info
// Close Route Info
document.getElementById('close-route-info').addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    triggerMapClickLock();

    setSheetState(document.getElementById('route-info'), 'hidden');
    clearHistory(); // Clear history on close
    clearRoute(); // Helper to clear route layers (modified to also reset focus)

    // Also reset URL when closing route info
    Router.update(null, false, [], getMapHash());
    map.flyTo({ pitch: 0 }); // REMOVED ZOOM
});

function clearRoute() {
    // Reset Focus (Make everything opaque again)
    setMapFocus(false);

    if (busUpdateInterval) clearInterval(busUpdateInterval);

    // Clear all route layers
    ['route', 'route-stops', 'live-buses-bg', 'live-buses-circle', 'live-buses-arrow'].forEach(id => {
        if (map.getLayer(id)) map.removeLayer(id);
    });
    // Remove source separately if needed or just leave it
    if (map.getSource('live-buses')) map.removeSource('live-buses');
    if (map.getSource('route')) map.removeSource('route');
    if (map.getSource('route-stops')) map.removeSource('route-stops');

    // Clear ghost layers
    const style = map.getStyle();
    if (style && style.layers) {
        style.layers.forEach(layer => {
            if (layer.id.startsWith('route-ghost')) {
                map.removeLayer(layer.id);
                map.removeSource(layer.id);
            }
        });
    }
    // Explicitly clear stop selection when closing route info
    if (map.getSource('selected-stop')) {
        map.getSource('selected-stop').setData({ type: 'FeatureCollection', features: [] });
    }

    // CRITICAL: Clear global state references so we don't accidentally restore them
    currentRoute = null;
    window.currentRoute = null;
}




// Helper to Load SVG as a Raster Image for Mapbox
function loadSvgImage(map, id, url, width = 32, height = 32) {
    const img = new Image(width, height);
    img.crossOrigin = "Anonymous";
    img.onload = () => {
        // Create an intermediate canvas to ensure dimensions
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);

        const imageData = ctx.getImageData(0, 0, width, height);
        if (!map.hasImage(id)) {
            map.addImage(id, imageData, { pixelRatio: 2 }); // Higher pixel ratio for crispness
            console.log(`Debug: Successfully added icon ${id}`);
        }
    };
    img.onerror = (e) => {
        console.error(`Error loading SVG icon ${id}:`, e);
    };
    img.src = url;
}


// Updated Multi-Target Connection Line Logic with Path Separation
// Track last logged state to reduce log spam
let _lastLoggedFilterState = { originId: null, targets: '', isHover: null };

function updateConnectionLine(originId, targetIdsInput, isHover = false, hoverId = null) {
    if (!originId) return;

    // Normalize Inputs
    let targets = new Set();
    if (targetIdsInput instanceof Set) {
        targets = new Set(targetIdsInput);
    } else if (targetIdsInput) {
        targets.add(targetIdsInput);
    }

    if (isHover && hoverId) {
        targets.add(hoverId); // Add the hover target to the set to be drawn
    }

    const originStop = allStops.find(s => s.id === originId);
    if (!originStop) return;

    // State change tracking for potential future debugging
    const currentTargetsKey = Array.from(targets).sort().join(',');
    const stateChanged = _lastLoggedFilterState.originId !== originId ||
        _lastLoggedFilterState.targets !== currentTargetsKey ||
        _lastLoggedFilterState.isHover !== isHover;

    if (stateChanged) {
        _lastLoggedFilterState = { originId, targets: currentTargetsKey, isHover };
    }

    const features = [];
    const allActiveSignatures = new Set();

    // Reset colors if this is a "real" update (active filter), not just a hover preview
    // Actually, we want to maintain consistent colors during a session.
    // If isHover only (not applied), maybe ephemeral? 
    // But typically this called by applyFilter -> permanent.
    // Let's assume the manager handles persistence.

    // Deduplicate targets by equivalence group to avoid drawing duplicate/reversed lines
    // When multiple targets are equivalent (same physical stop from different datasets),
    // we only need to draw one line for the group
    const processedEquivalenceGroups = new Set();
    const deduplicatedTargets = [];

    targets.forEach(targetId => {
        // Get equivalents for this target
        const equivalents = getEquivalentStops(targetId);
        // Create a sorted key to identify the equivalence group
        const groupKey = equivalents.slice().sort().join(',');

        if (!processedEquivalenceGroups.has(groupKey)) {
            processedEquivalenceGroups.add(groupKey);
            // Pick the best representative: prefer one with valid coordinates in allStops
            const representative = equivalents.find(id => {
                const stop = allStops.find(s => s.id === id);
                return stop && stop.lat && stop.lon && !(stop.lat === 0 && stop.lon === 0);
            }) || targetId; // Fallback to original if no valid coords found
            deduplicatedTargets.push(representative);
        }
    });

    // Process only deduplicated targets
    deduplicatedTargets.forEach(targetId => {
        const targetStop = allStops.find(s => s.id === targetId);
        if (!targetStop) return;

        // Skip stops with invalid coordinates (e.g., Rustavi equivalents with [0,0])
        // These would cause polyline slicing to find wrong points
        if (!targetStop.lat || !targetStop.lon || (targetStop.lat === 0 && targetStop.lon === 0)) {
            // Skip - stop has invalid coordinates (e.g., Rustavi equivalents with [0,0])
            return;
        }

        const targetFeatures = []; // Temporary collection for this target for quality filtering

        // Find connecting routes - only from selected origin, not all hub members
        // Hub equivalents should only be used for excluding destinations, not for route lookup
        const originIdsForRoutes = new Set();
        originIdsForRoutes.add(originId);
        // Include redirect target if this is a redirected stop
        if (redirectMap.has(originId)) {
            originIdsForRoutes.add(redirectMap.get(originId));
        }
        // Include merge sources if this is a parent stop
        if (mergeSourcesMap.has(originId)) {
            mergeSourcesMap.get(originId).forEach(s => originIdsForRoutes.add(s));
        }

        const originRoutesSet = new Set();
        originIdsForRoutes.forEach(oid => {
            const routes = stopToRoutesMap.get(oid) || [];
            routes.forEach(r => originRoutesSet.add(r));
        });
        const originRoutes = Array.from(originRoutesSet);



        // Group Routes by Path Signature
        const pathGroups = new Map(); // signature -> { routes: [], patternStops: [], pattern: patternObj }

        originRoutes.forEach(r => {
            // Strict Check Logic (Duplicates applyFilter logic but per target)
            // We need to EXTRACT the specific path segment for this route to generate signature
            let segmentStops = null;
            let matchedPattern = null;

            const targetEq = new Set(getEquivalentStops(targetId));

            if (r._details && r._details.patterns) {
                r._details.patterns.some(p => {
                    if (!p.stops) return false;


                    // For loop routes, we need to check both O→T and T→O directions
                    // and pick the shorter segment
                    let foundO = -1;
                    let foundT = -1;
                    let foundT_beforeO = -1; // T that comes before O (for loop routes)

                    for (let i = 0; i < p.stops.length; i++) {
                        const sId = p.stops[i].id;
                        const normId = redirectMap.get(sId) || sId;

                        if (foundO === -1 && originIdsForRoutes.has(normId)) {
                            foundO = i;
                        } else if (foundO !== -1 && targetEq.has(normId)) {
                            foundT = i;
                            break; // Found first T after O, stop.
                        }
                        // Track if we found T before O (for loop detection)
                        if (foundO === -1 && targetEq.has(normId)) {
                            foundT_beforeO = i;
                        }
                    }

                    // For loop routes: if we found T before O AND T after O,
                    // compare segment lengths and pick shorter one
                    // NOTE: This logic was causing issues with bidirectional routes (e.g., 532)
                    // where finding T before O simply means we're looking at the wrong pattern
                    // (the return direction). We should only take O→T (forward) segments.
                    // The special circular route handling for 387/397 below handles actual loops.



                    if (foundO !== -1 && foundT !== -1) {
                        // For loop routes: target must be before the terminus
                        // Otherwise the stop is only reachable via the return leg, which is "unlooped"
                        const isLoopRoute = r._overrides?.isLoop === true ||
                            r._overrides?.isLoop === 'true' ||
                            (p.patternSuffix && p.patternSuffix.includes('_PART'));

                        // Fix: If it's a virtual pattern (_PART), it's already sliced linearly. Treat as standard.
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
                            if (foundO <= terminusIdx && foundT > terminusIdx + 1) {
                                // Target is past terminus - skip this route for line drawing
                                return false;
                            }
                        }

                        segmentStops = p.stops.slice(foundO, foundT + 1).map(s => {
                            const normId = redirectMap.get(s.id) || s.id;
                            // Hydrate with overridden coordinates from allStops if available
                            const refStop = allStops.find(as => as.id === normId);
                            // Ensure we use the stop object ID but potentially override coords
                            return refStop ? { ...s, id: normId, lat: refStop.lat, lon: refStop.lon } : { ...s, id: normId };
                        });



                        matchedPattern = p;
                        return true;
                    }

                    // Wrapped route case: T only exists before O (at index 0)
                    // Special case for circular routes 387/397: bus continues from last to first stop
                    const CIRCULAR_ROUTES = ['387', '397'];
                    if (CIRCULAR_ROUTES.includes(String(r.shortName)) && foundO !== -1 && foundT === -1 && foundT_beforeO !== -1 && foundT_beforeO === 0) {
                        const firstStop = p.stops[0];
                        // Create wrapped segment: origin → end of pattern + first stop
                        const afterOrigin = p.stops.slice(foundO).map(s => {
                            const normId = redirectMap.get(s.id) || s.id;
                            const refStop = allStops.find(as => as.id === normId);
                            return refStop ? { ...s, id: normId, lat: refStop.lat, lon: refStop.lon } : { ...s, id: normId };
                        });
                        // Add the first stop (target) at the end of the segment
                        const firstStopHydrated = (() => {
                            const normId = redirectMap.get(firstStop.id) || firstStop.id;
                            const refStop = allStops.find(as => as.id === normId);
                            return refStop ? { ...firstStop, id: normId, lat: refStop.lat, lon: refStop.lon } : { ...firstStop, id: normId };
                        })();
                        segmentStops = [...afterOrigin, firstStopHydrated];
                        matchedPattern = p;
                        return true;
                    }

                    return false;
                });
            } else if (r.stops) {
                // Fallback
                const stops = r.stops;
                let foundO = -1;
                let foundT = -1;

                for (let i = 0; i < stops.length; i++) {
                    const sId = stops[i];
                    const normId = redirectMap.get(sId) || sId;
                    if (foundO === -1 && originIdsForRoutes.has(normId)) {
                        foundO = i;
                    } else if (foundO !== -1 && targetEq.has(normId)) {
                        foundT = i;
                        break;
                    }
                }

                if (foundO !== -1 && foundT !== -1) {
                    segmentStops = stops.slice(foundO, foundT + 1).map(sid => {
                        const normId = redirectMap.get(sid) || sid;
                        return allStops.find(s => s.id === normId);
                    }).filter(Boolean);
                }
            }

            if (segmentStops && segmentStops.length >= 2) {
                // Generate Signature
                // HUB COLOR LOGIC: Use HUB PARENT IDs for generating color signature
                // This ensures all routes going to the same "Hub" get the same color.
                const ids = generatePathSignature(segmentStops, null, hubMap);

                if (ids && !pathGroups.has(ids)) {
                    pathGroups.set(ids, {
                        routes: [],
                        stops: segmentStops,
                        pattern: matchedPattern
                    });
                }
                if (ids) pathGroups.get(ids).routes.push(r);
            }
        });

        if (pathGroups.size === 0) return; // Skip unconnected

        if (stateChanged && pathGroups.size > 0) {
            // Debug logging available if needed
        }


        // Track Active Signatures for Global GC
        for (const sig of pathGroups.keys()) {
            allActiveSignatures.add(sig);
        }

        // Process Groups
        pathGroups.forEach((group, signature) => {
            const routeIds = group.routes.map(r => r.id);

            // If the route is destined for one of our selected targets, 
            // ensure it gets the color WE assigned to it (if any).
            // But assignNextColor handles logic: if exists, return it. If not, assign and advance.
            // Wait, we need to know if this specific GROUP is heading to a *newly selected* target.
            // Actually, we can just call assignNextColor for ALL valid paths.
            // If they were already assigned (e.g. from previous select), they keep color.
            // If they are new (just selected), they get the current peek color AND queue advances.
            // But wait, if we have multiple routes to the SAME target, they share a signature?
            // Yes, grouped by signature (usually origin+dest+stops).

            // Check if this path goes to a target we care about
            if (group.pattern && group.pattern.stops) {
                const destStop = group.pattern.stops[group.pattern.stops.length - 1];
                // Check if this path eventually hits a selected target
                // Actually relying on "signature" is safer if we trust the group logic.
                // But simply: if `targetId` passed to applyFilter is in this group?
            }
            // Simplified: Just assign color for this path if it connects origin -> ANY target
            // But applyFilter is dealing with a SPECIFIC targetId addition/removal.

            // Correct approach:
            // 1. Identify if this pathGroup connects Origin -> NormTargetId
            // 2. If so, call assignNextColor(signature, routeIds).

            // We need to know which target this group serves.
            // The signature is usually based on the pattern.
            // Let's look at how we found commonRoutes.
            // commonRoutes was just a list of routes. `pathGroups` is derived from commonRoutes.

            // Determine Color Strategy
            let color;
            const isSelected = filterManager.state.targetIds && filterManager.state.targetIds.has(targetId);

            if (isSelected) {
                // Selected: Consume/Lock Color
                color = RouteFilterColorManager.assignNextColor(signature, routeIds);
            } else if (isHover && String(targetId) === String(hoverId)) {
                // Hover: Peek Next Color (Preview)
                color = RouteFilterColorManager.getNextColor();
                // Do NOT assign to map.
            } else {
                // Fallback (e.g. existing map but not selected? Should be covered by GC)
                const entry = RouteFilterColorManager.pathColors.get(signature);
                color = entry ? entry.color : '#888888';
            }

            const selectedPatternStops = group.stops.map(s => [s.lon, s.lat]);

            // DEBUG: Check if stops have valid coordinates
            if (stateChanged && (originId === '3963' || originId === 3963)) {
                const validCoords = selectedPatternStops.filter(c => c[0] && c[1]);
                // console.log(`[Coords Debug] group.stops=${group.stops.length}, valid=${validCoords.length}, first=${JSON.stringify(group.stops[0])}`);
            }

            // Geometry Logic
            let finalCoordinates = null;

            // "Actual Route" Logic
            // Prioritize fetched polyline from the pattern
            // Fix: Don't downgrade selected lines when hovering. Check if THIS target is selected.
            const isPersistent = filterManager.state.targetIds && filterManager.state.targetIds.has(targetId);

            // Debug: isPersistent, isHover, targetId, patternSuffix, hasPattern, hasDecodedPolyline

            if ((isPersistent || isHover) && group.pattern) {
                const bestPattern = group.pattern;
                const bestRoute = group.routes[0]; // Just need one route ID for fetching

                // Ensure we have a suffix
                if (!bestPattern.suffix && bestPattern.patternSuffix) {
                    bestPattern.suffix = bestPattern.patternSuffix;
                }

                if (bestPattern.suffix) {
                    if (bestPattern._decodedPolyline) {
                        // Using polyline from pattern for accurate route geometry
                        try {
                            const sliced = RouteGeometry.slicePolyline(bestPattern._decodedPolyline, originStop, targetStop, group.stops);


                            // Sanity check: reject sliced polylines that are too short or don't span enough distance
                            // This prevents garbage 2-point results from replacing good spline data
                            if (sliced && sliced.length >= 5) {
                                const firstPt = sliced[0];
                                const lastPt = sliced[sliced.length - 1];
                                const dLon = lastPt[0] - firstPt[0];
                                const dLat = lastPt[1] - firstPt[1];
                                const distSq = dLon * dLon + dLat * dLat;
                                // Require at least ~100m span (0.001 degrees ≈ 100m)
                                if (distSq > 0.000001) {
                                    finalCoordinates = sliced;
                                }
                            }
                        } catch (e) {
                            console.warn('Polyline slice failed', e);
                        }
                    } else {
                        // Trigger Fetch (Cache-Only for stability during picking)
                        RouteGeometry.fetchAndCacheGeometry(bestRoute, bestPattern, { strategy: 'cache-only' }, { filterManager, updateConnectionLine });
                    }
                }
            }

            // "Simple Line" (Spline) - ALWAYS create this as base or fallback?
            // User request: "so if the stops are a little or very different, we should plot another line (first a simple stop-by stop one, then an accurate from route shape."
            // This implies showing BOTH? 
            // "first a simple stop-by stop one, then an accurate from route shape" might mean loading sequence or layering.
            // "and they should have different colors" -> Wait, user said "if the stops are a little or very different... we should plot another line".
            // This means for DIFFERENT paths, we plot different lines. 
            // "first a simple stop-by stop one, then an accurate from route shape. and they should have different colors."
            // This phrasing is slightly ambiguous. 
            // 1. Path A (Simple) vs Path A (Accurate) have different colors? NO, that's weird.
            // 2. Path A vs Path B have different colors.
            // I'm assuming Interpretation 2.

            // Fallback / Simple Geometry
            let simpleCoordinates = null;
            if (selectedPatternStops.length >= 2) {
                simpleCoordinates = RouteGeometry.getCatmullRomSpline(selectedPatternStops);
            } else {
                simpleCoordinates = [[originStop.lon, originStop.lat], [targetStop.lon, targetStop.lat]];
            }

            // If we lack accurate polyline, us simpleCoordinates as the main line.
            // If we have accurate, maybe we just show accurate?
            // "first a simple stop-by stop one, then an accurate from route shape" seems to imply progressive loading.
            // I will add BOTH features if available, or just one.

            // Add Simple Feature (always, or only if no accurate?)
            // If I add both, they overlap.
            // Maybe add simple as a "halo" or base? 
            // Let's just add the best available geometry. 
            // If awaiting fetch, simple. If fetched, accurate.

            // Only show high-quality polylines (actual route geometry)
            // Skip low-quality spline fallbacks - no line is better than a wrong straight line
            if (!finalCoordinates) {
                // DEBUG: Check why no finalCoordinates
                if (stateChanged) {
                    const hasPattern = !!group.pattern;
                    const hasSuffix = hasPattern && !!group.pattern.suffix;
                    const hasDecoded = hasPattern && !!group.pattern._decodedPolyline;
                    const isFetching = hasPattern && !!group.pattern._fetchingPolyline;
                    // console.log(`[Polyline Debug] No finalCoords. hasPattern=${hasPattern}, hasSuffix=${hasSuffix}, hasDecoded=${hasDecoded}, isFetching=${isFetching}, isPersistent=${isPersistent}`);
                }

                // Trigger geometry fetch if not available
                // Use network fetch for persistent selections (skip fetching check), cache-only for hover
                if (group.pattern && group.pattern.suffix && !group.pattern._decodedPolyline) {
                    // For persistent selections, allow refetch even if already fetching
                    if (isPersistent || !group.pattern._fetchingPolyline) {
                        const bestRoute = group.routes[0];
                        const fetchOptions = isPersistent ? {} : { strategy: 'cache-only' };
                        // console.log(`[Polyline Debug] Fetching geometry for route ${bestRoute.id}/${bestRoute.shortName}, suffix=${group.pattern.suffix}`);
                        RouteGeometry.fetchAndCacheGeometry(bestRoute, group.pattern, fetchOptions, { filterManager, updateConnectionLine });
                    }
                }
                return; // Skip this path group - wait for high quality data
            }

            const activeCoords = finalCoordinates;

            // Safety: Ensure color is never null
            if (!color) {
                console.warn('[Debug] Color was null/undefined for signature:', signature, 'Using fallback.');
                color = '#888888';
            }

            // Quality Indicator
            const quality = 'high'; // We only reach here with finalCoordinates

            // DEBUG: Check coordinates validity
            if (stateChanged && activeCoords && activeCoords.length > 0) {
                const first = activeCoords[0];
                const last = activeCoords[activeCoords.length - 1];
                // console.log(`[Polyline Debug] quality=${quality}, color=${color}, coords: first=[${first}], last=[${last}], total=${activeCoords.length}`);
            }

            targetFeatures.push({
                type: 'Feature',
                geometry: {
                    type: 'LineString',
                    coordinates: activeCoords
                },
                properties: {
                    color: color,
                    lineWidth: 4,
                    opacity: 0.8,
                    quality: quality // Used for local dedup
                }
            });
        });

        // Dedup/Filter Logic per Target
        // All features are now high quality (we skip low quality above)
        const finalFeatures = targetFeatures;

        // Quality filter: prefer high-quality polylines over splines

        features.push(...finalFeatures);
    });

    // Garbage Collect Unused Colors (Global)
    RouteFilterColorManager.gc(allActiveSignatures);

    // Update Source
    const source = map.getSource('filter-connection');
    if (source) {
        if (features.length > 0 && stateChanged) {
            // console.log(`[Polyline Debug] Setting ${features.length} features to filter-connection source`);
        }
        source.setData({ type: 'FeatureCollection', features: features });
    } else {
        console.warn('[Polyline Debug] filter-connection source NOT FOUND!');
    }

    // Switch to Data-Driven Styling if needed
    if (map.getLayer('filter-connection-line')) {
        map.setPaintProperty('filter-connection-line', 'line-color', ['get', 'color']);
        map.setPaintProperty('filter-connection-line', 'line-width', 4); // Fixed width or data driven
        map.setPaintProperty('filter-connection-line', 'line-opacity', 0.8);
    } else {
        console.warn('[Polyline Debug] filter-connection-line layer NOT FOUND!');
    }
}


// --- Edit Tools Integration ---

// --- Route Overrides Logic ---
let routesConfig = { routeOverrides: {} };
window.routesConfig = routesConfig;

async function loadRoutesConfig() {
    // Route overrides are now applied server-side in Convex (transit:getRoutes query).
    // This CSV loading is kept for backwards compatibility but disabled.
    console.log('[Config] Route overrides now handled by Convex - skipping CSV load');
    routesConfig = { routeOverrides: {} };
    window.routesConfig = routesConfig;
    return;

    // --- LEGACY CSV LOADING (disabled) ---
    try {
        const basePath = import.meta.env.BASE_URL.endsWith('/') ? import.meta.env.BASE_URL : `${import.meta.env.BASE_URL}/`;
        // Add cache buster to ensure fresh config on reload
        const response = await fetch(`${basePath}data/routes_overrides.csv?v=${Date.now()}`);
        if (response.ok) {
            const csvText = await response.text();

            // Parse CSV and extract overrides
            const { parseCSV, extractOverrides } = await import('./csv-parser.js');
            const rows = parseCSV(csvText);
            const overrides = extractOverrides(rows, 'id');

            routesConfig = { routeOverrides: overrides };
            window.routesConfig = routesConfig;

            // Also store overrides with stripped keys for easier matching
            // (e.g., "1:R12237" -> also store as "R12237")
            Object.keys(overrides).forEach(key => {
                if (key.includes(':')) {
                    const stripped = key.split(':')[1];
                    if (!overrides[stripped]) {
                        overrides[stripped] = overrides[key];
                    }
                    // Also store with r-prefix for Rustavi routes (e.g., R12237 -> rR12237)
                    if (stripped.startsWith('R') && !stripped.startsWith('Ru')) {
                        const rPrefixed = 'r' + stripped;
                        if (!overrides[rPrefixed]) {
                            overrides[rPrefixed] = overrides[key];
                        }
                    }
                }
            });

            console.log('[Config] Loaded routes config from CSV', Object.keys(overrides).length, 'overrides');
            if (allRoutes && allRoutes.length > 0) applyRouteOverrides();
        }
    } catch (e) {
        console.warn('Failed to load routes_overrides.csv', e);
        routesConfig = { routeOverrides: {} };
        window.routesConfig = routesConfig;
    }
}

function applyRouteOverrides() {
    if (!window.routesConfig?.routeOverrides) {
        // console.log('[Config] No local route overrides found.');
        return;
    }
    console.log('[Config] Applying Route Overrides...', Object.keys(window.routesConfig.routeOverrides).length);

    // --- LEGACY CODE (ENABLED) ---

    // Detect locale loosely or assume EN/KA based on something? 
    // Ideally we want to patch the object with the *correct* locale string.
    // BUT `allRoutes` is usually monolingual based on what was fetched.
    // If we loaded EN routes, `longName` is EN.
    // If we have an override, we should check if we have an override for that locale.

    // We can infer locale from document.documentElement.lang or URL? 
    // Or just look at what's in `allRoutes`? 
    // Actually, `api.js` loads specific locale files.
    // Let's assume we patch `longName` if a matching locale override exists.
    // AND we attach `_overrides` object for components that support dual-lang or dynamic reuse.

    // Simple approach: Check URL locale or default 'en'
    const urlParams = new URLSearchParams(window.location.search);
    const locale = urlParams.get('locale') || 'en';

    let updateCount = 0;

    allRoutes.forEach(route => {
        // Robust ID Matching: Check raw, stripped, and multiple prefixes
        let override = window.routesConfig.routeOverrides[route.id];

        // Try stripping prefix (e.g., "2:R12237" -> "R12237")
        if (!override && route.id.includes(':')) {
            const stripped = route.id.split(':')[1];
            override = window.routesConfig.routeOverrides[stripped];

            // Try with 1: prefix (CSV uses 1: for all routes including Rustavi)
            if (!override) {
                override = window.routesConfig.routeOverrides[`1:${stripped}`];
            }
        }

        // Try adding prefix if no colon
        if (!override && !route.id.includes(':')) {
            override = window.routesConfig.routeOverrides[`1:${route.id}`];
            if (!override) {
                override = window.routesConfig.routeOverrides[`2:${route.id}`];
            }
        }

        // Handle Rustavi r-prefix (e.g., "rR12237" -> try "R12237" and "1:R12237")
        if (!override && route.id.startsWith('r')) {
            const withoutR = route.id.substring(1); // "rR12237" -> "R12237"
            override = window.routesConfig.routeOverrides[withoutR];
            if (!override) {
                override = window.routesConfig.routeOverrides[`1:${withoutR}`];
            }
        }

        // Debug specific route
        if (route.id === '1:minibusR1265' || route.id === 'minibusR1265') {
            // console.log(`[Config Debug] Route 466 ID: ${route.id}`);
            // console.log(`[Config Debug] Direct lookup:`, window.routesConfig.routeOverrides[route.id]);
            // console.log(`[Config Debug] Found override:`, !!override, override);
        }

        // Rustavi route debug disabled - CSV needs Rustavi entries

        // DEBUG: Log first 3 routes to check ID format
        /*
        if (updateCount < 3) {
             // console.log(`[Config] Checking route ID: '${route.id}'. Override exists? ${!!override}`);
        }
        */

        if (override) {
            updateCount++;
            route._overrides = override; // Attach for reference
            if (override.shortName) route.customShortName = override.shortName; // Display Alias
            // Do NOT overwrite route.shortName to preserve URLs and linking logic
            if (override.color) route.color = override.color;
            if (override.textColor) route.textColor = override.textColor;

            // Complex overrides (destinations, longName) are handled during render/details

            if (override.longName && override.longName[locale]) {
                route.longName = override.longName[locale];
            }
        }
    });

    console.log(`[Config] Applied overrides to ${updateCount} routes.`);
}



// --- Initialize Edit Tools ---
setupEditTools(map, {
    getAllStops: () => allStops,
    getAllRoutes: () => allRoutes,
    getMergeSourcesMap: () => mergeSourcesMap,
    getHubMap: () => hubMap,
    getHubSourcesMap: () => hubSourcesMap,
    getStopToRoutesMap: () => stopToRoutesMap,
    getEditState: getEditState
}, {
    refreshStopsLayer,
    updateMapFilterState,
    setSheetState,
    renderAllRoutes,
    checkDirtyState: () => { } // handled internally or not needed
});

// --- Keyboard Listeners ---
window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        // 1. All Routes Editor (High priority Modal)
        const allRoutesEditor = document.getElementById('all-routes-editor');
        if (allRoutesEditor && !allRoutesEditor.classList.contains('hidden')) {
            document.getElementById('close-all-routes-editor')?.click();
            return;
        }

        // 2. Search Suggestions
        const suggestions = document.getElementById('search-suggestions');
        if (suggestions && !suggestions.classList.contains('hidden')) {
            suggestions.classList.add('hidden');
            document.getElementById('search-input')?.blur();
            return;
        }

        // 3. Settings Menu
        const settingsMenu = document.getElementById('map-menu-popup');
        if (settingsMenu && !settingsMenu.classList.contains('hidden')) {
            settingsMenu.classList.add('hidden');
            return;
        }

        // 4. Sheets (Step-by-step: Route Info then Info Panel)
        const routeInfo = document.getElementById('route-info');
        if (routeInfo && !routeInfo.classList.contains('hidden')) {
            document.getElementById('close-route-info')?.click();
            return;
        }

        const infoPanel = document.getElementById('info-panel');
        if (infoPanel && !infoPanel.classList.contains('hidden')) {
            document.getElementById('close-panel')?.click();
            return;
        }
    }
});

loadRoutesConfig();

/* Map Menu & Simplify Logic */

