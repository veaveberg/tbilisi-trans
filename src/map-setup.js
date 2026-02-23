import mapboxgl from 'mapbox-gl';
import * as api from './api.js';

// Initialize Map
if (!api.MAPBOX_TOKEN) {
    throw new Error('Missing VITE_MAPBOX_TOKEN. Set it in .env.local or CI environment.');
}
mapboxgl.accessToken = api.MAPBOX_TOKEN;
if (typeof mapboxgl.setTelemetryEnabled === 'function') {
    mapboxgl.setTelemetryEnabled(false);
}
// Mapbox GL v3 uses a config getter; override to silence telemetry posts when possible.
if (mapboxgl.config && typeof Object.defineProperty === 'function') {
    try {
        Object.defineProperty(mapboxgl.config, 'EVENTS_URL', { value: null });
    } catch (e) {
        // Non-fatal: some builds may not allow redefining the property.
    }
}

// Determine Initial Theme for Mapbox (Prevent Flash)
const storedTheme = localStorage.getItem('theme') || 'system';
const sysDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
const isDark = storedTheme === 'dark' || (storedTheme === 'system' && sysDark);
const initialLightPreset = isDark ? 'night' : 'day';

export const map = new mapboxgl.Map({
    container: 'map',
    style: 'mapbox://styles/mapbox/standard', // Standard style
    config: {
        basemap: {
            lightPreset: initialLightPreset,
            show3dObjects: false, // Back to false by default (will toggle on tilt)
            showPointOfInterestLabels: localStorage.getItem('showPoiLabels') === 'true',
            showTransitLabels: false
        }
    },
    center: [44.78, 41.72], // Tbilisi center
    zoom: 12,
    trackResize: false
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

export function getMapHash() {
    const center = map.getCenter();
    const zoom = map.getZoom();
    return `#${zoom.toFixed(2)}/${center.lat.toFixed(5)}/${center.lng.toFixed(5)}`;
}

// Debug: Trace Map Movement
const originalFlyTo = map.flyTo.bind(map);
map.flyTo = (args, options) => {
    return originalFlyTo(args, options);
};

// Aggressive Resize Logic for iOS PWA
function resizeMap() {
    map.resize();
}

window.addEventListener('orientationchange', resizeMap);
window.addEventListener('resize', resizeMap);

map.on('load', () => {
    resizeMap();
    setTimeout(resizeMap, 100);
    setTimeout(resizeMap, 500);
    setTimeout(resizeMap, 1000);
});

const resizeObserver = new ResizeObserver(() => {
    resizeMap();
});
resizeObserver.observe(document.getElementById('map'));

map.on('error', (e) => {
    if (e && e.error) {
        const msg = e.error.message || '';
        if (msg.includes('ERR_BLOCKED_BY_CLIENT') || msg.includes('Failed to fetch') || msg.includes('NetworkError')) {
            return;
        }
    }
    console.warn('[Mapbox] Error:', e);
});
