import './style.css';
import mapboxgl from 'mapbox-gl';

import stopBearings from './data/stop_bearings.json';
// stopsConfig will be loaded dynamically
import { Router } from './router.js';
import * as api from './api.js';
import * as metro from './metro.js'; // Import new module
const { handleMetroStop } = metro; // Destructure for existing calls
import { db } from './db.js';
import { historyManager } from './history.js';
import { hydrateRouteDetails } from './fetch.js';

import iconFilterOutline from './assets/icons/line.3.horizontal.decrease.circle.svg';
// import iconFilterFill from './assets/icons/line.3.horizontal.decrease.circle.fill.svg'; // Only used in FilterManager now? No, need check.

import { map, getMapHash, setupMapControls } from './map-setup.js';
import { initSettings, simplifyNumber, shouldShowRoute } from './settings.js';

// --- Global State Declarations (Hoisted) ---
// These must be declared before api.fetchRoutes calls onRoutesLoaded
let allStops = [];
let rawStops = [];
let allRoutes = [];
let stopToRoutesMap = new Map();
let lastRouteUpdateId = 0;
const redirectMap = new Map();
const hubMap = new Map();
const hubSourcesMap = new Map();
const mergeSourcesMap = new Map();
let editState = null;
let busUpdateInterval = null;
// State declarations

// Initialize Settings
initSettings({
    onUpdate: () => {
        // Re-render Views
        if (window.currentStopId) {
            // If we have cached lastArrivals, re-render
            if (window.lastArrivals) {
                renderArrivals(window.lastArrivals, window.currentStopId);
                if (window.lastRoutes) renderAllRoutes(window.lastRoutes, window.lastArrivals);
            }
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

    if (isRouterLogicExecuted) return; // Only run initial routing once
    isRouterLogicExecuted = true;

    console.log('[Init] Router Logic Executing with', data.length, 'routes');

    // 1. Nested Route (Stop + Bus)
    if (initialState.type === 'nested' && initialState.stopId && initialState.shortName) {
        window.currentStopId = initialState.stopId;
        const execute = () => {
            showStopInfo({ id: initialState.stopId }, true, false, false).then(() => {
                api.fetchV3Routes().then(() => {
                    const routeObj = allRoutes.find(r => String(r.shortName) === String(initialState.shortName));
                    if (routeObj) {
                        showRouteOnMap(routeObj, true, { initialDirectionIndex: initialState.direction });
                    }
                });
            });
        };
        if (map.loaded()) execute(); else map.once('load', execute);
    }
    // 2. Direct Route (Bus only)
    else if (initialState.type === 'route' && initialState.shortName) {
        const execute = () => {
            api.fetchV3Routes().then(() => {
                const routeObj = allRoutes.find(r => String(r.shortName) === String(initialState.shortName));
                if (routeObj) {
                    showRouteOnMap(routeObj, true, { initialDirectionIndex: initialState.direction });
                }
            });
        };
        if (map.loaded()) execute(); else map.once('load', execute);
    }
    // 3. Stop Only / Filter / Other (Delegated to handleDeepLinks)
    // We only handle simple stop loads here if they are NOT filtered?
    // Actually, `handleDeepLinks` is much more robust for Stop logic.
    // Let's remove the duplicated Stop block here and call `handleDeepLinks` explicitly
    // OR ensure `handleDeepLinks` is called effectively.
    // But `handleDeepLinks` is currently called in `initializeMapData` (setupSearch callback).
    // Let's trust `handleDeepLinks` to handle the Stop case and remove it from here to avoid race/reset.

    else if (initialState.stopId) {
        // Delegating to handleDeepLinks which handles filters correctly.
        // However, we need to ensure handleDeepLinks is called or triggered.
        // Currently it's called in setupSearch -> onRouteSelect? No.
        // It's called in `initializeMapData` at line ~332?
        // Let's check line 332.

        // If I remove this block, `onRoutesLoaded` won't trigger the stop view.
        // I should call `handleDeepLinks` here instead.
        handleDeepLinks();
    }
}

// 1. Fast Load (Cache/Static) - Instant UI
api.fetchRoutes({ strategy: 'cache-only' }).then(onRoutesLoaded);

// 2. Fresh Load (Network) - Updates Data/UI
api.fetchRoutes().then(onRoutesLoaded);

map.on('moveend', () => {
    // Only update hash if no specialized view is active (Stop or Route)
    if (!window.currentStopId && !window.currentRoute) {
        Router.updateMapLocation(getMapHash());
    }
});

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
const historyStack = [];

function addToHistory(type, data) {
    // Don't add if it's the same as the current top
    const top = historyStack[historyStack.length - 1];
    if (top && top.type === type && top.data.id === data.id) return;

    historyStack.push({ type, data });
    updateBackButtons();
    // Save to Recent Cards history (separately from Search History)
    historyManager.addCard({ type, id: data.id, data });
}

function popHistory() {
    if (historyStack.length <= 1) return null;
    historyStack.pop(); // Remove current
    return historyStack[historyStack.length - 1]; // Return previous
}

function clearHistory() {
    historyStack.length = 0;
    updateBackButtons();
}

function updateBackButtons() {
    const hasHistory = historyStack.length > 1;
    const backPanel = document.getElementById('back-panel');
    const backRoute = document.getElementById('back-route-info');

    if (backPanel) backPanel.classList.toggle('hidden', !hasHistory);
    if (backRoute) backRoute.classList.toggle('hidden', !hasHistory);
}

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
import { FilterManager } from './filter-manager.js';

let filterManager;

const dataProvider = {
    getAllStops: () => allStops,
    getAllRoutes: () => allRoutes,
    getRedirectMap: () => redirectMap,
    getHubMap: () => hubMap,
    getHubSourcesMap: () => hubSourcesMap,
    getMergeSourcesMap: () => mergeSourcesMap,
    getStopToRoutesMap: () => stopToRoutesMap,
    getEditState: () => editState
};

const uiCallbacks = {
    renderArrivals,
    renderAllRoutes,
    setSheetState,
    updateConnectionLine,
    showStopInfo,
    getCircleRadiusExpression // Assuming we can use the local one or move it. Wait, getCircleRadiusExpression is defined locally. I should export it or move it or duplicate it.
    // It's defined at line ~4400. Let's find it. For now, I'll assume we can pass a wrapper.
};
// Wrapper for getCircleRadiusExpression if it's a function declaration
uiCallbacks.getCircleRadiusExpression = (scale) => getCircleRadiusExpression(scale);

// Lazy Init to ensure Map is ready? Or just init immediately.
// Map is imported. Router is imported.
filterManager = new FilterManager({ map, router: Router, dataProvider, uiCallbacks });

// Forwarding functions for UI event handlers
window.toggleFilterMode = () => filterManager.toggleFilterMode(window.currentStopId, window.isPickModeActive, setEditPickMode);
window.applyFilter = (targetId) => filterManager.applyFilter(targetId, window.currentStopId, window.lastArrivals, window.lastRoutes);
window.clearFilter = () => filterManager.clearFilter(window.currentStopId);

import { RouteFilterColorManager } from './color-manager.js';
import { setupSearch } from './search.js';

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

    // 2. Config & Layers (Populates allStops from rawStops)
    await refreshStopsLayer();

    // 3. Index Routes (Clear and Rebuild)
    stopToRoutesMap.clear();
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
    addStopsToMap(allStops);

    if (!areImagesLoaded) {
        await loadImages(map);
        areImagesLoaded = true;
    }

    // 6. Final UI
    document.body.classList.remove('loading');
    setTimeout(() => map.resize(), 100);

    // 7. Router / Deep Links
    if (!isDeepLinkHandled) {
        handleDeepLinks();
        isDeepLinkHandled = true;

        Router.onPopState = (state) => {
            if (state.stopId) {
                // ... (Router logic handled by handleDeepLinks essentially or showStopInfo)
                // Actually handleDeepLinks is one-off. Router listeners handle subsequent.
            }
        };
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



// Load Bus Icon (Simple Arrow)
const arrowImage = new Image(24, 24);
const arrowSvg = `
            <svg width="24" height="24" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                <path d="M12 2L4.5 20.29L5.21 21L12 18L18.79 21L19.5 20.29L12 2Z" fill="#ef4444" />
            </svg>`;
arrowImage.onload = () => {
    if (!map.hasImage('bus-arrow')) map.addImage('bus-arrow', arrowImage, { sdf: true });
};
arrowImage.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(arrowSvg);

// Load Transfer Station Icon (Half Red / Half Green)
const transferSvg = `
        <svg width="32" height="32" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">
        <circle cx="16" cy="16" r="14" fill="#ef4444" /> <!--Red Base-->
        <path d="M16 2 A14 14 0 0 1 16 30 L16 2 Z" fill="#22c55e" /> <!--Green Right Half-->
        <circle cx="16" cy="16" r="14" fill="none" stroke="white" stroke-width="4"/> <!--White border to match others-->
    </svg > `;
const transferImage = new Image(32, 32);
transferImage.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(transferSvg);
transferImage.onload = () => {
    if (!map.hasImage('station-transfer')) map.addImage('station-transfer', transferImage);
};

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
                    ['>', ['get', 'bearing'], 0], 'stop-selected-icon', // Arrow
                    'stop-icon' // Circle fallback
                ],
                'icon-size': [
                    'case',
                    ['==', ['get', 'mode'], 'SUBWAY'], 1.5,
                    1.2
                ],
                'icon-allow-overlap': true,
                'icon-ignore-placement': true,
                'icon-rotate': ['coalesce', ['get', 'bearing'], 0],
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
});

// Modify fetchWithCache to use db
// API Functions Moved to api.js




// Helper for Circle Radius Logic
function getCircleRadiusExpression(scale = 1) {
    return [
        'interpolate',
        ['linear'],
        ['zoom'],
        12.5, 1.2 * scale,
        16, 4.8 * scale
    ];
}

const GREEN_LINE_STOPS = [
    'State University', 'Vazha-Pshavela', 'Vazha Pshavela', 'Delisi', 'Medical University', 'Technical University', 'Tsereteli', 'Station Square 2'
];

// Handle Initial URL State (Deep Links)
async function handleDeepLinks() {
    const state = Router.parse();
    if (state.stopId) {
        const rawStopId = state.stopId;
        const normStopId = redirectMap.get(rawStopId) || rawStopId;
        const stop = allStops.find(s => String(s.id) === String(normStopId));

        console.log(`[DeepLink] Processing Stop: ${rawStopId} -> ${normStopId}. Found=${!!stop}`);
        if (stop) {
            // Check for Filtered State
            if (state.filterActive && state.targetIds && state.targetIds.length > 0) {
                console.log('[DeepLink] Applying Filter:', state.targetIds);

                // 2. Show Stop (Suppress URL update, NO FlyTo to avoid conflict with Filter flyTo)
                await showStopInfo(stop, false, false, false);

                // 3. Apply Filter Logic
                // We need to trigger the filter mode fully
                await filterManager.toggleFilterMode(normStopId);

                // Then apply specific targets if any
                if (state.targetIds && state.targetIds.length > 0) {
                    state.targetIds.forEach(tid => {
                        // Normalize Target ID (e.g. '930' -> '1:930')
                        const normTid = redirectMap.get(tid) || tid;
                        filterManager.state.targetIds.add(normTid);
                    });
                    // Trigger refresh to apply
                    await filterManager.refreshRouteFilter(normStopId);
                }

                // 4. Update UI Button State
                const filterBtn = document.getElementById('filter-routes-toggle');
                if (filterBtn) filterBtn.classList.add('active');
                if (filterBtn) filterBtn.classList.add('active');
            } else {
                // Standard Stop View
                // Pass updateURL=false because the URL is already correct (deep link)
                // Wait, if it's a deep link /stop123, showing it won't change URL?
                // But showStopInfo might try to pushState. 
                // We typically want to respect the current URL.
                showStopInfo(stop, false, true, false);
            }
        } else {
            console.warn(`[DeepLink] Stop ${state.stopId} not found in data.`);
        }
    }
    // Note: Route deep links are handled by onRoutesLoaded logic
}

function addStopsToMap(stops) {
    // Cleanup existing layers/sources if they exist (idempotency)
    const layers = ['metro-layer-label', 'metro-layer-circle', 'metro-transfer-layer', 'metro-lines-layer', 'stops-layer', 'stops-layer-circle', 'stops-label-selected'];
    const sources = ['metro-stops', 'metro-lines-manual', 'stops'];

    layers.forEach(id => {
        if (map.getLayer(id)) map.removeLayer(id);
    });
    sources.forEach(id => {
        if (map.getSource(id)) map.removeSource(id);
    });

    // --- Process Metro Stops ---
    const { busStops, metroFeatures } = metro.processMetroStops(stops, stopBearings);
    const metroLines = metro.generateMetroLines(metroFeatures);



    // 1. Bus Source & Layer (Existing code follows...)


    // 1. Bus Source & Layer
    if (!map.getSource('stops')) {
        map.addSource('stops', {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: busStops },
            cluster: false
        });
    }

    // 2. Bus Layers (Split for smooth scaling)

    // Layer A: Small Circles (Zoom < 16)
    if (!map.getLayer('stops-layer-circle')) {
        map.addLayer({
            id: 'stops-layer-circle',
            type: 'circle',
            source: 'stops',
            maxzoom: 16, // Visible until 16, then switches to icons
            paint: {
                'circle-color': '#000000',
                'circle-stroke-color': '#ffffff',
                'circle-stroke-width': 2.1, // Increased by 40% (1.5 * 1.4)
                'circle-radius': getCircleRadiusExpression(1),
                'circle-opacity': 1
            }
        });
    }

    // Layer B: Icons (Zoom >= 16)
    if (!map.getLayer('stops-layer')) {
        map.addLayer({
            id: 'stops-layer',
            type: 'symbol',
            source: 'stops',
            minzoom: 16, // Only visible when zoomed in
            layout: {
                'icon-allow-overlap': true,
                'icon-ignore-placement': true,
                'symbol-z-order': 'source',
                'icon-image': [
                    'case',
                    ['==', ['get', 'bearing'], 0],
                    'stop-icon',      // Bearing 0 -> Circle
                    'stop-close-up-icon' // Bearing !0 -> Directional
                ],
                // Fixed size at zoom 16+ (or slight scaling if desired, but request implies parity)
                'icon-size': [
                    'interpolate',
                    ['linear'],
                    ['zoom'],
                    // Unified size for both circle (bearing 0) and directional icons to prevent unevenness
                    16, 0.6,
                    18, 0.8
                ],
                // Rotation Logic
                'icon-rotate': ['get', 'bearing'],
                'icon-rotation-alignment': 'map'
            },
            paint: {
                'icon-opacity': 1
            }
        });
    }

    // Filter Connection Line Layer (Below stops, above routes?)
    if (!map.getSource('filter-connection')) {
        map.addSource('filter-connection', {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: [] }
        });
    }
    if (!map.getLayer('filter-connection-line')) {
        map.addLayer({
            id: 'filter-connection-line',
            type: 'line',
            source: 'filter-connection',
            layout: {
                'line-join': 'round',
                'line-cap': 'round'
            },
            paint: {
                'line-color': '#2563eb', // Default blue, updated dynamically
                'line-width': 4,
                'line-opacity': 0.8
            }
        });
        // Move below stops
        if (map.getLayer('stops-layer')) {
            map.moveLayer('filter-connection-line', 'stops-layer');
        }
    }

    // Hover Effect for Connection Line
    const hoverLayers = ['stops-layer', 'stops-layer-circle'];
    hoverLayers.forEach(layerId => {
        map.on('mousemove', layerId, (e) => {
            if (filterManager.state.picking) {
                let selectedFeature = null;

                // Loop through ALL features at this point to find a selectable one (handle z-overlap)
                for (const f of e.features) {
                    const p = f.properties;
                    const normId = redirectMap.get(p.id) || p.id;

                    // Exclude Origin, but allow any reachable/highlighted
                    // Actually hover effect logic: we want to draw line to POTENTIAL target.
                    // Usually we only draw to reachable stops.
                    if (filterManager.state.reachableStopIds.has(normId) || filterManager.state.targetIds.has(normId)) {
                        selectedFeature = f;
                        break;
                    }
                }

                if (selectedFeature) {
                    // Pass Current Selection + Hover ID
                    updateConnectionLine(filterManager.state.originId, filterManager.state.targetIds, true, selectedFeature.properties.id);
                }
            }
        });

        map.on('mouseleave', layerId, () => {
            if (filterManager.state.picking) {
                // Revert to just the selected lines (remove hover line)
                // Pass false for isHover
                updateConnectionLine(filterManager.state.originId, filterManager.state.targetIds, false);
            }
        });
    });

    // 2. Add Metro Layers
    metro.addMetroLayers(map, metroFeatures, metroLines);

    // 4. Labels for Selected Filter Stops (New)
    // Initially empty filter, populated by updateMapFilterState
    if (!map.getLayer('stops-label-selected')) {
        map.addLayer({
            id: 'stops-label-selected',
            type: 'symbol',
            source: 'stops',
            filter: ['in', ['get', 'id'], ['literal', []]], // Default empty
            layout: {
                'text-field': ['get', 'name'],
                'text-size': 12,
                'text-offset': [0, 1.2],
                'text-anchor': 'top',
                'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'], // Standard mapbox fonts
                'text-allow-overlap': false
            },
            paint: {
                'text-color': '#000000',
                'text-halo-color': '#ffffff',
                'text-halo-width': 2
            }
        });
    }


    // Ensure correct Layer Order (Z-Index)
    // 1. Metro Lines (Bottom)
    if (map.getLayer('metro-lines-layer') && map.getLayer('stops-layer')) {
        map.moveLayer('metro-lines-layer', 'stops-layer');
    }
    // 2. Stops (Normal)
    // 3. Highlight (Top)
    if (map.getLayer('stops-highlight')) {
        map.moveLayer('stops-highlight');
    }
}

