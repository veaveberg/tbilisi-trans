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
import { LoopUtils } from './loop-utils.js';
import * as metro from './metro.js';
const { handleMetroStop } = metro;
import { map, setupMapControls, getMapHash, loadImages, addStopsToMap, updateMapTheme, getCircleRadiusExpression, updateLiveBuses, setupHoverHandlers, setupClickHandlers, setMapFocus, isTrackingActive, isUserInteractingWithMap, stopTracking, setMapLightPreset } from './map-setup.js';
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
setupMapControls();

// Initial Router State Handling
Router.init();
const initialState = Router.parse();

// --- OPTIMIZED INITIALIZATION ---
let isRouterLogicExecuted = false;

function onRoutesLoaded(data) {
    if (!data) return;
    allRoutes = data; // Always update global data
    applyRouteOverrides(); // Apply overrides immediately after loading

    if (isRouterLogicExecuted) return; // Only run initial routing once
    isRouterLogicExecuted = true;

    console.log('[Init] Router Logic Executing with', data.length, 'routes');

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

// 1. Fast Load (Cache/Static) - Instant UI
const staticPreloadPromise = api.preloadStaticRoutesDetails(); // Preload for filtering
api.fetchRoutes({ strategy: 'cache-only' }).then(onRoutesLoaded);

// 2. Fresh Load (Network) - Updates Data/UI
api.fetchRoutes().then(onRoutesLoaded);

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
// Explicit Metro Hover Logic (Pop Effect / Overlay)
function addMetroHoverLogic(map, filterManager) {
    if (!map.getLayer('metro-layer-circle')) return;

    let hoveredStateId = null;
    const targets = ['metro-layer-circle', 'metro-layer-overlay', 'metro-layer-label', 'metro-transfer-layer'];

    map.on('mouseenter', targets, (e) => {
        // Disable Metro Hover if Filter is Active (Metro is not "reachable")
        // Debug
        // console.log('[MetroHover] Filter Active?', filterManager?.state?.active, filterManager?.state?.picking);

        if (filterManager && (filterManager.state.active || filterManager.state.picking)) return;

        map.getCanvas().style.cursor = 'pointer';
        if (e.features.length > 0) {
            const feature = e.features[0];

            if (hoveredStateId !== null) {
                map.setFeatureState(
                    { source: 'metro-stops', id: hoveredStateId },
                    { hover: false }
                );
            }
            hoveredStateId = e.features[0].id; // Use implicit ID for consistency
            map.setFeatureState(
                { source: 'metro-stops', id: hoveredStateId },
                { hover: true }
            );

            // Debug: Verify State
            // const state = map.getFeatureState({ source: 'metro-stops', id: hoveredStateId });
            // console.log('Metro Hover Set:', hoveredStateId, state); 
        }
    });

    map.on('mouseleave', targets, () => {
        map.getCanvas().style.cursor = '';
        if (hoveredStateId !== null) {
            map.setFeatureState(
                { source: 'metro-stops', id: hoveredStateId },
                { hover: false }
            );
        }
        hoveredStateId = null;
    });
}
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
    LoopUtils,
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
    filterManager: filterManager // Pass Manager
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

    console.log('[Main] Initializing Map Data...');

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
            console.log('[Main] Fresh data loaded while Filter Active. Re-applying...');
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

    // A. FAST PATH (Cache/Static) - Instant Load
    const loadFast = async () => {
        try {
            console.log('[Fast Load] Attempting...');
            const [stops, routes] = await Promise.all([
                api.fetchStops({ strategy: 'cache-only' }),
                api.fetchRoutes({ strategy: 'cache-only' })
            ]);
            console.log(`[Fast Load] Result - Stops: ${stops ? stops.length : 'MISSING'}, Routes: ${routes ? routes.length : 'MISSING'}`);

            if (stops && routes) {
                console.log('[Map] Loading FAST data...');
                await initializeMapData(stops, routes);
            } else {
                console.log('[Fast Load] Skipped - missing complete data.');
            }
        } catch (e) { console.warn('Fast Load Failed', e); }
    };

    // B. FRESH PATH (Network) - Updates over time
    const loadFresh = async () => {
        try {
            console.log('[Fresh Load] Starting...');
            const [stops, routes] = await Promise.all([
                api.fetchStops(),
                api.fetchRoutes()
            ]);
            console.log(`[Fresh Load] Result - Stops: ${stops ? stops.length : 'MISSING'}, Routes: ${routes ? routes.length : 'MISSING'}`);

            console.log('[Map] Loading FRESH data...');
            await initializeMapData(stops, routes);
        } catch (e) { console.error('Fresh Load Failed', e); }
    };

    await loadFast();
    loadFresh();
    loadMinibusSegments();
});

