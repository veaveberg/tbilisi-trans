import mapboxgl from 'mapbox-gl';
import * as api from './api.js';
import './style.css';

// Initialize Map
mapboxgl.accessToken = api.MAPBOX_TOKEN;

export const map = new mapboxgl.Map({
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

export function getMapHash() {
    const center = map.getCenter();
    const zoom = map.getZoom();
    return `#${zoom.toFixed(2)}/${center.lat.toFixed(5)}/${center.lng.toFixed(5)}`;
}

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

// listeners attached here to avoid exporting 'geolocate'
export function setupMapControls() {
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
}