// Handle clicks
map.on('click', 'stops-layer', async (e) => {
    // Check Click Lock
    if (window.ignoreMapClicks || window.isPickModeActive) {
        console.log('[Debug] Map Click Ignored (Lock Active or Pick Mode)');
        return;
    }

    const props = e.features[0].properties;

    // FILTER PICKING MODE
    if (filterManager.state.picking) {
        let selectedFeature = null;

        // Loop through ALL features at this point to find a selectable one (handle z-overlap)
        for (const f of e.features) {
            const p = f.properties;
            const normId = redirectMap.get(p.id) || p.id;
            // Exclude originId from being selectable in filter mode
            const isSelectable = filterManager.state.reachableStopIds.has(normId) || filterManager.state.targetIds.has(normId);
            if (isSelectable) {
                selectedFeature = f;
                break;
            }
        }

        if (selectedFeature) {
            applyFilter(selectedFeature.properties.id);
        } else {
            shakeFilterButton();
        }
        return;
    }

    // Prevent Bus click if Metro is top-most (UNLESS in Filter Picking Mode)
    const metroFeatures = map.queryRenderedFeatures(e.point, { layers: ['metro-layer-circle', 'metro-layer-label', 'metro-transfer-layer'] });
    if (metroFeatures.length > 0 && !filterManager.state.picking) {
        console.log('[Debug] Click hit Bus Stop but Metro is present. Ignoring Bus handler.');
        return;
    }

    const coordinates = e.features[0].geometry.coordinates.slice();

    // Keep global track of selected stop ID
    window.currentStopId = props.id;
    if (window.selectDevStop) window.selectDevStop(props.id);

    // Smart Zoom: Don't zoom out if already close
    const currentZoom = map.getZoom();
    const targetZoom = currentZoom > 16 ? currentZoom : 16;

    // Inject coordinates into props for History/Back navigation usage
    const stopData = { ...props, lat: coordinates[1], lon: coordinates[0] };

    showStopInfo(stopData, true, true); // Use centralized flyTo with offset
});

// Reuse same click logic for stops-layer-circle
map.on('click', 'stops-layer-circle', async (e) => {
    // Check Click Lock
    if (window.ignoreMapClicks || window.isPickModeActive) {
        return;
    }

    // Prevent Bus click if Metro is top-most (UNLESS in Filter Picking Mode)
    const metroFeatures = map.queryRenderedFeatures(e.point, { layers: ['metro-layer-circle', 'metro-layer-label', 'metro-transfer-layer'] });
    if (metroFeatures.length > 0 && !filterManager.state.picking) {
        return;
    }

    const props = e.features[0].properties;

    // FILTER PICKING MODE
    if (filterManager.state.picking) {
        let selectedFeature = null;
        for (const f of e.features) {
            const p = f.properties;
            const normId = redirectMap.get(p.id) || p.id;
            const isSelectable = filterManager.state.reachableStopIds.has(normId) || filterManager.state.targetIds.has(normId);
            if (isSelectable) {
                selectedFeature = f;
                break;
            }
        }

        if (selectedFeature) {
            applyFilter(selectedFeature.properties.id);
        } else {
            shakeFilterButton();
        }
        return;
    }

    const coordinates = e.features[0].geometry.coordinates.slice();

    window.currentStopId = props.id;
    if (window.selectDevStop) window.selectDevStop(props.id);

    const currentZoom = map.getZoom();
    const targetZoom = currentZoom > 16 ? currentZoom : 16;

    const stopData = { ...props, lat: coordinates[1], lon: coordinates[0] };
    showStopInfo(stopData, true, true);
});

// Metro Click Handlers (Same logic as stops-layer)
const metroLayers = ['metro-layer-circle', 'metro-layer-label', 'metro-transfer-layer'];
metroLayers.forEach(layerId => {
    map.on('click', layerId, async (e) => {
        const props = e.features[0].properties;

        // FILTER PICKING MODE
        if (filterManager.state.picking) {
            let selectedFeature = null;

            // Loop through ALL features at this click point
            for (const f of e.features) {
                const p = f.properties;
                const normId = redirectMap.get(p.id) || p.id;
                // Exclude originId from being selectable in filter mode
                const isSelectable = filterManager.state.reachableStopIds.has(normId) || filterManager.state.targetIds.has(normId);
                if (isSelectable) {
                    selectedFeature = f;
                    break;
                }
            }

            if (selectedFeature) {
                applyFilter(selectedFeature.properties.id);
            } else {
                shakeFilterButton();
            }
            return;
        }

        const coordinates = e.features[0].geometry.coordinates.slice();

        // Keep global track of selected stop ID
        window.currentStopId = props.id;
        if (window.selectDevStop) window.selectDevStop(props.id);

        // Smart Zoom: Don't zoom out if already close
        const currentZoom = map.getZoom();
        const targetZoom = currentZoom > 16 ? currentZoom : 16;

        const stopData = { ...props, lat: coordinates[1], lon: coordinates[0] };

        showStopInfo(stopData, true, true);
    });

    // Add pointer cursor
    map.on('mouseenter', layerId, (e) => {
        if (filterManager.state.picking) {
            const hasSelectable = e.features.some(f => {
                const p = f.properties;
                const normId = redirectMap.get(p.id) || p.id;
                return filterManager.state.reachableStopIds.has(normId) || filterManager.state.targetIds.has(normId);
            });
            if (!hasSelectable) return;
        }
        map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', layerId, () => {
        map.getCanvas().style.cursor = '';
    });
});

// Add pointer cursor for    // Hover Effect for Connection Line
const hoverLayers = ['stops-layer', 'stops-layer-circle'];
let lastHoveredStopId = null;
let hoverTimeout = null;

// Helper to dim/undim filter lines
const setFilterOpacity = (dim) => {
    const opacity = dim ? 0.3 : 0.8;
    if (map.getLayer('filter-connection-line')) {
        map.setPaintProperty('filter-connection-line', 'line-opacity', opacity);
    }
    // Also check for any other pattern matches if we add more dynamic layers later
    const style = map.getStyle();
    if (style && style.layers) {
        style.layers.forEach(l => {
            if (l.id.startsWith('filter-connection-')) {
                map.setPaintProperty(l.id, 'line-opacity', opacity);
            }
        });
    }
};

hoverLayers.forEach(layerId => {
    map.on('mousemove', layerId, (e) => {
        if (filterManager.state.picking) {
            map.getCanvas().style.cursor = 'pointer';

            // Cancel any pending reset from mouseleave
            if (hoverTimeout) {
                clearTimeout(hoverTimeout);
                hoverTimeout = null;
            }

            let selectedFeature = null;
            if (e.features.length > 0) {
                selectedFeature = e.features[0];
            }

            if (selectedFeature) {
                const props = selectedFeature.properties;
                // Normalize ID for comparison (String vs Number safety)
                // Use Group ID (Hub or Normalized) to prevent flickering between sibling stops
                const rawId = props.id;
                const normId = redirectMap.get(rawId) || rawId;
                const groupId = hubMap.get(normId) || normId;
                const currentStableId = String(groupId);

                // Optimization: Only update if the hovered GROUP/STOP CHANGED
                if (lastHoveredStopId === currentStableId) return;
                lastHoveredStopId = currentStableId;

                const hubEquivalents = getEquivalentStops(normId);

                // Check if ANY of the equivalents is selected (Hub Logic)
                let isSelected = false;
                hubEquivalents.forEach(id => {
                    if (filterManager.state.targetIds.has(id)) isSelected = true;
                });

                if (isSelected) {
                    // DIM if already selected
                    // MUST call updateConnectionLine FIRST (it resets opacity to 0.8)
                    updateConnectionLine(filterManager.state.originId, filterManager.state.targetIds, false);
                    // THEN Dim
                    setFilterOpacity(true);
                } else {
                    // STANDARD (Preview Select)
                    updateConnectionLine(filterManager.state.originId, filterManager.state.targetIds, true, props.id);
                    // Ensure full opacity
                    setFilterOpacity(false);
                }
            }
        } else {
            map.getCanvas().style.cursor = 'pointer';
            lastHoveredStopId = null;
        }
    });

    map.on('mouseleave', layerId, () => {
        map.getCanvas().style.cursor = '';

        // Debounce to 100ms for safety against layer gaps/jitter
        if (hoverTimeout) clearTimeout(hoverTimeout);

        hoverTimeout = setTimeout(() => {
            // Check if we have effectively moved away
            // NOTE: mousemove on another layer would have cleared this timeout & updated lastHoveredStopId

            if (lastHoveredStopId !== null) {
                lastHoveredStopId = null;

                // Reset Opacity & Lines
                updateConnectionLine(filterManager.state.originId, filterManager.state.targetIds, false);
                setFilterOpacity(false); // Ensure 0.8
            }
        }, 100);
    });
});

