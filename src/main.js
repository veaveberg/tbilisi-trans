import './style.css';
import mapboxgl from 'mapbox-gl';
import stopBearings from './data/stop_bearings.json';
// stopsConfig will be loaded dynamically
import { Router } from './router.js';
import { db } from './db.js';
import { historyManager } from './history.js';
import iconFilterOutline from './assets/icons/line.3.horizontal.decrease.circle.svg';
import iconFilterFill from './assets/icons/line.3.horizontal.decrease.circle.fill.svg';

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

// Check for deep link hash (Standard Mapbox format: #zoom/lat/lng)
const initialHash = window.location.hash;
if (initialHash) {
    const parts = initialHash.replace('#', '').split('/');
    if (parts.length >= 3) {
        const z = parseFloat(parts[0]);
        const lat = parseFloat(parts[1]);
        const lng = parseFloat(parts[2]);
        if (!isNaN(z) && !isNaN(lat) && !isNaN(lng)) {
            map.setZoom(z);
            map.setCenter([lng, lat]);
        }
    }
}

// Debug: Expose map to window
window.map = map;

function getMapHash() {
    const center = map.getCenter();
    const zoom = map.getZoom();
    return `#${zoom.toFixed(2)}/${center.lat.toFixed(5)}/${center.lng.toFixed(5)}`;
}

// Initial Router State Handling
Router.init();
const initialState = Router.parse();

// We need to wait for map load + route data fetching before we can fully restore state
// But we can start fetching immediately.
fetchRoutes().then(() => {
    // Determine what to show based on initial state
    if (initialState.type === 'route' && initialState.shortName) {
        // Find route by shortName
        // We need to wait for map logic a bit or use a ready check?
        map.once('load', () => {
            fetchV3Routes().then(() => {
                // Find route ID from v3 map or fallback to allRoutes
                const routeId = v3RoutesMap ? v3RoutesMap.get(initialState.shortName) : null;
                const routeObj = allRoutes.find(r => String(r.shortName) === String(initialState.shortName));

                if (routeObj) {
                    showRouteOnMap(routeObj, true, {
                        initialDirectionIndex: initialState.direction
                    });
                } else {
                    console.warn('[Router] Route not found:', initialState.shortName);
                }
            });
        });
    } else if (initialState.stopId) {
        window.currentStopId = initialState.stopId;
        // Filter restoration is complex, needs data.
        // Let's rely on map moveend or explicit fetch?
        // Existing logic relies on map events mostly.
    }
});

map.on('moveend', () => {
    // Only update hash if no specialized view is active (Stop or Route)
    if (!window.currentStopId && !window.currentRoute) {
        Router.updateMapLocation(getMapHash());
    }
});

// Debug: Trace Map Movement
const originalFlyTo = map.flyTo.bind(map);
map.flyTo = (args, options) => {
    console.log('[MapDebug] flyTo called:', args);
    // console.trace('[MapDebug] flyTo stack');
    return originalFlyTo(args, options);
};

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
document.getElementById('zoom-in')?.addEventListener('click', () => map.zoomIn());
document.getElementById('zoom-out')?.addEventListener('click', () => map.zoomOut());

