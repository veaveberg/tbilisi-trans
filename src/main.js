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
    // Debug: serialization to see what 'e' actually is on the wrapped event
    let msg = 'Unknown Error';
    try {
        // Try standard PositionError
        if (e.code) msg = `Error ${e.code}: ${e.message}`;
        // Try valid mapbox event wrapper
        else if (e.error && e.error.code) msg = `Error ${e.error.code}: ${e.error.message}`;
        // Fallback: Dump keys
        else msg = JSON.stringify(e);
    } catch (err) {
        msg = 'Serialization Failed';
    }

    alert(`DEBUG: ${msg}`);

    if (e.code === 1 || (e.error && e.error.code === 1)) { // PERMISSION_DENIED
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
        alert('Geolocate is already active/watching.');
    }

    // 2. Request Compass Permission (Secondary, iOS only)
    // DISABLED FOR DEBUGGING to isolate Location request
    /*
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
        setTimeout(async () => {
            try {
                const permissionState = await DeviceOrientationEvent.requestPermission();
                if (permissionState !== 'granted') {
                    console.warn('Compass (Motion) permission denied');
                }
            } catch (e) {
                console.debug('Compass permission request failed', e);
            }
        }, 100);
    }
    */
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
        filter: ['!=', 'mode', 'SUBWAY'], // Don't hide Metro icons with generic pin
        layout: {
            'icon-image': 'stop-selected-icon',
            'icon-size': [
                'interpolate',
                ['linear'],
                ['zoom'],
                13, 0.6,
                14, 1.0,
                16, 1.2
            ],
            'icon-allow-overlap': true,
            'icon-ignore-placement': true, // Show even if it collides (it's the selected one!)
            // Rotate selected stop always (if bearing exists)
            'icon-rotate': ['get', 'bearing'],
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
    const response = await fetch(url, options);
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
                    'stop-far-away-icon', // Default (< 14)
                    14, 'stop-icon',      // Mid zoom (14-16)
                    16.5, 'stop-close-up-icon' // High zoom (> 16.5)
                ],
                'icon-size': [
                    'interpolate',
                    ['linear'],
                    ['zoom'],
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
    const coordinates = e.features[0].geometry.coordinates.slice();
    const props = e.features[0].properties;

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
        const coordinates = e.features[0].geometry.coordinates.slice();
        const props = e.features[0].properties;

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


async function showStopInfo(stop, addToStack = true, flyToStop = false) {
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
        // Construct a feature
        if (stop.lon && stop.lat) {
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
            }
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

        // --- Build All Routes (Header Extension) ---
        const headerExtension = document.getElementById('header-extension');
        if (headerExtension) {
            headerExtension.innerHTML = ''; // Clear previous

            // Deduplicate Routes (Prioritize Parent aka first fetched)
            // Map: shortName -> routeObj
            const uniqueRoutesMap = new Map();

            allFetchedRoutes.forEach(r => {
                if (!uniqueRoutesMap.has(r.shortName)) {
                    uniqueRoutesMap.set(r.shortName, r);
                }
            });

            // Convert back to array
            let routesForStop = Array.from(uniqueRoutesMap.values());

            // Merge with arrivals for robustness (in case static schedule missed something live)
            if (arrivals && arrivals.length > 0) {
                arrivals.forEach(arr => {
                    if (!uniqueRoutesMap.has(arr.shortName)) {
                        // Create phantom route entry for live-only bus
                        const fullRoute = allRoutes.find(r => r.shortName === arr.shortName);
                        const newRoute = fullRoute || { shortName: arr.shortName, id: null, color: '2563eb' };

                        uniqueRoutesMap.set(arr.shortName, newRoute);
                        routesForStop.push(newRoute);
                    }
                });
            }

            if (routesForStop.length > 0) {
                routesForStop.sort((a, b) => (parseInt(a.shortName) || 0) - (parseInt(b.shortName) || 0));

                const container = document.createElement('div');
                container.className = 'all-routes-container';
                // Remove padding from container itself if managed by CSS, but style.css has it.

                const tilesContainer = document.createElement('div');
                tilesContainer.className = 'route-tiles-container';

                routesForStop.forEach(route => {
                    const tile = document.createElement('button');
                    tile.className = 'route-tile';
                    tile.textContent = route.shortName;
                    const color = route.color || '2563eb';
                    // Style: Light BG, Dark Text
                    tile.style.backgroundColor = `#${color}20`; // 12% opacity
                    tile.style.color = `#${color}`;
                    tile.style.fontWeight = '700';

                    tile.addEventListener('click', (e) => {
                        e.stopPropagation();
                        if (route.id) {
                            showRouteOnMap(route);
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



        // --- Render Arrivals ---
        renderArrivals(arrivals);

    } catch (error) {
        listEl.innerHTML = '<div class="error">Failed to load arrivals</div>';
        console.error(error);
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
    const combined = results.flat();

    // Dedup by simple key (route + time + headsign)?
    // Or just let them pile up? 
    // Usually duplicates happen if data is identical.
    // Let's rely on simple dedup by JSON string if identical?
    // Or deduplicate by vehicleId if available?
    // Let's dedup by (shortName + arrivalTime).

    const unique = [];
    const seen = new Set();
    combined.forEach(a => {
        const key = `${a.shortName}_${a.realtimeArrivalMinutes}_${a.headsign}`;
        if (!seen.has(key)) {
            seen.add(key);
            unique.push(a);
        }
    });

    // Sort by time
    unique.sort((a, b) => a.realtimeArrivalMinutes - b.realtimeArrivalMinutes);

    return unique;
}

function renderArrivals(arrivals) {
    const listEl = document.getElementById('arrivals-list');
    listEl.innerHTML = '';

    if (arrivals.length === 0) {
        listEl.innerHTML = '<div class="empty">No upcoming arrivals</div>';
        return;
    }

    arrivals.forEach(arrival => {
        const item = document.createElement('div');
        item.className = 'arrival-item';

        // Color based on route color if available
        const color = arrival.color ? `#${arrival.color}` : 'var(--primary)';
        item.style.borderLeftColor = color;

        item.innerHTML = `
      <div class="route-number" style="color: ${color}">${arrival.shortName}</div>
      <div class="destination" title="${arrival.headsign}">${arrival.headsign}</div>
      <div class="time">${arrival.realtimeArrivalMinutes} min</div>
    `;

        // Find route object to attach click handler
        const routeObj = allRoutes.find(r => r.shortName === arrival.shortName);

        if (routeObj) {
            // When clicking from a stop, we want to initiate a specific direction if possible
            // But for now, just showing the route with context
            item.addEventListener('click', () => {
                showRouteOnMap(routeObj, true, {
                    preserveBounds: true,
                    fromStopId: window.currentStopId
                });
            });
        }

        listEl.appendChild(item);
    });
}

// Search Logic
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

        // Auto-Direction Logic: Find pattern that contains the fromStopId
        if (options.fromStopId && patterns.length > 0) {
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

// Close panel
document.getElementById('close-panel').addEventListener('click', () => {
    setSheetState(document.getElementById('info-panel'), 'hidden');
    // Remove highlight
    if (map.getSource('selected-stop')) {
        map.getSource('selected-stop').setData({ type: 'FeatureCollection', features: [] });
    }
    clearHistory(); // Clear history on close
});

// Close Route Info
document.getElementById('close-route-info').addEventListener('click', () => {
    setSheetState(document.getElementById('route-info'), 'hidden');
    clearHistory(); // Clear history on close

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
});


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