// Helper: Shake Animation
function shakeFilterButton() {
    const btn = document.getElementById('filter-routes-toggle');
    if (btn) {
        btn.classList.remove('shake');
        void btn.offsetWidth; // Force reflow
        btn.classList.add('shake');
    }
}

// Generic Map Click (Catch background clicks in Filter Mode)
map.on('click', (e) => {
    if (!filterManager.state.picking && !window.isPickModeActive) return;

    // Check if we clicked a stop layer (stops or metro)
    // Check if we clicked a stop layer (stops or metro)
    const features = map.queryRenderedFeatures(e.point, { layers: ['stops-layer', 'stops-layer-circle', ...metroLayers] });

    // If we didn't hit a stop layer, we hit background -> Shake
    if (features.length === 0) {
        shakeFilterButton();
    }
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
            if (e.deltaY < 0) { // Scroll Up (pull) -> Expand
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


// Helper: Dim background layers when focusing on a stop/route
function setMapFocus(active) {
    const opacity = active ? 0.4 : 1.0;

    // Bus Stops
    if (map.getLayer('stops-layer')) {
        map.setPaintProperty('stops-layer', 'icon-opacity', opacity);
    }

    // Metro Layers
    if (map.getLayer('metro-layer-circle')) {
        map.setPaintProperty('metro-layer-circle', 'circle-opacity', opacity);
        map.setPaintProperty('metro-layer-circle', 'circle-stroke-opacity', opacity);
    }
    if (map.getLayer('metro-layer-label')) {
        map.setPaintProperty('metro-layer-label', 'text-opacity', opacity);
    }
    if (map.getLayer('metro-transfer-layer')) {
        map.setPaintProperty('metro-transfer-layer', 'icon-opacity', opacity);
        map.setPaintProperty('metro-transfer-layer', 'text-opacity', opacity);
    }

    if (map.getLayer('stops-label-selected')) {
        map.setPaintProperty('stops-label-selected', 'text-opacity', opacity);
    }

    // Selected Stop Highlight - ALWAYS KEEP OPAQUE
    if (map.getLayer('stops-highlight')) {
        map.setPaintProperty('stops-highlight', 'icon-opacity', 1.0);
    }
}

async function showStopInfo(stop, addToStack = true, flyToStop = false, updateURL = true) {
    // Enable Focus Mode (Dim others)
    setMapFocus(true);

    if (addToStack) addToHistory('stop', stop);

    // Sync URL (Router)
    // Only update if it's a new stop or first load, and updateURL is true
    // Sync URL (Router)
    // Only update if it's a new stop or first load, and updateURL is true
    if (updateURL) {
        Router.updateStop(stop.id, filterManager.state.active, Array.from(filterManager.state.targetIds));
    }

    // Explicitly clean up any route layers when showing a stop
    // This is crucial when coming "Back" from a route
    if (busUpdateInterval) clearInterval(busUpdateInterval);

    // Robust Layer Cleanup: Remove any layer starting with route- or live-buses-
    const style = map.getStyle();
    if (style && style.layers) {
        // Collect IDs first
        const layersToRemove = style.layers
            .filter(layer => layer.id.startsWith('route') || layer.id.startsWith('live-buses'))
            .map(layer => layer.id);

        layersToRemove.forEach(id => {
            if (map.getLayer(id)) map.removeLayer(id);
        });
    }
    // Remove sources
    ['route', 'route-stops', 'live-buses'].forEach(id => {
        if (map.getSource(id)) map.removeSource(id);
    });

    // Highlight selected stop
    // Highlight selected stop
    if (stop.id) {
        // Restore Global State (Crucial for Back Button / State Restoration)
        window.currentStopId = stop.id;
        if (window.selectDevStop) window.selectDevStop(stop.id);

        // Should we fetch the stop again to get coordinates if we don't have them?
        // Usually 'stop' object has lat/lon if coming from cache/list.
        if (flyToStop && stop.lon && stop.lat) {
            // Calculate offset to shift center upwards (account for bottom panel)
            // Panel covers bottom ~40%, so we want to shift the visual center up by ~10% of screen height
            // Reduced to 10% to avoid being too close to the top search bar
            const offsetY = -(window.innerHeight * 0.1);

            // 1. Saved Persistence (Back Button)
            if (stop.savedZoom) {
                map.flyTo({
                    center: [stop.lon, stop.lat],
                    zoom: stop.savedZoom,
                    offset: [0, offsetY]
                });
            }
            // 2. Smart Zoom (Click)
            else {
                const currentZoom = map.getZoom();
                const targetZoom = currentZoom > 16 ? currentZoom : 16;
                map.flyTo({
                    center: [stop.lon, stop.lat],
                    zoom: targetZoom,
                    offset: [0, offsetY]
                });
            }
        }

        // Update highlight source
        // We might not have the full feature if coming from history/cache depending on structure
        console.log('[Debug] showStopInfo called for:', stop);




        if (stop.lon && stop.lat) {
            console.log('[Debug] Updating selected-stop source with:', stop.lon, stop.lat);
            const feature = {
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [stop.lon, stop.lat] },
                properties: stop
            };
            if (map.getSource('selected-stop')) {
                map.getSource('selected-stop').setData({
                    type: 'FeatureCollection',
                    features: [feature]
                });



                // Force highlight layers to top
                if (map.getLayer('debug-selected-circle')) map.moveLayer('debug-selected-circle');
                if (map.getLayer('stops-highlight')) map.moveLayer('stops-highlight');
            } else {
                console.warn('[Debug] Source selected-stop NOT found, waiting for map load...');
            }
        } else {
            console.warn('[Debug] Stop missing coords, attempting fix:', stop);
            // Attempt to retrieve from allStops again in case it was a skeletal object
            const refreshedStop = allStops.find(s => s.id === stop.id);
            if (refreshedStop && refreshedStop.lat) {
                console.log('[Debug] Recovered stop coordinates from global list');
                stop.lat = refreshedStop.lat;
                stop.lon = refreshedStop.lon;
                stop.name = refreshedStop.name;
                // Recursive retry once
                return showStopInfo(stop, addToHistory, isPopState);
            }
            // If still missing, maybe fetch? (Optional future improvement)
        }
    }

    const panel = document.getElementById('info-panel');
    const nameEl = document.getElementById('stop-name');
    const listEl = document.getElementById('arrivals-list');
    const idDisplayEl = document.getElementById('stop-id-display');

    // Close route info if open (exclusive panels)
    // Close route info if open (exclusive panels)
    setSheetState(document.getElementById('route-info'), 'hidden');

    nameEl.textContent = stop.name || 'Unknown Stop';
    if (idDisplayEl) idDisplayEl.textContent = `ID: ${stop.id}`;
    panel.classList.remove('metro-mode'); // Reset mode
    listEl.innerHTML = '<div class="loading">Loading arrivals...</div>';

    // Cleanup: Remove any existing Metro header if it exists (from previous selection)
    const existingHeader = panel.querySelector('.metro-header');
    if (existingHeader) existingHeader.remove();

    // Detect Metro Station
    // Detect Metro Station
    // Clear header extension
    const headerExtension = document.getElementById('header-extension');
    if (headerExtension) headerExtension.innerHTML = '';

    // STRICT CHECK: Metro stations must have mode 'SUBWAY' (set in addStopsToMap) OR have a specific ID pattern.
    const isMetro = stop.mode === 'SUBWAY' || (stop.id && (stop.id.startsWith('1:metro') || stop.id.includes('metro') || stop.id.includes('Metro')));

    console.log(`[Debug] showStopInfo: ID=${stop.id}, Mode=${stop.mode}, isMetro=${isMetro}`);

    // Toggle UI Actions Visibility (Edit & Filter)
    const editBtn = document.getElementById('btn-edit-stop');
    const filterBtn = document.getElementById('filter-routes-toggle');

    if (isMetro) {
        console.log('[Debug] Entering Metro Branch');
        if (editBtn) {
            editBtn.classList.add('hidden');
            editBtn.style.display = 'none';
        }
        if (filterBtn) {
            filterBtn.classList.add('hidden');
            filterBtn.style.display = 'none';
        }

        // Delegate to Metro Module
        handleMetroStop(stop, panel, nameEl, listEl, {
            allRoutes,
            stopToRoutesMap,
            setSheetState,
            updateBackButtons
        });
        return;
    } else {
        console.log('[Debug] Entering Bus Branch');

        // Bus Stop Logic
        const isLocalhost = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
        // Write access is only available in Dev Server mode (active middleware)
        const hasWriteAccess = isLocalhost && import.meta.env.DEV;

        if (editBtn) {
            editBtn.style.display = hasWriteAccess ? '' : 'none';
            editBtn.classList.toggle('hidden', !hasWriteAccess);
        }
        if (filterBtn) {
            filterBtn.style.display = ''; // Restore flex/block
            filterBtn.classList.remove('hidden');
        }
    }




    setSheetState(panel, 'half'); // Default to half open
    updateBackButtons(); // Ensure back button state is correct


    try {
        // Check for merged IDs
        const subIds = mergeSourcesMap.get(stop.id) || [];
        const idsAndParent = [stop.id, ...subIds];

        // Fetch Routes (static) for ALL IDs in parallel
        // Optimization: Only fetch if NOT already in stopToRoutesMap
        const routePromises = idsAndParent.map(id => {
            if (stopToRoutesMap.has(id) && stopToRoutesMap.get(id).length > 0) {
                console.log(`[Optimization] Routes for ${id} already loaded. Skipping fetch.`);
                // Return wrapped promise compatible with the result structure (array of routes)
                return Promise.resolve(stopToRoutesMap.get(id));
            }
            return api.fetchStopRoutes(id).catch(e => { console.warn(`fetchStopRoutes failed for ${id}:`, e); return []; });
        });

        // Fetch Arrivals (live) - this function already handles merged IDs internally
        const arrivalsPromise = fetchArrivals(stop.id);

        const [results, arrivals] = await Promise.all([
            Promise.all(routePromises),
            arrivalsPromise
        ]);

        // Flatten attributes from all stops
        const allFetchedRoutes = results.flat();

        // UPDATE CACHE for Filtering
        // We have fresh routes for this stop. Update the map so filtering works!
        stopToRoutesMap.set(stop.id, allFetchedRoutes);
        console.log(`[Debug] Updated stopToRoutesMap for ${stop.id} with ${allFetchedRoutes.length} routes.`);

        // --- Build All Routes (Header Extension) ---
        window.lastRoutes = allFetchedRoutes;
        renderAllRoutes(allFetchedRoutes, arrivals);

        // --- Render Arrivals ---
        window.lastArrivals = arrivals; // Store for filtering
        renderArrivals(arrivals, stop.id);

    } catch (error) {
        listEl.innerHTML = '<div class="error">Failed to load arrivals</div>';
        console.error(error);
    }
}

function renderAllRoutes(routesInput, arrivals) {
    const headerExtension = document.getElementById('header-extension');
    if (!headerExtension) return;

    headerExtension.innerHTML = ''; // Clear previous

    // Deduplicate Routes (Prioritize Parent aka first fetched)
    const uniqueRoutesMap = new Map();

    if (routesInput && Array.isArray(routesInput)) {
        routesInput.forEach(r => {
            if (r && r.shortName && !uniqueRoutesMap.has(r.shortName)) {
                uniqueRoutesMap.set(r.shortName, r);
            }
        });
    }


    // Merge with arrivals for robustness
    if (arrivals && arrivals.length > 0) {
        arrivals.forEach(arr => {
            if (!uniqueRoutesMap.has(arr.shortName)) {
                const fullRoute = allRoutes.find(r => r.shortName === arr.shortName);
                const newRoute = fullRoute || { shortName: arr.shortName, id: null, color: '2563eb' };
                uniqueRoutesMap.set(arr.shortName, newRoute);
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

            // Numeric Sort
            return (parseInt(a.shortName) || 0) - (parseInt(b.shortName) || 0);
        });

        const container = document.createElement('div');
        container.className = 'all-routes-container';

        const tilesContainer = document.createElement('div');
        tilesContainer.className = 'route-tiles-container';

        routesForStop.forEach(route => {
            // Apply Show Minibuses Filter
            if (!shouldShowRoute(route.shortName)) return;

            const tile = document.createElement('button');
            tile.className = 'route-tile';
            tile.textContent = simplifyNumber(route.shortName);
            const color = route.color || '2563eb';
            tile.style.backgroundColor = `#${color}20`; // 12% opacity
            tile.style.color = `#${color}`;
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
                        tile.style.backgroundColor = `${filterColor}20`; // Hex + opacity
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

        container.appendChild(tilesContainer);
        headerExtension.appendChild(container);
    }
}

async function fetchArrivals(stopId) {
    // Check for all equivalent IDs (merged and hubbed)
    const equivalentIds = getEquivalentStops(stopId, false);
    const idsToCheck = new Set();
    equivalentIds.forEach(eqId => {
        idsToCheck.add(eqId);
        // Also add any direct merges into this equivalent ID
        const subIds = mergeSourcesMap.get(eqId) || [];
        subIds.forEach(sId => idsToCheck.add(sId));
    });

    // Fetch all in parallel using API
    let combined = await api.fetchArrivalsForStopIds(Array.from(idsToCheck));

    // --- Per-Route Filtering Logic (Live > Scheduled) ---
    // 1. Group by Route (shortName)
    const arrivalsByRoute = new Map();
    combined.forEach(a => {
        const routeKey = a.shortName;
        if (!arrivalsByRoute.has(routeKey)) {
            arrivalsByRoute.set(routeKey, []);
        }
        arrivalsByRoute.get(routeKey).push(a);
    });

    const filtered = [];

    // 2. For each route, check if ANY live data exists
    arrivalsByRoute.forEach((arrivals, routeKey) => {
        const hasLive = arrivals.some(a => a.realtime);

        if (hasLive) {
            // If live exists, ONLY keep live
            const liveOnly = arrivals.filter(a => a.realtime);
            filtered.push(...liveOnly);
        } else {
            // If NO live exists, keep ALL (which are presumably scheduled)
            // But we might want to limit how many scheduled we show? For now, keep all.
            filtered.push(...arrivals);
        }
    });

    combined = filtered;

    // Dedup by simple key (route + time + headsign)
    // Now that we filtered, we can dedup safely.
    const unique = [];
    const seen = new Set();
    combined.forEach(a => {
        // Use scheduled time if live is missing for key uniqueness
        const time = a.realtimeArrivalMinutes !== undefined ? a.realtimeArrivalMinutes : a.scheduledArrivalMinutes;
        const key = `${a.shortName}_${time}_${a.headsign}`;
        if (!seen.has(key)) {
            seen.add(key);
            unique.push(a);
        }
    });

    // Sort by time
    unique.sort((a, b) => {
        const timeA = a.realtimeArrivalMinutes !== undefined ? a.realtimeArrivalMinutes : a.scheduledArrivalMinutes;
        const timeB = b.realtimeArrivalMinutes !== undefined ? b.realtimeArrivalMinutes : b.scheduledArrivalMinutes;
        return timeA - timeB;
    });

    return unique;
}

// --- V3 API Integration ---
let v3RoutesMap = null; // Maps shortName ("306") -> V3 ID ("1:R98190")

// Promise singleton to prevent parallel route fetches
let v3RoutesPromise = null;
const V3_ROUTES_CACHE_KEY = 'v3_routes_map_cache';
const V3_CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours

async function fetchV3Routes() {
    if (v3RoutesMap) return;
    if (v3RoutesPromise) return v3RoutesPromise;

    // 1. Try Local Storage Cache first
    try {
        const cached = await db.get(V3_ROUTES_CACHE_KEY);
        if (cached) {
            const { timestamp, data } = cached;
            if (Date.now() - timestamp < V3_CACHE_DURATION) {
                console.log('[V3] Loaded routes map from local cache');
                v3RoutesMap = new Map(data); // Rehydrate Map from array
                return;
            }
        }
    } catch (e) {
        console.warn('[V3] Error reading local routes cache', e);
    }

    // 2. Fetch from API if no cache
    v3RoutesPromise = (async () => {
        // 1. Try Cache First
        try {
            const cached = await db.get(V3_ROUTES_CACHE_KEY);
            if (cached && (Date.now() - cached.timestamp < CACHE_DURATION)) {
                console.log('[V3] Loaded global routes list from DB Cache');
                v3RoutesMap = new Map(cached.data);
                return;
            }
        } catch (e) {
            console.warn('[V3] Failed to read routes cache', e);
        }

        // 2. Network Fetch via API Module
        try {
            console.log('[V3] Fetching global routes list from API...');
            const routes = await api.fetchV3Routes();

            v3RoutesMap = new Map();
            routes.forEach(r => {
                v3RoutesMap.set(String(r.shortName), r.id);
            });
            console.log(`[V3] Mapped ${v3RoutesMap.size} routes`);

            // Cache Logic
            try {
                await db.set(V3_ROUTES_CACHE_KEY, {
                    timestamp: Date.now(),
                    // Convert Map to Array for storage
                    data: Array.from(v3RoutesMap.entries())
                });
            } catch (e) {
                console.warn('LS Write Failed (V3 Routes)', e);
            }

        } catch (e) {
            console.error('[V3] Global routes fetch failed', e);
            v3RoutesMap = null; // Reset on failure
        } finally {
            v3RoutesPromise = null;
        }
    })();

    return v3RoutesPromise;
}

// Queue variables removed (moved to api.js)

// fetchWithRetry moved to api.js

async function getV3Schedule(routeShortName, stopId) {
    if (!v3RoutesMap) await fetchV3Routes();
    const routeId = v3RoutesMap && v3RoutesMap.get(String(routeShortName));
    if (!routeId) return null;

    // Use API
    const stopIds = getEquivalentStops(stopId);
    if (mergeSourcesMap.has(stopId)) {
        mergeSourcesMap.get(stopId).forEach(s => stopIds.push(s));
    }

    const schedule = await api.fetchScheduleForStop(routeId, stopIds);
    if (!schedule) return null;

    // Parse Schedule locally (or move parsing to api? Parsing is fast)
    // The previous implementation returned "12:34" string or similar?
    // Let's assume api returns raw schedule object. We need to format it.
    // Wait, the previous getV3Schedule returned "12:34" string?
    // Step 105: "return timeString;" at the end (truncated, but implied).
    // Let's check the previous code logic again or assume we need to format it.

    return parseSchedule(schedule, stopIds);
}

function parseSchedule(schedule, potentialIds) {
    if (!schedule || !Array.isArray(schedule)) return null;

    try {
        // Fix: Force Tbilisi Timezone (GMT+4)
        const tbilisiNow = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Tbilisi' }); // YYYY-MM-DD
        const todayStr = tbilisiNow;

        let daySchedule = schedule.find(s => s.serviceDates.includes(todayStr));

        // Helper to find next time in a specific day's schedule
        const findNextTime = (sched, minTimeMinutes) => {
            if (!sched) return null;
            // Check against all equivalent stop IDs
            const stop = sched.stops.find(s => potentialIds.includes(String(s.id)));
            if (!stop) return null;

            const times = stop.arrivalTimes.split(',');
            for (const t of times) {
                const [h, m] = t.split(':').map(Number);
                const stopMinutes = h * 60 + m; // Absolute minutes in the day
                if (stopMinutes > minTimeMinutes) {
                    return t;
                }
            }
            return null;
        };

        // Get Current Minutes in Tbilisi
        const now = new Date();
        const tbilisiParts = new Intl.DateTimeFormat('en-US', {
            timeZone: "Asia/Tbilisi",
            hour: 'numeric',
            minute: 'numeric',
            hour12: false
        }).formatToParts(now);
        const h = parseInt(tbilisiParts.find(p => p.type === 'hour').value);
        const m = parseInt(tbilisiParts.find(p => p.type === 'minute').value);
        const curMinutes = h * 60 + m;

        let nextTime = findNextTime(daySchedule, curMinutes);

        // Fallback: Check tomorrow if no time found today
        if (!nextTime) {
            // Calculate tomorrow string safe for timezone
            const tDate = new Date(todayStr);
            tDate.setDate(tDate.getDate() + 1);
            const tomorrowStr = tDate.toISOString().split('T')[0];

            const tmrSchedule = schedule.find(s => s.serviceDates.includes(tomorrowStr));
            nextTime = findNextTime(tmrSchedule, -1);
        }

        return nextTime;

    } catch (err) {
        console.warn(`[V3] Logic Error parsing schedule:`, err);
    }
    return null;
}

// Helper to format minutes from now to HH:mm (Tbilisi Time)
function formatScheduledTime(minutesFromNow) {
    const now = new Date();
    const target = new Date(now.getTime() + minutesFromNow * 60000);

    // Force Tbilisi Timezone display
    return new Intl.DateTimeFormat('en-GB', {
        timeZone: "Asia/Tbilisi",
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
    }).format(target);
}

// Let's implement the DOM sorting helper
function getMinutesFromNow(timeStr) {
    if (!timeStr || timeStr === '--:--' || timeStr === '...') return 9999;

    // Parse timeStr (HH:mm) strings
    const [h, m] = timeStr.split(':').map(Number);
    if (isNaN(h) || isNaN(m)) return 9999;

    const now = new Date();
    // Use Tbilisi time components for "current"
    const tbilisiParts = new Intl.DateTimeFormat('en-US', {
        timeZone: "Asia/Tbilisi",
        hour: 'numeric',
        minute: 'numeric',
        hour12: false
    }).formatToParts(now);

    const currH = parseInt(tbilisiParts.find(p => p.type === 'hour').value);
    const currM = parseInt(tbilisiParts.find(p => p.type === 'minute').value);

    let diff = (h * 60 + m) - (currH * 60 + currM);
    if (diff < -60) { // Likely tomorrow (e.g. now 23:00, bus 01:00)
        diff += 24 * 60;
    }
    return diff;
}

function sortArrivalsList() {
    const listEl = document.getElementById('arrivals-list');
    if (!listEl) return;

    const items = Array.from(listEl.children);

    // Sort logic
    items.sort((a, b) => {
        const minA = parseInt(a.getAttribute('data-minutes') || '99999');
        const minB = parseInt(b.getAttribute('data-minutes') || '99999');

        const diff = minA - minB;
        if (diff !== 0) return diff;

        // Secondary: Route Number
        const nameA = a.querySelector('.route-number')?.textContent?.trim() || '';
        const nameB = b.querySelector('.route-number')?.textContent?.trim() || '';
        return nameA.localeCompare(nameB, undefined, { numeric: true });
    });

    // Re-append in order
    items.forEach(item => listEl.appendChild(item));
}

// getV3ScheduleSync removed
function getV3ScheduleSync(routeShortName, stopId) {
    return null;
}

function renderArrivals(arrivals, currentStopId = null) {
    const listEl = document.getElementById('arrivals-list');
    listEl.innerHTML = '';

    const stopId = currentStopId || window.currentStopId;

    // 1. Identify "Missing" Routes
    let extraRoutes = [];
    if (stopId) {
        const equivalentIds = getEquivalentStops(stopId, false);
        const servingRoutes = new Set();
        equivalentIds.forEach(eqId => {
            const routes = stopToRoutesMap.get(eqId) || [];
            routes.forEach(r => servingRoutes.add(r));
        });

        const arrivalRouteShortNames = new Set(arrivals.map(a => String(a.shortName)));
        extraRoutes = Array.from(servingRoutes).filter(r => !arrivalRouteShortNames.has(String(r.shortName)));
    }

    // 2. Filter Logic (User Route Filter)
    if (filterManager.state.active) {
        arrivals = arrivals.filter(a => {
            const r = allRoutes.find(route => String(route.shortName) === String(a.shortName));
            return r && filterManager.state.filteredRoutes.includes(r.id);
        });
        extraRoutes = extraRoutes.filter(r => filterManager.state.filteredRoutes.includes(r.id));
    }

    // 2.5 Show Minibuses Filter
    arrivals = arrivals.filter(a => shouldShowRoute(a.shortName));
    extraRoutes = extraRoutes.filter(r => shouldShowRoute(r.shortName));

    // 3. Unified List Creation with Cache Lookup
    let renderList = [];

    // Add Live Arrivals
    arrivals.forEach(a => {
        renderList.push({
            type: 'live',
            data: a,
            // Calculate sort minutes
            minutes: (!a.realtime)
                ? (a.scheduledArrivalMinutes ?? 999)
                : (a.realtimeArrivalMinutes ?? 999),
            // Pre-calculate display strings
            color: (filterManager.state.active && RouteFilterColorManager.getColorForRoute(allRoutes.find(r => r.shortName === a.shortName)?.id))
                ? RouteFilterColorManager.getColorForRoute(allRoutes.find(r => r.shortName === a.shortName)?.id)
                : (a.color ? `#${a.color}` : 'var(--primary)'),
            headsign: a.headsign
        });
    });

    // Add Extra Routes (Try Sync Cache)
    extraRoutes.forEach(r => {
        // Try to get time from cache synchronously
        // Logic changed: Always async
        const cachedTimeStr = null; // No sync cache access
        const isAsync = true;

        // Calculate minutes if cached
        let minutes = 99999;
        let timeDisplay = '...';

        if (cachedTimeStr) {
            minutes = getMinutesFromNow(cachedTimeStr);
            // Smart formatting
            if (minutes < 60 && minutes >= 0) {
                timeDisplay = `${minutes} min`;
            } else {
                timeDisplay = cachedTimeStr;
            }
        }

        renderList.push({
            type: 'scheduled',
            data: r,
            minutes: minutes,

            color: (filterManager.state.active && RouteFilterColorManager.getColorForRoute(r.id))
                ? RouteFilterColorManager.getColorForRoute(r.id)
                : (r.color ? `#${r.color}` : 'var(--primary)'),
            needsFetch: !cachedTimeStr
        });
    });

    // 4. Sort EVERYTHING
    renderList.sort((a, b) => {
        const minDiff = a.minutes - b.minutes;
        if (minDiff !== 0) return minDiff; // Sort by Time

        // Secondary Sort: Route Number
        const nameA = String(a.data.shortName || '');
        const nameB = String(b.data.shortName || '');
        return nameA.localeCompare(nameB, undefined, { numeric: true });
    });

    if (renderList.length === 0) {
        if (filterManager.state.active) {
            listEl.innerHTML = '<div class="empty">No arrivals for selected destination</div>';
        } else {
            listEl.innerHTML = '<div class="empty">No upcoming arrivals</div>';
        }
        return;
    }

    // 5. Render Unified List
    renderList.forEach(item => {
        const div = document.createElement('div');
        div.className = item.type === 'scheduled' ? 'arrival-item extra-route' : 'arrival-item';
        div.style.borderLeftColor = item.color;
        div.setAttribute('data-minutes', item.minutes);

        let innerContent = '';

        if (item.type === 'live') {
            const a = item.data;
            const isScheduled = !a.realtime;
            const scheduledClass = isScheduled ? 'scheduled-time' : '';
            const disclaimer = isScheduled ? '<div class="scheduled-disclaimer">Scheduled</div>' : '';

            let tDisp;
            if (isScheduled && item.minutes < 60 && item.minutes >= 0) {
                tDisp = `${item.minutes} min`;
            } else if (isScheduled) {
                tDisp = formatScheduledTime(a.scheduledArrivalMinutes);
            } else {
                tDisp = `${a.realtimeArrivalMinutes} min`;
            }

            innerContent = `
              <div class="route-number" style="color: ${item.color}">${simplifyNumber(a.shortName)}</div>
              <div class="destination" title="${a.headsign}">${a.headsign}</div>
              <div class="time-container">
                  <div class="time ${scheduledClass}">${tDisp}</div>
                  ${disclaimer}
              </div>
            `;

            const routeObj = allRoutes.find(r => r.shortName === a.shortName);
            if (routeObj) {
                div.addEventListener('click', () => {
                    showRouteOnMap(routeObj, true, {
                        preserveBounds: true,
                        fromStopId: stopId,
                        targetHeadsign: a.headsign
                    });
                });
            }

        } else {
            // Scheduled (Extra)
            const r = item.data;
            const timeElId = `time-${r.shortName}-${stopId}`;

            innerContent = `
              <div class="route-number" style="color: ${item.color}">${simplifyNumber(r.shortName)}</div>
              <div class="destination" title="${r.longName}">${r.longName}</div>
              <div class="time-container">
                  <div id="${timeElId}" class="time scheduled-time">${item.timeDisplay}</div>
                  <div class="scheduled-disclaimer">Scheduled</div>
              </div>
            `;

            div.addEventListener('click', () => {
                showRouteOnMap(r, true, { preserveBounds: true, fromStopId: stopId });
            });

            // Trigger Async Fetch if needed
            if (item.needsFetch) {
                // Async Load
                // Async Load
                getV3Schedule(r.shortName, stopId).then(timeStr => {
                    if (!timeStr) {
                        const el = document.getElementById(timeElId);
                        if (el) el.textContent = '--:--';
                        return;
                    }

                    const mins = getMinutesFromNow(timeStr);
                    div.setAttribute('data-minutes', mins);

                    const el = document.getElementById(timeElId);
                    if (el) {
                        el.classList.remove('loading-text');
                        // Smart format matching 'live' style
                        if (mins < 60 && mins >= 0) {
                            el.textContent = `${mins} min`;
                        } else {
                            el.textContent = timeStr;
                        }
                    }

                    // Crucial: Re-sort list now that we have a time
                    sortArrivalsList();
                });
            }
        }

        div.innerHTML = innerContent;
        listEl.appendChild(div);
    });
}

// --- REUSABLE: Refresh Stops Logic (Apply Overrides/Merges) ---
async function refreshStopsLayer(useLocalConfig = false) {
    if (!rawStops || rawStops.length === 0) return;

    let stopsConfigToUse;

    if (useLocalConfig && window.stopsConfig) {
        // Use the in-memory config (already updated by EditTools)
        stopsConfigToUse = window.stopsConfig;
        console.log('[Main] Refreshing with LOCAL stops config...');
    } else {
        // Reload from file (Standard Load)
        if (import.meta.env.DEV) {
            try {
                const configUrl = new URL('./data/stops_config.json', import.meta.url).href;
                const res = await fetch(configUrl + '?t=' + Date.now());
                stopsConfigToUse = await res.json();
                console.log('[Main] Loaded Fresh Stops Config (Dev Mode)');
            } catch (e) {
                console.error('[Main] Failed to load stops config:', e);
                stopsConfigToUse = { overrides: {}, merges: {}, hubs: {} };
            }
        } else {
            try {
                const module = await import('./data/stops_config.json');
                stopsConfigToUse = module.default;
            } catch (e) {
                console.error('[Main] Failed to load stops config:', e);
                stopsConfigToUse = { overrides: {}, merges: {}, hubs: {} };
            }
        }
    }

    // Update Global Ref
    window.stopsConfig = stopsConfigToUse;

    // Reset Maps
    redirectMap.clear();
    mergeSourcesMap.clear();
    hubMap.clear();
    hubSourcesMap.clear();

    const overrides = stopsConfigToUse?.overrides || {};
    const merges = stopsConfigToUse?.merges || {};
    const hubs = stopsConfigToUse?.hubs || {};

    // Build merge mappings
    Object.keys(merges).forEach(source => {
        const target = merges[source];
        redirectMap.set(source, target);
        if (!mergeSourcesMap.has(target)) mergeSourcesMap.set(target, []);
        mergeSourcesMap.get(target).push(source);
    });

    // Build Hub mappings
    Object.keys(hubs).forEach(hubId => {
        const members = hubs[hubId];
        if (Array.isArray(members)) {
            members.forEach(memberId => {
                hubMap.set(memberId, hubId);
            });
            hubSourcesMap.set(hubId, members);
        }
    });

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
    const freshStops = rawStops.map(s => ({ ...s }));

    const busStops = [];
    const metroStops = [];

    // Helper to identify Metro
    const isMetroStop = (s) =>
        (s.vehicleMode === 'SUBWAY') ||
        (s.name && s.name.includes('Metro Station')) ||
        (s.id && typeof s.id === 'string' && s.id.startsWith('M:'));

    freshStops.forEach(stop => {
        // If this stop is merged INTO another, skip adding it to map list
        if (merges[stop.id]) return;

        // Apply Default Bearings (Standard Config)
        if (stop.bearing === undefined) {
            stop.bearing = stopBearings[stop.id] || 0;
        }

        // Apply Override if exists
        if (overrides[stop.id]) {
            Object.assign(stop, overrides[stop.id]);
        }

        // Deduplicate
        const coordKey = `${stop.lat.toFixed(6)},${stop.lon.toFixed(6)}`;
        if (seenCoords.has(coordKey)) return;
        seenCoords.add(coordKey);

        if (isMetroStop(stop)) {
            metroStops.push(stop);
        } else {
            busStops.push(stop);
        }
        stops.push(stop); // allStops keeps everything for search
    });

    console.log(`[Refresh] Processed Stops: ${freshStops.length} -> ${stops.length}`);
    allStops = stops;
    window.allStops = allStops;

    // UPDATE MAP SOURCES (Delegated to shared function to ensure formatting/filtering is consistent with Initial Load)
    addStopsToMap(allStops);
}
// Search Logic




// Route Plotting
let currentRoute = null;
let currentPatternIndex = 0;
// busUpdateInterval declared at top scope

async function showRouteOnMap(route, addToStack = true, options = {}) {
    // Snapshot current Zoom into the previous state (the Stop view) 
    // This allows "Back" to restore the exact zoom level.
    if (historyStack.length > 0) {
        const top = historyStack[historyStack.length - 1];
        if (top.type === 'stop') {
            top.data.savedZoom = map.getZoom();
        }
    }

    if (addToStack) addToHistory('route', route);

    currentRoute = route;
    currentPatternIndex = 0; // Reset to default
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
        infoPanel.classList.add('hidden');
        infoPanel.classList.remove('sheet-half', 'sheet-full', 'sheet-collapsed');

        // Route Info Card Setup
        const infoCard = document.getElementById('route-info');
        document.getElementById('route-info-number').textContent = route.shortName;
        document.getElementById('route-info-number').style.color = route.color ? `#${route.color}` : 'var(--primary)';
        document.getElementById('route-info-number').style.color = route.color ? `#${route.color}` : 'var(--primary)';
        // NOTE: Initial longName might be "Origin - Destination". We try to split it if possible, or just show as destination for now.
        // Better to wait for stops data to render properly, but for immediate feedback:
        document.getElementById('route-info-text').textContent = route.longName; // Will be properly formatted by updateRouteView line 1588
        setSheetState(infoCard, 'half'); // Default to half open
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
        const routeDetails = await api.fetchRouteDetailsV3(route.id);
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
            const matchedIndex = patterns.findIndex(p =>
                p.headsign && p.headsign.toLowerCase().trim() === normalizedTarget
            );
            if (matchedIndex !== -1) {
                currentPatternIndex = matchedIndex;
                directionFound = true;
                console.log(`[Debug] Matched pattern by headsign: ${options.targetHeadsign}`);
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
                        return getEquivalentStops(options.fromStopId).has(normId);
                    });
                });

                if (matchedIndex !== -1) {
                    currentPatternIndex = matchedIndex;
                }
            } catch (err) {
                console.warn('Failed to auto-detect direction:', err);
                // Fallback to default index 0
            }
        }

        // Handle Direction Switching Button
        const switchBtn = document.getElementById('switch-direction');
        const currentPattern = patterns[currentPatternIndex];

        // Fetch stops for current pattern to get origin → destination
        const currentPatternStops = await api.fetchRouteStopsV3(route.id, currentPattern.patternSuffix);
        if (requestId !== lastRouteUpdateId) return; // Stale check

        const originStop = currentPatternStops[0]?.name || '';
        const destinationStop = currentPatternStops[currentPatternStops.length - 1]?.name || currentPattern.headsign;

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

            document.getElementById('route-info-text').innerHTML = `
                <div class="origin">${originStop}</div>
                <div class="destination">→ ${destinationStop}</div>
            `;
        } else {
            switchBtn.classList.add('hidden');
            document.getElementById('route-info-text').innerHTML = `
                <div class="origin">${originStop}</div>
                <div class="destination">→ ${destinationStop}</div>
            `;
        }

        if (requestId !== lastRouteUpdateId) return; // Stale check before heavy map ops

        const patternSuffix = currentPattern.patternSuffix;

        // 2. Fetch Polylines (Current & Ghost)
        const allSuffixes = patterns.map(p => p.patternSuffix).join(',');
        const polylineData = await api.fetchRoutePolylineV3(route.id, allSuffixes);
        if (requestId !== lastRouteUpdateId) return; // Stale check

        // Plot Ghost Route (Other patterns)
        patterns.forEach(p => {
            if (p.patternSuffix !== patternSuffix) {
                const ghostEncoded = polylineData[p.patternSuffix]?.encodedValue;
                if (ghostEncoded) {
                    const ghostCoords = api.decodePolyline(ghostEncoded);
                    map.addSource(`route-ghost-${p.patternSuffix}`, {
                        type: 'geojson',
                        data: {
                            type: 'Feature',
                            geometry: { type: 'LineString', coordinates: ghostCoords }
                        }
                    });
                    map.addLayer({
                        id: `route-ghost-${p.patternSuffix}`,
                        type: 'line',
                        source: `route-ghost-${p.patternSuffix}`,
                        layout: { 'line-join': 'round', 'line-cap': 'round' },
                        paint: {
                            'line-color': route.color ? `#${route.color}` : '#2563eb',
                            'line-width': 4,
                            'line-opacity': 0.3 // 30% opacity for ghost route
                        }
                    }, 'stops-layer'); // Below stops
                }
            }
        });

        // Plot Current Route
        const encodedPolyline = polylineData[patternSuffix]?.encodedValue;
        if (encodedPolyline) {
            const coordinates = api.decodePolyline(encodedPolyline);

            map.addSource('route', {
                type: 'geojson',
                data: {
                    type: 'Feature',
                    geometry: { type: 'LineString', coordinates: coordinates }
                }
            });

            // Gentle Zoom Out (No Panning)
            // If zoomed in close (>14.5), ease to 14. Otherwise keep current view.
            if (map.getZoom() > 14.5) {
                map.easeTo({ zoom: 14, duration: 800 });
            } else {
                // Do nothing (preserve center and zoom)
            }
        }

        // 3. Fetch Stops for "Bumps" / Beads
        const stopsData = await api.fetchRouteStopsV3(route.id, patternSuffix);
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
                'line-color': route.color ? `#${route.color}` : '#2563eb',
                'line-width': 12, // Extra Bolder line
                'line-opacity': 0.8
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
                'circle-opacity': 1
            }
        });

        // 4. Start Live Bus Tracking
        if (route.id) {
            updateLiveBuses(route.id, patternSuffix, route.color ? `#${route.color}` : '#2563eb');
            busUpdateInterval = setInterval(() => updateLiveBuses(route.id, patternSuffix, route.color ? `#${route.color}` : '#2563eb'), 5000);
        }

        // Force Stop Highlight to Top
        if (map.getLayer('stops-highlight')) {
            map.moveLayer('stops-highlight');
        }

    } catch (error) {
        console.error('CRITICAL: Failed to plot route:', error);
        alert(`Error plotting route: ${error.message}`);
    }
}