document.getElementById('locate-me')?.addEventListener('click', () => {
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

// Initialize Filter Icon
const initialFilterBtn = document.getElementById('filter-routes-toggle');
if (initialFilterBtn) {
    initialFilterBtn.querySelector('.filter-icon').src = iconFilterOutline;
}


// State
let allStops = [];
let rawStops = []; // Persist raw data for re-processing
let allRoutes = [];
let stopToRoutesMap = new Map(); // Index: stopId -> [route objects]
let lastRouteUpdateId = 0; // Async Lock for Route Updates
// Merge/Redirect Maps
const redirectMap = new Map(); // sourceId -> targetId
const hubMap = new Map(); // stopId -> hubLeaderId (Hub Group)
const hubSourcesMap = new Map(); // hubLeaderId -> [memberIds]
const mergeSourcesMap = new Map(); // targetId -> [sourceIds]

function getEquivalentStops(id) {
    const parent = hubMap.get(id) || id;
    const children = hubSourcesMap.get(parent);

    if (children) {
        // If it's a hub, return all children.
        // The parent (hubId) is virtual and should NOT be in the set if it's not a real stop.
        // But our logic elsewhere might expect the input 'id' to be present? 
        // Logic: Return Set(children).
        return new Set(children);
    }

    // Not a hub member. Return self.
    return new Set([id]);
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

// --- Filter State ---
const filterState = {
    active: false,
    picking: false,
    originId: null,
    targetIds: new Set(), // Multi-select support
    reachableStopIds: new Set(),
    filteredRoutes: [] // Array of route IDs
};

const RouteFilterColorManager = {
    palette: [
        '#5BB042', // green
        '#97544C', // brown
        '#C78FBF', // violet
        '#0083C8', // blue
        '#EF3F47', // red
        '#FFCB05', // yellow
        '#00C1F3', // light blue
        '#ADCD3F', // lime
        '#F58620', // orange
        '#EE4C9B', // magenta
        '#A1A2A3', // grey
        '#09B096', // mint
        '#8F489C', // purple
        '#FBA919'  // physalis
    ],
    pathColors: new Map(), // signature -> color
    routeColors: new Map(), // routeId -> color
    colorQueue: [],
    queueIndex: 0,

    reset() {
        console.log('[ColorManager] RESET triggered.');
        this.pathColors.clear();
        this.routeColors.clear();
        this.colorQueue = this.shuffle([...this.palette]);
        this.queueIndex = 0;
    },

    // Fisher-Yates Shuffle
    shuffle(array) {
        for (let i = array.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [array[i], array[j]] = [array[j], array[i]];
        }
        return array;
    },

    // Peek at the next color for Hover
    getNextColor() {
        if (this.colorQueue.length === 0) this.reset();
        return this.colorQueue[this.queueIndex % this.colorQueue.length];
    },

    // Consume next color for Selection
    assignNextColor(signature, routeIds) {
        // If already assigned, return existing
        if (this.pathColors.has(signature)) {
            const existing = this.pathColors.get(signature);
            console.log(`[ColorManager] Reusing EXISTING color ${existing} for signature ${signature}`);
            routeIds.forEach(rid => this.routeColors.set(rid, existing));
            return existing;
        }

        const color = this.getNextColor(); // Get current peek color
        console.log(`[ColorManager] Assigning NEW color ${color} to signature ${signature}. Path Queue Index: ${this.queueIndex} -> ${(this.queueIndex + 1) % this.colorQueue.length}`);
        this.pathColors.set(signature, color);
        routeIds.forEach(rid => this.routeColors.set(rid, color));

        // Advance Pointer
        this.queueIndex = (this.queueIndex + 1) % this.colorQueue.length;

        return color;
    },

    // Legacy method mostly replaced by assignNextColor, but kept for compatibility if needed
    assignColorForPath(signature, routeIds) {
        return this.assignNextColor(signature, routeIds);
    },

    getColorForRoute(routeId) {
        return this.routeColors.get(routeId);
    }
};

async function toggleFilterMode() {
    console.log('[Debug] toggleFilterMode called. Active:', filterState.active, 'Picking:', filterState.picking, 'CurrentStop:', window.currentStopId);

    // Cancel Edit Pick Mode if active
    if (window.isPickModeActive) setEditPickMode(null);

    // If already active/picking, cancel it
    if (filterState.active || filterState.picking) {
        clearFilter();
        // Force UI update to ensure button state syncs
        const btn = document.getElementById('filter-routes-toggle');
        if (btn) btn.classList.remove('active');
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
    const btn = document.getElementById('filter-routes-toggle');
    if (btn) {
        btn.classList.add('active');
        btn.querySelector('.filter-icon').src = iconFilterFill;
        btn.querySelector('.filter-text').textContent = 'Select destination stops...';
    }

    // Removed old instruction panel logic
    // const instructionEl = document.getElementById('filter-instruction-panel');
    // if (instructionEl) instructionEl.classList.remove('hidden');

    // Camera Logic: Zoom out & Pan
    if (window.currentStopId) {
        // Auto-collapse panel to reveal map (Peek State)
        const panel = document.getElementById('info-panel');
        // Only collapse if it's currently blocking view (half or full), or just force consistent "Filter Mode View"
        if (panel) setSheetState(panel, 'peek');

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
    // 1. Get all routes passing through currentStopId (and its hub equivalents)
    const originEq = getEquivalentStops(window.currentStopId);
    const routes = new Set();
    originEq.forEach(oid => {
        const r = stopToRoutesMap.get(oid) || [];
        r.forEach(route => routes.add(route));
    });
    const originRoutes = Array.from(routes);

    const reachableStopIds = new Set(); // Initialize Scope Here

    // FETCH MISSING DETAILS
    // If routes exist but don't have 'stops', we must fetch them.
    const routesNeedingFetch = originRoutes.filter(r => !r._details || !r._details.patterns); // Check for _details and patterns

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
                                // Find index of current stop (checking redirects and hubs)
                                const idx = p.stops.findIndex(s => originEq.has(redirectMap.get(s.id) || s.id));

                                if (idx !== -1 && idx < p.stops.length - 1) {
                                    p.stops.slice(idx + 1).forEach(s => {
                                        const normId = redirectMap.get(s.id) || s.id;
                                        // Add all equivalent stops of the reachable stop
                                        getEquivalentStops(normId).forEach(eqId => reachableStopIds.add(eqId));
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
                                    const idx = stopsList.findIndex(s => originEq.has(redirectMap.get(s.id) || s.id));
                                    if (idx !== -1 && idx < stopsList.length - 1) {
                                        stopsList.slice(idx + 1).forEach(s => {
                                            const normId = redirectMap.get(s.id) || s.id;
                                            getEquivalentStops(normId).forEach(eqId => reachableStopIds.add(eqId));
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
                            if (!originEq.has(normId)) { // Check against all origin equivalents
                                getEquivalentStops(normId).forEach(eqId => reachableStopIds.add(eqId));
                            }
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
    originRoutes.forEach(r => {
        if (r._details && r._details.patterns) {
            r._details.patterns.forEach(p => {
                if (p.stops) {
                    // Normalized Find
                    const idx = p.stops.findIndex(s => originEq.has(redirectMap.get(s.id) || s.id));
                    if (idx !== -1 && idx < p.stops.length - 1) {
                        p.stops.slice(idx + 1).forEach(s => {
                            const normId = redirectMap.get(s.id) || s.id;
                            getEquivalentStops(normId).forEach(eqId => reachableStopIds.add(eqId));
                        });
                    }
                }
            });
        } else if (r._details && r._details.stops) { // Fallback for V2-like structure
            r._details.stops.forEach(s => {
                const normId = redirectMap.get(s.id) || s.id;
                if (!originEq.has(normId)) {
                    getEquivalentStops(normId).forEach(eqId => reachableStopIds.add(eqId));
                }
            });
        }
    });

    // Store Reachable Stops in State
    filterState.reachableStopIds = reachableStopIds; // Save Set

    console.log(`[Debug] Filter Mode. Origin: ${window.currentStopId}. Routes: ${originRoutes.length}. Reachable Stops: ${reachableStopIds.size}`);

    // Debug Data Availability
    if (originRoutes.length === 0) {
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
        if (map.getLayer('stops-label-selected')) {
            map.setFilter('stops-label-selected', ['in', ['get', 'id'], ['literal', []]]);
        }
        if (map.getLayer('stops-layer-circle')) {
            map.setPaintProperty('stops-layer-circle', 'circle-opacity', 1);
            map.setPaintProperty('stops-layer-circle', 'circle-stroke-opacity', 1);
            map.setPaintProperty('stops-layer-circle', 'circle-radius', getCircleRadiusExpression(1));
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

    if (map.getLayer('stops-layer-circle')) {
        map.setPaintProperty('stops-layer-circle', 'circle-opacity', opacityExpression);
        map.setPaintProperty('stops-layer-circle', 'circle-stroke-opacity', opacityExpression);

        // Make selectable stops BIGGER (1.5x)
        // Make selectable stops BIGGER (1.5x)
        // Note: We cannot nest 'interpolate' inside 'match'. We must use 'interpolate' at top level
        // and condition inside the stops.
        const radiusExpression = [
            'interpolate',
            ['linear'],
            ['zoom'],
            12.5, [
                'case',
                ['match', ['get', 'id'], Array.from(highOpacityIds), true, false], // Is High Opacity?
                1.2 * 1.5,
                1.2
            ],
            16, [
                'case',
                ['match', ['get', 'id'], Array.from(highOpacityIds), true, false], // Is High Opacity?
                4.8 * 1.5,
                4.8
            ]
        ];
        map.setPaintProperty('stops-layer-circle', 'circle-radius', radiusExpression);
    }

    if (map.getLayer('stops-label-selected')) {
        // Only show labels for SELECTED targetIds
        if (selectedArray.length > 0) {
            map.setFilter('stops-label-selected', ['in', ['get', 'id'], ['literal', selectedArray]]);
        } else {
            map.setFilter('stops-label-selected', ['in', ['get', 'id'], ['literal', []]]);
        }
    }

    if (map.getLayer('metro-layer-circle')) {
        map.setPaintProperty('metro-layer-circle', 'circle-opacity', opacityExpression);
        map.setPaintProperty('metro-layer-circle', 'circle-stroke-opacity', opacityExpression);
        // Metro stays same size for now (unless requested otherwise)
    }
}

function refreshRouteFilter() {
    console.log(`[Debug] refreshRouteFilter. Origin: ${filterState.originId}, Targets: ${Array.from(filterState.targetIds).join(', ')}`);

    const originEq = getEquivalentStops(filterState.originId);
    const originRoutesSet = new Set();
    originEq.forEach(oid => {
        const routes = stopToRoutesMap.get(oid) || [];
        routes.forEach(r => originRoutesSet.add(r));
    });
    const originRoutes = Array.from(originRoutesSet);

    // We want routes that pass check for AT LEAST ONE target
    const commonRoutes = originRoutes.filter(r => {
        // HUB LOGIC: Route matches if it touches ANY equivalent of Origin AND ANY equivalent of Target
        // Order must be OriginSection < TargetSection

        // Optimize: Convert route stops to normalized IDs to avoid repeated map lookups? 
        // Or just iterate.
        let routeStopsNormalized = null; // Lazy load

        // Check against ALL targets. If matches ANY, keep it.
        for (const tid of filterState.targetIds) {
            const targetEq = getEquivalentStops(tid);
            let matches = false;

            if (r._details && r._details.patterns) {
                matches = r._details.patterns.some(p => {
                    if (!p.stops) return false;
                    // Find first occurrence of ANY Origin Equivalent
                    const idxO = p.stops.findIndex(s => originEq.has(redirectMap.get(s.id) || s.id));
                    // Find first occurrence of ANY Target Equivalent AFTER idxO
                    if (idxO === -1) return false;

                    const idxT = p.stops.findIndex((s, i) => i > idxO && targetEq.has(redirectMap.get(s.id) || s.id));
                    return idxT !== -1;
                });
            } else if (r.stops) {
                if (!routeStopsNormalized) {
                    routeStopsNormalized = r.stops.map(sid => redirectMap.get(sid) || sid);
                }
                const stops = routeStopsNormalized;
                const idxO = stops.findIndex(sid => originEq.has(sid));
                if (idxO !== -1) {
                    const idxT = stops.findIndex((sid, i) => i > idxO && targetEq.has(sid));
                    matches = (idxT !== -1);
                }
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
        if (window.lastArrivals) {
            renderArrivals(window.lastArrivals, filterState.originId);
            if (window.lastRoutes) {
                renderAllRoutes(window.lastRoutes, window.lastArrivals);
            }
        } else {
            const stop = allStops.find(s => s.id === filterState.originId);
            if (stop) showStopInfo(stop, false, false);
        }
    }

    // Highlight Targets on Map & Draw Lines
    // HUB LOGIC: updateConnectionLine should use Hub IDs for color signature
    updateConnectionLine(filterState.originId, filterState.targetIds, false);

    // Sync URL (Router)
    Router.updateStop(filterState.originId, true, Array.from(filterState.targetIds));

    // Refresh Panel List if we are still viewing the origin stop
    // RE-RENDER TO APPLY COLORS
    if (window.currentStopId === filterState.originId) {
        console.log('[Debug] ApplyFilter: Refreshing arrivals to apply colors...');
        if (window.lastArrivals) {
            renderArrivals(window.lastArrivals, filterState.originId);
            if (window.lastRoutes && window.lastArrivals) {
                renderAllRoutes(window.lastRoutes, window.lastArrivals);
            }
        }
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

    refreshRouteFilter();
}

function clearFilter() {
    filterState.active = false;
    filterState.picking = false;
    filterState.originId = null;
    filterState.targetIds = new Set(); // Reset Set
    filterState.filteredRoutes = [];
    RouteFilterColorManager.reset(); // Reset Colors

    // Clear Connection Line
    if (map.getSource('filter-connection')) {
        map.getSource('filter-connection').setData({ type: 'FeatureCollection', features: [] });
    }

    // Reset UI
    // Reset UI
    const btn = document.getElementById('filter-routes-toggle');
    if (btn) {
        btn.classList.remove('active');
        btn.querySelector('.filter-icon').src = iconFilterOutline; // Revert Icon
        btn.querySelector('.filter-text').textContent = 'Filter routes...';
    }
    // const instructionEl = document.getElementById('filter-instruction-panel');
    // if (instructionEl) instructionEl.classList.add('hidden');

    // Reset Map
    if (map.getLayer('stops-layer')) map.setPaintProperty('stops-layer', 'icon-opacity', 1);
    if (map.getLayer('stops-label-selected')) {
        map.setFilter('stops-label-selected', ['in', ['get', 'id'], ['literal', []]]);
    }
    if (map.getLayer('metro-layer-circle')) {
        map.setPaintProperty('metro-layer-circle', 'circle-opacity', 1);
        map.setPaintProperty('metro-layer-circle', 'circle-stroke-opacity', 1);
    }
    if (map.getLayer('stops-layer-circle')) {
        map.setPaintProperty('stops-layer-circle', 'circle-opacity', 1);
        map.setPaintProperty('stops-layer-circle', 'circle-stroke-opacity', 1);
        map.setPaintProperty('stops-layer-circle', 'circle-radius', getCircleRadiusExpression(1));
    }

    // Refresh view
    if (window.currentStopId) {
        const stop = allStops.find(s => s.id === window.currentStopId);
        // Force flyTo=true to restore zoom
        if (stop) showStopInfo(stop, false, true);
    }
}

// Back Button Listeners
document.getElementById('back-panel')?.addEventListener('click', handleBack);
document.getElementById('back-route-info')?.addEventListener('click', handleBack);

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
        // Initialize Raw Data
        const [stopsData, routesData] = await Promise.all([fetchStops(), fetchRoutes()]);
        rawStops = stopsData;
        allRoutes = routesData;

        // Load Config & Process
        await refreshStopsLayer();

        // Check cache for initial edits
        // ... (existing logic continues from line 816?)
        // Wait, line 816 uses allRoutes. Correct.

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
        addStopsToMap(allStops);

        // Load custom icons (SDF for coloring)
        await loadImages(map);

        // Remove loading state once map and data are ready
        document.body.classList.remove('loading');

        // Fix for Safari/Mobile (Force resize to account for dynamic address bar)
        setTimeout(() => map.resize(), 100);


        // --- Dev Tools Support ---
        // --- Dev Tools Support ---
        // Removed old DevTools as per user request
        // if (import.meta.env.DEV) {
        //     import('./dev-tools.js').then(module => module.initDevTools(map));
        // }

        // Router Initialization
        Router.init();

        // Handle Deep Linking (Initial Load)
        const initialState = Router.parse();
        if (initialState.stopId) {
            console.log('[App] Deep Link Detected:', initialState);

            // 1. Normalize Stop ID (Handle Merged/Redirected Stops)
            const rawStopId = initialState.stopId;
            const normStopId = redirectMap.get(rawStopId) || rawStopId;

            // Wait for map idle or just slight delay to ensure rendering
            const stop = allStops.find(s => String(s.id) === String(normStopId));

            if (stop) {
                // Determine if we need to restore filter state
                if (initialState.filterActive) {
                    // Show Stop Info (NO URL UPDATE to preserve filter params)
                    showStopInfo(stop, false, true, false);

                    // HACK: Allow showStopInfo to run, then apply filter.
                    setTimeout(() => {
                        // Ensure Stop Highlight is Enforced
                        if (map.getSource('selected-stop')) {
                            map.getSource('selected-stop').setData({
                                type: 'FeatureCollection',
                                features: [{
                                    type: 'Feature',
                                    geometry: { type: 'Point', coordinates: [stop.lon, stop.lat] },
                                    properties: stop
                                }]
                            });
                        }

                        // Initialize Filter Mode (Fetch Data & Calculate)
                        // Do NOT set active=true beforehand, or toggleFilterMode will close it!
                        toggleFilterMode().then(() => {
                            // Restore Targets
                            filterState.targetIds.clear();
                            initialState.targetIds.forEach(tid => {
                                const normTid = redirectMap.get(tid) || tid;
                                filterState.targetIds.add(normTid);
                            });

                            filterState.active = true;
                            // filterState.picking is set true by toggleFilterMode, leave it or set false if we want strict viewing mode?
                            // Leave it true as we are technically in a filtered state where picking might be relevant.

                            filterState.active = true;
                            // filterState.picking is set true by toggleFilterMode

                            // Refactored: Use shared logic
                            refreshRouteFilter();
                        });
                    }, 500); // Wait for showStopInfo to settle


                } else {
                    showStopInfo(stop, false, true);
                    // Ensure highlight enforces
                    setTimeout(() => {
                        if (map.getSource('selected-stop')) {
                            map.getSource('selected-stop').setData({
                                type: 'FeatureCollection',
                                features: [{
                                    type: 'Feature',
                                    geometry: { type: 'Point', coordinates: [stop.lon, stop.lat] },
                                    properties: stop
                                }]
                            });
                        }
                    }, 200);
                }
            } else {
                console.warn(`[App] Deep Link Stop ${normStopId} (Raw: ${rawStopId}) not found in allStops.`);
            }
        }

        // Router Listener for Back Button
        Router.onPopState = (state) => {
            console.log('[App] PopState Handled:', state);
            if (state.stopId) {
                const stop = allStops.find(s => String(s.id) === String(state.stopId));
                if (stop) {
                    // Check if filter state changed
                    if (state.filterActive !== filterState.active) {
                        if (state.filterActive) {
                            // Restore Filter (Complex, maybe just Alert or Reload?)
                            // For MVP, just reloading page is safer for Deep Link restoration?
                            // No, SPA feel is better.
                            // Simply re-run the "Deep Link Detected" logic above?
                            // Yes, extract it to valid function?
                        } else {
                            clearFilter();
                        }
                    }
                    // Show Stop
                    showStopInfo(stop, false, true);
                }
            } else {
                // Home
                handleBack(); // Pops history stack. Ideally we clear UI.
                // handleBack pops internal stack. If we are syncing, maybe we just reset UI.
                closeAllPanels();
                setMapFocus(false);
                clearRoute();
                window.currentStopId = null;
            }
        };

    } catch (error) {
        console.error('Error initializing app:', error);
        // Ensure UI is revealed even on error
        document.body.classList.remove('loading');
        alert(`Error plotting route: ${error.message} `);
    }


    // Load Bus Icon (Simple Arrow)
    const arrowImage = new Image(24, 24);
    const arrowSvg = `
            <svg width="24" height="24" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                <path d="M12 2L4.5 20.29L5.21 21L12 18L18.79 21L19.5 20.29L12 2Z" fill="#ef4444" />
            </svg>`;
    arrowImage.onload = () => map.addImage('bus-arrow', arrowImage, { sdf: true });
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
                ['==', ['get', 'mode'], 'SUBWAY'], 1.5, // Keep Metro Big
                1.2 // Unified size for Bus (Arrow or Circle) matches visual weight
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

const pendingRequests = new Map(); // Global in-flight deduplication



// ... (keep this replacement near imports later)

// Modify fetchWithCache to use db
async function fetchWithCache(url, options = {}) {
    const cacheKey = `cache_${url}`;
    const now = Date.now();
    let cached = null;

    try {
        cached = await db.get(cacheKey);
    } catch (e) {
        console.warn('DB Get Failed', e);
    }

    if (cached) {
        // IDB stores objects directly, no need to JSON.parse
        const { timestamp, data } = cached;
        if (now - timestamp < CACHE_DURATION) {
            console.log(`[Cache] Hit: ${url}`);
            return data;
        } else {
            console.log(`[Cache] Expired: ${url}`);
            db.del(cacheKey);
        }
    }

    // Deduplication Logic
    // If a request for this URL is already in flight, return the existing promise
    if (pendingRequests.has(url)) {
        console.log(`[Cache] Deduping in-flight request: ${url}`);
        return pendingRequests.get(url);
    }

    console.log(`[Cache] Miss: ${url}`);

    // Merge options with credentials: 'omit' to avoid sending problematic cookies
    const fetchOptions = { ...options, credentials: 'omit' };

    // Create the promise and store it
    const requestPromise = (async () => {
        try {
            const response = await fetch(url, fetchOptions);
            if (!response.ok) throw new Error('Network response was not ok');
            const data = await response.json();

            // Cache Success
            try {
                // Store object directly
                await db.set(cacheKey, { timestamp: now, data });
            } catch (e) {
                console.warn('[Cache] Failed to set item in DB:', e);
            }
            return data;
        } finally {
            // Cleanup pending request regardless of success/failure
            pendingRequests.delete(url);
        }
    })();

    pendingRequests.set(url, requestPromise);
    return requestPromise;
}

async function fetchStopRoutes(stopId) {
    // Try raw ID first as seen in HAR/Curl (e.g. "1:1000")
    // Some APIs handle encoded vs unencoded differently.
    return await fetchWithCache(`${API_BASE_URL}/stops/${encodeURIComponent(stopId)}/routes?locale=en`, {
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
    return await fetchWithCache(`${v3Base}/routes/${encodeURIComponent(routeId)}/schedule?patternSuffix=0:01&locale=en`, {
        headers: { 'x-api-key': API_KEY }
    });
}

async function fetchMetroSchedulePattern(routeId, patternSuffix) {
    const v3Base = API_BASE_URL.replace('/v2', '/v3');
    return await fetchWithCache(`${v3Base}/routes/${routeId}/schedule?patternSuffix=${patternSuffix}&locale=en`, {
        headers: { 'x-api-key': API_KEY }
    });
}




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

function addStopsToMap(stops) {
    // Cleanup existing layers/sources if they exist (idempotency)
    const layers = ['metro-layer-label', 'metro-layer-circle', 'metro-transfer-layer', 'metro-lines-layer', 'stops-layer', 'stops-layer-circle'];
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

    const ALL_METRO_NAMES = [...RED_LINE_ORDER, ...GREEN_LINE_ORDER, ...GREEN_LINE_STOPS];

    const busStops = [];
    const metroFeatures = [];
    const seenMetroNames = new Set();

    stops.forEach(stop => {
        // Inject Bearing: Prioritize Override, then Default Config, then 0
        if (stop.bearing === undefined) {
            stop.bearing = stopBearings[stop.id] || 0;
        }

        // Robust Metro Check
        const nameMatch = ALL_METRO_NAMES.some(m => stop.name.includes(m));
        const codeMissing = !stop.code || stop.code.length === 0 || !stop.code.match(/^\d+$/);

        const isMetro = stop.vehicleMode === 'SUBWAY' ||
            stop.name.includes('Metro Station') ||
            (stop.id && stop.id.startsWith('M:')) ||
            (nameMatch && codeMissing);

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
            if (filterState.picking) {
                let selectedFeature = null;

                // Loop through ALL features at this point to find a selectable one (handle z-overlap)
                for (const f of e.features) {
                    const p = f.properties;
                    const normId = redirectMap.get(p.id) || p.id;

                    // Exclude Origin, but allow any reachable/highlighted
                    // Actually hover effect logic: we want to draw line to POTENTIAL target.
                    // Usually we only draw to reachable stops.
                    if (filterState.reachableStopIds.has(normId) || filterState.targetIds.has(normId)) {
                        selectedFeature = f;
                        break;
                    }
                }

                if (selectedFeature) {
                    // Pass Current Selection + Hover ID
                    updateConnectionLine(filterState.originId, filterState.targetIds, true, selectedFeature.properties.id);
                }
            }
        });

        map.on('mouseleave', layerId, () => {
            if (filterState.picking) {
                // Revert to just the selected lines (remove hover line)
                // Pass false for isHover
                updateConnectionLine(filterState.originId, filterState.targetIds, false);
            }
        });
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
                'text-halo-color': '#ffffff',
                'text-halo-width': 2,
                'text-allow-overlap': false
            },
            paint: {
                'text-color': '#000000'
            }
        });
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
    if (window.ignoreMapClicks || window.isPickModeActive) {
        console.log('[Debug] Map Click Ignored (Lock Active or Pick Mode)');
        return;
    }

    const props = e.features[0].properties;

    // FILTER PICKING MODE
    if (filterState.picking) {
        let selectedFeature = null;

        // Loop through ALL features at this point to find a selectable one (handle z-overlap)
        for (const f of e.features) {
            const p = f.properties;
            const normId = redirectMap.get(p.id) || p.id;
            // Exclude originId from being selectable in filter mode
            const isSelectable = filterState.reachableStopIds.has(normId) || filterState.targetIds.has(normId);
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

// Reuse same click logic for stops-layer-circle
map.on('click', 'stops-layer-circle', async (e) => {
    // Check Click Lock
    if (window.ignoreMapClicks || window.isPickModeActive) {
        return;
    }

    const props = e.features[0].properties;

    // FILTER PICKING MODE
    if (filterState.picking) {
        let selectedFeature = null;
        for (const f of e.features) {
            const p = f.properties;
            const normId = redirectMap.get(p.id) || p.id;
            const isSelectable = filterState.reachableStopIds.has(normId) || filterState.targetIds.has(normId);
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

    map.flyTo({
        center: coordinates,
        zoom: targetZoom
    });

    const feature = {
        type: 'Feature',
        geometry: e.features[0].geometry,
        properties: props
    };
    map.getSource('selected-stop').setData({
        type: 'FeatureCollection',
        features: [feature]
    });

    const stopData = { ...props, lat: coordinates[1], lon: coordinates[0] };
    showStopInfo(stopData, true, false);
});

// Metro Click Handlers (Same logic as stops-layer)
const metroLayers = ['metro-layer-circle', 'metro-layer-label', 'metro-transfer-layer'];
metroLayers.forEach(layerId => {
    map.on('click', layerId, async (e) => {
        const props = e.features[0].properties;

        // FILTER PICKING MODE
        if (filterState.picking) {
            let selectedFeature = null;

            // Loop through ALL features at this click point
            for (const f of e.features) {
                const p = f.properties;
                const normId = redirectMap.get(p.id) || p.id;
                // Exclude originId from being selectable in filter mode
                const isSelectable = filterState.reachableStopIds.has(normId) || filterState.targetIds.has(normId);
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
    map.on('mouseenter', layerId, (e) => {
        if (filterState.picking) {
            const hasSelectable = e.features.some(f => {
                const p = f.properties;
                const normId = redirectMap.get(p.id) || p.id;
                return filterState.reachableStopIds.has(normId) || filterState.targetIds.has(normId);
            });
            if (!hasSelectable) return;
        }
        map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', layerId, () => {
        map.getCanvas().style.cursor = '';
    });
});

// Add pointer cursor for stops-layer
// Add pointer cursor for stops-layer and stops-layer-circle
const busLayers = ['stops-layer', 'stops-layer-circle'];
busLayers.forEach(layerId => {
    map.on('mouseenter', layerId, (e) => {
        if (filterState.picking) {
            const hasSelectable = e.features.some(f => {
                const p = f.properties;
                const normId = redirectMap.get(p.id) || p.id;
                return filterState.reachableStopIds.has(normId) || filterState.targetIds.has(normId);
            });

            if (!hasSelectable) return;
        }
        map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', layerId, () => {
        map.getCanvas().style.cursor = '';
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
    if (!filterState.picking && !window.isPickModeActive) return;

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
        Router.updateStop(stop.id, filterState.active, Array.from(filterState.targetIds));
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

    // Toggle Edit Button Visibility
    const editBtn = document.getElementById('btn-edit-stop');
    if (editBtn) {
        const isLocalhost = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
        if (isMetro || !isLocalhost) {
            editBtn.classList.add('hidden');
            editBtn.style.display = 'none';
        } else {
            editBtn.classList.remove('hidden');
            editBtn.style.display = ''; // Reset to default (flex/block)
        }
    }


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
                                        ? (() => {
                                            const diff = upcoming[0].diff;
                                            const time = upcoming[0].time;
                                            const displayTime = diff < 60 ? `${diff} min` : time;
                                            return `<div class="time-container">
                                                       <div class="time scheduled-time">${displayTime}</div>
                                                       <div class="scheduled-disclaimer">Scheduled</div>
                                                   </div>`;
                                        })()
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
        // Optimization: Only fetch if NOT already in stopToRoutesMap
        const routePromises = idsAndParent.map(id => {
            if (stopToRoutesMap.has(id) && stopToRoutesMap.get(id).length > 0) {
                console.log(`[Optimization] Routes for ${id} already loaded. Skipping fetch.`);
                // Return wrapped promise compatible with the result structure (array of routes)
                return Promise.resolve(stopToRoutesMap.get(id));
            }
            return fetchStopRoutes(id).catch(e => { console.warn(`fetchStopRoutes failed for ${id}:`, e); return []; });
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
    const equivalentIds = getEquivalentStops(stopId);
    const idsToCheck = new Set();
    equivalentIds.forEach(eqId => {
        idsToCheck.add(eqId);
        // Also add any direct merges into this equivalent ID
        const subIds = mergeSourcesMap.get(eqId) || [];
        subIds.forEach(sId => idsToCheck.add(sId));
    });

    // Fetch all in parallel
    const promises = Array.from(idsToCheck).map(id =>
        fetch(`${API_BASE_URL}/stops/${encodeURIComponent(id)}/arrival-times?locale=en&ignoreScheduledArrivalTimes=false`, {
            headers: { 'x-api-key': API_KEY }
        }).then(res => {
            if (!res.ok) return [];
            return res.json();
        }).catch(err => {
            console.warn(`Failed to fetch arrivals for equivalent ID ${id}:`, err);
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
    schedules: new Map(), // routeId:suffix:date -> schedule
    polylines: new Map() // routeId:suffix -> polyline data
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

        // 2. Network Fetch
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
            await db.set(V3_ROUTES_CACHE_KEY, {
                timestamp: Date.now(),
                data: Array.from(v3RoutesMap.entries())
            });

        } catch (err) {
            console.warn('[V3] Error fetching routes map:', err);
            // Don't set v3RoutesMap to null if we can help it, but here we have nothing.
            // If cache failed AND network failed, we are stuck.
            // But we should probably throttle retries?
            // For now, allow retry on next call, but the cache check above helps if cache was valid.
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

// Retry Utility
async function fetchWithRetry(url, options = {}, retries = 3, backoff = 1000) {
    try {
        const res = await fetch(url, options);
        // Retry on 5xx errors
        if (retries > 0 && res.status >= 500 && res.status < 600) {
            console.warn(`[Network] 5xx Error (${res.status}) fetching ${url}. Retrying in ${backoff}ms... (${retries} left)`);
            await new Promise(r => setTimeout(r, backoff));
            return fetchWithRetry(url, options, retries - 1, backoff * 2);
        }
        return res;
    } catch (err) {
        // Retry on network failures (fetch throws)
        if (retries > 0) {
            console.warn(`[Network] Connection Failed fetching ${url}. Retrying in ${backoff}ms... (${retries} left). Error: ${err.message}`);
            await new Promise(r => setTimeout(r, backoff));
            return fetchWithRetry(url, options, retries - 1, backoff * 2);
        }
        throw err;
    }
}

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
                    const cached = await db.get(lsKey);
                    if (cached) {
                        const { timestamp, data } = cached;
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
                        const suffixesRes = await fetchWithRetry(`${API_V3_BASE_URL}/routes/${routeId}?locale=en`, {
                            headers: { 'x-api-key': API_KEY },
                            credentials: 'omit'
                        });
                        if (!suffixesRes.ok) throw new Error(`Routes details failed: ${suffixesRes.status}`);
                        const routeData = await suffixesRes.json();

                        if (routeData.patterns) {
                            const suffixes = routeData.patterns.map(p => p.patternSuffix).join(',');
                            const patRes = await fetchWithRetry(`${API_V3_BASE_URL}/routes/${routeId}/stops-of-patterns?patternSuffixes=${suffixes}&locale=en`, {
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
                                await db.set(`v3_patterns_${routeId}`, {
                                    timestamp: Date.now(),
                                    data: patterns
                                });
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
            let potentialIds = Array.from(getEquivalentStops(stopId)); // Use hub equivalents
            potentialIds.push(...Array.from(mergeSourcesMap.get(stopId) || [])); // Also check merged sources

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
                    const cached = await db.get(lsKey);
                    if (cached) {
                        const { timestamp, data } = cached;
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
                                await db.set(`v3_sched_${cacheKey}`, {
                                    timestamp: Date.now(),
                                    data: schedule
                                });
                            } catch (e) {
                                console.warn('LS Write Failed (Schedule)', e);
                            }
                        }
                    } catch (e) {
                        console.error(`[V3] Schedule fetch error`, e);
                    } finally {
                        v3InFlight.schedules.delete(cacheKey);
                    }
                }
            }

            if (!schedule) return null;

            // 4. Parse Schedule
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
        } catch (e) {
            console.error('[V3] Critical Error:', e);
            return null;
        }
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

// Helper for Synchronous Cache Lookup (Removed - IDB is async)
function getV3ScheduleSync(routeShortName, stopId) {
    return null; // Force async fallback
}



function renderArrivals(arrivals, currentStopId = null) {
    const listEl = document.getElementById('arrivals-list');
    listEl.innerHTML = '';

    const stopId = currentStopId || window.currentStopId;

    // 1. Identify "Missing" Routes
    let extraRoutes = [];
    if (stopId) {
        const equivalentIds = getEquivalentStops(stopId);
        const servingRoutes = new Set();
        equivalentIds.forEach(eqId => {
            const routes = stopToRoutesMap.get(eqId) || [];
            routes.forEach(r => servingRoutes.add(r));
        });

        const arrivalRouteShortNames = new Set(arrivals.map(a => String(a.shortName)));
        extraRoutes = Array.from(servingRoutes).filter(r => !arrivalRouteShortNames.has(String(r.shortName)));
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
            color: (filterState.active && RouteFilterColorManager.getColorForRoute(allRoutes.find(r => r.shortName === a.shortName)?.id))
                ? RouteFilterColorManager.getColorForRoute(allRoutes.find(r => r.shortName === a.shortName)?.id)
                : (a.color ? `#${a.color}` : 'var(--primary)'),
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

            color: (filterState.active && RouteFilterColorManager.getColorForRoute(r.id))
                ? RouteFilterColorManager.getColorForRoute(r.id)
                : (r.color ? `#${r.color}` : 'var(--primary)'),
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

    console.log(`[Refresh] Processed Stops: ${freshStops.length} -> ${stops.length} (Bus: ${busStops.length}, Metro: ${metroStops.length})`);
    allStops = stops;
    window.allStops = allStops;

    // UPDATE MAP SOURCES
    if (map.getSource('stops')) {
        map.getSource('stops').setData({
            type: 'FeatureCollection',
            features: busStops.map(stop => ({
                type: 'Feature',
                geometry: {
                    type: 'Point',
                    coordinates: [stop.lon, stop.lat]
                },
                properties: {
                    id: stop.id,
                    name: stop.name,
                    lat: stop.lat,
                    lon: stop.lon,
                    bearing: stop.bearing,
                    mode: stop.mode
                }
            }))
        });
        console.log('[Main] Map source "stops" updated (Bus).');
    }

    if (map.getSource('metro-stops')) {
        map.getSource('metro-stops').setData({
            type: 'FeatureCollection',
            features: metroStops.map(stop => ({
                type: 'Feature',
                geometry: {
                    type: 'Point',
                    coordinates: [stop.lon, stop.lat]
                },
                properties: {
                    id: stop.id,
                    name: stop.name
                }
            }))
        });
        console.log('[Main] Map source "metro-stops" updated.');
    }
}
// Search Logic
function setupSearch() {
    const input = document.getElementById('search-input');
    const suggestions = document.getElementById('search-suggestions');
    const clearBtn = document.getElementById('search-clear');
    let debounceTimeout;

    // DEBUG: Log clicks in suggestions to diagnose blocking
    suggestions.addEventListener('click', (e) => {
        console.log('[UI Debug] Suggestions Clicked:', e.target.tagName, e.target.className);
    });

    function updateClearBtn() {
        if (input.value.length > 0) {
            clearBtn.classList.remove('hidden');
        } else {
            clearBtn.classList.add('hidden');
        }
    }

    clearBtn.addEventListener('click', () => {
        input.value = '';
        input.focus();
        updateClearBtn();
        renderFullHistory();
    });

    // Show history on focus if empty
    input.addEventListener('focus', () => {
        if (input.value.trim() === '') {
            renderFullHistory();
        }
    });

    input.addEventListener('input', (e) => {
        const query = e.target.value.toLowerCase();
        updateClearBtn();

        clearTimeout(debounceTimeout);
        debounceTimeout = setTimeout(async () => {

            if (query.length < 2) {
                if (query.length === 0) {
                    renderFullHistory();
                    return;
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
                // Force English language for addresses
                const geocodingUrl = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json?access_token=${mapboxgl.accessToken}&country=ge&language=en&types=place,address,poi&limit=5`;
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

function renderFullHistory(expanded = false) {
    const container = document.getElementById('search-suggestions');

    // Get Data
    const searchLimit = expanded ? 15 : 5;
    const recentSearches = historyManager.getRecentSearches(searchLimit);
    const recentCards = historyManager.getRecentCards(10); // Always 10

    // --- 1. Recently Searched ---

    container.innerHTML = '';

    // --- 1. Recently Searched ---
    if (recentSearches.length > 0) {
        // Create Header with Clear Button
        const header = document.createElement('div');
        header.className = 'suggestion-header';
        header.style.cssText = 'padding: 12px 16px 4px; font-size: 0.75rem; color: var(--text-light); font-weight: 600; background: #fff; display: flex; justify-content: space-between; align-items: center;';

        const title = document.createElement('span');
        title.innerText = 'RECENTLY SEARCHED';
        header.appendChild(title);

        const clearBtn = document.createElement('span');
        clearBtn.innerText = 'CLEAR ALL';
        clearBtn.style.cssText = 'font-size: 0.65rem; color: #ef4444; cursor: pointer; letter-spacing: 0.5px;';
        clearBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (confirm('Clear search history?')) {
                historyManager.clearSearchHistory();
                renderFullHistory();
            }
        });
        header.appendChild(clearBtn);

        container.appendChild(header);

        recentSearches.forEach(item => {
            const div = createSuggestionElement(item, 'search');
            container.appendChild(div);
        });

        // "Show More" Button
        if (!expanded && historyManager.getRecentSearches(15).length > 5) {
            const moreBtn = document.createElement('div');
            moreBtn.className = 'suggestion-item show-more-btn'; // Added class
            moreBtn.style.color = 'var(--primary)';
            moreBtn.style.fontWeight = '600';
            moreBtn.style.justifyContent = 'center';
            moreBtn.innerHTML = 'Show more...';
            moreBtn.addEventListener('click', (e) => {
                e.stopPropagation(); // Prevent closing
                renderFullHistory(true); // Re-render expanded
            });
            container.appendChild(moreBtn);
        }
    }

    // --- 2. Recent Cards ---
    // Only show if not expanded? User said "after this first section show 10 recent cards, dont put a show more button there"
    // I assume show it always.
    if (recentCards.length > 0) {
        container.innerHTML += '<div class="suggestion-header" style="padding: 12px 16px 4px; font-size: 0.75rem; color: var(--text-light); font-weight: 600; background: #fff; border-top: 1px solid #f3f4f6; margin-top: 4px;">RECENT CARDS</div>';

        recentCards.forEach(item => {
            // Deduplicate? If it's in Recent Searches, maybe don't show here?
            // "recent cards" might overlap. I'll just show them raw as requested.
            const div = createSuggestionElement(item, 'card');
            container.appendChild(div);
        });
    }

    // Empty State
    if (recentSearches.length === 0 && recentCards.length === 0) {
        container.innerHTML = `
            <div style="padding: 20px; text-align: center; color: var(--text-light); font-size: 0.9rem;">
                <div style="font-size: 1.5rem; margin-bottom: 8px;">🔍</div>
                <div>Type to search for stops,<br>routes, or addresses</div>
            </div>
        `;
    }

    container.classList.remove('hidden');
}

function createSuggestionElement(item, historyType = null) {
    const div = document.createElement('div');
    div.className = 'suggestion-item';

    // Data extraction
    // item.data might be the object, or item might be the object if passed directly?
    // HistoryManager stores { type, id, data: fullObject }
    const type = item.type || (item.geometry ? 'place' : (item.stops ? 'route' : 'stop')); // Fallback inference
    const data = item.data || item;
    const isHistory = !!historyType;

    let iconHTML = '';
    let textHTML = '';

    if (type === 'route') {
        const route = data;
        iconHTML = `<div class="suggestion-icon route" style="background: ${isHistory ? '#f3f4f6' : '#dcfce7'}; color: ${isHistory ? '#6b7280' : '#16a34a'};">${isHistory ? '🕒' : '🚌'}</div>`;
        textHTML = `
            <div style="font-weight:600;">Route ${route.shortName}</div>
            <div class="suggestion-subtext">${route.longName}</div>
        `;
    } else if (type === 'stop') {
        const stop = data;
        iconHTML = `<div class="suggestion-icon stop" style="background: ${isHistory ? '#f3f4f6' : '#e0f2fe'}; color: ${isHistory ? '#6b7280' : '#0284c7'};">${isHistory ? '🕒' : '🚏'}</div>`;
        textHTML = `
            <div style="font-weight:600;">${stop.name}</div>
            <div class="suggestion-subtext">Code: ${stop.code || 'N/A'}</div>
        `;
    } else if (type === 'place') {
        iconHTML = `<div class="suggestion-icon place" style="background: ${isHistory ? '#f3f4f6' : '#eef2ff'}; color: ${isHistory ? '#6b7280' : '#4f46e5'};">${isHistory ? '🕒' : '📍'}</div>`;
        textHTML = `
            <div style="font-weight:600;">${data.text}</div>
            <div class="suggestion-subtext">${data.place_name}</div>
        `;
    }

    div.innerHTML = `
        ${iconHTML}
        <div class="suggestion-text">
            ${textHTML}
        </div>
    `;

    // Click Action
    div.addEventListener('click', () => {
        if (!isHistory) {
            // Ensure ID is captured correctly based on type
            let id = data.id;
            if (type === 'stop') id = data.id || data.stopId || data.code;
            if (type === 'route') id = data.id || data.routeId || data.shortName; // Fallback to shortName if needed

            historyManager.addSearch({ type, id, data });
        }

        if (type === 'route') showRouteOnMap(data);
        else if (type === 'stop') {
            map.flyTo({ center: [data.lon, data.lat], zoom: 16 });
            showStopInfo(data);
        } else if (type === 'place') {
            const coords = data.center;
            map.flyTo({ center: coords, zoom: 16 });
            new mapboxgl.Marker().setLngLat(coords).addTo(map);
        }
        document.getElementById('search-suggestions').classList.add('hidden');
    });

    // Delete Button (if history)
    if (isHistory) {
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'suggestion-delete-btn';
        deleteBtn.innerHTML = `
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
        `;
        deleteBtn.title = "Remove from history";
        deleteBtn.addEventListener('click', (e) => {
            e.stopPropagation(); // Stop click from triggering item selection
            console.log('[UI] Delete button clicked for', item.type, item.id);

            // Check expansion state BEFORE removing (simple heuristic: if "Show more" is absent but we have >5, likely expanded)
            // Or just check if the list currently has > 6 items?
            // Let's assume collapsed unless we see > 5 Search items visible?
            const searchItemsVisible = document.querySelectorAll('.suggestion-icon.stop, .suggestion-icon.route, .suggestion-icon.place').length;
            // This counts everything.
            // Better: Check if `.show-more-btn` exists.
            const showMoreExists = !!document.querySelector('.show-more-btn');
            const wasExpanded = !showMoreExists;

            if (historyType === 'search') {
                historyManager.removeSearch(item);
            } else if (historyType === 'card') {
                historyManager.removeCard(item);
            }

            renderFullHistory(wasExpanded);
        });
        div.appendChild(deleteBtn);
    }

    return div;
}

// Helper to keep old function signature working or replaced
// renderSuggestions calls this internal Logic? No, renderSuggestions handles new search results.
// We need to update renderSuggestions to use createSuggestionElement key logic or similar.

function renderSuggestions(stops, routes, places = []) {
    const container = document.getElementById('search-suggestions');
    container.innerHTML = '';

    if (stops.length === 0 && routes.length === 0 && places.length === 0) {
        container.classList.add('hidden');
        return;
    }

    // Render Routes
    routes.forEach(route => {
        const div = createSuggestionElement({ type: 'route', data: route }, null);
        container.appendChild(div);
    });

    // Render Stops
    stops.forEach(stop => {
        const div = createSuggestionElement({ type: 'stop', data: stop }, null);
        container.appendChild(div);
    });

    // Render Places
    places.forEach(place => {
        const div = createSuggestionElement({ type: 'place', data: place }, null);
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

    // Update URL
    Router.updateRoute(route.shortName, currentPatternIndex);
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
                const stopsPromises = patterns.map(p => fetchRouteStopsV3(route.id, p.patternSuffix).then(stops => ({
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
        const currentPatternStops = await fetchRouteStopsV3(route.id, currentPattern.patternSuffix);
        if (requestId !== lastRouteUpdateId) return; // Stale check

        const originStop = currentPatternStops[0]?.name || '';
        const destinationStop = currentPatternStops[currentPatternStops.length - 1]?.name || currentPattern.headsign;

        if (patterns.length > 1) {
            switchBtn.classList.remove('hidden');
            switchBtn.onclick = () => {
                currentPatternIndex = (currentPatternIndex + 1) % patterns.length;
                updateRouteView(route, { preserveBounds: true }); // Keep bounds when switching directions
                Router.updateRoute(route.shortName, currentPatternIndex);
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

async function fetchRouteDetailsV3(routeId) {
    return await fetchWithCache(`${API_BASE_URL.replace('/v2', '/v3')}/routes/${encodeURIComponent(routeId)}`, {
        headers: { 'x-api-key': API_KEY }
    });
}



async function fetchRouteStopsV3(routeId, patternSuffix) {
    return await fetchWithCache(`${API_BASE_URL.replace('/v2', '/v3')}/routes/${encodeURIComponent(routeId)}/stops?patternSuffix=${encodeURIComponent(patternSuffix)}`, {
        headers: { 'x-api-key': API_KEY }
    });
}

async function fetchBusPositionsV3(routeId, patternSuffix) {
    const response = await fetch(`${API_BASE_URL.replace('/v2', '/v3')}/routes/${encodeURIComponent(routeId)}/positions?patternSuffixes=${encodeURIComponent(patternSuffix)}`, {
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
    map.addImage('bus-arrow', imageData, { sdf: true });
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
        const originEq = getEquivalentStops(originId);
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

            const targetEq = getEquivalentStops(targetId);

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
            const isSelected = filterState.targetIds && filterState.targetIds.has(targetId);

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
            const isPersistent = filterState.targetIds && filterState.targetIds.has(targetId);

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

// Helper to fetch V3 route polyline (with caching)
async function fetchRoutePolylineV3(routeId, patternSuffixes) {
    const cacheKey = `/pis-gateway/api/v3/routes/${routeId}/polylines?patternSuffixes=${patternSuffixes}`;
    // Use v3Cache.polylines
    if (v3Cache.polylines.has(cacheKey)) {
        console.log('[Cache] Hit:', cacheKey);
        return v3Cache.polylines.get(cacheKey);
    }

    // Use Queue
    return enqueueV3Request(async () => {
        try {
            console.log('[Cache] Miss:', cacheKey);
            const res = await fetchWithRetry(`${API_V3_BASE_URL}/routes/${encodeURIComponent(routeId)}/polylines?patternSuffixes=${encodeURIComponent(patternSuffixes)}`, {
                headers: { 'x-api-key': API_KEY },
                credentials: 'omit'
            });

            if (!res.ok) throw new Error(`Polyline fetch failed: ${res.status}`);
            const data = await res.json();

            v3Cache.polylines.set(cacheKey, data);
            return data;
        } catch (error) {
            console.error('Failed to fetch polyline', error);
            throw error;
        }
    });
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
// --- Edit Tools Integration ---

let isEditing = false;
let editState = {
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
            stopEditing(true);
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
            <svg width="53" height="76" viewBox="0 0 53 76" fill="none" xmlns="http://www.w3.org/2000/svg">
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
