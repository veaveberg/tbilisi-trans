import mapboxgl from 'mapbox-gl';
import { Capacitor } from '@capacitor/core';
import * as api from './api.js';
import { getCurrentMapLanguage, onLanguageChange } from './i18n.ts';

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
    center: [44.78, 41.72], // Tbilisi center
    zoom: 12,
    trackResize: false
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

// Debug: Trace Map Movement and Viewport/Padding changes
const traceMapCall = (methodName, originalFunc) => {
    return function(...args) {
        let padding = null;
        if (methodName === 'setPadding' && args[0]) {
            padding = args[0];
        } else if (args[0] && typeof args[0] === 'object' && 'padding' in args[0]) {
            padding = args[0].padding;
        } else if (args[1] && typeof args[1] === 'object' && 'padding' in args[1]) {
            padding = args[1].padding;
        }

        if (padding) {
            console.log(`[Viewport] ${methodName}() -> padding:`, padding);
        } else if (methodName === 'resize') {
            console.log(`[Viewport] resize()`);
        } else {
            console.log(`[Viewport] ${methodName}()`);
        }

        try {
            const res = originalFunc.apply(this, args);
            if (methodName === 'resize') {
                const container = typeof this.getContainer === 'function' ? this.getContainer() : null;
                const rect = container ? container.getBoundingClientRect() : null;
                if (rect) {
                    console.log(`[Viewport] resize() -> size: ${Math.round(rect.width)}x${Math.round(rect.height)}`);
                }
            }
            return res;
        } catch (e) {
            console.error(`[Viewport] Error in ${methodName}:`, e);
            throw e;
        }
    };
};

const mapMethodsToTrace = ['flyTo', 'easeTo', 'fitBounds', 'jumpTo', 'setCenter', 'setZoom', 'setPadding', 'resize'];
for (const methodName of mapMethodsToTrace) {
    if (typeof map[methodName] === 'function') {
        const original = map[methodName].bind(map);
        map[methodName] = traceMapCall(methodName, original);
    }
}

map.on('resize', () => {
    const container = map.getContainer();
    const rect = container ? container.getBoundingClientRect() : null;
    console.log('[Viewport] Event "resize" triggered. Current dimensions:', rect ? { width: rect.width, height: rect.height } : null, 'Padding:', map.getPadding());
});

map.on('movestart', () => {
    console.log('[Viewport] Event "movestart" triggered. Center:', map.getCenter().toArray(), 'Zoom:', map.getZoom(), 'Padding:', map.getPadding());
});

map.on('moveend', () => {
    console.log('[Viewport] Event "moveend" triggered. Center:', map.getCenter().toArray(), 'Zoom:', map.getZoom(), 'Padding:', map.getPadding());
});

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
