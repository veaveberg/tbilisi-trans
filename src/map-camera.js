import mapboxgl from 'mapbox-gl';
import { map } from './map-setup.js';

let activeCameraIntentId = 0;

export function beginMapCameraIntent() {
    activeCameraIntentId += 1;
    return activeCameraIntentId;
}

export function invalidateMapCameraIntent() {
    return beginMapCameraIntent();
}

export function isCurrentMapCameraIntent(intentId) {
    return intentId === activeCameraIntentId;
}

function getElementBottom(selector) {
    if (!selector) return null;
    const element = document.querySelector(selector);
    if (!element || element.classList.contains('hidden')) return null;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return rect.bottom;
}

function getElementTop(selector) {
    if (!selector) return null;
    const element = document.querySelector(selector);
    if (!element || element.classList.contains('hidden')) return null;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return rect.top;
}

function getSheetTopFromClassList(classList) {
    const viewportHeight = window.innerHeight || 0;
    if (classList.contains('sheet-full')) return 0;
    if (classList.contains('sheet-half')) return Math.round(viewportHeight * (1 - 0.483));
    if (classList.contains('sheet-peek')) return Math.round(viewportHeight * (1 - 0.25));
    if (classList.contains('sheet-collapsed')) return Math.max(0, viewportHeight - 80);
    return null;
}

export function getSheetAwarePadding(panelId, options = {}) {
    const {
        top = 80,
        left = 40,
        right = 40,
        bottomExtra = 40,
        fallbackRatio = 0.483
    } = options;

    let panelHeight = 0;
    let rectInfo = null;
    let panelClasses = null;
    if (window.innerWidth <= 600) {
        panelHeight = window.innerHeight * fallbackRatio;
        const panel = panelId ? document.getElementById(panelId) : null;
        if (panel) {
            panelClasses = Array.from(panel.classList);
            if (!panel.classList.contains('hidden')) {
                const rect = panel.getBoundingClientRect();
                rectInfo = { top: rect.top, height: rect.height, bottom: rect.bottom };
                if (rect.height > 0 && rect.top > 0) {
                    panelHeight = Math.max(0, window.innerHeight - rect.top);
                }
            }
        }
    }

    const padding = {
        top,
        bottom: panelHeight + bottomExtra,
        left,
        right
    };

    return padding;
}

export function getBandPadding({
    topAnchorSelector = '.search-wrapper',
    bottomAnchorSelector,
    topMargin = 16,
    bottomMargin = 16,
    topFallback = 80,
    bottomFallbackRatio = 0.483,
    bottomFallbackExtra = 40
} = {}) {
    const viewportHeight = window.innerHeight || 0;

    const topAnchorBottom = getElementBottom(topAnchorSelector);
    const bottomAnchorEl = bottomAnchorSelector ? document.querySelector(bottomAnchorSelector) : null;
    const bottomAnchorTop = bottomAnchorEl
        ? (getSheetTopFromClassList(bottomAnchorEl.classList) ?? getElementTop(bottomAnchorSelector))
        : null;

    const top = topAnchorBottom !== null ? topAnchorBottom + topMargin : topFallback;
    let bottom;
    if (bottomAnchorTop !== null) {
        bottom = Math.max(0, viewportHeight - bottomAnchorTop + bottomMargin);
    } else {
        bottom = Math.max(0, Math.round(viewportHeight * bottomFallbackRatio) + bottomFallbackExtra);
    }

    const padding = {
        top,
        bottom,
        left: 40,
        right: 40
    };

    return padding;
}

export function getBandCenterOffset(options = {}) {
    const padding = getBandPadding(options);
    const offset = [0, (padding.bottom - padding.top) / 2];
    return offset;
}

export function flyToPointInView(center, options = {}) {
    const {
        zoom,
        topAnchorSelector = '.search-wrapper',
        bottomAnchorSelector,
        duration = 900,
        radiusMeters = 8,
        essential,
    } = options;
    const intentId = beginMapCameraIntent();
    const target = mapboxgl.LngLat.convert(center);
    const padding = getBandPadding({
        topAnchorSelector,
        bottomAnchorSelector
    });

    // Mapbox's flyTo animation deliberately arcs out while travelling. At close
    // zoom levels that briefly takes the map below the label-detail threshold,
    // making labels flicker.
    // Use easeTo here so zoom follows a direct path to the selected point.
    const currentZoom = map.getZoom();
    if (currentZoom >= 16 && zoom >= 16) {
        const camera = map.cameraForBounds(target.toBounds(radiusMeters), {
            padding,
            maxZoom: zoom
        });
        map.easeTo({
            ...camera,
            zoom: Math.min(zoom, 17),
            duration,
            essential
        });
        return intentId;
    }

    map.fitBounds(target.toBounds(radiusMeters), {
        padding,
        maxZoom: zoom,
        duration,
        retainPadding: false,
        essential
    });

    return intentId;
}
