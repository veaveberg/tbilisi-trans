import './style.css';
import mapboxgl from 'mapbox-gl';
import stopBearings from './data/stop_bearings.json';
import stopsConfig from './data/stops_config.json'; // Import Config

// Configuration
const MAPBOX_TOKEN = 'pk.eyJ1IjoidHRjYXpyeSIsImEiOiJjam5sZWU2NHgxNmVnM3F0ZGN2N2lwaGF2In0.00TvUGr9Qu4Q4fc_Jb9wjw';
const API_KEY = 'c0a2f304-551a-4d08-b8df-2c53ecd57f9f';
// For local development, we use the Vite proxy.
// For production (GitHub Pages), set VITE_API_BASE_URL in your repo secrets/vars.
// Default fallback is the placeholder which requires replacement.
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || (import.meta.env.DEV
    ? '/pis-gateway/api/v2'
    : 'https://YOUR_WORKER_URL.workers.dev/pis-gateway/api/v2');

const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours

mapboxgl.accessToken = MAPBOX_TOKEN;

const map = new mapboxgl.Map({
    container: 'map',
    style: 'mapbox://styles/mapbox/streets-v12', // Standard style
    center: [44.78, 41.72], // Tbilisi center
    zoom: 12
});

// Debug: Expose map to window
window.map = map;

// Ensure map resizing handles layout changes
const resizeObserver = new ResizeObserver(() => {
    map.resize();
});
resizeObserver.observe(document.getElementById('map'));

// Force Mapbox resize on load to handle iOS safe area settling
map.on('load', () => {
    setTimeout(() => {
        map.resize();
        console.log('[Mapbox] Force resized for iOS safe area');
    }, 500); // Delay to allow browser bars to settle
});

// Extra safety for mobile orientation/bar changes
window.addEventListener('resize', () => {
    setTimeout(() => map.resize(), 100);
});

// Add Geolocate Control (Hidden, driven by custom button)
const geolocate = new mapboxgl.GeolocateControl({
    positionOptions: {
        enableHighAccuracy: true,
        timeout: 10000 // 10 seconds timeout
    },
    trackUserLocation: true,
    showUserHeading: true,
    showAccuracyCircle: true
});
map.addControl(geolocate);

// Handle Geolocate Errors (e.g., iOS HTTP restriction)
geolocate.on('error', (e) => {
    console.error('Geolocate error:', e);
    // Safe Debug Dump
    let code = 'undefined';
    let message = 'undefined';
    let errorObjCode = 'undefined';
    let errorObjMsg = 'undefined';

    if (e) {
        if ('code' in e) code = e.code;
        if ('message' in e) message = e.message;
        if (e.error) {
            if ('code' in e.error) errorObjCode = e.error.code;
            if ('message' in e.error) errorObjMsg = e.error.message;
        }
    }

    alert(`DEBUG:\nRoot Code: ${code}\nRoot Msg: ${message}\nErrObj Code: ${errorObjCode}\nErrObj Msg: ${errorObjMsg}`);

    if (code === 1 || errorObjCode === 1) { // PERMISSION_DENIED
        alert('Location permission denied via Settings.');
    } else if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
        alert('Location requires HTTPS.');
    }
});

// Custom Controls Logic
document.getElementById('zoom-in').addEventListener('click', () => map.zoomIn());
document.getElementById('zoom-out').addEventListener('click', () => map.zoomOut());

document.getElementById('locate-me').addEventListener('click', () => {
    // 1. Immediately trigger Location (Primary Action)
    // Prevent toggling off if already active
    if (!geolocate._watchState || geolocate._watchState === 'OFF' || geolocate._watchState === 'BACKGROUND') {
        geolocate.trigger();
    } else {
        // Optional: Alert or just let it toggle off (default behavior if we didn't check)
        // For now, let's just trigger it to follow standard toggle behavior if active
        // Or keep the "Prevent toggling off" logic if preferred. User didn't complain about this.
        // Let's stick to the previous "Force On" logic which serves "Locate Me" best.
        geolocate.trigger();
    }
});



// State
let allStops = [];
let allRoutes = [];
let stopToRoutesMap = new Map(); // Index: stopId -> [route objects]
let lastRouteUpdateId = 0; // Async Lock for Route Updates
// Merge/Redirect Maps
const redirectMap = new Map(); // sourceId -> targetId
const mergeSourcesMap = new Map(); // targetId -> [sourceId1, sourceId2]

// --- Navigation History ---
const historyStack = [];