async function updateLiveBuses(routeId, patternSuffix, color) {
    try {
        const positionsData = await api.fetchBusPositionsV3(routeId, patternSuffix);
        const buses = positionsData[patternSuffix] || [];

        const busGeoJSON = {
            type: 'FeatureCollection',
            features: buses.map(bus => ({
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [bus.lon, bus.lat] },
                properties: {
                    heading: bus.heading,
                    id: bus.vehicleId,
                    color: color
                }
            }))
        };

        if (map.getSource('live-buses')) {
            map.getSource('live-buses').setData(busGeoJSON);
        } else {
            map.addSource('live-buses', { type: 'geojson', data: busGeoJSON });

            // Bus Icon Layer (Arrow) - SDF Colored
            map.addLayer({
                id: 'live-buses-arrow',
                type: 'symbol',
                source: 'live-buses',
                layout: {
                    'icon-image': 'bus-arrow',
                    'icon-size': 1.2, // Larger
                    'icon-allow-overlap': true,
                    'icon-rotate': ['get', 'heading'],
                    'icon-rotation-alignment': 'map'
                },
                paint: {
                    'icon-color': ['get', 'color'], // SDF coloring
                    'icon-halo-color': '#ffffff',
                    'icon-halo-width': 4,
                    'icon-halo-blur': 0
                }
            });
        }
    } catch (error) {
        console.error('Failed to update live buses:', error);
    }
}

