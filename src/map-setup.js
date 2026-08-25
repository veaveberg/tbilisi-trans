import mapboxgl from 'mapbox-gl';
import { Capacitor } from '@capacitor/core';
import * as api from './api.js';
import { getCurrentMapLanguage, onLanguageChange } from './i18n.ts';
import { attachMapPerformanceRecorder, markPerformanceEvent } from './performance-recorder.js';

function getMapboxLanguageValue(language = getCurrentMapLanguage()) {
    switch (language) {
        case 'ka':
            return ['ka', 'en'];
        case 'ru':
            return ['ru', 'en'];
        case 'en':
        default:
            return 'en';
    }
}

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
const BASEMAP_FONT = 'Open Sans';
const LOCAL_FONT_FAMILY = 'Roboto, Inter, Arial, "Helvetica Neue", Helvetica, sans-serif';
// Whole-country bounds. fitBounds derives a device-appropriate zoom from these.
export const GEORGIA_BOUNDS = Object.freeze([[40.0, 41.0], [46.8, 43.6]]);
export const GEORGIA_CENTER = Object.freeze({ lng: 43.4, lat: 42.3 });

export function getGeorgiaFitOptions(options = {}) {
    const compactViewport = Math.min(window.innerWidth, window.innerHeight) < 600;
    const padding = compactViewport ? 20 : 40;
    return {
        padding,
        maxZoom: 8,
        ...options
    };
}

export function fitMapToGeorgia(options = {}) {
    map.fitBounds(GEORGIA_BOUNDS, getGeorgiaFitOptions(options));
}

export function isMapViewportOutsideGeorgia() {
    const bounds = map.getBounds();
    const [[west, south], [east, north]] = GEORGIA_BOUNDS;
    return bounds.getEast() < west || bounds.getWest() > east ||
        bounds.getNorth() < south || bounds.getSouth() > north;
}

// Keep the reset affordance available when the whole country is no longer
// legible, while letting fitBounds choose the appropriate threshold per screen.
export function isMapZoomedOutBeyondGeorgia() {
    const fittedCamera = map.cameraForBounds(GEORGIA_BOUNDS, getGeorgiaFitOptions());
    const fittedZoom = fittedCamera?.zoom;
    return Number.isFinite(fittedZoom) && map.getZoom() < fittedZoom - 0.75;
}

export const map = new mapboxgl.Map({
    container: 'map',
    style: 'mapbox://styles/mapbox/standard', // Standard style
    language: getMapboxLanguageValue(),
    localFontFamily: LOCAL_FONT_FAMILY,
    config: {
        basemap: {
            font: BASEMAP_FONT,
            lightPreset: initialLightPreset,
            show3dObjects: false, // Back to false by default (will toggle on tilt)
            showPointOfInterestLabels: localStorage.getItem('showPoiLabels') !== 'false',
            showTransitLabels: false
        }
    },
    center: [GEORGIA_CENTER.lng, GEORGIA_CENTER.lat],
    zoom: 6,
    trackResize: false
});

attachMapPerformanceRecorder(map);
markPerformanceEvent('map:created', {
    center: [GEORGIA_CENTER.lng, GEORGIA_CENTER.lat],
    zoom: 6,
    style: 'mapbox://styles/mapbox/standard'
});

map.once('load', () => {
    fitMapToGeorgia({ duration: 0 });
});

function installTapDragZoomAnchorPatch() {
    const tapDragZoom = map.touchZoomRotate?._tapDragZoom;
    if (!tapDragZoom || tapDragZoom.__tapAnchorPatched) return;

    const originalReset = tapDragZoom.reset;
    const originalTouchstart = tapDragZoom.touchstart;
    const originalTouchmove = tapDragZoom.touchmove;

    tapDragZoom.reset = function patchedReset(...args) {
        this._anchorPoint = undefined;
        return originalReset.apply(this, args);
    };

    tapDragZoom.touchstart = function patchedTouchstart(e, points, mapTouches) {
        const result = originalTouchstart.call(this, e, points, mapTouches);
        if (this._tapTime && this._swipePoint && !this._anchorPoint) {
            // Keep the second tap point as the zoom anchor for the whole drag gesture.
            this._anchorPoint = this._swipePoint;
        }
        return result;
    };

    tapDragZoom.touchmove = function patchedTouchmove(e, points, mapTouches) {
        const result = originalTouchmove.call(this, e, points, mapTouches);
        if (result?.zoomDelta !== undefined && this._anchorPoint) {
            result.around = this._anchorPoint;
        }
        return result;
    };

    tapDragZoom.__tapAnchorPatched = true;
}