function addToHistory(type, data) {
    // Don't add if it's the same as the current top
    const top = historyStack[historyStack.length - 1];
    if (top && top.type === type && top.data.id === data.id) return;

    historyStack.push({ type, data });
    updateBackButtons();
    saveToSearchHistory({ type, data });
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

// --- Filter State ---
const filterState = {
    active: false,
    picking: false,
    originId: null,
    targetIds: new Set(), // Multi-select support
    reachableStopIds: new Set(),
    filteredRoutes: [] // Array of route IDs
};

async function toggleFilterMode() {
    console.log('[Debug] toggleFilterMode called. Active:', filterState.active, 'Picking:', filterState.picking, 'CurrentStop:', window.currentStopId);

    // If already active/picking, cancel it
    if (filterState.active || filterState.picking) {
        clearFilter();
        return;
    }

    if (!window.currentStopId) {
        console.warn('[Debug] No currentStopId, cannot filter');
        return;
    }

    // Start Picking Mode
    filterState.picking = true;
    filterState.originId = window.currentStopId;

    // Filter Button UI Update
    const btn = document.getElementById('filter-routes');
    if (btn) {
        btn.classList.add('active');
        btn.querySelector('img').src = 'line.3.horizontal.decrease.circle.fill.svg';
    }

    // Show Prompt
    document.getElementById('stop-name').textContent = "Select destination stop...";

    // Camera Logic: Zoom out & Pan
    if (window.currentStopId) {
        const stop = allStops.find(s => s.id === window.currentStopId);
        if (stop) {
            const currentZoom = map.getZoom();
            const targetZoom = currentZoom > 14 ? 14 : currentZoom;

            // Calculate Pan Offset (300m in bearing direction)
            // Default bearing 0 if missing
            const bearing = (stop.bearing || 0) * (Math.PI / 180); // radians
            const distance = 300; // meters
            const R = 6371e3; // Earth radius in meters
            const lat1 = stop.lat * (Math.PI / 180);
            const lon1 = stop.lon * (Math.PI / 180);

            const lat2 = Math.asin(Math.sin(lat1) * Math.cos(distance / R) +
                Math.cos(lat1) * Math.sin(distance / R) * Math.cos(bearing));
            const lon2 = lon1 + Math.atan2(Math.sin(bearing) * Math.sin(distance / R) * Math.cos(lat1),
                Math.cos(distance / R) - Math.sin(lat1) * Math.sin(lat2));

            const targetLat = lat2 * (180 / Math.PI);
            const targetLon = lon2 * (180 / Math.PI);

            map.flyTo({
                center: [targetLon, targetLat],
                zoom: targetZoom,
                duration: 1500,
                essential: true
            });
        }
    }

    // Calculate Reachable Stops
    // 1. Get all routes passing through currentStopId
    const routes = stopToRoutesMap.get(window.currentStopId) || [];
    const reachableStopIds = new Set(); // Initialize Scope Here

    // FETCH MISSING DETAILS
    // If routes exist but don't have 'stops', we must fetch them.
    const routesNeedingFetch = routes.filter(r => !r._details || !r._details.patterns); // Check for _details and patterns

    if (routesNeedingFetch.length > 0) {
        console.log(`[Debug] Need to fetch details for ${routesNeedingFetch.length} routes...`);
        document.body.style.cursor = 'wait';

        // Show loading state on button?
        const btn = document.getElementById('filter-routes');
        if (btn) btn.style.opacity = '0.5';

        try {
            await Promise.all(routesNeedingFetch.map(async (r) => {
                try {
                    // Fetch full route object via V3 API which has patterns and stops
                    const routeDetails = await fetchRouteDetailsV3(r.id);
                    r._details = routeDetails; // Store for applyFilter

                    // DEBUG: Custom Logger
                    if (routesNeedingFetch.indexOf(r) === 0) {
                        console.log(`[Debug] V3 Route Details (${r.id}):`, routeDetails);
                        if (routeDetails?.patterns) console.log(`[Debug] Patterns:`, routeDetails.patterns.length);
                    }

                    if (routeDetails && routeDetails.patterns) {
                        // Strategy A: Stops are inside patterns
                        let foundStopsInPatterns = false;

                        routeDetails.patterns.forEach(p => {
                            if (p.stops && p.stops.length > 0) {
                                foundStopsInPatterns = true;
                                // Directional Logic: Only add stops AFTER currentStopId (Normalized)
                                // Find index of current stop (checking redirects)
                                const idx = p.stops.findIndex(s => (redirectMap.get(s.id) || s.id) === window.currentStopId);

                                if (idx !== -1 && idx < p.stops.length - 1) {
                                    p.stops.slice(idx + 1).forEach(s => {
                                        const normId = redirectMap.get(s.id) || s.id;
                                        reachableStopIds.add(normId);
                                    });
                                }
                            }
                        });

                        // Strategy B: Fetch Stops by Suffix if A failed
                        if (!foundStopsInPatterns) {
                            console.log(`[Debug] No stops in patterns for ${r.id}, fetching by suffix...`);
                            await Promise.all(routeDetails.patterns.map(async (p) => {
                                try {
                                    const stopsData = await fetchRouteStopsV3(r.id, p.patternSuffix);
                                    let stopsList = [];
                                    if (stopsData && Array.isArray(stopsData)) {
                                        stopsList = stopsData;
                                    } else if (stopsData && stopsData.stops) {
                                        stopsList = stopsData.stops;
                                    }

                                    // Store for applyFilter (mocking pattern structure)
                                    p.stops = stopsList;

                                    // Directional Logic (Normalized)
                                    const idx = stopsList.findIndex(s => (redirectMap.get(s.id) || s.id) === window.currentStopId);
                                    if (idx !== -1 && idx < stopsList.length - 1) {
                                        stopsList.slice(idx + 1).forEach(s => {
                                            const normId = redirectMap.get(s.id) || s.id;
                                            reachableStopIds.add(normId);
                                        });
                                    }
                                } catch (err) {
                                    console.warn(`[Debug] Failed to fetch stops for suffix ${p.patternSuffix}`, err);
                                }
                            }));
                        }
                    } else if (routeDetails && routeDetails.stops) {
                        // Fallback V2 style (unlikely for V3 but safety) - No directionality possible easily
                        // Just add all except current?
                        r._details.stops = routeDetails.stops; // normalize
                        routeDetails.stops.forEach(s => {
                            const normId = redirectMap.get(s.id) || s.id;
                            if (normId !== window.currentStopId) reachableStopIds.add(normId);
                        });
                    }
                } catch (e) {
                    console.warn(`[Debug] Failed to fetch details for route ${r.id}`, e);
                }
            }));
        } catch (err) {
            console.error('[Debug] Error fetching route details', err);
        } finally {
            document.body.style.cursor = 'default';
            if (btn) btn.style.opacity = '1';
        }
    }

    // Iterate over ALL routes (whether fetched or not) and calculate reachability
    // This ensures consistency and covers routes that were already cached.
    routes.forEach(r => {
        if (r._details && r._details.patterns) {
            r._details.patterns.forEach(p => {
                if (p.stops) {
                    // Normalized Find
                    const idx = p.stops.findIndex(s => (redirectMap.get(s.id) || s.id) === window.currentStopId);
                    if (idx !== -1 && idx < p.stops.length - 1) {
                        p.stops.slice(idx + 1).forEach(s => {
                            const normId = redirectMap.get(s.id) || s.id;
                            reachableStopIds.add(normId);
                        });
                    }
                }
            });
        } else if (r._details && r._details.stops) { // Fallback for V2-like structure
            r._details.stops.forEach(s => {
                const normId = redirectMap.get(s.id) || s.id;
                if (normId !== window.currentStopId) reachableStopIds.add(normId);
            });
        }
    });

    // Store Reachable Stops in State
    filterState.reachableStopIds = reachableStopIds; // Save Set

    console.log(`[Debug] Filter Mode. Origin: ${window.currentStopId}. Routes: ${routes.length}. Reachable Stops: ${reachableStopIds.size}`);

    // Debug Data Availability
    if (routes.length === 0) {
        console.warn('[Debug] stopToRoutesMap is empty. Checking fetchStopRoutes cache?');
    }

    if (reachableStopIds.size === 0) {
        alert("No route data available for filtering (Stops list empty).");
        clearFilter();
        return;
    }

    updateMapFilterState();
}

// Update Map Visuals for Filter Mode (Opacity & Z-Index)
function updateMapFilterState() {
    if (!filterState.picking && !filterState.active) {
        // Reset
        if (map.getLayer('stops-layer')) {
            map.setPaintProperty('stops-layer', 'icon-opacity', 1);
            map.setLayoutProperty('stops-layer', 'symbol-sort-key', 0);
        }
        if (map.getLayer('metro-layer-circle')) {
            map.setPaintProperty('metro-layer-circle', 'circle-opacity', 1);
            map.setPaintProperty('metro-layer-circle', 'circle-stroke-opacity', 1);
        }
        return;
    }

    const reachableArray = Array.from(filterState.reachableStopIds || []);
    const selectedArray = Array.from(filterState.targetIds || []);
    const originId = filterState.originId;

    // Merge important IDs for High Opacity
    // Reachable + Selected + Origin
    const highOpacityIds = new Set(reachableArray);
    selectedArray.forEach(id => highOpacityIds.add(id));
    if (originId) highOpacityIds.add(originId);

    // 1. Opacity Expression: Reachable/Selected = 1.0, Others = 0.1
    const opacityExpression = ['match', ['get', 'id'], Array.from(highOpacityIds), 1.0, 0.1];

    // 2. Sort Key Expression: Selected > Reachable > Others
    // This allows clicking "Highlighted" stops easily even if clustered
    // Mapbox symbol-sort-key: Higher sorts first? No, sort order ASCENDING? 
    // Docs: "Features with a higher sort key are drawn over features with a lower sort key." -> Yes, Higher = Top.
    // Selected = 1000
    // Reachable = 100
    // Origin = 500
    // Others = 0

    const sortExpression = [
        'match', ['get', 'id'],
        selectedArray, 1000, // Selected are Top Priority
        // Nested match? Or just flat list? Match takes one list.
        // We can't easily nest matches for different priorities unless we use 'case'.
        // Let's use 'case' for granular priorities.
        // ['case', condition, output, condition, output, fallback]
    ];

    // Using 'case' with 'in' operator check is cleaner logic than nested matches
    const caseExpression = [
        'case',
        ['in', ['get', 'id'], ['literal', selectedArray]], 1000,
        ['==', ['get', 'id'], originId], 900,
        ['in', ['get', 'id'], ['literal', reachableArray]], 100,
        0 // Fallback
    ];

    if (map.getLayer('stops-layer')) {
        map.setPaintProperty('stops-layer', 'icon-opacity', opacityExpression);
        map.setLayoutProperty('stops-layer', 'symbol-sort-key', caseExpression);
    }

    if (map.getLayer('metro-layer-circle')) {
        map.setPaintProperty('metro-layer-circle', 'circle-opacity', opacityExpression);
        map.setPaintProperty('metro-layer-circle', 'circle-stroke-opacity', opacityExpression);
    }
}

function applyFilter(targetId) {
    if (!filterState.picking || !filterState.originId) return;

    // Normalize Target ID
    const normTargetId = redirectMap.get(targetId) || targetId;

    // Toggle Selection
    if (filterState.targetIds.has(normTargetId)) {
        filterState.targetIds.delete(normTargetId);
    } else {
        filterState.targetIds.add(normTargetId);
    }

    console.log(`[Debug] Apply Filter. Origin: ${filterState.originId}, Targets: ${Array.from(filterState.targetIds).join(', ')}`);

    // Logic: Find routes connecting Origin to ANY of the TargetIds using Strict Check
    const originRoutes = stopToRoutesMap.get(filterState.originId) || [];

    // We want routes that pass check for AT LEAST ONE target
    const commonRoutes = originRoutes.filter(r => {
        // Check against ALL targets. If matches ANY, keep it.
        for (const tid of filterState.targetIds) {
            let matches = false;

            if (r._details && r._details.patterns) {
                matches = r._details.patterns.some(p => {
                    if (!p.stops) return false;
                    const idxO = p.stops.findIndex(s => (redirectMap.get(s.id) || s.id) === filterState.originId);
                    const idxT = p.stops.findIndex(s => (redirectMap.get(s.id) || s.id) === tid);
                    return idxO !== -1 && idxT !== -1 && idxO < idxT;
                });
            } else if (r.stops) {
                // Fallback Strict
                const stops = r.stops;
                const idxO = stops.findIndex(sid => (redirectMap.get(sid) || sid) === filterState.originId);
                const idxT = stops.findIndex(sid => (redirectMap.get(sid) || sid) === tid);
                matches = (idxO !== -1 && idxT !== -1 && idxO < idxT);
            }

            if (matches) return true; // Keep route
        }

        return false;
    });

    console.log(`[Debug] Common Routes for Union: ${commonRoutes.length}`, commonRoutes.map(r => r.shortName));

    filterState.filteredRoutes = commonRoutes.map(r => r.id);
    filterState.active = true; // Still active/picking

    // Update UI
    updateMapFilterState();

    // Refresh Panel List if we are still viewing the origin stop
    if (window.currentStopId === filterState.originId) {
        console.log('[Debug] ApplyFilter: Attempting to refresh arrivals list...');
        // Re-fetch arrivals / refresh UI
        if (window.lastArrivals) {
            console.log(`[Debug] Using cached lastArrivals: ${window.lastArrivals.length}`);
            renderArrivals(window.lastArrivals, filterState.originId);

            // Also refresh All Routes Header
            if (window.lastRoutes) {
                renderAllRoutes(window.lastRoutes, window.lastArrivals);
            }
        } else {
            console.warn('[Debug] No window.lastArrivals found. Triggering full fetch.');
            // Fallback: trigger showStopInfo refresh logic (without network if possible, but safe to just refresh)
            const stop = allStops.find(s => s.id === filterState.originId);
            if (stop) showStopInfo(stop, false, false);
        }
    }

    // Highlight Targets on Map & Draw Lines
    updateConnectionLine(filterState.originId, filterState.targetIds, false);
}

function clearFilter() {
    filterState.active = false;
    filterState.picking = false;
    filterState.originId = null;
    filterState.targetIds = new Set(); // Reset Set
    filterState.filteredRoutes = [];

    // Clear Connection Line
    if (map.getSource('filter-connection')) {
        map.getSource('filter-connection').setData({ type: 'FeatureCollection', features: [] });
    }

    // Reset UI
    const btn = document.getElementById('filter-routes');
    if (btn) {
        btn.classList.remove('active');
        // Use relative path (Vite/Base path safe) or imported asset
        // If file is in public, relative to root without leading slash works if base is set, 
        // OR use leading slash if we assume base is handled. 
        // Actually, for GH pages with base '/repo/', '/file.svg' goes to host root. 
        // 'file.svg' or './file.svg' is safer.
        btn.querySelector('img').src = 'line.3.horizontal.decrease.circle.svg';
    }

    // Reset Map
    if (map.getLayer('stops-layer')) map.setPaintProperty('stops-layer', 'icon-opacity', 1);
    if (map.getLayer('metro-layer-circle')) {
        map.setPaintProperty('metro-layer-circle', 'circle-opacity', 1);
        map.setPaintProperty('metro-layer-circle', 'circle-stroke-opacity', 1);
    }

    // Refresh view
    if (window.currentStopId) {
        const stop = allStops.find(s => s.id === window.currentStopId);
        if (stop) showStopInfo(stop, false, false);
    }
}

// Back Button Listeners
document.getElementById('back-panel').addEventListener('click', handleBack);
document.getElementById('back-route-info').addEventListener('click', handleBack);

// --- Search History ---
function saveToSearchHistory(item) {
    let history = JSON.parse(localStorage.getItem('search_history') || '[]');
    // Remove duplicates
    history = history.filter(h => !(h.type === item.type && h.data.id === item.data.id));
    // Add to top
    history.unshift(item);
    // Limit to 10
    if (history.length > 10) history.pop();
    localStorage.setItem('search_history', JSON.stringify(history));
}

function getSearchHistory() {
    return JSON.parse(localStorage.getItem('search_history') || '[]');
}

// Initialize map data
map.on('load', async () => {
    try {
        const [rawStops, routes] = await Promise.all([fetchStops(), fetchRoutes()]);

        // --- Process Stops (Overrides & Merges) ---
        // 1. Apply Overrides & Build Redirects
        const stops = [];
        const overrides = stopsConfig?.overrides || {};
        const merges = stopsConfig?.merges || {};

        // Build merge mappings
        Object.keys(merges).forEach(source => {
            const target = merges[source];
            redirectMap.set(source, target);
            if (!mergeSourcesMap.has(target)) mergeSourcesMap.set(target, []);
            mergeSourcesMap.get(target).push(source);
        });

        // Filter and Override
        rawStops.forEach(stop => {
            // If this stop is merged INTO another, skip adding it to map list
            if (merges[stop.id]) return;

            // Apply Override if exists
            if (overrides[stop.id]) {
                Object.assign(stop, overrides[stop.id]);
            }

            stops.push(stop);
        });
        // For debugging: Bypass processing
        // rawStops.forEach(s => stops.push(s));

        console.log(`Processed Stops: ${rawStops.length} -> ${stops.length} (Merged/Filtered)`);

        allStops = stops;
        allRoutes = routes;
        window.allStops = allStops; // Debug: Expose to window
        window.stopsConfig = stopsConfig; // Debug

        // Index Routes by Stop ID (for "All Routes" list)
        allRoutes.forEach(route => {
            if (route.stops) {
                route.stops.forEach(stopId => {
                    // If stopId is a merged source, map it to target
                    const targetId = redirectMap.get(stopId) || stopId;

                    if (!stopToRoutesMap.has(targetId)) {
                        stopToRoutesMap.set(targetId, []);
                    }
                    // Avoid dupes
                    if (!stopToRoutesMap.get(targetId).includes(route)) {
                        stopToRoutesMap.get(targetId).push(route);
                    }
                });
            }
        });

        // Initialize Search & Layers
        setupSearch();
        addStopsToMap(stops);

        // Load custom icons (SDF for coloring)
        await loadImages(map);

        // Remove loading state once map and data are ready
        document.body.classList.remove('loading');

        // Fix for Safari/Mobile (Force resize to account for dynamic address bar)
        setTimeout(() => map.resize(), 100);

        // --- Dev Tools Support ---
        if (import.meta.env.DEV) {
            import('./dev-tools.js').then(module => module.initDevTools(map));
        }

    } catch (error) {
        console.error('Error initializing app:', error);
        // Ensure UI is revealed even on error
        document.body.classList.remove('loading');
        alert(`Error plotting route: ${error.message}`);
    }


    // Load Bus Icon (Simple Arrow)
    const arrowImage = new Image(24, 24);
    arrowImage.onload = () => map.addImage('bus-arrow', arrowImage);
    // Create a simple arrow SVG as a data URI
    const svg = `
    <svg width="24" height="24" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
        <path d="M12 2L4.5 20.29L5.21 21L12 18L18.79 21L19.5 20.29L12 2Z" fill="#ef4444"/>
    </svg>`;
    arrowImage.onload = () => {
        map.addImage('bus-arrow', arrowImage, { sdf: true }); // enable SDF for coloring
    };

    // Load Transfer Station Icon (Half Red / Half Green)
    const transferSvg = `
    <svg width="32" height="32" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">
        <circle cx="16" cy="16" r="14" fill="#ef4444" /> <!-- Red Base -->
        <path d="M16 2 A14 14 0 0 1 16 30 L16 2 Z" fill="#22c55e" /> <!-- Green Right Half -->
        <circle cx="16" cy="16" r="14" fill="none" stroke="white" stroke-width="4"/> <!-- White border to match others -->
    </svg>`;
    const transferImage = new Image(32, 32);
    transferImage.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(transferSvg);
    transferImage.onload = () => map.addImage('station-transfer', transferImage);

    // Selected Stop Source
    map.addSource('selected-stop', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
    });

    // Stop Selection State Layer (more prominent)
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
                ['>', ['get', 'bearing'], 0], 1.2, // Arrow fixed scale
                1.5 // Circle fixed scale (Big)
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
});