// Helper for Sheet State (Mobile)
function setSheetState(panel, state) {
    // states: hidden, collapsed, peek, half, full
    panel.classList.remove('hidden', 'sheet-half', 'sheet-full', 'sheet-collapsed', 'sheet-peek');

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
        panel.classList.remove('hidden');
    } else if (state === 'peek') {
        panel.classList.add('sheet-peek');
        panel.classList.remove('hidden');
        panel.style.display = ''; // Reset
    } else if (state === 'half') {
        panel.classList.add('sheet-half');
        panel.classList.remove('hidden');
        panel.style.display = ''; // Reset
    } else if (state === 'full') {
        panel.classList.add('sheet-full');
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
});

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
    ['route', 'route-stops', 'live-buses-circle', 'live-buses-arrow'].forEach(id => {
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

// Load Custom Icons
function loadImages(map) {
    // Determine base URL for assets
    const baseUrl = import.meta.env.BASE_URL || '/';

    // Load SVG Icons (Rasterized)
    // loadSvgImage(map, 'stop-icon', `${baseUrl}stop.svg`, 64, 64);

    // UNIFIED CIRCLE (0 degree stops): Match stop-selected.svg style (Black, r=24.5, stroke=4)
    const circleSize = 53; // Width of the SVG is 53
    const circleCanvas = document.createElement('canvas');
    circleCanvas.width = circleSize * 2; // Retina
    circleCanvas.height = circleSize * 2;
    const cCtx = circleCanvas.getContext('2d');

    // Scale for retina
    cCtx.scale(2, 2);

    // Center logic (53/2 = 26.5)
    const cx = 26.5;
    const cy = 26.5;
    const r = 24.5;

    cCtx.fillStyle = '#000000';
    cCtx.strokeStyle = '#ffffff';
    cCtx.lineWidth = 4;

    cCtx.beginPath();
    cCtx.arc(cx, cy, r, 0, Math.PI * 2);
    cCtx.fill();
    cCtx.stroke();

    map.addImage('stop-icon', cCtx.getImageData(0, 0, circleSize * 2, circleSize * 2), { pixelRatio: 2 });
    // STOPS FAR AWAY: Simple Circle (Programmatic)
    const farSize = 24; // Small canvas
    const farCanvas = document.createElement('canvas');
    farCanvas.width = farSize;
    farCanvas.height = farSize;
    const farCtx = farCanvas.getContext('2d');

    farCtx.fillStyle = 'rgba(60, 60, 60, 0.7)'; // Less intense black (Dark Grey, slight opacity)
    farCtx.beginPath();
    farCtx.arc(farSize / 2, farSize / 2, 6, 0, Math.PI * 2); // Radius 6 = 12px circle
    farCtx.fill();

    map.addImage('stop-far-away-icon', farCtx.getImageData(0, 0, farSize, farSize), { pixelRatio: 2 });

    // Unified Design: Use 'stop-selected.svg' (Circle + Arrow, Black) for ALL close-up stops
    // Pivot Issue: The visual center (circle) is at Y=49.35, but image height is 76 (Center 38).
    // Mapbox rotates around 38. We need it to rotate around 49.35.
    // Solution: Pad the image bottom so Center Y = 49.35. Total Height = 49.35 * 2 = 98.7.

    const svgUrl = `${baseUrl}stop-selected.svg`;
    const imgIco = new Image();
    imgIco.crossOrigin = 'Anonymous';
    imgIco.onload = () => {
        // Source Logical Size: 53 x 76
        // Target Pixel Size (2x): 106 x 152
        // Pivot Y (Logical): 49.35
        // New Logical Height: 49.35 * 2 = 98.7
        // New Pixel Height (2x): 197.4 -> 198

        const padCanvas = document.createElement('canvas');
        padCanvas.width = 106; // 53 * 2
        padCanvas.height = 198; // 99 * 2 (Pivot at 99)
        const pCtx = padCanvas.getContext('2d');

        // Draw image at Top (0,0) so Pivot (49.35 * 2 = 98.7) aligns with Center (198 / 2 = 99)
        // Wait, if I draw at 0, Pivot is at 98.7. Center is 99. Close enough.
        pCtx.drawImage(imgIco, 0, 0, 106, 152);

        const imageData = pCtx.getImageData(0, 0, 106, 198);

        // Add both icons using this centered image
        map.addImage('stop-close-up-icon', imageData, { pixelRatio: 2 });
        map.addImage('stop-selected-icon', imageData, { pixelRatio: 2 });
    };
    imgIco.onerror = (e) => console.error('Failed to load stop-selected.svg for padding', e);
    imgIco.src = svgUrl;

    // Create an SDF Arrow Icon programmatically
    const width = 48;
    const height = 48;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');

    // Draw Arrow
    ctx.fillStyle = '#000000'; // SDF requires black drawing on transparent
    ctx.beginPath();
    ctx.moveTo(width / 2, 0); // Top
    ctx.lineTo(width, height); // Bottom Right
    ctx.lineTo(width / 2, height * 0.7); // Inner Notch
    ctx.lineTo(0, height); // Bottom Left
    ctx.closePath();
    ctx.fill();

    // Add to map as SDF
    const imageData = ctx.getImageData(0, 0, width, height);
    if (!map.hasImage('bus-arrow')) map.addImage('bus-arrow', imageData, { sdf: true });
}

// Updated Multi-Target Connection Line Logic with Path Separation
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

        // Find connecting routes
        const originEq = new Set(getEquivalentStops(originId));
        const originRoutesSet = new Set();
        originEq.forEach(oid => {
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

                    // Iterate once to find first O followed by first T
                    let foundO = -1;
                    let foundT = -1;

                    for (let i = 0; i < p.stops.length; i++) {
                        const sId = p.stops[i].id;
                        const normId = redirectMap.get(sId) || sId;

                        if (foundO === -1 && originEq.has(normId)) {
                            foundO = i;
                        } else if (foundO !== -1 && targetEq.has(normId)) {
                            foundT = i;
                            break; // Found first T after O, stop.
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
                    if (foundO === -1 && originEq.has(normId)) {
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
                const ids = segmentStops
                    .map(s => {
                        const id = s.id || s;
                        return hubMap.get(id) || id; // Normalize to HUB
                    })
                    .filter((id, i, arr) => i === 0 || id !== arr[i - 1]) // Dedup adjacent
                    .join('|');

                if (!pathGroups.has(ids)) {
                    pathGroups.set(ids, {
                        routes: [],
                        stops: segmentStops,
                        pattern: matchedPattern
                    });
                }
                pathGroups.get(ids).routes.push(r);
            }
        });

        if (pathGroups.size === 0) return; // Skip unconnected

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

            // Geometry Logic
            let finalCoordinates = null;

            // "Actual Route" Logic
            // Prioritize fetched polyline from the pattern
            // Fix: Don't downgrade selected lines when hovering. Check if THIS target is selected.
            const isPersistent = filterManager.state.targetIds && filterManager.state.targetIds.has(targetId);

            if (isPersistent && group.pattern) {
                const bestPattern = group.pattern;
                const bestRoute = group.routes[0]; // Just need one route ID for fetching

                // Ensure we have a suffix
                if (!bestPattern.suffix && bestPattern.patternSuffix) {
                    bestPattern.suffix = bestPattern.patternSuffix;
                }

                if (bestPattern.suffix) {
                    if (bestPattern._decodedPolyline) {
                        try {
                            const sliced = slicePolyline(bestPattern._decodedPolyline, originStop, targetStop);
                            if (sliced) finalCoordinates = sliced;
                        } catch (e) {
                            console.warn('Polyline slice failed', e);
                        }
                    } else {
                        // Trigger Fetch
                        fetchAndCacheGeometry(bestRoute, bestPattern);
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

            const activeCoords = finalCoordinates || simpleCoordinates;

            // Safety: Ensure color is never null
            if (!color) {
                console.warn('[Debug] Color was null/undefined for signature:', signature, 'Using fallback.');
                color = '#888888';
            }

            features.push({
                type: 'Feature',
                geometry: {
                    type: 'LineString',
                    coordinates: activeCoords
                },
                properties: {
                    color: color,
                    lineWidth: 4,
                    opacity: 0.8
                }
            });
        });
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
        source.setData({ type: 'FeatureCollection', features: features });
    }

    // Switch to Data-Driven Styling if needed
    if (map.getLayer('filter-connection-line')) {
        map.setPaintProperty('filter-connection-line', 'line-color', ['get', 'color']);
        map.setPaintProperty('filter-connection-line', 'line-width', 4); // Fixed width or data driven
        map.setPaintProperty('filter-connection-line', 'line-opacity', 0.8);
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

function slicePolyline(points, originStop, targetStop) {
    if (!points || points.length < 2) return null;

    // Helper: Find nearest index
    const getNearestIndex = (pt) => {
        let minDist = Infinity;
        let index = -1;
        for (let i = 0; i < points.length; i++) {
            // points are [lng, lat] (from decodePolyline)
            const lng = points[i][0];
            const lat = points[i][1];

            const d = (lng - pt.lon) ** 2 + (lat - pt.lat) ** 2;
            if (d < minDist) {
                minDist = d;
                index = i;
            }
        }
        return index;
    };

    const idxOriginal = getNearestIndex(originStop);
    const idxTarget = getNearestIndex(targetStop);

    if (idxOriginal === -1 || idxTarget === -1) return null;

    // Ensure directionality (Origin -> Target)
    let segment = [];

    if (idxOriginal <= idxTarget) {
        segment = points.slice(idxOriginal, idxTarget + 1);
    } else {
        // Fallback to Spline
        return null;
    }

    // Return segments directly (already [lng, lat])
    return segment;
}

// fetchRoutePolylineV3 definition removed (moved to api.js)

async function fetchAndCacheGeometry(route, pattern) {
    if (pattern._fetchingPolyline || pattern._polyfailed) return;
    pattern._fetchingPolyline = true;

    try {
        const data = await api.fetchRoutePolylineV3(route.id, pattern.suffix);

        // console.log(`[Debug] Polyline API Response for ${route.shortName} (${pattern.suffix}):`, JSON.stringify(data));
        // Data format usually: { [suffix]: "encoded_string" } OR { [suffix]: { encodedValue: "..." } }
        let entry = data[pattern.suffix];
        let encoded = null;

        if (typeof entry === 'string') {
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

        if (typeof encoded === 'string') {
            pattern._decodedPolyline = api.decodePolyline(encoded);
            console.log(`[Debug] Polyline fetched & decoded for ${route.shortName} (${pattern.suffix}), points: ${pattern._decodedPolyline.length}`);

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

let isEditing = false;
editState = {
    stopId: null,
    overrides: {}, // { lat, lon, bearing }
    merges: []     // [id1, id2...]
};
const editSessionCache = {}; // Cache for unapplied drafts: { stopId: { overrides, parent, unmerges } }

// Map Markers for Editing
let editLocMarker = null;
let editRotMarker = null;
let editRotLine = null; // GeoJSON source for line between center and rotation handle

function initEditTools() {
    const editBtn = document.getElementById('btn-edit-stop');
    const editBlock = document.getElementById('stop-edit-block');
    const applyBtn = document.getElementById('edit-btn-apply');

    const toggleLoc = document.getElementById('edit-toggle-loc');
    const toggleRot = document.getElementById('edit-toggle-rot');
    const toggleMerge = document.getElementById('edit-toggle-merge');

    if (!editBtn || !editBlock) return;

    // Toggle Edit Mode
    editBtn.addEventListener('click', () => {
        isEditing = !isEditing;
        editBtn.classList.toggle('active', isEditing);

        // Reset toggles when closing/opening
        if (isEditing) {
            editBlock.classList.remove('hidden');
            editBlock.style.display = 'flex';
            // Initialize State
            startEditing(window.currentStopId);
        } else {
            editBlock.classList.add('hidden');
            editBlock.style.display = 'none';
            editBlock.style.display = 'none';
            stopEditing(true);
            // updateMapFilterState(); // Handled in stopEditing
        }
    });

    // Toggles
    toggleLoc.addEventListener('click', () => {
        toggleLoc.classList.toggle('active');
        if (!toggleLoc.classList.contains('active') && editState.overrides) {
            delete editState.overrides.lat;
            delete editState.overrides.lon;
        }
        updateEditMap();
        checkDirtyState();
    });

    toggleRot.addEventListener('click', () => {
        toggleRot.classList.toggle('active');
        if (!toggleRot.classList.contains('active') && editState.overrides) {
            delete editState.overrides.bearing;
        }
        updateEditMap();
        checkDirtyState();
    });

    toggleMerge.addEventListener('click', () => {
        const wasActive = toggleMerge.classList.contains('active');
        const nowActive = !wasActive;
        toggleMerge.classList.toggle('active', nowActive);

        // Disable Hub if Merge active
        if (nowActive) {
            document.getElementById('edit-toggle-hub').classList.remove('active');
            setEditPickMode('merge');
        } else {
            setEditPickMode(null);
        }
    });

    const toggleHub = document.getElementById('edit-toggle-hub');
    toggleHub.addEventListener('click', () => {
        const wasActive = toggleHub.classList.contains('active');
        const nowActive = !wasActive;
        toggleHub.classList.toggle('active', nowActive);

        // Disable Merge if Hub active
        if (nowActive) {
            toggleMerge.classList.remove('active');
            setEditPickMode('hub');
        } else {
            // Turning off defaults to null (no picker)
            setEditPickMode(null);
        }
    });

    // Apply
    applyBtn.addEventListener('click', async () => {
        await saveEditChanges();
        // Don't close, just update state.
    });
}

function startEditing(stopId) {
    if (!stopId) return;
    const stop = allStops.find(s => s.id === stopId);
    if (!stop) return;

    if (editSessionCache[stopId]) {
        console.log('[EditTools] Restoring draft for:', stopId);
        editState = {
            stopId: stopId,
            overrides: { ...editSessionCache[stopId].overrides },
            mergeParent: editSessionCache[stopId].mergeParent,
            unmerges: [...(editSessionCache[stopId].unmerges || [])],
            hubTarget: editSessionCache[stopId].hubTarget,
            unhubs: [...(editSessionCache[stopId].unhubs || [])]
        };
    } else {
        // 2. Load from Config
        editState = {
            stopId: stopId,
            overrides: {},
            mergeParent: null,
            unmerges: [],
            hubTarget: null,
            unhubs: []
        };

        if (stopsConfig?.overrides?.[stopId]) {
            editState.overrides = { ...stopsConfig.overrides[stopId] };
        }

        // Existing Hub?
        if (stopsConfig?.hubs?.[stopId]) {
            editState.hubTarget = stopsConfig.hubs[stopId];
        } else {
            // Check reverse (hubSourcesMap) to see if this stop is the Leader?
            // If I am Leader, I don't point to anyone. `hubTarget` is null.
            // But I might want to link TO someone else.
            editState.hubTarget = null;
        }
    }

    // Set toggle state based on overrides (Active = Has Override)
    const toggleLoc = document.getElementById('edit-toggle-loc');
    const toggleRot = document.getElementById('edit-toggle-rot');

    if (editState.overrides.lat || editState.overrides.lon) {
        toggleLoc.classList.add('active');
    } else {
        toggleLoc.classList.remove('active');
    }

    if (editState.overrides.bearing !== undefined) {
        toggleRot.classList.add('active');
    } else {
        toggleRot.classList.remove('active');
    }

    updateEditMergedList();
    updateEditMap();
    updateMapFilterState(); // Trigger hide of original
    checkDirtyState();
}

function stopEditing(persist = false) {
    try {
        // Persist State if requested
        if (persist && editState.stopId) {
            editSessionCache[editState.stopId] = {
                overrides: { ...editState.overrides },
                mergeParent: editState.mergeParent,
                unmerges: editState.unmerges,
                hubTarget: editState.hubTarget,
                unhubs: editState.unhubs
            };
            console.log('[EditTools] Persisted draft for:', editState.stopId);
        } else if (!persist && editState.stopId) {
            delete editSessionCache[editState.stopId];
        }
    } catch (e) {
        console.error('[EditTools] Error persisting state:', e);
    }

    // Always Reset UI
    const editBtn = document.getElementById('btn-edit-stop');
    if (editBtn) editBtn.classList.remove('active');

    const editBlock = document.getElementById('stop-edit-block');
    if (editBlock) {
        editBlock.classList.add('hidden');
        editBlock.style.display = 'none';
    }

    isEditing = false;

    // Clear Markers
    if (editLocMarker) { editLocMarker.remove(); editLocMarker = null; }
    if (editRotMarker) { editRotMarker.remove(); editRotMarker = null; }

    if (map.getSource('edit-rot-line')) {
        map.removeLayer('edit-rot-line-layer');
        map.removeSource('edit-rot-line');
    }

    // Reset Toggles
    document.querySelectorAll('.edit-chip').forEach(el => el.classList.remove('active'));
    setEditPickMode(null); // Use null to turn off

    // Clear Edit State ID so updateMapFilterState RESTORES the original marker
    editState.stopId = null;

    updateMapFilterState(); // Restore original stop visibility
}

// Rotation Handler Global Reference (need to remove listeners on cleanup)
let rotateMouseHandler = null;
let rotateUpHandler = null;

function updateEditMap() {
    const stopId = editState.stopId;
    const stopFeature = map.querySourceFeatures('stops', { filter: ['==', ['get', 'id'], stopId] })[0];
    const stop = stopFeature ? stopFeature.properties : allStops.find(s => s.id === stopId);

    if (!stop) return;

    let lat, lon;
    if (editState.overrides.lat) lat = parseFloat(editState.overrides.lat);
    if (editState.overrides.lon) lon = parseFloat(editState.overrides.lon);

    if ((isNaN(lat) || isNaN(lon)) && stopFeature && stopFeature.geometry) {
        lon = stopFeature.geometry.coordinates[0];
        lat = stopFeature.geometry.coordinates[1];
    }
    if (isNaN(lat) || isNaN(lon)) {
        lat = parseFloat(stop.lat);
        lon = parseFloat(stop.lon);
    }
    if (isNaN(lat) || isNaN(lon)) return;

    const bearing = editState.overrides.bearing !== undefined ? editState.overrides.bearing : (stop.bearing || 0);

    const toggleLoc = document.getElementById('edit-toggle-loc');
    const toggleRot = document.getElementById('edit-toggle-rot');

    // Always show the unified marker in Edit Mode
    let el;
    if (!editLocMarker) {
        el = document.createElement('div');
        el.className = 'edit-stop-marker';
        el.innerHTML = `
            <svg width="63.6" height="91.2" viewBox="0 0 53 76" fill="none" xmlns="http://www.w3.org/2000/svg">
                <circle cx="26.5" cy="49.3533" r="24.5" fill="black" stroke="white" stroke-width="4"/>
                <path d="M22.1698 4.5C24.0943 1.1667 28.9054 1.16675 30.83 4.5L35.9657 13.3945C37.8902 16.7278 35.4845 20.8944 31.6356 20.8945H21.3651C17.5161 20.8945 15.1096 16.7279 17.0341 13.3945L22.1698 4.5Z" fill="black" stroke="white" stroke-width="4"/>
            </svg>
            <div class="edit-arrow-zone" title="Drag to Rotate"></div>
            <div class="edit-body-zone" title="Drag to Move"></div>
        `;

        // Marker
        editLocMarker = new mapboxgl.Marker({
            element: el,
            draggable: true,
        })
            .setLngLat([lon, lat])
            .setRotation(bearing) // Native rotation of the DIV
            .setRotationAlignment('map') // Align to map (North) or 'viewport'? 'map' means 0 is North.
            .addTo(map);

        const arrowZone = el.querySelector('.edit-arrow-zone');

        // --- Rotation Logic ---
        arrowZone.addEventListener('mousedown', (e) => {
            e.stopPropagation(); // Prevent Drag Start (Movement)
            e.preventDefault();

            el.classList.add('rotating');
            map.dragPan.disable(); // Prevent map panning while rotating

            // Center of the marker in pixels
            const pos = map.project([lon, lat]);

            const onMouseMove = (moveEvent) => {
                const dx = moveEvent.clientX - pos.x;
                const dy = moveEvent.clientY - pos.y;
                /*
                   Mapbox Bearing: 0 = North (Up), 90 = East (Right).
                   Math.atan2(y, x): 0 = Right, -PI/2 = Up.
                   Angle differences:
                   Math 0deg = Mapbox 90
                   Math -90deg = Mapbox 0
                   Math 180deg = Mapbox 270 (-90)
                   Math 90deg = Mapbox 180
 
                   Formula: Mapbox = 90 + (Math * 180 / PI)
                */

                let rad = Math.atan2(dy, dx);
                let deg = rad * (180 / Math.PI);

                // Convert to Bearing (0 North, CW)
                // atan2(0, 1) [Right] -> 0 deg. Mapbox expect 90.
                // atan2(-1, 0) [Up] -> -90 deg. Mapbox expect 0.

                let newBearing = 90 + deg;
                if (newBearing < 0) newBearing += 360;
                if (newBearing >= 360) newBearing -= 360;

                // Snap to 15 degrees? No, smooth.
                newBearing = Math.round(newBearing);

                // Update State
                editState.overrides.bearing = newBearing;

                // LIGHT UP BUTTON
                if (toggleRot) toggleRot.classList.add('active');

                // Update Marker Visual (Immediate)
                editLocMarker.setRotation(newBearing);

                // Update Toggles Check
                checkDirtyState();
            };

            const onMouseUp = () => {
                document.removeEventListener('mousemove', onMouseMove);
                document.removeEventListener('mouseup', onMouseUp);
                el.classList.remove('rotating');
                map.dragPan.enable();
            };

            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        });

        // --- Drag Logic (Body) ---
        editLocMarker.on('drag', () => {
            const lngLat = editLocMarker.getLngLat();
            editState.overrides.lon = parseFloat(lngLat.lng.toFixed(5));
            editState.overrides.lat = parseFloat(lngLat.lat.toFixed(5));

            // LIGHT UP BUTTON
            if (toggleLoc) toggleLoc.classList.add('active');

            // Keep state consistent
            lon = lngLat.lng;
            lat = lngLat.lat;

            checkDirtyState();
        });

    } else {
        // Update Position & Rotation if it already exists
        editLocMarker.setLngLat([lon, lat]);
        editLocMarker.setRotation(bearing);
    }

    // Cleanup old artifacts if they exist (legacy safety)
    if (editRotMarker) { editRotMarker.remove(); editRotMarker = null; }
    if (map.getSource('edit-rot-line')) {
        map.removeLayer('edit-rot-line-layer');
        map.removeSource('edit-rot-line');
    }
}

function updateEditStateFromMap() {
    // Sync state if needed
}

let editPickHandler = null;

function setEditPickMode(mode) {
    // Turning off if mode is null (or falsy)
    if (!mode) {
        window.isPickModeActive = false;
        window.editPickModeType = null;
        const existing = document.getElementById('edit-pick-banner');
        if (existing) existing.remove();
        document.body.style.cursor = 'default';
        if (editPickHandler) map.off('click', 'stops-layer', editPickHandler);
        return;
    }

    // Turning on
    window.isPickModeActive = true;
    window.editPickModeType = mode; // 'merge' or 'hub'

    const banner = document.createElement('div');
    banner.id = 'edit-pick-banner';
    banner.style.cssText = `
        position: fixed; top: 20px; left: 50%; transform: translateX(-50%);
        background: ${mode === 'hub' ? '#2563eb' : '#ef4444'}; color: white; padding: 12px 24px; border-radius: 50px;
        font-weight: 600; box-shadow: 0 4px 12px rgba(0,0,0,0.2);
        z-index: 999999; cursor: pointer; display: flex; align-items: center; gap: 12px;
    `;
    const label = mode === 'hub' ? 'Select a stop to Hub with...' : 'Select a stop to merge into...';

    banner.innerHTML = `
        <span>${label}</span>
        <span style="font-size:18px; line-height:1; background:rgba(255,255,255,0.25); width:24px; height:24px; display:flex; align-items:center; justify-content:center; border-radius:50%; flex-shrink:0">×</span>
    `;

    // Remove existing
    const existing = document.getElementById('edit-pick-banner');

    // If toggling OFF (mode is null)
    if (mode === null) {
        // If we were in Hub mode, we might need cleanup specific to it
        if (window.editPickModeType === 'hub') {
            // Cleanup Hub Listeners
            if (editPickHandler) map.off('click', 'stops-layer', editPickHandler);
        }

        // General Cleanup
        window.isPickModeActive = false;
        window.editPickModeType = null;
        if (existing) existing.remove();
        document.body.style.cursor = 'default';
        if (editPickHandler) map.off('click', 'stops-layer', editPickHandler); // Redundant but safe

        // Re-open panel fully
        setSheetState(document.getElementById('info-panel'), 'half');
        return;
    }

    // Normal ON Logic
    window.isPickModeActive = true;
    window.editPickModeType = mode; // 'merge' or 'hub'

    const bannerEl = document.createElement('div');
    bannerEl.id = 'edit-pick-banner';
    bannerEl.style.cssText = `
        position: fixed; top: 0; left: 0; width: 100%; height: 60px;
        background: #3b82f6; color: white; display: flex; align-items: center; justify-content: center;
        font-weight: bold; z-index: 9999; box-shadow: 0 2px 10px rgba(0,0,0,0.2); cursor: pointer;
    `;
    bannerEl.innerHTML = mode === 'merge' ?
        'Tap a stop to MERGE this one into...' :
        'Tap stops to HUB with (Click banner to finish)';

    if (existing) existing.remove();
    document.body.appendChild(bannerEl);
    document.body.style.cursor = 'crosshair';

    // Close Panel to see map
    setSheetState(document.getElementById('info-panel'), 'collapsed');

    // Click Handler
    if (editPickHandler) map.off('click', 'stops-layer', editPickHandler);

    editPickHandler = (e) => {
        const targetFeature = e.features[0];
        if (!targetFeature) return;
        const targetId = targetFeature.properties.id;

        if (targetId === editState.stopId) {
            // alert("Cannot pick itself!"); // Annoying in multi-pick?
            return;
        }

        if (window.editPickModeType === 'merge') {
            editState.mergeParent = targetId;
            // Merge is single-shot
            setEditPickMode(null);
            document.getElementById('edit-toggle-merge').classList.remove('active');
            updateEditMergedList();
            checkDirtyState();
            setSheetState(document.getElementById('info-panel'), 'half');
        }
        else if (window.editPickModeType === 'hub') {
            // Hub is Multi-Shot Toggle
            if (!editState.hubAdds) editState.hubAdds = [];

            // Toggle logic: If already added, remove?
            // Or if already in unhubs, remove from unhubs?

            // 1. If in 'unhubs', remove it from unhubs (Re-adding existing sibling)
            if (editState.unhubs && editState.unhubs.includes(targetId)) {
                editState.unhubs = editState.unhubs.filter(id => id !== targetId);
            }
            // 2. Else check if already in hubAdds
            else if (editState.hubAdds.includes(targetId)) {
                // Remove from adds (Toggle off new selection)
                editState.hubAdds = editState.hubAdds.filter(id => id !== targetId);
            }
            // 3. Else Add
            else {
                editState.hubAdds.push(targetId);
            }

            updateEditMergedList();
            checkDirtyState();
            // Do NOT close panel or mode
        }
    };

    map.on('click', 'stops-layer', editPickHandler);

    bannerEl.addEventListener('click', () => {
        // Finishing Selection
        setEditPickMode(null);
        document.getElementById('edit-toggle-merge').classList.remove('active');
        document.getElementById('edit-toggle-hub').classList.remove('active');
        setSheetState(document.getElementById('info-panel'), 'half');
    });
}

function updateEditMergedList() {
    // Show Children
    const container = document.getElementById('edit-merged-list');
    container.innerHTML = '';

    // 1. Merged Children (I am the target, these are hidden into me)
    const mergedChildren = mergeSourcesMap.get(editState.stopId) || [];
    mergedChildren.forEach(childId => {
        const span = document.createElement('span');
        span.className = 'merge-chip';
        span.style.cssText = 'background:#e5e7eb; padding:2px 6px; border-radius:12px; display:inline-flex; align-items:center; gap:4px';
        span.innerHTML = `#${childId} <span class="del-btn" style="cursor:pointer; font-weight:bold">×</span>`;

        span.querySelector('.del-btn').addEventListener('click', () => {
            // Un-merge this child
            if (!editState.unmerges) editState.unmerges = [];
            editState.unmerges.push(childId);
            span.remove();
            checkDirtyState();
        });
        container.appendChild(span);
    });

    // 2. Hub Siblings (We are in the same Hub Group)
    // We combine:
    //  - Existing Siblings (Global Config) (Minus 'unhubs')
    //  - New Siblings (editState.hubAdds)

    const myHubId = hubMap.get(editState.stopId);
    let currentSiblings = [];

    if (myHubId) {
        const allMembers = hubSourcesMap.get(myHubId) || [];
        currentSiblings = allMembers.filter(id => id !== editState.stopId);
    }

    // Filter out unhubs
    if (editState.unhubs) {
        currentSiblings = currentSiblings.filter(id => !editState.unhubs.includes(id));
    }

    // Add new adds
    if (editState.hubAdds) {
        editState.hubAdds.forEach(id => {
            if (!currentSiblings.includes(id) && id !== editState.stopId) {
                currentSiblings.push(id);
            }
        });
    }


    if (currentSiblings.length > 0) {
        const label = document.createElement('div');
        label.style.cssText = 'font-size: 0.75rem; color: #666; margin-top: 4px; width:100%;';
        label.textContent = 'Hub Siblings:';
        container.appendChild(label);
    }

    currentSiblings.forEach(siblingId => {
        const span = document.createElement('span');
        span.style.cssText = 'background:#dbeafe; color:#1e40af; padding:2px 6px; border-radius:12px; display:inline-flex; align-items:center; gap:4px';
        const isNew = editState.hubAdds && editState.hubAdds.includes(siblingId);
        span.innerHTML = `${siblingId} ${isNew ? '<span style="font-size:0.7em; opacity:0.7">(new)</span>' : ''} <span class="del-btn" style="cursor:pointer; font-weight:bold">×</span>`;

        span.querySelector('.del-btn').addEventListener('click', () => {
            // If it was a 'hubAdd', just remove from hubAdd
            if (editState.hubAdds && editState.hubAdds.includes(siblingId)) {
                editState.hubAdds = editState.hubAdds.filter(id => id !== siblingId);
            } else {
                // It's an existing sibling, add to unhubs
                if (!editState.unhubs) editState.unhubs = [];
                editState.unhubs.push(siblingId);
            }
            // Refresh UI
            updateEditMergedList(); // Visual refresh only?
            // Need to actually remove element or re-render
            // Re-render is safer
            span.remove();
            // Actually, re-render whole list to be safe?
            // Since we manually removed span, let's just check dirty state.
            checkDirtyState();
        });
        container.appendChild(span);
    });

    // Show Pending Parent (Merge)
    if (editState.mergeParent) {
        const span = document.createElement('span');
        span.style.cssText = 'background:#fee2e2; color:#b91c1c; padding:2px 6px; border-radius:12px; display:inline-flex; align-items:center; gap:4px';
        span.innerHTML = `→ ${editState.mergeParent} <span class="del-btn" style="cursor:pointer; font-weight:bold">×</span>`;
        span.querySelector('.del-btn').addEventListener('click', () => {
            editState.mergeParent = null;
            span.remove();
            checkDirtyState();
        });
        container.appendChild(span);
    }
}

async function saveEditChanges() {
    if (!editState.stopId) return;

    const applyBtn = document.getElementById('edit-btn-apply');
    applyBtn.disabled = true;
    applyBtn.textContent = 'Saving...';

    // 1. Update Global Config PRE-SAVE (so we send the new state)
    if (!stopsConfig.overrides) stopsConfig.overrides = {};
    stopsConfig.overrides[editState.stopId] = { ...editState.overrides };

    if (!stopsConfig.merges) stopsConfig.merges = {};
    if (editState.mergeParent) {
        stopsConfig.merges[editState.stopId] = editState.mergeParent;
    } else {
        delete stopsConfig.merges[editState.stopId];
    }

    // Process Unmerges (Children removed from this parent)
    if (editState.unmerges && editState.unmerges.length > 0) {
        editState.unmerges.forEach(childId => {
            if (stopsConfig.merges[childId] === editState.stopId) {
                delete stopsConfig.merges[childId];
            }
        });
    }

    // Process Hubs (New Array Logic)
    if (!stopsConfig.hubs) stopsConfig.hubs = {};

    // A. Joining/Adding Hubs (editState.hubAdds)
    if (editState.hubAdds && editState.hubAdds.length > 0) {
        const sourceId = editState.stopId;

        // Iterate through all added targets
        editState.hubAdds.forEach(targetId => {
            // Helper to find Hub ID in current config
            const findHub = (id) => Object.keys(stopsConfig.hubs).find(k => stopsConfig.hubs[k].includes(id));

            const currentSourceHub = findHub(sourceId);
            const currentTargetHub = findHub(targetId);

            if (currentSourceHub && currentTargetHub) {
                // Merge Two Hubs
                if (currentSourceHub !== currentTargetHub) {
                    // Move target members to source
                    stopsConfig.hubs[currentTargetHub].forEach(m => {
                        if (!stopsConfig.hubs[currentSourceHub].includes(m)) {
                            stopsConfig.hubs[currentSourceHub].push(m);
                        }
                    });
                    delete stopsConfig.hubs[currentTargetHub];
                }
            } else if (currentSourceHub) {
                // Add target to source
                if (!stopsConfig.hubs[currentSourceHub].includes(targetId)) {
                    stopsConfig.hubs[currentSourceHub].push(targetId);
                }
            } else if (currentTargetHub) {
                // Add source to target
                if (!stopsConfig.hubs[currentTargetHub].includes(sourceId)) {
                    stopsConfig.hubs[currentTargetHub].push(sourceId);
                }
            } else {
                // New Hub
                const newHubId = `HUB_${sourceId.replace(/:/g, '_')}`;
                stopsConfig.hubs[newHubId] = [sourceId, targetId];
            }
        });
    }

    // B. Unhubs (Removing Sibling from My Hub) (editState.unhubs)
    // My Hub ID:
    const myHubId = hubMap.get(editState.stopId);
    if (myHubId && editState.unhubs && editState.unhubs.length > 0) {
        editState.unhubs.forEach(childId => {
            if (stopsConfig.hubs[myHubId]) {
                stopsConfig.hubs[myHubId] = stopsConfig.hubs[myHubId].filter(id => id !== childId);
                // Cleanup empty hubs?
                if (stopsConfig.hubs[myHubId].length <= 1) {
                    // Start dissolving? Or keep 1? 
                    // Keeping 1 is fine, effectively standard stop.
                    // Or delete key if empty.
                }
            }
        });
    }

    // 2. Send to Server
    try {
        const res = await fetch('/api/save-stops-config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(stopsConfig, null, 2)
        });

        if (!res.ok) throw new Error('Save failed');

        // Success UI
        applyBtn.textContent = 'Saved';
        applyBtn.classList.add('success');
        applyBtn.classList.remove('active');

        // Clear Draft
        if (editSessionCache[editState.stopId]) delete editSessionCache[editState.stopId];

        // Persist "Clean" state
        stopEditing(true);

        // REFRESH MAP LAYER with new config
        // Pass true to use the local window.stopsConfig (which we just updated)
        // rather than fetching from server (which might race)
        await refreshStopsLayer(true);

        setTimeout(() => {
            applyBtn.classList.remove('success');
            applyBtn.textContent = 'Apply';
            applyBtn.disabled = true;
            checkDirtyState();
        }, 1500);

    } catch (err) {
        console.error('Save error:', err);
        alert('Failed to save changes: ' + err.message);
        applyBtn.disabled = false;
        applyBtn.textContent = 'Apply';
    }
}

// Check if current edit state differs from saved config
function checkDirtyState() {
    const applyBtn = document.getElementById('edit-btn-apply');
    if (!applyBtn || !editState.stopId) return;

    const savedOverrides = stopsConfig?.overrides?.[editState.stopId] || {};

    const currentParent = editState.mergeParent || null;
    const savedParent = stopsConfig?.merges?.[editState.stopId] || null;

    const getVal = (v) => v === undefined || v === null ? '' : v.toString();

    // Compare loosely (string) to avoid float precision issues or type mismatches
    const latDirty = getVal(editState.overrides.lat) !== getVal(savedOverrides.lat);
    const lonDirty = getVal(editState.overrides.lon) !== getVal(savedOverrides.lon);
    const bearDirty = getVal(editState.overrides.bearing) !== getVal(savedOverrides.bearing);

    const mergeDirty = currentParent !== savedParent;
    const unmergeDirty = editState.unmerges && editState.unmerges.length > 0;

    const currentHub = editState.hubTarget || null;
    const savedHub = stopsConfig?.hubs?.[editState.stopId] || null;
    const hubDirty = currentHub !== savedHub;

    const unhubDirty = editState.unhubs && editState.unhubs.length > 0;
    const hubAddDirty = editState.hubAdds && editState.hubAdds.length > 0;

    const isDirty = latDirty || lonDirty || bearDirty || mergeDirty || unmergeDirty || unhubDirty || hubAddDirty;

    applyBtn.disabled = !isDirty;
    if (isDirty) {
        applyBtn.classList.add('active');
    } else {
        applyBtn.classList.remove('active');
    }
}

// Initialize on Load
initEditTools();

// Global Hook to open edit
window.selectDevStop = (id) => {
    // If dev tools (old) requested strict selection, we can just highlight it.
    // But since we are integrating, we ignore the old panel logic for now.
}

/* Map Menu & Simplify Logic */