installTapDragZoomAnchorPatch();

export function updateMapLanguage(language = getCurrentMapLanguage()) {
    if (!map || typeof map.setLanguage !== 'function') return;
    try {
        map.setLanguage(getMapboxLanguageValue(language));
    } catch (error) {
        console.warn('[Map] Failed to update label language:', error);
    }
}

onLanguageChange((change) => {
    if (change.target !== 'map') return;
    updateMapLanguage(change.value);
});

const isNativeIOS = typeof Capacitor?.getPlatform === 'function' &&
    Capacitor.getPlatform() === 'ios' &&
    (typeof Capacitor.isNativePlatform !== 'function' || Capacitor.isNativePlatform());

function readSafeAreaInset(edge) {
    const probe = document.createElement('div');
    probe.style.position = 'fixed';
    probe.style.pointerEvents = 'none';
    probe.style.opacity = '0';
    if (edge === 'top') {
        probe.style.top = '0';
        probe.style.paddingTop = 'env(safe-area-inset-top)';
    } else {
        probe.style.bottom = '0';
        probe.style.paddingBottom = 'env(safe-area-inset-bottom)';
    }
    document.body.appendChild(probe);
    const styles = window.getComputedStyle(probe);
    const value = parseFloat(edge === 'top' ? styles.paddingTop : styles.paddingBottom);
    probe.remove();
    return Number.isFinite(value) ? value : 0;
}

// Suppress iOS text selection magnifier (loupe) on the map canvas.
// Keep this scoped to the canvas/container. Disabling WKWebView text interaction
// globally breaks native keyboard delivery for HTML inputs.
function installSelectionLoupeSuppressor() {
    const canvas = map.getCanvas();
    if (!canvas) return;

    const prevent = (e) => e.preventDefault();

    // Block the signal that triggers the iOS text-selection loupe.
    canvas.addEventListener('selectstart', prevent, { passive: false });
    canvas.addEventListener('contextmenu', prevent, { passive: false });

    // Also cover the full map container for markers/overlays that bubble up.
    const container = map.getContainer();
    if (container) {
        container.addEventListener('selectstart', prevent, { passive: false });
        container.addEventListener('contextmenu', prevent, { passive: false });
    }
}

function installIOSMapEdgePanGuard() {
    if (!isNativeIOS) return;

    const canvas = map.getCanvas();
    let dragPanTemporarilyDisabled = false;
    let topGuard = 44;
    let bottomGuard = 28;

    const updateGuardBounds = () => {
        topGuard = Math.max(44, readSafeAreaInset('top') + 12);
        bottomGuard = Math.max(28, readSafeAreaInset('bottom') + 12);
    };

    const releaseDragPan = () => {
        if (!dragPanTemporarilyDisabled) return;
        dragPanTemporarilyDisabled = false;
        if (!map.dragPan.isEnabled()) {
            map.dragPan.enable();
        }
    };

    updateGuardBounds();
    window.addEventListener('resize', updateGuardBounds);
    window.addEventListener('orientationchange', updateGuardBounds);

    canvas.addEventListener('touchstart', (event) => {
        if (event.touches.length !== 1) {
            releaseDragPan();
            return;
        }
        if (!map.dragPan.isEnabled()) return;

        const touch = event.touches[0];
        const isInTopGuard = touch.clientY <= topGuard;
        const isInBottomGuard = touch.clientY >= (window.innerHeight - bottomGuard);

        if (!isInTopGuard && !isInBottomGuard) return;

        dragPanTemporarilyDisabled = true;
        map.dragPan.disable();
    }, { passive: true });

    canvas.addEventListener('touchend', releaseDragPan, { passive: true });
    canvas.addEventListener('touchcancel', releaseDragPan, { passive: true });
}

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

// Aggressive Resize Logic for iOS PWA
function resizeMap() {
    map.resize();
}

window.addEventListener('orientationchange', resizeMap);
window.addEventListener('resize', resizeMap);

map.on('load', () => {
    installIOSMapEdgePanGuard();
    installSelectionLoupeSuppressor();
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