async function fetchWithCache(url, options = {}) {
    const cacheKey = `cache_${url}`;
    const now = Date.now();
    const cached = localStorage.getItem(cacheKey);

    if (cached) {
        try {
            const { timestamp, data } = JSON.parse(cached);
            if (now - timestamp < CACHE_DURATION) {
                console.log(`[Cache] Hit: ${url}`);
                return data;
            } else {
                console.log(`[Cache] Expired: ${url}`);
                localStorage.removeItem(cacheKey);
            }
        } catch (e) {
            console.error('[Cache] Error parsing cache:', e);
            localStorage.removeItem(cacheKey);
        }
    }

    console.log(`[Cache] Miss: ${url}`);

    // Merge options with credentials: 'omit' to avoid sending problematic cookies
    const fetchOptions = { ...options, credentials: 'omit' };

    const response = await fetch(url, fetchOptions);
    if (!response.ok) throw new Error('Network response was not ok');
    const data = await response.json();

    try {
        localStorage.setItem(cacheKey, JSON.stringify({ timestamp: now, data }));
    } catch (e) {
        console.warn('[Cache] Failed to set item (likely quota exceeded):', e);
    }

    return data;
}

async function fetchStopRoutes(stopId) {
    // Try raw ID first as seen in HAR/Curl (e.g. "1:1000")
    // Some APIs handle encoded vs unencoded differently.
    return await fetchWithCache(`${API_BASE_URL}/stops/${stopId}/routes?locale=en`, {
        headers: { 'x-api-key': API_KEY }
    });
}

async function fetchStops() {
    return await fetchWithCache(`${API_BASE_URL}/stops`, {
        headers: { 'x-api-key': API_KEY }
    });
}


async function fetchRoutes() {
    return await fetchWithCache(`${API_BASE_URL}/routes`, {
        headers: { 'x-api-key': API_KEY }
    });
}

async function fetchMetroSchedule(routeId) {
    // Metro Schedule API is V3
    // URL: https://transit.ttc.com.ge/pis-gateway/api/v3/routes/${routeId}/schedule?patternSuffix=0:01&locale=ka
    // We use the proxy which points to /pis-gateway/api/v2 usually, but let's check if we can reach v3.
    // The proxy might map /pis-gateway/api/* -> target/pis-gateway/api/*.
    // Let's assume the proxy works for v3 if we change the path slightly or use absolute if needed.
    // However, the worker proxy likely forwards the whole path.
    // Our API_BASE_URL is .../api/v2. We need .../api/v3.
    const v3Base = API_BASE_URL.replace('/v2', '/v3');
    return await fetchWithCache(`${v3Base}/routes/${routeId}/schedule?patternSuffix=0:01&locale=en`, {
        headers: { 'x-api-key': API_KEY }
    });
}

async function fetchMetroSchedulePattern(routeId, patternSuffix) {
    const v3Base = API_BASE_URL.replace('/v2', '/v3');
    return await fetchWithCache(`${v3Base}/routes/${routeId}/schedule?patternSuffix=${patternSuffix}&locale=en`, {
        headers: { 'x-api-key': API_KEY }
    });
}



const GREEN_LINE_STOPS = [
    'State University', 'University', 'Univercity', 'Vazha-Pshavela', 'Vazha Pshavela', 'Delisi', 'Medical University', 'Technical University', 'Tsereteli', 'Station Square 2'
];