async function loadMinibusSegments() {
    try {
        const response = await fetch('data/long_segments.geojson');
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
        console.log(`[Map] Loaded ${data.features.length} minibus segments`);
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
    console.log(`[Theme] Switching to: ${theme} (Preset: ${lightPreset})`);

    // 1. Update the map's light preset
    setMapLightPreset(lightPreset);

    // 2. Update custom label colors (Metro, etc.) after a brief delay
    setTimeout(() => updateMapTheme(), 50);

    // 3. Refresh UI elements if panels are open
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
        console.log('[Restore] Re-plotting active route:', currentRoute.shortName);
        // Suppress panel if we have an active stop (Nested view) 
        // OR if we just want to restore the map lines without altering UI state too much
        const hasActiveStop = !!window.currentStopId;
        showRouteOnMap(currentRoute, false, { preserveBounds: true, suppressPanel: hasActiveStop });
    }

    // 4. Restore Active Stop Selection & Focus
    if (window.currentStopId) {
        console.log('[Restore] Restoring active stop selection:', window.currentStopId);

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

        console.log(`[DeepLink] Processing Stop: ${rawStopId} -> ${normStopId}. Found=${!!stop}`);
        if (stop) {
            // Check for Filtered State
            if (state.filterActive && state.targetIds && state.targetIds.length > 0) {
                console.log('[DeepLink] Applying Filter:', state.targetIds);

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
    if (map && map.getStyle()) updateMapTheme();
});






// Handle touch/drag logic for panels
setupPanelDrag('info-panel');
setupPanelDrag('route-info');

function setupPanelDrag(panelId) {
    const panel = document.getElementById(panelId);
    let startY = 0;
    let currentY = 0;
    let startTransformY = 0;
    let isDragging = false;
    let startTime = 0;

    // Helper to get current translate Y from computed style
    const getTranslateY = () => {
        const style = window.getComputedStyle(panel);
        // Transform is matrix(1, 0, 0, 1, 0, Y)
        const matrix = new DOMMatrixReadOnly(style.transform);
        return matrix.m42;
    };

    // Unified Start Handler (Mouse & Touch)
    const handleStart = (e) => {
        const target = e.target;

        // Explicitly ignore Close Buttons
        if (target.closest('#close-panel') || target.closest('#close-route-info') || target.closest('.icon-btn')) {
            return;
        }

        // Allow Text Selection in Route Header (ignore drag start)
        if (target.closest('#route-info-text') || target.closest('#route-info-number')) {
            return; // Let browser handle selection
        }

        // Check if header or body
        const isHeader = target.closest('.panel-header') ||
            target.closest('#header-extension') ||
            target.closest('.drag-handle') ||
            panel.classList.contains('metro-mode');

        // Normalize coordinates
        const clientY = e.type.includes('mouse') ? e.clientY : e.touches[0].clientY;

        startY = clientY;
        startTime = Date.now();
        startTransformY = getTranslateY();

        // If Header, start dragging immediately
        if (isHeader) {
            isDragging = true;
            panel.style.transition = 'none';
            panel.classList.add('is-dragging');
            if (e.type.includes('mouse')) e.preventDefault(); // Prevent text selection
        } else {
            // If body, we MIGHT start dragging if they pull down at top
            isDragging = false;
        }
    };

    // Unified Move Handler
    const handleMove = (e) => {
        const clientY = e.type.includes('mouse') ? e.clientY : e.touches[0].clientY;
        const delta = clientY - startY;

        // If NOT yet dragging, check if we should switch to drag
        if (!isDragging) {
            // Only care about Pull Down (delta > 0)
            if (delta > 0) {
                const scrollable = panel.querySelector('.panel-body');
                if (scrollable && scrollable.scrollTop <= 0) {
                    // WE HIT TOP! Switch to drag.
                    isDragging = true;
                    startTransformY = getTranslateY(); // Reset start to current position
                    startY = clientY; // Reset

                    panel.style.transition = 'none';
                    panel.classList.add('is-dragging');

                    if (e.cancelable) e.preventDefault();
                }
            }
        }

        if (isDragging) {
            if (e.cancelable) e.preventDefault();

            const currentDelta = clientY - startY;
            const newTransformY = startTransformY + currentDelta;
            panel.style.transform = `translateY(${newTransformY}px)`;
        }
    };

    // Unified End Handler
    const handleEnd = (e) => {
        if (!isDragging) return;

        isDragging = false;
        panel.classList.remove('is-dragging');
        panel.style.transition = '';

        // Get end Y
        let endY;
        if (e.type.includes('mouse')) {
            endY = e.clientY;
        } else {
            endY = e.changedTouches[0].clientY;
        }

        const delta = endY - startY;
        const time = Date.now() - startTime;
        const velocity = Math.abs(delta / time);

        // Snap Logic
        snapSheet(delta, velocity);
    };

    // Helper: Snap Logic (Shared scope)
    const snapSheet = (delta, velocity) => {
        const currentY = getTranslateY();
        const screenH = window.innerHeight;

        // Thresholds
        const TRIGGER_VELOCITY = 0.3;
        const HALF_SHEET_Y = screenH * 0.6; // Assuming 40vh height (1 - 0.4)

        let targetState = 'half';

        // 1. Velocity Flick
        if (velocity > TRIGGER_VELOCITY) {
            if (delta > 0) {
                // Flipped Down
                // If really low or fast, go hidden?
                // For now, let's Stick to Collapsed to avoid accidental closes, 
                // UNLESS we are near bottom.
                targetState = currentY > HALF_SHEET_Y + 50 ? 'collapsed' : 'half';
            } else {
                // Flipped Up
                targetState = 'full';
            }
        } else {
            // 2. Position Check
            // Tune: easier to leave full (0.3 -> 0.15)
            if (currentY < screenH * 0.15) targetState = 'full';
            else if (currentY > screenH * 0.85) targetState = 'collapsed';
            else targetState = 'half';
        }

        setSheetState(panel, targetState);
        panel.style.transform = ''; // Clear inline transform
    };

    // Touch Listeners
    panel.addEventListener('touchstart', handleStart, { passive: true });
    panel.addEventListener('touchmove', handleMove, { passive: false });
    panel.addEventListener('touchend', handleEnd);

    // Mouse Listeners
    panel.addEventListener('mousedown', handleStart);
    window.addEventListener('mousemove', (e) => {
        if (isDragging) handleMove(e);
    });
    window.addEventListener('mouseup', handleEnd);

    // Wheel Logic (Desktop)
    let wheelTimeout;
    let isScrollingContent = false;
    let scrollEndTimeout;

    panel.addEventListener('wheel', (e) => {
        const currentClass = panel.classList.contains('sheet-full') ? 'full' :
            panel.classList.contains('sheet-half') ? 'half' :
                panel.classList.contains('sheet-collapsed') ? 'collapsed' : 'half';

        // Reset scroll end detection
        clearTimeout(scrollEndTimeout);
        scrollEndTimeout = setTimeout(() => {
            isScrollingContent = false;
        }, 60); // Faster reset (Trackpad friendly)

        // Threshold to prevent accidental jitters for triggers
        if (Math.abs(e.deltaY) < 5) return;

        // ... (middle code logic remains same, skipping for brevity in replace tool if distinct)

        // ACTUALLY, replace tool needs contiguous block. 
        // I will target the SnapSheet function first, then the listener debounce if needed.
        // Wait, the replace tool handles chunks.


        if (currentClass === 'collapsed') {
            if (e.deltaY > 0) { // Scroll Down (pull up) -> Expand
                e.preventDefault();
                setSheetState(panel, 'half');
            }
        } else if (currentClass === 'half') {
            if (e.deltaY > 0) { // Scroll Down -> Full
                e.preventDefault();
                setSheetState(panel, 'full');
            } else if (e.deltaY < 0) { // Scroll Up -> Collapse
                e.preventDefault();
                setSheetState(panel, 'collapsed');
            }
        } else if (currentClass === 'full') {
            const scrollable = panel.querySelector('.panel-body');

            // Check usage
            if (scrollable && scrollable.scrollTop > 0) {
                isScrollingContent = true;
                // Allow native scroll
                return;
            }

            // If we are here, we are at TOP (or no scrollable).
            // Logic: If we were JUST scrolling content, we must "stumble" (ignore this momentum).
            // We only allow transition if this is a FREH gesture (isScrollingContent == false).

            if (e.deltaY < 0 && (scrollable && scrollable.scrollTop <= 0)) {

                if (isScrollingContent) {
                    // STUMBLE: We came from content, hitting the top.
                    // Absorb the momentum but do NOT transition.
                    // Doing nothing lets the native "bounce" happen or just stops.
                    // Usually we want to preventing the sheet drag.

                    // Actually, if we don't preventDefault, mac might trigger page back swipe or bounce.
                    // Let's preventDefault to show "Hard Stop".
                    // But maybe user wants bounce?
                    // Let's start with hard stop.
                    // e.preventDefault();
                    return;
                    // Returning here allows "overscroll" events (bounce) naturally if we don't preventDefault.
                    // But we MUST NOT run the drag logic below.
                }

                e.preventDefault();

                // FLUID DRAG LOGIC
                // 1. Disable transition
                panel.style.transition = 'none';

                // 2. Move panel
                const currentY = getTranslateY();
                const newY = currentY - e.deltaY;
                panel.style.transform = `translateY(${newY}px)`;

                // 3. Debounce Snap
                clearTimeout(wheelTimeout);
                wheelTimeout = setTimeout(() => {
                    // Restore transition and snap
                    panel.style.transition = '';
                    snapSheet(0, 0); // Snap based on position only
                }, 150);
            }
            // Else let native scroll happen
        }
    }, { passive: false });
}

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
            console.log(`[Debug 810] Fetched ${allFetchedRoutes.length} routes.Rustavi routes: `,
                allFetchedRoutes.filter(r => ['20', '21', '22', '23', '24', '10'].includes(String(r.shortName))).map(r => r.shortName));
        }
        stopToRoutesMap.set(stop.id, allFetchedRoutes);
        window.lastRoutes = allFetchedRoutes;
        window.lastArrivals = arrivalsData;
        window.arrivalsDataTimestamp = Date.now(); // Track fetch time for staleness check
        arrivals.renderArrivals(arrivalsData, stop.id);
    } catch (error) {
        listEl.innerHTML = '<div class="error">Failed to load arrivals</div>';
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

    // 1. Resolve Route & Overrides
    const matchedRoute = allRoutes.find(r => r.id === route.id || r.shortName === route.shortName);
    const overrides = (matchedRoute && matchedRoute._overrides) ? matchedRoute._overrides : route._overrides;

    // DEBUG for route 466
    if (route.shortName === '466') {
        console.log('[HeadsignDebug] Route 466 called with directionIndex:', directionIndex);
        console.log('[HeadsignDebug] Has overrides:', !!overrides);
        console.log('[HeadsignDebug] Destinations:', overrides?.destinations);
        console.log('[HeadsignDebug] Dest for direction:', overrides?.destinations?.[directionIndex]);
    }

    if (overrides && overrides.destinations) {
        const destObj = overrides.destinations[directionIndex];
        if (destObj && destObj.headsign) {
            const locale = new URLSearchParams(window.location.search).get('locale') || 'en';
            return destObj.headsign[locale] || destObj.headsign.en || destObj.headsign.ka || defaultHeadsign;
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

        // 1. Fetch Route Details (v3) to get patterns
        const routeDetails = await api.fetchRouteDetailsV3(route.id, { strategy: 'cache-first' });
        if (requestId !== lastRouteUpdateId) return; // Stale check
        const patterns = routeDetails.patterns;

        // Auto-Direction Logic:
        let directionFound = false;

        // 1. Initial State override (from URL)
        if (options.initialDirectionIndex !== undefined && patterns[options.initialDirectionIndex]) {
            currentPatternIndex = options.initialDirectionIndex;
            directionFound = true;
            console.log(`[Router] Restoring direction index: ${currentPatternIndex}`);
        }
        // 2. Try to match by Headsign (most accurate for specific arrival clicks)
        else if (options.targetHeadsign && patterns.length > 0) {
            const normalizedTarget = options.targetHeadsign.toLowerCase().trim();
            // console.log(`[Router] Attempting Headsign Match: "${normalizedTarget}" vs`, patterns.map(p => `"${p.headsign}"`));

            const matchedIndex = patterns.findIndex(p =>
                p.headsign && p.headsign.toLowerCase().trim() === normalizedTarget
            );
            if (matchedIndex !== -1) {
                currentPatternIndex = matchedIndex;
                directionFound = true;
                console.log(`[Debug] Matched pattern by headsign: ${options.targetHeadsign} -> Index ${matchedIndex}`);
            }
        }

        // 2. Fallback: Find pattern that contains the fromStopId (if no headsign match or not provided)
        if (!directionFound && options.fromStopId && patterns.length > 0) {
            try {
                const stopsPromises = patterns.map(p => api.fetchRouteStopsV3(route.id, p.patternSuffix).then(stops => ({
                    suffix: p.patternSuffix,
                    stops: stops
                })));

                const allStopsData = await Promise.all(stopsPromises);
                if (requestId !== lastRouteUpdateId) return; // Stale check

                // Find index of pattern that has the stop
                const matchedIndex = patterns.findIndex(p => {
                    const data = allStopsData.find(d => d.suffix === p.patternSuffix);
                    return data && data.stops.some(s => {
                        const sId = String(s.id || s.stopId);
                        const normId = redirectMap.get(sId) || sId;
                        // Check against all equivalent stops of fromStopId
                        const equivs = getEquivalentStops(options.fromStopId);
                        return equivs.includes(normId);
                    });
                });

                if (matchedIndex !== -1) {
                    currentPatternIndex = matchedIndex;
                    directionFound = true;
                }
            } catch (e) {
                console.warn('[Router] Failed to auto-detect direction from stop', e);
            }
        } else {
            if (!patterns[currentPatternIndex]) {
                currentPatternIndex = 0;
            }
        }

        // Handle Direction Switching Button
        const switchBtn = document.getElementById('switch-direction');
        const currentPattern = patterns[currentPatternIndex];

        // Fetch stops for current pattern to get origin → destination
        const currentPatternStops = await api.fetchRouteStopsV3(route.id, currentPattern.patternSuffix);
        if (requestId !== lastRouteUpdateId) return; // Stale check

        const destinationHeadsign = getPatternHeadsign(route, currentPatternIndex, currentPattern.headsign);
        let originHeadsign = '';
        if (patterns.length > 1) {
            // Find the other pattern to use its headsign as the origin
            const otherIdx = patterns.findIndex((p, idx) => idx !== currentPatternIndex);
            if (otherIdx !== -1) {
                originHeadsign = getPatternHeadsign(route, otherIdx, patterns[otherIdx].headsign);
            }
        }

        // DEBUG for route 532
        if (route.shortName === '532') {
            console.log('[Route532Debug] currentPattern:', currentPattern);
            console.log('[Route532Debug] destinationHeadsign:', destinationHeadsign);
            console.log('[Route532Debug] originHeadsign:', originHeadsign);
            console.log('[Route532Debug] patterns count:', patterns.length);
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

        if (patterns.length > 1) {
            switchBtn.classList.remove('hidden');
            switchBtn.onclick = () => {
                currentPatternIndex = (currentPatternIndex + 1) % patterns.length;
                updateRouteView(route, { preserveBounds: true }); // Keep bounds when switching directions

                if (window.currentStopId) {
                    Router.updateNested(window.currentStopId, route.shortName, currentPatternIndex);
                } else {
                    Router.updateRoute(route.shortName, currentPatternIndex);
                }
            };
        } else {
            switchBtn.classList.add('hidden');
        }

        if (requestId !== lastRouteUpdateId) return; // Stale check before heavy map ops

        const patternSuffix = currentPattern.patternSuffix;

        // 2. Fetch Polylines (Current & Ghost)
        const allSuffixes = patterns.map(p => p.patternSuffix).join(',');
        const polylineData = await api.fetchRoutePolylineV3(route.id, allSuffixes, { strategy: 'cache-first' });
        if (!polylineData) {
            console.warn('[Route] No polyline data available (offline?)');
            return;
        }
        if (requestId !== lastRouteUpdateId) return; // Stale check

        // Plot Ghost Route (Other patterns)
        patterns.forEach(p => {
            if (p.patternSuffix !== patternSuffix) {
                const ghostEntry = polylineData[p.patternSuffix];
                let ghostCoords = null;

                if (Array.isArray(ghostEntry)) {
                    ghostCoords = ghostEntry;
                } else if (ghostEntry && ghostEntry.encodedValue) {
                    ghostCoords = api.decodePolyline(ghostEntry.encodedValue);
                }

                if (ghostCoords) {
                    // Check if source/layer already exists to prevent dupes/errors if re-running
                    const ghostId = `route-ghost-${p.patternSuffix}`;
                    if (!map.getSource(ghostId)) {
                        map.addSource(ghostId, {
                            type: 'geojson',
                            data: {
                                type: 'Feature',
                                geometry: { type: 'LineString', coordinates: ghostCoords }
                            }
                        });
                        map.addLayer({
                            id: ghostId,
                            type: 'line',
                            source: ghostId,
                            layout: { 'line-join': 'round', 'line-cap': 'round' },
                            paint: {
                                'line-color': getRouteDisplayColor(route),
                                'line-width': 4,
                                'line-opacity': 0.3, // 30% opacity for ghost route
                                'line-emissive-strength': 1
                            }
                        }, 'stops-layer'); // Below stops
                    }
                }
            }
        });

        // Plot Current Route
        const currEntry = polylineData[patternSuffix];
        let coordinates = null;

        if (Array.isArray(currEntry)) {
            coordinates = currEntry;
        } else if (currEntry && currEntry.encodedValue) {
            coordinates = api.decodePolyline(currEntry.encodedValue);
        }

        if (coordinates) {
            if (map.getSource('route')) {
                map.getSource('route').setData({
                    type: 'Feature',
                    geometry: { type: 'LineString', coordinates: coordinates }
                });
            } else {
                map.addSource('route', {
                    type: 'geojson',
                    data: {
                        type: 'Feature',
                        geometry: { type: 'LineString', coordinates: coordinates }
                    }
                });
            }

            // Map View: Center on stop if coming from deep link, fit route if standalone, otherwise gentle zoom
            if (options.fitToRoute && coordinates.length > 0) {
                // Standalone route deep link: fit the entire route in view
                const bounds = new mapboxgl.LngLatBounds();
                coordinates.forEach(coord => bounds.extend(coord));

                // Get panel height for bottom padding, capped
                const panel = document.getElementById('route-info');
                const rawPanelHeight = panel ? panel.offsetHeight : 200;
                const maxPadding = Math.min(window.innerHeight * 0.35, 250);
                const panelHeight = Math.min(rawPanelHeight, maxPadding);

                console.log(`[DeepLink Route] Fitting route bounds. Panel: ${rawPanelHeight}px, capped to: ${panelHeight}px`);

                // Temporarily restore original methods if overridden
                const origMethods = window._originalMapMethods;
                if (origMethods) {
                    map.flyTo = origMethods.flyTo;
                    map.jumpTo = origMethods.jumpTo;
                    map.easeTo = origMethods.easeTo;
                }

                map.fitBounds(bounds, {
                    padding: {
                        top: 80,
                        bottom: panelHeight + 40,
                        left: 40,
                        right: 40
                    },
                    maxZoom: 15,
                    duration: 1200
                });

                // Re-apply no-op overrides
                if (origMethods) {
                    map.flyTo = () => map;
                    map.jumpTo = () => map;
                    map.easeTo = () => map;
                }
            } else if (options.centerOnStop && options.centerOnStop.lat && options.centerOnStop.lon) {
                // Deep link from stop: fly to the stop location at route-appropriate zoom
                const offsetY = -(window.innerHeight * 0.1);
                map.flyTo({
                    center: [options.centerOnStop.lon, options.centerOnStop.lat],
                    zoom: 14, // Route-appropriate zoom (slightly zoomed out from stop's default 16)
                    offset: [0, offsetY],
                    duration: 1500
                });
            } else if (map.getZoom() > 14.5) {
                // Normal click: Gentle Zoom Out (No Panning)
                map.easeTo({ zoom: 14, duration: 800 });
            }
            // else: Do nothing (preserve center and zoom)
        }

        // 3. Fetch Stops for "Bumps" / Beads
        const stopsData = await api.fetchRouteStopsV3(route.id, patternSuffix, { strategy: 'cache-first' });
        if (requestId !== lastRouteUpdateId) return; // Stale check

        const stopsGeoJSON = {
            type: 'FeatureCollection',
            features: stopsData.map(stop => {
                // Apply Merges & Overrides
                const sId = String(stop.id);
                const normId = redirectMap.get(sId) || sId;
                // Look up in allStops to get overridden coordinates
                const existingStop = allStops.find(s => s.id === normId);
                const lat = existingStop ? existingStop.lat : stop.lat;
                const lon = existingStop ? existingStop.lon : stop.lon;

                return {
                    type: 'Feature',
                    geometry: { type: 'Point', coordinates: [lon, lat] },
                    properties: { name: stop.name }
                };
            })
        };

        map.addSource('route-stops', { type: 'geojson', data: stopsGeoJSON });

        // Route Line Layer (Bold, Top)
        map.addLayer({
            id: 'route',
            type: 'line',
            source: 'route',
            layout: {
                'line-join': 'round',
                'line-cap': 'round'
            },
            paint: {
                'line-color': getRouteDisplayColor(route),
                'line-width': 12, // Extra Bolder line
                'line-opacity': 0.8,
                'line-emissive-strength': 1
            }
        }); // Removing beforeId to place on top

        // Route Stops (White "Beads")
        map.addLayer({
            id: 'route-stops',
            type: 'circle',
            source: 'route-stops',
            paint: {
                'circle-color': '#ffffff', // White
                'circle-radius': 3, // Small
                'circle-stroke-width': 0,
                'circle-opacity': 1,
                'circle-emissive-strength': 1
            }
        });

        // 4. Start Live Bus Tracking
        if (route.id) {
            const liveColor = getRouteDisplayColor(route);
            updateLiveBuses(route.id, patternSuffix, liveColor);
            busUpdateInterval = setInterval(() => updateLiveBuses(route.id, patternSuffix, liveColor), 5000);
        }

        // Force Stop Highlight to Top and reapply data if needed
        // (Race condition fix: highlight may have been set before style was ready)
        if (options.fromStopId) {
            const highlightStop = allStops.find(s => String(s.id) === String(options.fromStopId));
            if (highlightStop && highlightStop.lon && highlightStop.lat) {
                // Ensure source exists
                if (!map.getSource('selected-stop')) {
                    map.addSource('selected-stop', {
                        type: 'geojson',
                        data: { type: 'FeatureCollection', features: [] }
                    });
                }
                // Ensure layer exists
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
                // Set the highlight feature data
                map.getSource('selected-stop').setData({
                    type: 'FeatureCollection',
                    features: [{
                        type: 'Feature',
                        geometry: { type: 'Point', coordinates: [highlightStop.lon, highlightStop.lat] },
                        properties: highlightStop
                    }]
                });
            }
        }

        // Move highlight layer to top
        if (map.getLayer('stops-highlight')) {
            map.moveLayer('stops-highlight');
        }

    } catch (error) {
        console.error('CRITICAL: Failed to plot route:', error);
        alert(`Error plotting route: ${error.message}`);
    }
}

// updateLiveBuses moved to map-setup.js

// Helper for Sheet State (Mobile)
function setSheetState(panel, state) {
    // states: hidden, collapsed, peek, half, full
    panel.classList.remove('hidden', 'sheet-half', 'sheet-full', 'sheet-collapsed', 'sheet-peek');
    document.body.classList.remove('sheet-half', 'sheet-full', 'sheet-collapsed', 'sheet-peek');

    if (state === 'hidden') {
        panel.classList.add('hidden');
        panel.style.display = 'none'; // Force hide
        // Only clear stop highlight when explicitly closing info-panel (not when switching to route)
        if (panel.id === 'info-panel' && map.getSource('selected-stop')) {
            // Preserve highlight if route-info is about to open (fromStopId case)
            const routePanel = document.getElementById('route-info');
            if (routePanel.classList.contains('hidden')) {
                map.getSource('selected-stop').setData({ type: 'FeatureCollection', features: [] });
            }
        }
    } else if (state === 'collapsed') {
        panel.classList.add('sheet-collapsed');
        document.body.classList.add('sheet-collapsed');
        panel.classList.remove('hidden');
    } else if (state === 'peek') {
        panel.classList.add('sheet-peek');
        document.body.classList.add('sheet-peek');
        panel.classList.remove('hidden');
        panel.style.display = ''; // Reset
    } else if (state === 'half') {
        panel.classList.add('sheet-half');
        document.body.classList.add('sheet-half');
        panel.classList.remove('hidden');
        panel.style.display = ''; // Reset
    } else if (state === 'full') {
        panel.classList.add('sheet-full');
        document.body.classList.add('sheet-full');
        panel.classList.remove('hidden');
    }

    // For desktop compatibility
    // We WANT these states to persist now, so we can support the half/full/collapsed logic on desktop too.
    // The CSS handles the centering and width constraints for desktop.

    // Previous logic forced it to just removed 'hidden' on desktop. 
    // We'll keep the classes. The CSS for desktop needs to respect them if we want this behavior.

    // However, we might want to ensure 'half' on desktop doesn't mean "bottom 40% of screen" if the design is a sidebar...
    // Wait, the design IS a sidebar on desktop? 
    // The user said "Desktop (narrow window)". 
    // If it's a Sidebar, vertical sliding makes no sense.
    // Sidebars typically don't "collapse down".

    // If the app switches to Sidebar on Desktop, this whole "Slide Up/Down" logic logic is moot unless we are in Mobile Mode.
    // My CSS media queries toggle between Bottom Sheet and Sidebar at 768px.

    // Checks:
    // If width > 768px: Panel is usually top-left or sidebar.
    // If width < 768px: Panel is bottom sheet.

    // If user says "Desktop (narrow window)", they might mean < 768px responsiveness.
    // IN THAT CASE, the `window.innerWidth >= 769` check below is valid for "Real Desktop".
    // AND it overrides the states.

    // IF the user wants this behavior when the window is NARROW, then we are ALREADY in the <768px block effectively?
    // Unless the breakpoint is different.

    // Let's assume "Desktop (narrow window)" means "Simulating mobile on desktop". 
    // In that case, `window.innerWidth` would be small, so this `if` block wouldn't run.

    // BUT if the user has a window of say 800px, and they want this behavior? 
    // Then my CSS still renders a Sidebar.
    // A Sidebar snapping to "Half Height" is weird.

    // User said: "on desktop (narrow window)". 
    // Hypotesis: They are testing responsively. 
    // If they are seeing "unable to scroll from collapsed", it implies they ARE in a mode where 'collapsed' exists (Mobile Mode).
    // So this function is NOT the blocker for <768px.

    // HOWEVER, if they are testing on a "Desktop" width (e.g. 1000px) but expecting mobile behavior?
    // That would require a massive CSS refactor.
    // I will assume they mean <768px (Mobile View).

    // Re-reading: "on desktop (narrow window)". 
    // If I am in Mobile View (<768), `setSheetState` DOES apply classes. 

    // So why "unable to scroll from collapsed"?
    // Because my `wheel` listener logic: 
    // `const currentClass = ...`
    // If I am in `collapsed` (bottom 80px), and I use the mouse wheel over the map? 
    // The listener is on the PANEL.
    // If the panel is collapsed, it is only 80px tall. 
    // The user has to mouse over that specific 80px strip to trigger the wheel event.

    // If they mouse over that strip and scroll...
    // My logic: `if (currentClass === 'collapsed')` -> MISSING!
    // I missed handling 'collapsed' in the wheel event listener! I only did 'half' and 'full'.

    // Fixing setSheetState just in case it's interfering with clean state transitions, 
    // but the real bug is in `wheel` listener.

    // Unified logic: Desktop now uses the same bottom sheet classes as mobile.
    // The CSS handles the centering and width constraints for desktop.
}

// fetchRouteDetailsV3 moved to api.js



// fetchRouteStopsV3 moved to api.js

// fetchBusPositionsV3 definition removed (moved to api.js)

// Polyline Decoder (Google Encoded Polyline Algorithm)
// decodePolyline definition removed (moved to api.js)

// Helper to toggle panel state
function setPanelState(isOpen) {
    if (isOpen) {
        document.body.classList.add('panel-open');
    } else {
        // Only remove if BOTH panels are hidden
        const infoHidden = document.getElementById('info-panel').classList.contains('hidden');
        const routeHidden = document.getElementById('route-info').classList.contains('hidden');
        if (infoHidden && routeHidden) {
            document.body.classList.remove('panel-open');
        }
    }
}

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

    // Process EACH target independently
    targets.forEach(targetId => {
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
                    if (foundO !== -1 && foundT !== -1 && foundT_beforeO !== -1) {
                        const segmentLengthForward = foundT - foundO;
                        const segmentLengthBackward = foundO - foundT_beforeO;

                        // If backward segment is shorter, use T→O segment instead
                        if (segmentLengthBackward < segmentLengthForward) {
                            segmentStops = p.stops.slice(foundT_beforeO, foundO + 1).map(s => {
                                const normId = redirectMap.get(s.id) || s.id;
                                const refStop = allStops.find(as => as.id === normId);
                                return refStop ? { ...s, id: normId, lat: refStop.lat, lon: refStop.lon } : { ...s, id: normId };
                            });
                            matchedPattern = p;
                            return true;
                        }
                    }

                    if (foundO !== -1 && foundT !== -1) {
                        segmentStops = p.stops.slice(foundO, foundT + 1).map(s => {
                            const normId = redirectMap.get(s.id) || s.id;
                            // Hydrate with overridden coordinates from allStops if available
                            const refStop = allStops.find(as => as.id === normId);
                            // Ensure we use the stop object ID but potentially override coords
                            return refStop ? { ...s, id: normId, lat: refStop.lat, lon: refStop.lon } : { ...s, id: normId };
                        });

                        // DEBUG: Log segment info
                        if (stateChanged && (originId === '3963' || originId === 3963)) {
                            console.log(`[Segment Debug] Route ${r.shortName}: O=${foundO}, T=${foundT}, segment=${segmentStops.length} stops, target=${targetId}`);
                        }

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
                color = RouteFilterColorManager.pathColors.get(signature) || '#888888';
            }

            const selectedPatternStops = group.stops.map(s => [s.lon, s.lat]);

            // DEBUG: Check if stops have valid coordinates
            if (stateChanged && (originId === '3963' || originId === 3963)) {
                const validCoords = selectedPatternStops.filter(c => c[0] && c[1]);
                console.log(`[Coords Debug] group.stops=${group.stops.length}, valid=${validCoords.length}, first=${JSON.stringify(group.stops[0])}`);
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
                            // Pass intermediate stops to guide slicing for loop routes
                            // DEBUG: Log stop coords being passed to slicePolyline
                            console.log(`[Slice Debug] originStop: lat=${originStop.lat}, lon=${originStop.lon}`);
                            console.log(`[Slice Debug] targetStop: lat=${targetStop.lat}, lon=${targetStop.lon}`);
                            const sliced = slicePolyline(bestPattern._decodedPolyline, originStop, targetStop, group.stops);

                            // DEBUG: See what slicePolyline returns
                            if (sliced) {
                                const firstPt = sliced[0];
                                const lastPt = sliced[sliced.length - 1];
                                const dLon = lastPt[0] - firstPt[0];
                                const dLat = lastPt[1] - firstPt[1];
                                const distSq = dLon * dLon + dLat * dLat;
                                console.log(`[Slice Debug] points=${sliced.length}, distSq=${distSq.toFixed(8)}, first=${firstPt}, last=${lastPt}`);
                            }

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
                        fetchAndCacheGeometry(bestRoute, bestPattern, { strategy: 'cache-only' });
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
                simpleCoordinates = getCatmullRomSpline(selectedPatternStops);
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
                    console.log(`[Polyline Debug] No finalCoords. hasPattern=${hasPattern}, hasSuffix=${hasSuffix}, hasDecoded=${hasDecoded}, isFetching=${isFetching}, isPersistent=${isPersistent}`);
                }

                // Trigger geometry fetch if not available
                // Use network fetch for persistent selections (skip fetching check), cache-only for hover
                if (group.pattern && group.pattern.suffix && !group.pattern._decodedPolyline) {
                    // For persistent selections, allow refetch even if already fetching
                    if (isPersistent || !group.pattern._fetchingPolyline) {
                        const bestRoute = group.routes[0];
                        const fetchOptions = isPersistent ? {} : { strategy: 'cache-only' };
                        console.log(`[Polyline Debug] Fetching geometry for route ${bestRoute.id}/${bestRoute.shortName}, suffix=${group.pattern.suffix}`);
                        fetchAndCacheGeometry(bestRoute, group.pattern, fetchOptions);
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
                console.log(`[Polyline Debug] quality=${quality}, color=${color}, coords: first=[${first}], last=[${last}], total=${activeCoords.length}`);
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
    for (const [sig, col] of RouteFilterColorManager.pathColors.entries()) {
        if (!allActiveSignatures.has(sig)) {
            console.log('[ColorManager] GC Deleting signature:', sig, 'Color:', col);
            RouteFilterColorManager.pathColors.delete(sig);
        }
    }

    // Update Source
    const source = map.getSource('filter-connection');
    if (source) {
        if (features.length > 0 && stateChanged) {
            console.log(`[Polyline Debug] Setting ${features.length} features to filter-connection source`);
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

// Catmull-Rom Spline Interpolation for smooth curves (Global Version)
function getCatmullRomSpline(points, tension = 0.25, numOfSegments = 16) {
    if (points.length < 2) return points;

    let res = [];
    const _points = points.slice();
    // duplicate first and last points to close the curve segment
    _points.unshift(points[0]);
    _points.push(points[points.length - 1]);

    for (let i = 1; i < _points.length - 2; i++) {
        const p0 = _points[i - 1];
        const p1 = _points[i];
        const p2 = _points[i + 1];
        const p3 = _points[i + 2];

        // If distance between p1 and p2 is tiny, skip? 
        // No, keep logic simple.

        for (let t = 0; t <= numOfSegments; t++) {
            const t1 = t / numOfSegments;
            const t2 = t1 * t1;
            const t3 = t2 * t1;

            // Catmull-Rom factors
            const f1 = -0.5 * t3 + t2 - 0.5 * t1;
            const f2 = 1.5 * t3 - 2.5 * t2 + 1.0;
            const f3 = -1.5 * t3 + 2.0 * t2 + 0.5 * t1;
            const f4 = 0.5 * t3 - 0.5 * t2;

            const x = p0[0] * f1 + p1[0] * f2 + p2[0] * f3 + p3[0] * f4;
            const y = p0[1] * f1 + p1[1] * f2 + p2[1] * f3 + p3[1] * f4;

            res.push([x, y]);
        }
    }
    return res;
}

// --- Polyline Slicing & Fetching Helpers ---

function slicePolyline(points, originStop, targetStop, intermediateStops = null) {
    if (!points || points.length < 2) return null;

    // Helper: Find nearest index within a range, preferring the FIRST occurrence (cluster)
    const getNearestIndex = (pt, startIndex = 0, endIndex = points.length) => {
        let minDist = Infinity;
        let globalBestIndex = -1;

        let currentClusterBestIndex = -1;
        let currentClusterMinDist = Infinity;
        let foundFirstCluster = false;

        // Threshold: Approx 30m radius squared
        const THRESHOLD_SQ = 0.0000001;

        for (let i = startIndex; i < endIndex; i++) {
            const lng = points[i][0];
            const lat = points[i][1];

            const d = (lng - pt.lon) ** 2 + (lat - pt.lat) ** 2;

            if (d < minDist) {
                minDist = d;
                globalBestIndex = i;
            }

            if (d < THRESHOLD_SQ) {
                if (!foundFirstCluster) {
                    if (d < currentClusterMinDist) {
                        currentClusterMinDist = d;
                        currentClusterBestIndex = i;
                    }
                }
            } else {
                if (currentClusterBestIndex !== -1 && !foundFirstCluster) {
                    foundFirstCluster = true;
                }
            }
        }

        if (foundFirstCluster) return currentClusterBestIndex;
        if (currentClusterBestIndex !== -1) return currentClusterBestIndex;
        return globalBestIndex;
    };

    // NEW APPROACH: If we have intermediate stops, use them to guide finding the correct segment
    // This is essential for loop routes where each stop appears twice on the polyline
    if (intermediateStops && intermediateStops.length >= 2) {
        // First, find ALL occurrences of the first stop on the polyline
        // For loop routes, the same stop may appear at multiple positions
        const firstStop = intermediateStops[0];
        if (!firstStop.lat || !firstStop.lon) {
            // Fall through to fallback
        } else {
            const THRESHOLD_SQ = 0.0000001; // ~30m
            const firstStopOccurrences = [];

            for (let i = 0; i < points.length; i++) {
                const d = (points[i][0] - firstStop.lon) ** 2 + (points[i][1] - firstStop.lat) ** 2;
                if (d < THRESHOLD_SQ) {
                    // Found a match - record the cluster center
                    let clusterBest = i;
                    let clusterMinDist = d;
                    // Skip through the cluster to avoid duplicates
                    while (i + 1 < points.length) {
                        const d2 = (points[i + 1][0] - firstStop.lon) ** 2 + (points[i + 1][1] - firstStop.lat) ** 2;
                        if (d2 < THRESHOLD_SQ) {
                            if (d2 < clusterMinDist) {
                                clusterMinDist = d2;
                                clusterBest = i + 1;
                            }
                            i++;
                        } else {
                            break;
                        }
                    }
                    firstStopOccurrences.push(clusterBest);
                }
            }

            // Try each occurrence and find the one that gives the best (shortest) valid path
            let bestResult = null;
            let bestLength = Infinity;

            for (const startIdx of firstStopOccurrences) {
                // Try to trace the path from this starting position
                const stopIndices = [{ stopId: firstStop.id, idx: startIdx }];
                let searchStart = startIdx;
                let valid = true;

                for (let i = 1; i < intermediateStops.length; i++) {
                    const stop = intermediateStops[i];
                    if (!stop.lat || !stop.lon) continue;

                    // Skip consecutive duplicate stop IDs (avoid failing on same stop at same position)
                    const prevStop = stopIndices[stopIndices.length - 1];
                    if (prevStop && prevStop.stopId === stop.id) {
                        continue; // Same stop ID as previous, skip it
                    }

                    const idx = getNearestIndex(stop, searchStart);
                    // console.log(`[Slice Debug] Stop ${i}/${intermediateStops.length}: ${stop.id} at [${stop.lat}, ${stop.lon}] -> idx=${idx} (searchStart=${searchStart})`);
                    if (idx !== -1 && idx > searchStart) {
                        stopIndices.push({ stopId: stop.id, idx });
                        searchStart = idx;
                    } else {
                        // console.log(`[Slice Debug] FAILED to find stop ${stop.id} after idx ${searchStart}`);
                        valid = false;
                        break;
                    }
                }

                if (valid && stopIndices.length >= 2) {
                    const firstIdx = stopIndices[0].idx;
                    const lastIdx = stopIndices[stopIndices.length - 1].idx;
                    const segmentLength = lastIdx - firstIdx;
                    console.log(`[Slice Debug] Valid path found: firstIdx=${firstIdx}, lastIdx=${lastIdx}, segmentLength=${segmentLength}`);

                    if (segmentLength > 0 && segmentLength < bestLength) {
                        bestLength = segmentLength;
                        bestResult = points.slice(firstIdx, lastIdx + 1);
                    }
                }
            }

            if (bestResult) {
                console.log(`[Slice Debug] Returning best result with ${bestResult.length} points`);
                return bestResult;
            }
        }
    }

    // FALLBACK: Original approach for non-loop routes or when intermediate stops aren't available
    const idxOrigin = getNearestIndex(originStop);
    if (idxOrigin === -1) return null;

    const idxTargetForward = getNearestIndex(targetStop, idxOrigin);
    const idxTargetBackward = getNearestIndex(targetStop, 0, idxOrigin);

    const forwardLength = idxTargetForward !== -1 ? idxTargetForward - idxOrigin : Infinity;
    const backwardLength = idxTargetBackward !== -1 ? idxOrigin - idxTargetBackward : Infinity;

    if (idxTargetBackward !== -1 && backwardLength < forwardLength) {
        return points.slice(idxTargetBackward, idxOrigin + 1).reverse();
    }

    if (idxTargetForward !== -1 && idxOrigin <= idxTargetForward) {
        return points.slice(idxOrigin, idxTargetForward + 1);
    }

    return null;
}


// fetchRoutePolylineV3 definition removed (moved to api.js)

async function fetchAndCacheGeometry(route, pattern, options = {}) {
    if (pattern._fetchingPolyline || pattern._polyfailed) return;
    pattern._fetchingPolyline = true;

    try {
        const data = await api.fetchRoutePolylineV3(route.id, pattern.suffix, options);

        // console.log(`[Debug] Polyline API Response for ${route.shortName} (${pattern.suffix}):`, JSON.stringify(data));
        // Data format usually: { [suffix]: "encoded_string" } OR { [suffix]: { encodedValue: "..." } }
        let entry = data[pattern.suffix];
        let encoded = null;

        if (typeof entry === 'string') {
            encoded = entry;
        } else if (Array.isArray(entry)) {
            // Updated API returns decoded array for validation/slices
            encoded = entry;
        } else if (entry && typeof entry === 'object') {
            encoded = entry.encodedValue || entry.points || entry.geometry;
        }

        // Robust Fallback Fallbacks
        if (!encoded) {
            // 1. Try finding in array if data is array
            if (Array.isArray(data)) {
                const match = data.find(p => p.suffix === pattern.suffix || p.patternSuffix === pattern.suffix);
                if (match) encoded = match.encodedValue || match.points || match.geometry;
            }
            // 2. Try 'polylines' property
            else if (data.polylines && Array.isArray(data.polylines)) {
                const match = data.polylines.find(p => p.suffix === pattern.suffix || p.patternSuffix === pattern.suffix);
                if (match) encoded = match.encodedValue || match.points || match.geometry;
            }
            // 3. Try direct 'points' property (if single result)
            else if (data.points) {
                encoded = data.points;
            }
        }

        if (typeof encoded === 'string' || Array.isArray(encoded)) {
            pattern._decodedPolyline = (typeof encoded === 'string') ? api.decodePolyline(encoded) : encoded;
            // console.log(`[Debug] Polyline fetched & decoded for ${route.shortName} (${pattern.suffix}), points: ${pattern._decodedPolyline.length}`);

            // Re-Draw if still selected
            if (filterManager.state.active && filterManager.state.targetIds.size > 0) {
                updateConnectionLine(filterManager.state.originId, filterManager.state.targetIds, false);
            }
        } else {
            console.warn(`[Debug] No polyline string for ${route.shortName} suffix ${pattern.suffix}`);
            pattern._polyfailed = true;
        }

    } catch (e) {
        console.error('Failed to fetch polyline', e);
        pattern._polyfailed = true;
    } finally {
        pattern._fetchingPolyline = false;
    }
}
// --- Edit Tools Integration ---

// --- Route Overrides Logic ---
let routesConfig = { routeOverrides: {} };
window.routesConfig = routesConfig;

async function loadRoutesConfig() {
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
    console.log('[Config] Applying Route Overrides...', window.routesConfig?.routeOverrides ? Object.keys(window.routesConfig.routeOverrides).length : 0);

    if (!window.routesConfig?.routeOverrides) return;

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

        // Debug Rustavi routes
        if (['20', '21', '22', '23', '24', '10'].includes(route.shortName)) {
            // console.log(`[Config Debug] Rustavi route ${route.shortName} ID: "${route.id}"`);
            // console.log(`[Config Debug] Direct lookup:`, window.routesConfig.routeOverrides[route.id]);
            if (route.id.includes(':')) {
                const stripped = route.id.split(':')[1];
                // console.log(`[Config Debug] Stripped "${stripped}" lookup:`, window.routesConfig.routeOverrides[stripped]);
                // console.log(`[Config Debug] "1:${stripped}" lookup:`, window.routesConfig.routeOverrides[`1:${stripped}`]);
            }
            // console.log(`[Config Debug] Found override:`, !!override, override);
        }

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