function addStopsToMap(stops) {
    // Cleanup existing layers/sources if they exist (idempotency)
    const layers = ['metro-layer-label', 'metro-layer-circle', 'metro-transfer-layer', 'metro-lines-layer', 'stops-layer'];
    const sources = ['metro-stops', 'metro-lines-manual', 'stops'];

    layers.forEach(id => {
        if (map.getLayer(id)) map.removeLayer(id);
    });
    sources.forEach(id => {
        if (map.getSource(id)) map.removeSource(id);
    });

    // Separate Metro from Bus/Other
    const metroStops = stops.filter(s => s.code && (s.code.length === 0 || !s.code.match(/^\d+$/)) && (s.name.includes('Station') || s.vehicleMode === 'SUBWAY')); // Approximation if mode is missing
    // Better approximation: The API usually returns vehicleMode='SUBWAY' or empty code for metro. 
    // Let's rely on vehicleMode if available, or name heuristic.

    // Actually, checking the raw data, metro stops often have NO code or a non-numeric ID.
    // Let's assume input 'stops' has vehicleMode.

    const busStops = [];
    const metroFeatures = [];
    const seenMetroNames = new Set();

    stops.forEach(stop => {
        // Inject Bearing: Prioritize Override, then Default Config, then 0
        if (stop.bearing === undefined) {
            stop.bearing = stopBearings[stop.id] || 0;
        }

        const isMetro = stop.vehicleMode === 'SUBWAY' || stop.name.includes('Metro Station') || (stop.id && stop.id.startsWith('M:'));

        if (isMetro) {
            // Clean Name
            let displayName = stop.name
                .replace('M/S', '')
                .replace('Metro Station', '')
                .replace('Station Square 1', 'Station Square')
                .replace('Station Square 2', 'Station Square')
                .replace('Univercity', 'University') // Fix API Typo
                .replace('Technacal', 'Technical') // Fix API Typo
                .replace('Techinacal', 'Technical') // Fix API Typo 2
                .replace('Grmaghele', 'Ghrmaghele') // Standardize
                .replace('Sarajisvhili', 'Sarajishvili') // Fix API/User Typo
                .replace('Saradjishvili', 'Sarajishvili') // Fix Variant
                .trim();

            // Deduplicate: If we already have this metro station, skip it
            if (seenMetroNames.has(displayName)) return;
            seenMetroNames.add(displayName);

            // Determine Color (check original or cleaned name)
            // Green Line Check
            let color = '#ef4444'; // Red Line Default
            if (GREEN_LINE_STOPS.some(n => stop.name.includes(n) || displayName.includes(n))) {
                color = '#22c55e'; // Green Line
            }

            // Correction: Technical University is Green. API might have typo "Univercity"
            if (displayName.includes('Technical University') || stop.name.includes('Technical Univercity')) {
                color = '#22c55e';
            }

            // Correction: Vazha-Pshavela is Green
            if (displayName.includes('Vazha-Pshavela')) color = '#22c55e';
            // Correction: Tsereteli is Green
            if (displayName.includes('Tsereteli')) color = '#22c55e';

            // Correction: Gotsiridze/Nadzaladevi are Red (Default)

            metroFeatures.push({
                type: 'Feature',
                geometry: {
                    type: 'Point',
                    coordinates: [stop.lon, stop.lat]
                },
                properties: {
                    id: stop.id,
                    name: displayName,
                    code: stop.code,
                    mode: 'SUBWAY',
                    color: color
                }
            });
        } else {
            busStops.push({
                type: 'Feature',
                geometry: {
                    type: 'Point',
                    coordinates: [stop.lon, stop.lat]
                },
                properties: {
                    id: stop.id,
                    name: stop.name,
                    code: stop.code,
                    mode: stop.vehicleMode || 'BUS',
                    bearing: stop.bearing // Already resolved
                }
            });
        }
    });

    // --- Generate Metro Lines (Manual) ---
    // We need to find the coordinates for each station in order.
    // Order matters!
    const RED_LINE_ORDER = [
        'Varketili', 'Samgori', 'Isani', 'Aviabar', '300 Aragveli', 'Avlabari', 'Liberty Square', 'Rustaveli', 'Marjanishvili', 'Station Square', 'Nadzaladevi', 'Gotsiridze', 'Didube', 'Ghrmaghele', 'Guramishvili', 'Sarajishvili', 'Akhmeteli Theatre'
    ];
    // Note: 'Aviabar' might be a typo or alias for Avlabari/300ish? 'Avlabari' is there. '300 Aragveli'.
    // Let's stick to known major stations using fuzzy match.
    // Cleaned names: 'Varketili', 'Samgori', 'Isani', '300 Aragveli', 'Avlabari', 'Liberty Square', 'Rustaveli', 'Marjanishvili', 'Station Square', 'Nadzaladevi', 'Gotsiridze', 'Didube', 'Ghrmaghele', 'Guramishvili', 'Sarajishvili', 'Akhmeteli Theatre'

    const GREEN_LINE_ORDER = [
        'State University', 'Vazha-Pshavela', 'Delisi', 'Medical University', 'Technical University', 'Tsereteli', 'Station Square'
    ];
    // Station Square is the transfer point.

    function getLineCoordinates(orderList, features) {
        const coords = [];
        orderList.forEach(name => {
            const f = features.find(feat => feat.properties.name.includes(name) || name.includes(feat.properties.name));
            if (f) coords.push(f.geometry.coordinates);
        });
        // smooth the line
        return getSpline(coords);
    }

    // Catmull-Rom Spline Interpolation for smooth curves
    function getSpline(points, tension = 0.25, numOfSegments = 16) {
        if (points.length < 2) return points;

        let res = [];
        const _points = points.slice();
        _points.unshift(points[0]);
        _points.push(points[points.length - 1]);

        for (let i = 1; i < _points.length - 2; i++) {
            const p0 = _points[i - 1];
            const p1 = _points[i];
            const p2 = _points[i + 1];
            const p3 = _points[i + 2];

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

    const redLineCoords = getLineCoordinates(RED_LINE_ORDER, metroFeatures);
    const greenLineCoords = getLineCoordinates(GREEN_LINE_ORDER, metroFeatures);



    // 1. Bus Source & Layer (Existing code follows...)


    // 1. Bus Source & Layer
    if (!map.getSource('stops')) {
        map.addSource('stops', {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: busStops },
            cluster: false
        });
    }

    if (!map.getLayer('stops-layer')) {
        map.addLayer({
            id: 'stops-layer',
            type: 'symbol',
            source: 'stops',
            layout: {
                'icon-image': [
                    'step',
                    ['zoom'],
                    'stop-far-away-icon', // < 14
                    14, 'stop-icon',      // 14-16.5
                    16.5, [               // >= 16.5
                        'case',
                        ['==', ['get', 'bearing'], 0],
                        'stop-icon',      // Bearing 0 -> Circle
                        'stop-close-up-icon' // Bearing !0 -> Directional
                    ]
                ],
                'icon-size': [
                    'interpolate',
                    ['linear'],
                    ['zoom'],
                    10, 0.4,   // Visible at zoom 10
                    13, 0.5,
                    14, 0.8,
                    16, 1
                ],
                // Rotation Logic: 0 until 16.5, then follow bearing.
                'icon-rotate': [
                    'step',
                    ['zoom'],
                    0,       // Default (zoom < 16.5)
                    16.5, ['get', 'bearing'] // Zoom >= 16.5
                ],
                'icon-rotation-alignment': 'map', // Fixed to map (North relative)
                'icon-allow-overlap': true,
                'icon-ignore-placement': false
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
    map.on('mousemove', 'stops-layer', (e) => {
        if (filterState.picking) {
            const hoveredStop = e.features[0].properties;
            const normId = redirectMap.get(hoveredStop.id) || hoveredStop.id;

            if (normId !== filterState.originId) {
                // Pass Current Selection + Hover ID
                updateConnectionLine(filterState.originId, filterState.targetIds, true, normId);
            }
        }
    });

    map.on('mouseleave', 'stops-layer', () => {
        if (filterState.picking) {
            // Revert to just the selected lines (remove hover line)
            // Pass false for isHover
            updateConnectionLine(filterState.originId, filterState.targetIds, false);
        }
    });

    // --- Insert Metro Lines HERE ---
    // Now that stops-layer exists, we can put metro-lines UNDER it.
    if (!map.getSource('metro-lines-manual')) {
        map.addSource('metro-lines-manual', {
            type: 'geojson',
            data: {
                type: 'FeatureCollection',
                features: [
                    {
                        type: 'Feature',
                        properties: { color: '#ef4444' }, // Red
                        geometry: { type: 'LineString', coordinates: redLineCoords }
                    },
                    {
                        type: 'Feature',
                        properties: { color: '#22c55e' }, // Green
                        geometry: { type: 'LineString', coordinates: greenLineCoords }
                    }
                ]
            }
        });
    }

    if (!map.getLayer('metro-lines-layer')) {
        map.addLayer({
            id: 'metro-lines-layer',
            type: 'line',
            source: 'metro-lines-manual',
            layout: {
                'line-join': 'round',
                'line-cap': 'round'
            },
            paint: {
                'line-color': ['get', 'color'],
                'line-width': 8,
                'line-opacity': 0.3
            }
        }); // Add on top for now, we will reorder it when stops-layer exists
    }

    // 2. Metro Source & Layers (Dots)
    if (!map.getSource('metro-stops')) {
        map.addSource('metro-stops', {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: metroFeatures }
        });
    }


    // Metro Circles (Big & Colored) - Exclude Station Square
    if (!map.getLayer('metro-layer-circle')) {
        map.addLayer({
            id: 'metro-layer-circle',
            type: 'circle',
            source: 'metro-stops',
            filter: ['!=', 'name', 'Station Square'],
            paint: {
                'circle-color': ['get', 'color'],
                'circle-radius': [
                    'interpolate',
                    ['linear'],
                    ['zoom'],
                    10, 4,
                    14, 10,
                    16, 14
                ],
                'circle-stroke-width': 2,
                'circle-stroke-color': '#fff'
            }
        });
    }

    // Metro Transfer Station (Station Square only)
    if (!map.getLayer('metro-transfer-layer')) {
        map.addLayer({
            id: 'metro-transfer-layer',
            type: 'symbol',
            source: 'metro-stops',
            filter: ['==', 'name', 'Station Square'],
            layout: {
                'icon-image': 'station-transfer',
                'icon-allow-overlap': true,
                'icon-size': [
                    'interpolate',
                    ['linear'],
                    ['zoom'],
                    10, 0.4,
                    14, 0.8,
                    16, 1.0
                ]
            }
        });
    }

    // Metro Labels (Visible Zoom 13+, closer to circles)
    if (!map.getLayer('metro-layer-label')) {
        map.addLayer({
            id: 'metro-layer-label',
            type: 'symbol',
            source: 'metro-stops',
            minzoom: 13,  // More zoomed in before showing
            layout: {
                'text-field': ['get', 'name'],
                'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
                'text-size': 12,
                'text-offset': [0, 1.0], // Closer to circle (was 1.5)
                'text-anchor': 'top',
                'text-allow-overlap': false,
                'text-ignore-placement': false
            },
            paint: {
                'text-color': '#333333',
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
    if (window.ignoreMapClicks) {
        console.log('[Debug] Map Click Ignored (Lock Active)');
        return;
    }

    const props = e.features[0].properties;

    // FILTER PICKING MODE
    if (filterState.picking) {
        applyFilter(props.id);
        return;
    }

    const coordinates = e.features[0].geometry.coordinates.slice();

    // Keep global track of selected stop ID
    window.currentStopId = props.id;
    if (window.selectDevStop) window.selectDevStop(props.id);

    // Smart Zoom: Don't zoom out if already close
    const currentZoom = map.getZoom();
    const targetZoom = currentZoom > 16 ? currentZoom : 16;

    map.flyTo({
        center: coordinates,
        zoom: targetZoom
    });

    // Set selected stop data
    const feature = {
        type: 'Feature',
        geometry: e.features[0].geometry,
        properties: props
    };
    map.getSource('selected-stop').setData({
        type: 'FeatureCollection',
        features: [feature]
    });

    // Inject coordinates into props for History/Back navigation usage
    const stopData = { ...props, lat: coordinates[1], lon: coordinates[0] };

    showStopInfo(stopData, true, false); // Don't fly again inside showStopInfo
});

// Metro Click Handlers (Same logic as stops-layer)
const metroLayers = ['metro-layer-circle', 'metro-layer-label', 'metro-transfer-layer'];
metroLayers.forEach(layerId => {
    map.on('click', layerId, async (e) => {
        const props = e.features[0].properties;

        // FILTER PICKING MODE
        if (filterState.picking) {
            applyFilter(props.id);
            return;
        }

        const coordinates = e.features[0].geometry.coordinates.slice();

        // Keep global track of selected stop ID
        window.currentStopId = props.id;
        if (window.selectDevStop) window.selectDevStop(props.id);

        // Smart Zoom: Don't zoom out if already close
        const currentZoom = map.getZoom();
        const targetZoom = currentZoom > 16 ? currentZoom : 16;

        map.flyTo({
            center: coordinates,
            zoom: targetZoom
        });

        // Set selected stop data (for highlight source if we want to use it, though metro circles are already highlighted by design usually)
        // But for consistency/logic:
        const feature = {
            type: 'Feature',
            geometry: e.features[0].geometry,
            properties: props
        };
        // We might want to clear "selected-stop" (bus highlight ring) if it looks weird on metro
        // Or reuse it? Metro circles are big. Bus highlight is a ring.
        // Let's reuse it for now.
        map.getSource('selected-stop').setData({
            type: 'FeatureCollection',
            features: [feature]
        });

        // Inject coordinates into props for History/Back navigation usage
        const stopData = { ...props, lat: coordinates[1], lon: coordinates[0] };

        showStopInfo(stopData, true, false);
    });

    // Add pointer cursor
    map.on('mouseenter', layerId, () => {
        map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', layerId, () => {
        map.getCanvas().style.cursor = '';
    });
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
            if (e.deltaY > 0) { // Scroll Down (pull) -> Expand
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

    // Selected Stop Highlight - ALWAYS KEEP OPAQUE
    if (map.getLayer('stops-highlight')) {
        map.setPaintProperty('stops-highlight', 'icon-opacity', 1.0);
    }
}

async function showStopInfo(stop, addToStack = true, flyToStop = false) {
    // Enable Focus Mode (Dim others)
    setMapFocus(true);

    if (addToStack) addToHistory('stop', stop);

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
            // 1. Saved Persistence (Back Button)
            if (stop.savedZoom) {
                map.flyTo({ center: [stop.lon, stop.lat], zoom: stop.savedZoom });
            }
            // 2. Smart Zoom (Click)
            else {
                const currentZoom = map.getZoom();
                const targetZoom = currentZoom > 16 ? currentZoom : 16;
                map.flyTo({ center: [stop.lon, stop.lat], zoom: targetZoom });
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
                console.error('[Debug] Source selected-stop NOT found!');
            }
        } else {
            console.error('[Debug] Stop missing coords:', stop);
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
    const isMetro = stop.mode === 'SUBWAY' || (stop.id && stop.id.startsWith('1:metro'));

    if (isMetro) {
        panel.classList.add('metro-mode');
        // --- Metro Display Logic ---
        setSheetState(panel, 'half'); // Open panel immediately
        updateBackButtons();

        nameEl.textContent = stop.name.replace('M/S', '').replace('Metro Station', '').trim() || 'Metro Station';

        // Add Open Hours Badge
        const headerContainer = document.createElement('div');
        headerContainer.className = 'metro-header';
        headerContainer.innerHTML = `
            <div class="metro-hours-badge">
                <span class="icon">🕒</span> Entrance open 6:00 – 0:00
            </div>
        `;
        // Insert after name
        const existingHeader = panel.querySelector('.metro-header');
        if (existingHeader) existingHeader.remove();
        nameEl.parentNode.insertBefore(headerContainer, nameEl.nextSibling);

        listEl.innerHTML = '<div class="loading">Loading metro schedule...</div>';

        // Clean up any old "All Routes" container if switching from bus stop
        const oldContainer = panel.querySelector('.all-routes-container');
        if (oldContainer) oldContainer.remove();

        try {
            // Identify Route ID for this station
            // Iterate allRoutes to find which route stops here.
            // Metro IDs usually start with "1:Metro" or similar.
            let metroRoutes = [];
            // Try to use the stopToRoutesMap if populated, otherwise search
            if (stopToRoutesMap.has(stop.id)) {
                metroRoutes = stopToRoutesMap.get(stop.id);
            } else {
                metroRoutes = allRoutes.filter(r => r.mode === 'SUBWAY');
            }

            if (metroRoutes.length === 0) {
                // If ID-based lookup failed (common for transfer stations where we only have one ID but need both routes),
                // OR if we intentionally want to find ALL routes for this station name (handling Station Square case).

                // Strategy: Iterate ALL subway routes. For each route, check if it has a stop with a matching NAME.
                metroRoutes = [];
                const subwayRoutes = allRoutes.filter(r => r.mode === 'SUBWAY');

                // We need to check if these routes actually stop at "Station Square" (or whatever the current stop name is).
                // We don't have the full stop list for every route in memory unless we fetch it or iterate 'stopToRoutesMap' widely?
                // 'allRoutes' just has id/shortName/longName usually.

                // BUT, for Metro, we know there are only ~2 lines. 
                // Let's just include ALL subway routes if the station is "Station Square".
                // Or better: Assume if it's a metro station, we should check all metro routes.

                // Let's verify each route against the Station Name. 
                // We don't have the stops for each route readily available to check purely by name without async fetch?
                // Wait, 'stopToRoutesMap' is built from 'allStops'.
                // If 'Station Square 1' and 'Station Square 2' were in 'allStops', they should be in the map.
                // But we might be clicking on a feature that has only ONE of the IDs.

                // Fix: Search stopToRoutesMap for ANY key that matches our name? No, keys are IDs.
                // Fix: Search `allStops` for stops with similar name, get their IDs, then get routes?

                const targetName = stop.name.replace('M/S', '').replace('Metro Station', '').replace(/[12]$/, '').trim();

                // Find ALL stop IDs that match this name (fuzzy)
                // We need access to 'allStops' (global variable?) or we assume we can just fetch all metro routes.

                // Simple approach for Station Square:
                if (targetName.includes('Station Square')) {
                    metroRoutes = subwayRoutes; // Show both lines
                } else {
                    // For others, default to all subway routes? 
                    // No, don't show Green line for Deep Red line stations.
                    // But we are about to FILTER logic inside the loop anyway?
                    // The loop: "Process EACH route... 1. Get Route Details ... 2. Results.forEach... if(!scheduleGroup) return... matchingStops..."

                    // If we include a route that DOESN'T serve this station, the inner loop (matchingStops) will essentially yield nothing.
                    // So it is SAFE to pass ALL metro routes into the processing loop!
                    // The processing loop fetches schedule and checks `scheduleGroup.stops.filter(...)`.
                    // If the stop isn't in that route's schedule, it won't display anything.

                    metroRoutes = subwayRoutes;
                }
            }

            if (metroRoutes.length > 0) {
                // Sort Routes: Line 1 (Red) first, then Line 2 (Green)
                metroRoutes.sort((a, b) => (parseInt(a.shortName) || 0) - (parseInt(b.shortName) || 0));

                let arrivalHTML = '';
                // let firstLastHTML = ''; // No longer used separately

                const dayOfWeek = new Date().getDay(); // 0 = Sunday, 6 = Saturday
                const isWeekend = (dayOfWeek === 0 || dayOfWeek === 6);
                const dayType = isWeekend ? 'SATURDAY' : 'MONDAY';
                const currentMinutes = new Date().getHours() * 60 + new Date().getMinutes();

                // Process EACH route (for transfer stations like Station Square)
                for (const route of metroRoutes) {
                    try {
                        // 1. Get Route Details to find patterns (directions)
                        const routeDetails = await fetchRouteDetailsV3(route.id);
                        const patterns = routeDetails.patterns || [];

                        // 2. Fetch Schedule for EACH pattern to cover both directions
                        // We need to fetch schedule for specific pattern suffix to get that direction's data?
                        // The previous API call was .../schedule?patternSuffix=0:01
                        // We should iterate patterns and fetch schedule for each.

                        // Optimization: Fetch in parallel
                        const patternPromises = patterns.map(p =>
                            fetchMetroSchedulePattern(route.id, p.patternSuffix).then(data => ({
                                pattern: p,
                                data: data
                            }))
                        );

                        const results = await Promise.all(patternPromises);

                        results.forEach(({ pattern, data }) => {
                            if (!data) return;

                            const scheduleGroup = data.find(g => g.fromDay === dayType) || data[0];
                            if (!scheduleGroup) return;

                            // Find stops for this station
                            // Note: Use fuzzy match or ID match. 
                            // Match if IDs match OR if names match (checking normalized names)
                            const targetName = stop.name.replace('M/S', '').replace('Metro Station', '').replace(/[12]$/, '').trim();

                            const matchingStops = scheduleGroup.stops.filter(s => {
                                if (s.id === stop.id) return true;
                                const sName = s.name.replace('M/S', '').replace('Metro Station', '').replace(/[12]$/, '').trim();
                                return sName === targetName || sName.includes(targetName) || targetName.includes(sName);
                            });

                            matchingStops.forEach(s => {
                                const times = s.arrivalTimes.split(',');
                                if (!times || times.length === 0) return;

                                const firstTrain = times[0];
                                const lastTrain = times[times.length - 1];

                                const upcoming = [];
                                for (const t of times) {
                                    const [h, m] = t.split(':').map(Number);
                                    let timeMins = h * 60 + m;
                                    if (h < 4) timeMins += 24 * 60; // Handle post-midnight (00:xx, 01:xx) as next day relative to 6am start? 
                                    // Actually, if current is 23:00 and train is 00:10, timeMins needs adjustment?
                                    // Let's keep simple comparison. If timeMins >= currentMinutes. 
                                    // What if current is 23:55 and train is 00:05? 
                                    // 00:05 is 5 mins. 23:55 is 1435 mins.
                                    // 5 < 1435. Won't show.
                                    // We should normalize "service day". 
                                    // Metro likely operates 06:00 to 24:00+ (00:xx).
                                    // Treat 00:00-03:00 as 24:00-27:00.

                                    let cmpTime = timeMins;
                                    if (h < 4) cmpTime += 24 * 60; // Extend night
                                    let cmpCurrent = currentMinutes;
                                    if (new Date().getHours() < 4) cmpCurrent += 24 * 60;

                                    if (cmpTime >= cmpCurrent) {
                                        upcoming.push({ time: t, diff: cmpTime - cmpCurrent });
                                        if (upcoming.length >= 3) break;
                                    }
                                }

                                // Build UI
                                // Clean Headsign: "Station Square 2" -> "Station Square"
                                let headsign = pattern.headsign || "Unknown Direction";
                                headsign = headsign.replace(/ [12]$/, '').trim(); // Remove trailing " 1", " 2"

                                // Check if this is the terminus (Destination == Current Station)
                                // First normalize current stop name
                                const currentStopName = stop.name.replace('M/S', '').replace('Metro Station', '').replace(/[12]$/, '').trim();
                                if (headsign === currentStopName || headsign.includes(currentStopName) || currentStopName.includes(headsign)) {
                                    headsign = "Arriving trains";
                                }

                                // Format First/Last times: 24:xx -> 0:xx
                                const formatTime = (t) => {
                                    if (!t) return 'N/A';
                                    const [h, m] = t.split(':');
                                    if (parseInt(h) >= 24) {
                                        return `${parseInt(h) - 24}:${m}`;
                                    }
                                    return t;
                                };

                                arrivalHTML += `
                                    <div class="arrival-item metro-consolidated-item" style="border-left-color: #${route.color || 'ef4444'}">
                                        <div class="metro-card-top">
                                            <div class="route-info">
                                                <div class="route-number" style="color: #${route.color || 'ef4444'}">${route.shortName}</div>
                                                <div class="destination">${headsign}</div>
                                            </div>
                                            <div class="next-arrival">
                                                 ${upcoming.length > 0
                                        ? `<div class="next-arrival-chip">${upcoming[0].diff} min <span class="small-time">(${upcoming[0].time})</span></div>`
                                        : `<div class="status-closed">End of Service</div>`
                                    }
                                            </div>
                                        </div>
                                        <div class="metro-card-bottom">
                                            <div class="first-last-row">
                                                <span>First: <b>${formatTime(firstTrain)}</b></span>
                                                <span class="separator">•</span>
                                                <span>Last: <b>${formatTime(lastTrain)}</b></span>
                                            </div>
                                        </div>
                                    </div>
                                 `;
                            });
                        });

                    } catch (e) {
                        console.error(`Failed to process route ${route.id}`, e);
                    }
                }

                if (arrivalHTML) {
                    listEl.innerHTML = arrivalHTML;
                    // No separate firstLast container needed anymore
                } else {
                    listEl.innerHTML = '<div class="empty">No schedules found.</div>';
                }


            } else {
                listEl.innerHTML = '<div class="error">Metro data not found.</div>';
            }


        } catch (err) {
            console.error(err);
            listEl.innerHTML = '<div class="error">Failed to load metro schedule.</div>';
        }
        return;
    }

    setSheetState(panel, 'half'); // Default to half open
    updateBackButtons(); // Ensure back button state is correct


    try {
        // Check for merged IDs
        const subIds = mergeSourcesMap.get(stop.id) || [];
        const idsAndParent = [stop.id, ...subIds];

        // Fetch Routes (static) for ALL IDs in parallel
        const routePromises = idsAndParent.map(id =>
            fetchStopRoutes(id).catch(e => { console.warn(`fetchStopRoutes failed for ${id}:`, e); return []; })
        );

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

    routesInput.forEach(r => {
        if (!uniqueRoutesMap.has(r.shortName)) {
            uniqueRoutesMap.set(r.shortName, r);
        }
    });

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
            if (filterState.active) {
                const idA = a.id || (allRoutes.find(r => r.shortName === a.shortName) || {}).id;
                const idB = b.id || (allRoutes.find(r => r.shortName === b.shortName) || {}).id;

                const matchA = idA && filterState.filteredRoutes.includes(idA);
                const matchB = idB && filterState.filteredRoutes.includes(idB);

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
            const tile = document.createElement('button');
            tile.className = 'route-tile';
            tile.textContent = route.shortName;
            const color = route.color || '2563eb';
            tile.style.backgroundColor = `#${color}20`; // 12% opacity
            tile.style.color = `#${color}`;
            tile.style.fontWeight = '700';

            // Apply Dimming (don't hide)
            if (filterState.active) {
                const realId = route.id || (allRoutes.find(r => r.shortName === route.shortName) || {}).id;
                if (!realId || !filterState.filteredRoutes.includes(realId)) {
                    tile.classList.add('dimmed');
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
    // Check if this ID merges others
    const subIds = mergeSourcesMap.get(stopId) || [];
    const idsToCheck = [stopId, ...subIds];

    // Fetch all in parallel
    const promises = idsToCheck.map(id =>
        fetch(`${API_BASE_URL}/stops/${id}/arrival-times?locale=en&ignoreScheduledArrivalTimes=false`, {
            headers: { 'x-api-key': API_KEY }
        }).then(res => {
            if (!res.ok) return [];
            return res.json();
        }).catch(err => {
            console.warn(`Failed to fetch arrivals for merged ID ${id}:`, err);
            return [];
        })
    );

    const results = await Promise.all(promises);
    let combined = results.flat();

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
const v3Cache = {
    patterns: new Map(), // routeId -> patterns
    schedules: new Map() // routeId:suffix:date -> schedule
};

// Use the proxy's base URL and append /v3 manually to avoid proxy path issues
// API_BASE_URL is .../api/v2 usually.
// If we change it to .../api/v3, the proxy might not match if it's set to /pis-gateway
// Reviewing vite.config.js: proxy is '/pis-gateway'. So /pis-gateway/api/v3 SHOULD work.
// But let's try constructing it relative to the proxy root if possible.
// Actually, let's just stick to what effectively works.
// API_BASE_URL usually ends in /api/v2.
const API_V3_BASE_URL = API_BASE_URL.replace('/v2', '/v3');

// Promise singleton to prevent parallel route fetches
let v3RoutesPromise = null;
const V3_ROUTES_CACHE_KEY = 'v3_routes_map_cache';
const V3_CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours

async function fetchV3Routes() {
    if (v3RoutesMap) return;
    if (v3RoutesPromise) return v3RoutesPromise;

    // 1. Try Local Storage Cache first
    try {
        const cached = localStorage.getItem(V3_ROUTES_CACHE_KEY);
        if (cached) {
            const { timestamp, data } = JSON.parse(cached);
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
        try {
            console.log('[V3] Fetching global routes list from API...');
            const res = await fetch(`${API_V3_BASE_URL}/routes?locale=en`, {
                headers: { 'x-api-key': API_KEY },
                credentials: 'omit'
            });
            if (!res.ok) throw new Error(`Failed to fetch V3 routes: ${res.status}`);

            const routes = await res.json();
            v3RoutesMap = new Map();
            routes.forEach(r => {
                v3RoutesMap.set(String(r.shortName), r.id);
            });
            console.log(`[V3] Mapped ${v3RoutesMap.size} routes`);

            // Save to cache (Map -> Array for JSON)
            localStorage.setItem(V3_ROUTES_CACHE_KEY, JSON.stringify({
                timestamp: Date.now(),
                data: Array.from(v3RoutesMap.entries())
            }));

        } catch (err) {
            console.warn('[V3] Error fetching routes map:', err);
            v3RoutesMap = null;
        } finally {
            v3RoutesPromise = null;
        }
    })();

    return v3RoutesPromise;
}

// Simple concurrency limiter
// Simple concurrency limiter
// Re-enabling throttling to prevent 520/500 errors
const MAX_CONCURRENT_V3_REQUESTS = 3;
let activeV3Requests = 0;
const v3RequestQueue = [];

async function enqueueV3Request(fn) {
    return new Promise((resolve, reject) => {
        v3RequestQueue.push({ fn, resolve, reject });
        processV3Queue();
    });
}

function processV3Queue() {
    if (activeV3Requests >= MAX_CONCURRENT_V3_REQUESTS || v3RequestQueue.length === 0) return;

    const { fn, resolve, reject } = v3RequestQueue.shift();
    activeV3Requests++;

    fn().then(resolve).catch(reject).finally(() => {
        activeV3Requests--;
        // Add 200ms delay to be safe
        setTimeout(processV3Queue, 200);
    });
}

const v3InFlight = {
    patterns: new Map(),
    schedules: new Map()
};

async function getV3Schedule(routeShortName, stopId) {
    // Wrap the entire logic in the queue
    return enqueueV3Request(async () => {
        // console.log(`[V3] getV3Schedule called for ${routeShortName} at ${stopId}`);
        await fetchV3Routes();

        // Safety check: if fetch failed, map is still null
        if (!v3RoutesMap) {
            console.warn('[V3] v3RoutesMap is null');
            return null;
        }

        const routeId = v3RoutesMap.get(String(routeShortName));
        if (!routeId) {
            console.warn(`[V3] No Route ID found for ${routeShortName}`);
            return null;
        }

        try {
            // 1. Get Patterns
            let patterns = v3Cache.patterns.get(routeId);

            // Try Local Storage for Patterns
            if (!patterns) {
                const lsKey = `v3_patterns_${routeId}`;
                try {
                    const cached = localStorage.getItem(lsKey);
                    if (cached) {
                        const { timestamp, data } = JSON.parse(cached);
                        // Cache patterns for 7 days (they change rarely)
                        if (Date.now() - timestamp < 7 * 24 * 60 * 60 * 1000) {
                            patterns = data;
                            v3Cache.patterns.set(routeId, patterns);
                        }
                    }
                } catch (e) { /* ignore */ }
            }

            // Fetch if missing (with deduplication)
            if (!patterns) {
                if (v3InFlight.patterns.has(routeId)) {
                    // Reuse in-flight promise
                    patterns = await v3InFlight.patterns.get(routeId);
                } else {
                    const promise = (async () => {
                        const suffixesRes = await fetch(`${API_V3_BASE_URL}/routes/${routeId}?locale=en`, {
                            headers: { 'x-api-key': API_KEY },
                            credentials: 'omit'
                        });
                        if (!suffixesRes.ok) throw new Error(`Routes details failed: ${suffixesRes.status}`);
                        const routeData = await suffixesRes.json();

                        if (routeData.patterns) {
                            const suffixes = routeData.patterns.map(p => p.patternSuffix).join(',');
                            const patRes = await fetch(`${API_V3_BASE_URL}/routes/${routeId}/stops-of-patterns?patternSuffixes=${suffixes}&locale=en`, {
                                headers: { 'x-api-key': API_KEY },
                                credentials: 'omit'
                            });
                            if (!patRes.ok) throw new Error(`Patterns fetch failed: ${patRes.status}`);
                            const patText = await patRes.text();
                            return JSON.parse(patText);
                        }
                        return null;
                    })();

                    v3InFlight.patterns.set(routeId, promise);
                    try {
                        patterns = await promise;
                        if (patterns) {
                            v3Cache.patterns.set(routeId, patterns);
                            try {
                                localStorage.setItem(`v3_patterns_${routeId}`, JSON.stringify({
                                    timestamp: Date.now(),
                                    data: patterns
                                }));
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
                console.warn(`[V3] No patterns loaded for ${routeId}`);
                return null;
            }

            // 2. Find Pattern containing Stop
            let potentialIds = [String(stopId)];
            if (typeof mergeSourcesMap !== 'undefined' && mergeSourcesMap.has(stopId)) {
                const subIds = mergeSourcesMap.get(stopId) || [];
                potentialIds.push(...subIds.map(String));
            }

            const stopEntry = patterns.find(p => {
                const pId = String(p.stop.id);
                const pCode = String(p.stop.code);
                return potentialIds.some(targetId => {
                    const targetStr = String(targetId);
                    if (targetStr === pId) return true;
                    if (targetStr.split(':')[1] === pCode) return true;
                    return false;
                });
            });

            if (!stopEntry || !stopEntry.patternSuffixes.length) {
                console.warn(`[V3] Stop ${stopId} not found in patterns for route ${routeId}`);
                return null;
            }

            const suffix = stopEntry.patternSuffixes[0];

            // 3. Fetch Schedule
            const cacheKey = `${routeId}:${suffix}`;
            // Try memory cache first
            let schedule = v3Cache.schedules.get(cacheKey);

            // Try LocalStorage if memory miss
            if (!schedule) {
                const lsKey = `v3_sched_${cacheKey}`;
                try {
                    const cached = localStorage.getItem(lsKey);
                    if (cached) {
                        const { timestamp, data } = JSON.parse(cached);
                        // Cache for 24h
                        if (Date.now() - timestamp < 24 * 60 * 60 * 1000) {
                            schedule = data;
                            v3Cache.schedules.set(cacheKey, schedule); // Hydrate memory
                        }
                    }
                } catch (e) { /* ignore */ }
            }

            // Fetch with deduplication
            if (!schedule) {
                if (v3InFlight.schedules.has(cacheKey)) {
                    schedule = await v3InFlight.schedules.get(cacheKey);
                } else {
                    const promise = (async () => {
                        const schRes = await fetch(`${API_V3_BASE_URL}/routes/${routeId}/schedule?patternSuffix=${suffix}&locale=en`, {
                            headers: { 'x-api-key': API_KEY },
                            credentials: 'omit'
                        });
                        if (!schRes.ok) throw new Error(`Schedule fetch failed: ${schRes.status}`);
                        const schText = await schRes.text();
                        return JSON.parse(schText);
                    })();

                    v3InFlight.schedules.set(cacheKey, promise);
                    try {
                        schedule = await promise;
                        if (schedule) {
                            v3Cache.schedules.set(cacheKey, schedule);
                            try {
                                localStorage.setItem(`v3_sched_${cacheKey}`, JSON.stringify({
                                    timestamp: Date.now(),
                                    data: schedule
                                }));
                            } catch (e) { console.warn('LS Write Failed (Schedule)', e); }
                        }
                    } catch (e) {
                        console.error(`[V3] Schedule fetch error`, e);
                    } finally {
                        v3InFlight.schedules.delete(cacheKey);
                    }
                }
            }

            // 4. Parse Schedule
            // Fix: Force Tbilisi Timezone (GMT+4)
            const tbilisiNow = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Tbilisi' }); // YYYY-MM-DD
            const todayStr = tbilisiNow;

            let daySchedule = schedule.find(s => s.serviceDates.includes(todayStr));

            // Helper to find next time in a specific day's schedule
            const findNextTime = (sched, minTimeMinutes) => {
                if (!sched) return null;
                const stop = sched.stops.find(s => s.id === stopEntry.stop.id);
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
                // Parsing YYYY-MM-DD as UTC is safest for date math
                const tDate = new Date(todayStr);
                tDate.setDate(tDate.getDate() + 1);
                const tomorrowStr = tDate.toISOString().split('T')[0];

                const tmrSchedule = schedule.find(s => s.serviceDates.includes(tomorrowStr));
                nextTime = findNextTime(tmrSchedule, -1);
            }

            if (nextTime) {
                return nextTime;
            }

        } catch (err) {
            console.warn(`[V3] Logic Error for ${routeShortName}:`, err);
        }
        return null;
    });
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
        const minA = parseInt(a.getAttribute('data-minutes') || '9999');
        const minB = parseInt(b.getAttribute('data-minutes') || '9999');
        return minA - minB;
    });

    // Re-append in order
    items.forEach(item => listEl.appendChild(item));
}

// Helper for Synchronous Cache Lookup
function getV3ScheduleSync(routeShortName, stopId) {
    if (!v3RoutesMap) return null;
    const routeId = v3RoutesMap.get(String(routeShortName));
    if (!routeId) return null;

    // 1. Get Patterns
    let patterns = v3Cache.patterns.get(routeId);
    if (!patterns) {
        try {
            const cached = localStorage.getItem(`v3_patterns_${routeId}`);
            if (cached) {
                const { timestamp, data } = JSON.parse(cached);
                if (Date.now() - timestamp < 7 * 24 * 60 * 60 * 1000) {
                    patterns = data;
                    v3Cache.patterns.set(routeId, patterns);
                }
            }
        } catch (e) { }
    }
    if (!patterns) return null;

    // 2. Find Stop Suffix
    let potentialIds = [String(stopId)];
    if (typeof mergeSourcesMap !== 'undefined' && mergeSourcesMap.has(stopId)) {
        const subIds = mergeSourcesMap.get(stopId) || [];
        potentialIds.push(...subIds.map(String));
    }

    const stopEntry = patterns.find(p => {
        const pId = String(p.stop.id);
        const pCode = String(p.stop.code);
        return potentialIds.some(targetId => {
            const targetStr = String(targetId);
            if (targetStr === pId) return true;
            if (targetStr.split(':')[1] === pCode) return true;
            return false;
        });
    });
    if (!stopEntry || !stopEntry.patternSuffixes.length) return null;
    const suffix = stopEntry.patternSuffixes[0];

    // 3. Get Schedule
    const cacheKey = `${routeId}:${suffix}`;
    let schedule = v3Cache.schedules.get(cacheKey);
    if (!schedule) {
        try {
            const cached = localStorage.getItem(`v3_sched_${cacheKey}`);
            if (cached) {
                const { timestamp, data } = JSON.parse(cached);
                if (Date.now() - timestamp < 24 * 60 * 60 * 1000) {
                    schedule = data;
                    v3Cache.schedules.set(cacheKey, schedule);
                }
            }
        } catch (e) { }
    }
    if (!schedule) return null;

    // 4. Calculate Time
    const tbilisiNow = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Tbilisi' });
    let daySchedule = schedule.find(s => s.serviceDates.includes(tbilisiNow));

    const now = new Date();
    const tbilisiParts = new Intl.DateTimeFormat('en-US', {
        timeZone: "Asia/Tbilisi", hour: 'numeric', minute: 'numeric', hour12: false
    }).formatToParts(now);
    const h = parseInt(tbilisiParts.find(p => p.type === 'hour').value);
    const m = parseInt(tbilisiParts.find(p => p.type === 'minute').value);
    const curMinutes = h * 60 + m;

    const findNextTime = (sched, minTimeMinutes) => {
        if (!sched) return null;
        const stop = sched.stops.find(s => s.id === stopEntry.stop.id);
        if (!stop) return null;
        const times = stop.arrivalTimes.split(',');
        for (const t of times) {
            const [h, m] = t.split(':').map(Number);
            if ((h * 60 + m) > minTimeMinutes) return t;
        }
        return null;
    };

    let nextTime = findNextTime(daySchedule, curMinutes);
    if (!nextTime) {
        // Tomorrow logic
        const tDate = new Date(tbilisiNow);
        tDate.setDate(tDate.getDate() + 1);
        const tomorrowStr = tDate.toISOString().split('T')[0];
        const tmrSchedule = schedule.find(s => s.serviceDates.includes(tomorrowStr));
        nextTime = findNextTime(tmrSchedule, -1);
    }
    return nextTime;
}


function renderArrivals(arrivals, currentStopId = null) {
    const listEl = document.getElementById('arrivals-list');
    listEl.innerHTML = '';

    const stopId = currentStopId || window.currentStopId;

    // 1. Identify "Missing" Routes
    let extraRoutes = [];
    if (stopId && stopToRoutesMap.has(stopId)) {
        const servingRoutes = stopToRoutesMap.get(stopId) || [];
        const arrivalRouteShortNames = new Set(arrivals.map(a => String(a.shortName)));
        extraRoutes = servingRoutes.filter(r => !arrivalRouteShortNames.has(String(r.shortName)));
    }

    // 2. Filter Logic
    if (filterState.active) {
        arrivals = arrivals.filter(a => {
            const r = allRoutes.find(route => String(route.shortName) === String(a.shortName));
            return r && filterState.filteredRoutes.includes(r.id);
        });
        extraRoutes = extraRoutes.filter(r => filterState.filteredRoutes.includes(r.id));
    }

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
            color: a.color ? `#${a.color}` : 'var(--primary)',
            headsign: a.headsign
        });
    });

    // Add Extra Routes (Try Sync Cache)
    extraRoutes.forEach(r => {
        // Try to get time from cache synchronously
        const cachedTimeStr = getV3ScheduleSync(r.shortName, stopId);

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
            timeDisplay: timeDisplay,
            color: r.color ? `#${r.color}` : 'var(--primary)',
            needsFetch: !cachedTimeStr
        });
    });

    // 4. Sort EVERYTHING
    renderList.sort((a, b) => a.minutes - b.minutes);

    if (renderList.length === 0) {
        if (filterState.active) {
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
              <div class="route-number" style="color: ${item.color}">${a.shortName}</div>
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
              <div class="route-number" style="color: ${item.color}">${r.shortName}</div>
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
                getV3Schedule(r.shortName, stopId).then(timeStr => {
                    const el = document.getElementById(timeElId);
                    if (el) {
                        const mins = getMinutesFromNow(timeStr);
                        div.setAttribute('data-minutes', mins);

                        let displayStr = timeStr;
                        if (mins < 60 && mins >= 0) displayStr = `${mins} min`;
                        el.innerText = displayStr || '--:--';

                        sortArrivalsList();
                    }
                });
            }
        }

        div.innerHTML = innerContent;
        listEl.appendChild(div);
    });
}

// Search Logic
function setupSearch() {
    const input = document.getElementById('search-input');
    const suggestions = document.getElementById('search-suggestions');
    let debounceTimeout;

    // Show history on focus if empty
    input.addEventListener('focus', () => {
        if (input.value.trim() === '') {
            const history = getSearchHistory();
            if (history.length > 0) {
                renderHistorySuggestions(history);
            }
        }
    });

    input.addEventListener('input', (e) => {
        const query = e.target.value.toLowerCase();

        clearTimeout(debounceTimeout);
        debounceTimeout = setTimeout(async () => {

            if (query.length < 2) {
                if (query.length === 0) {
                    const history = getSearchHistory();
                    if (history.length > 0) {
                        renderHistorySuggestions(history);
                        return;
                    }
                }
                suggestions.classList.add('hidden');
                return;
            }

            // 1. Local Search (Stops & Routes) - Render IMMEDIATELY
            const matchedStops = allStops.filter(stop =>
                (stop.name && stop.name.toLowerCase().includes(query)) ||
                (stop.code && stop.code.includes(query))
            ).slice(0, 5);

            const matchedRoutes = allRoutes.filter(route =>
                (route.shortName && route.shortName.toLowerCase().includes(query)) ||
                (route.longName && route.longName.toLowerCase().includes(query))
            ).slice(0, 5);

            // Render local first to be responsive
            renderSuggestions(matchedStops, matchedRoutes, []);

            // 2. Remote Search (Mapbox Geocoding) - Addresses in Georgia
            let matchedPlaces = [];
            try {
                const geocodingUrl = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json?access_token=${mapboxgl.accessToken}&country=ge&types=place,address,poi&limit=5`;
                const res = await fetch(geocodingUrl);
                if (res.ok) {
                    const data = await res.json();
                    matchedPlaces = data.features || [];

                    // Re-render with ALL results
                    renderSuggestions(matchedStops, matchedRoutes, matchedPlaces);
                } else {
                    console.warn('[Search] Geocoding error:', res.status, res.statusText);
                }
            } catch (err) {
                console.warn('[Search] Geocoding exception', err);
            }
        }, 300); // 300ms debounce
    });

    // Hide suggestions on click outside
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.search-container')) {
            suggestions.classList.add('hidden');
        }
    });
}

function renderHistorySuggestions(historyItems) {
    const container = document.getElementById('search-suggestions');
    container.innerHTML = '<div class="suggestion-header" style="padding: 8px 16px; font-size: 0.75rem; color: #6b7280; font-weight: 600;">RECENT</div>';

    historyItems.forEach(item => {
        const div = document.createElement('div');
        div.className = 'suggestion-item';

        if (item.type === 'route') {
            const route = item.data;
            div.innerHTML = `
        <div class="suggestion-icon route" style="background: #f3f4f6; color: #6b7280;">🕒</div>
        <div class="suggestion-text">
          <div>Route ${route.shortName}</div>
          <div class="suggestion-subtext">${route.longName}</div>
        </div>
      `;
            div.addEventListener('click', () => {
                showRouteOnMap(route);
                container.classList.add('hidden');
            });
        } else {
            const stop = item.data;
            div.innerHTML = `
        <div class="suggestion-icon stop" style="background: #f3f4f6; color: #6b7280;">🕒</div>
        <div class="suggestion-text">
          <div>${stop.name}</div>
          <div class="suggestion-subtext">Code: ${stop.code}</div>
        </div>
      `;
            div.addEventListener('click', () => {
                map.flyTo({ center: [stop.lon, stop.lat], zoom: 16 });
                showStopInfo(stop);
                container.classList.add('hidden');
            });
        }
        container.appendChild(div);
    });
    container.classList.remove('hidden');
}

function renderSuggestions(stops, routes, places = []) {
    const container = document.getElementById('search-suggestions');
    container.innerHTML = '';

    if (stops.length === 0 && routes.length === 0 && places.length === 0) {
        container.classList.add('hidden');
        return;
    }

    // Render Routes
    routes.forEach(route => {
        const div = document.createElement('div');
        div.className = 'suggestion-item';
        div.innerHTML = `
      <div class="suggestion-icon route">BUS</div>
      <div class="suggestion-text">
        <div>Route ${route.shortName}</div>
        <div class="suggestion-subtext">${route.longName}</div>
      </div>
    `;
        div.addEventListener('click', () => {
            showRouteOnMap(route);
            container.classList.add('hidden');
        });
        container.appendChild(div);
    });

    // Render Stops
    stops.forEach(stop => {
        const div = document.createElement('div');
        div.className = 'suggestion-item';
        div.innerHTML = `
      <div class="suggestion-icon stop">STOP</div>
      <div class="suggestion-text">
        <div>${stop.name}</div>
        <div class="suggestion-subtext">Code: ${stop.code}</div>
      </div>
    `;
        div.addEventListener('click', () => {
            map.flyTo({ center: [stop.lon, stop.lat], zoom: 16 });
            showStopInfo(stop);
            container.classList.add('hidden');
        });
        container.appendChild(div);
    });

    // Render Places
    places.forEach(place => {
        const div = document.createElement('div');
        div.className = 'suggestion-item';
        div.innerHTML = `
      <div class="suggestion-icon place">📍</div>
      <div class="suggestion-text">
        <div>${place.text}</div>
        <div class="suggestion-subtext">${place.place_name}</div>
      </div>
    `;
        div.addEventListener('click', () => {
            const [lon, lat] = place.center;
            map.flyTo({ center: [lon, lat], zoom: 16 });

            // Optional: Add a temporary marker
            new mapboxgl.Marker({ color: '#4f46e5' })
                .setLngLat([lon, lat])
                .addTo(map);

            container.classList.add('hidden');
        });
        container.appendChild(div);
    });

    container.classList.remove('hidden');
}

// Route Plotting
let currentRoute = null;
let currentPatternIndex = 0;
let busUpdateInterval = null;

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
        const routeDetails = await fetchRouteDetailsV3(route.id);
        if (requestId !== lastRouteUpdateId) return; // Stale check
        const patterns = routeDetails.patterns;

        // Auto-Direction Logic:
        // 1. Try to match by Headsign (most accurate for specific arrival clicks)
        let directionFound = false;
        if (options.targetHeadsign && patterns.length > 0) {
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
                const stopsPromises = patterns.map(p => fetchRouteStopsV3(route.id, p.patternSuffix).then(stops => ({
                    suffix: p.patternSuffix,
                    stops: stops
                })));

                const allStopsData = await Promise.all(stopsPromises);
                if (requestId !== lastRouteUpdateId) return; // Stale check

                // Find index of pattern that has the stop
                const matchedIndex = patterns.findIndex(p => {
                    const data = allStopsData.find(d => d.suffix === p.patternSuffix);
                    return data && data.stops.some(s => s.id === options.fromStopId || s.stopId === options.fromStopId);
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
        const currentPatternStops = await fetchRouteStopsV3(route.id, currentPattern.patternSuffix);
        if (requestId !== lastRouteUpdateId) return; // Stale check

        const originStop = currentPatternStops[0]?.name || '';
        const destinationStop = currentPatternStops[currentPatternStops.length - 1]?.name || currentPattern.headsign;

        if (patterns.length > 1) {
            switchBtn.classList.remove('hidden');
            switchBtn.onclick = () => {
                currentPatternIndex = (currentPatternIndex + 1) % patterns.length;
                updateRouteView(route, { preserveBounds: true }); // Keep bounds when switching directions
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
        const polylineData = await fetchRoutePolylineV3(route.id, allSuffixes);
        if (requestId !== lastRouteUpdateId) return; // Stale check

        // Plot Ghost Route (Other patterns)
        patterns.forEach(p => {
            if (p.patternSuffix !== patternSuffix) {
                const ghostEncoded = polylineData[p.patternSuffix]?.encodedValue;
                if (ghostEncoded) {
                    const ghostCoords = decodePolyline(ghostEncoded);
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
            const coordinates = decodePolyline(encodedPolyline);

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
        const stopsData = await fetchRouteStopsV3(route.id, patternSuffix);
        if (requestId !== lastRouteUpdateId) return; // Stale check

        const stopsGeoJSON = {
            type: 'FeatureCollection',
            features: stopsData.map(stop => ({
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [stop.lon, stop.lat] },
                properties: { name: stop.name }
            }))
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
        const positionsData = await fetchBusPositionsV3(routeId, patternSuffix);
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
    // states: hidden, collapsed, half, full
    panel.classList.remove('hidden', 'sheet-half', 'sheet-full', 'sheet-collapsed');

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
    // The CSS media queries should handle the sizing (width), but the height/y-transform is controlled by these classes/JS.

    // Previous logic forced it to just removed 'hidden' on desktop. 
    // We'll keep the classes. The CSS for desktop needs to respect them if we want this behavior.

    // However, we might want to ensure 'half' on desktop doesn't mean "bottom 40% of screen" if the design is a sidebar...
    // Wait, the design IS a sidebar on desktop? 
    // The user said "Desktop (narrow window)". 
    // If it's a Sidebar, vertical sliding makes no sense.
    // BUT the user asked for: "on desktop (narrow window) i expect this behaviour: the card opens halfway..."

    // If window is narrow (<768px), it's mobile layout anyway.
    // If window is >768px but "narrow"? 
    // Usually >768 is treated as tablet/desktop in my CSS.

    // If the user wants this behavior on "Desktop (narrow window)", they likely mean when they resize the browser to be mobile-like.
    // OR they mean the sidebar itself should have states?
    // "the card opens halfway... scrolling collapses the card". This implies vertical movement.
    // Vertical movement implies Bottom Sheet.
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

async function fetchRouteDetailsV3(routeId) {
    return await fetchWithCache(`${API_BASE_URL.replace('/v2', '/v3')}/routes/${routeId}`, {
        headers: { 'x-api-key': API_KEY }
    });
}

async function fetchRoutePolylineV3(routeId, patternSuffixes) {
    return await fetchWithCache(`${API_BASE_URL.replace('/v2', '/v3')}/routes/${routeId}/polylines?patternSuffixes=${patternSuffixes}`, {
        headers: { 'x-api-key': API_KEY }
    });
}

async function fetchRouteStopsV3(routeId, patternSuffix) {
    return await fetchWithCache(`${API_BASE_URL.replace('/v2', '/v3')}/routes/${routeId}/stops?patternSuffix=${patternSuffix}`, {
        headers: { 'x-api-key': API_KEY }
    });
}

async function fetchBusPositionsV3(routeId, patternSuffix) {
    const response = await fetch(`${API_BASE_URL.replace('/v2', '/v3')}/routes/${routeId}/positions?patternSuffixes=${patternSuffix}`, {
        headers: { 'x-api-key': API_KEY }
    });
    if (!response.ok) throw new Error('Network response was not ok');
    return await response.json();
}

// Polyline Decoder (Google Encoded Polyline Algorithm)
function decodePolyline(encoded) {
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
const filterBtn = document.getElementById('filter-routes');
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
        const fb = document.getElementById('filter-routes');
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
document.getElementById('close-panel').addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    triggerMapClickLock();

    console.log('[Debug] Close panel clicked');
    const panel = document.getElementById('info-panel');
    setSheetState(panel, 'hidden');

    window.currentStopId = null; // Clear Global State
    if (window.selectDevStop) window.selectDevStop(null); // Notify DevTools

    clearFilter(); // Reset filter
    setMapFocus(false); // Reset map focus (opacity)
    // Remove highlight
    if (map.getSource('selected-stop')) {
        map.getSource('selected-stop').setData({ type: 'FeatureCollection', features: [] });
    }
    clearHistory(); // Clear history on close
});

// Close Route Info
document.getElementById('close-route-info').addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    triggerMapClickLock();

    setSheetState(document.getElementById('route-info'), 'hidden');
    clearHistory(); // Clear history on close
    clearRoute(); // Helper to clear route layers (modified to also reset focus)
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
    loadSvgImage(map, 'stop-icon', `${baseUrl}stop.svg`, 64, 64);
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

    // Use correct aspect ratio for these (Original: 43x66 -> 2x: 86x132)
    loadSvgImage(map, 'stop-close-up-icon', `${baseUrl}stop-close-up.svg`, 86, 132);
    // (Original: 53x76 -> 2x: 106x152)
    loadSvgImage(map, 'stop-selected-icon', `${baseUrl}stop-selected.svg`, 106, 152);

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
    map.addImage('bus-arrow', imageData, { sdf: true });
}

// Updated Multi-Target Connection Line Logic
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

    // Process EACH target independently
    targets.forEach(targetId => {
        const targetStop = allStops.find(s => s.id === targetId);
        if (!targetStop) return;

        // Find connecting routes
        const originRoutes = stopToRoutesMap.get(originId) || [];

        const common = originRoutes.filter(r => {
            // Strict Check Logic (Duplicates applyFilter logic but per target)
            if (r._details && r._details.patterns) {
                return r._details.patterns.some(p => {
                    if (!p.stops) return false;
                    const idxO = p.stops.findIndex(s => (redirectMap.get(s.id) || s.id) === originId);
                    const idxT = p.stops.findIndex(s => (redirectMap.get(s.id) || s.id) === targetId);
                    return idxO !== -1 && idxT !== -1 && idxO < idxT;
                });
            }
            if (r.stops) {
                const stops = r.stops;
                const idxO = stops.findIndex(sid => (redirectMap.get(sid) || sid) === originId);
                const idxT = stops.findIndex(sid => (redirectMap.get(sid) || sid) === targetId);
                return idxO !== -1 && idxT !== -1 && idxO < idxT;
            }
            return false;
        });

        if (common.length === 0) return; // Skip unconnected

        // Color Logic
        const greenRoute = common.find(r => r.color && r.color.toUpperCase() === '00B38B');
        const bestRoute = greenRoute || common[0];
        const color = (bestRoute && bestRoute.color && bestRoute.color.toUpperCase() === '00B38B') ? '#00B38B' : '#2563eb';

        // Geometry Logic
        let selectedPatternStops = [];
        let bestPattern = null;

        if (bestRoute && bestRoute._details && bestRoute._details.patterns) {
            bestRoute._details.patterns.some(p => {
                if (!p.stops) return false;
                const idxO = p.stops.findIndex(s => (redirectMap.get(s.id) || s.id) === originId);
                const idxT = p.stops.findIndex(s => (redirectMap.get(s.id) || s.id) === targetId);
                if (idxO !== -1 && idxT !== -1 && idxO < idxT) {
                    selectedPatternStops = p.stops.slice(idxO, idxT + 1).map(s => [s.lon, s.lat]);
                    bestPattern = p;
                    return true;
                }
                return false;
            });
        }

        // Fallback Geometry
        if (selectedPatternStops.length < 2) {
            selectedPatternStops = [
                [originStop.lon, originStop.lat],
                [targetStop.lon, targetStop.lat]
            ];
        }

        let finalCoordinates = null;

        // "Actual Route" Logic for Selection (Persistent Targets)
        // Fix: Don't downgrade selected lines when hovering. Check if THIS target is selected.
        const isPersistent = filterState.targetIds && filterState.targetIds.has(targetId);

        if (isPersistent && bestPattern && bestRoute) {
            // Ensure we have a suffix
            if (!bestPattern.suffix && bestPattern.patternSuffix) {
                bestPattern.suffix = bestPattern.patternSuffix;
            }

            if (!bestPattern.suffix) {
                console.warn('[Debug] Pattern missing suffix:', bestPattern);
            } else {
                if (bestPattern._decodedPolyline) {
                    // Try Slicing
                    const sliced = slicePolyline(bestPattern._decodedPolyline, originStop, targetStop);
                    if (sliced) {
                        finalCoordinates = sliced;
                    }
                } else {
                    // Trigger Fetch
                    fetchAndCacheGeometry(bestRoute, bestPattern);
                }
            }
        }

        // Default / Fallback Smoothing
        if (!finalCoordinates) {
            if (selectedPatternStops.length >= 2) {
                finalCoordinates = getCatmullRomSpline(selectedPatternStops);
            } else {
                finalCoordinates = selectedPatternStops;
            }
        }

        features.push({
            type: 'Feature',
            geometry: {
                type: 'LineString',
                coordinates: finalCoordinates
            },
            properties: {
                color: color
            }
        });
    });

    // Update Source
    const source = map.getSource('filter-connection');
    if (source) {
        source.setData({ type: 'FeatureCollection', features: features });
    }

    // Switch to Data-Driven Styling if needed
    if (map.getLayer('filter-connection-line')) {
        map.setPaintProperty('filter-connection-line', 'line-color', ['get', 'color']);
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

async function fetchAndCacheGeometry(route, pattern) {
    if (pattern._fetchingPolyline || pattern._polyfailed) return;
    pattern._fetchingPolyline = true;

    try {
        const data = await fetchRoutePolylineV3(route.id, pattern.suffix);
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
            pattern._decodedPolyline = decodePolyline(encoded);
            console.log(`[Debug] Polyline fetched & decoded for ${route.shortName} (${pattern.suffix}), points: ${pattern._decodedPolyline.length}`);

            // Re-Draw if still selected
            if (filterState.active && filterState.targetIds.size > 0) {
                updateConnectionLine(filterState.originId, filterState.targetIds, false);
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
