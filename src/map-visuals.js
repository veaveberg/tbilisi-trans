import { map } from './map-setup.js';
import * as api from './api.js';
import * as metro from './metro.js';
import stopRotations from './data/stop_bearings.json';

// --- 3D Buildings & Theme-Based Lighting ---
let is3dEnabled = false;
const initialLightPreset = 'dawn'; // Default
let currentLightPreset = initialLightPreset;

const PERMANENT_CONFIG = {
    showTransitLabels: false
};

// Export function to allow ThemeManager to update the light preset
export function setMapLightPreset(preset) {
    const wasChanged = currentLightPreset !== preset;
    currentLightPreset = preset;

    // Try to apply immediately using setConfigProperty (more reliable)
    try {
        map.setConfigProperty('basemap', 'lightPreset', preset);
        if (wasChanged) {
            console.log('[Map] Light preset changed to:', preset);
        }
    } catch (err) {
        // If setConfigProperty fails, try setConfig as fallback
        console.warn('[Map] setConfigProperty failed, trying setConfig:', err.message);
        try {
            map.setConfig('basemap', {
                lightPreset: preset,
                show3dObjects: is3dEnabled,
                showPointOfInterestLabels: userPoiLabels,
                ...PERMANENT_CONFIG
            });
            if (wasChanged) {
                console.log('[Map] Light preset changed via setConfig to:', preset);
            }
        } catch (err2) {
            console.error('[Map] Failed to set light preset:', err2.message);
        }
    }

    // Re-apply terrain if user has it enabled
    if (user3DTerrain) {
        ensureTerrain();
    }
}

function ensureTerrain() {
    try {
        if (!map.getSource('mapbox-dem')) {
            map.addSource('mapbox-dem', {
                'type': 'raster-dem',
                'url': 'mapbox://mapbox.mapbox-terrain-dem-v1',
                'tileSize': 512,
                'maxzoom': 14
            });
        }

        // Use exaggeration based on user preference
        const exaggeration = userExaggerate ? 1.75 : 1.0;
        const current = map.getTerrain();

        // Check if we need to set/override terrain exaggeration
        const needsUpdate = !current ||
            current.source !== 'mapbox-dem' ||
            typeof current.exaggeration !== 'number' ||
            current.exaggeration !== exaggeration;

        if (needsUpdate) {
            map.setTerrain({ 'source': 'mapbox-dem', 'exaggeration': exaggeration });
        }

        // Verify terrain was actually set (catches Safari privacy issues)
        setTimeout(() => {
            const terrainActive = map.getTerrain() !== null;
            window.dispatchEvent(new CustomEvent('terrainStatusChange', { detail: { active: terrainActive } }));
        }, 500);
    } catch (err) {
        console.warn('[Map] ensureTerrain error:', err.message);
        window.dispatchEvent(new CustomEvent('terrainStatusChange', { detail: { active: false, error: err.message } }));
    }
}

// User preferences for 3D features (read from localStorage, default true)
let user3DBuildings = localStorage.getItem('show3DBuildings') !== 'false';
let user3DTerrain = localStorage.getItem('show3DTerrain') !== 'false';
let userExaggerate = localStorage.getItem('exaggerateTerrain') === 'true';
let userPoiLabels = localStorage.getItem('showPoiLabels') === 'true';

// Listen for settings changes
window.addEventListener('map3DBuildingsChange', (e) => {
    user3DBuildings = e.detail;
    update3DBuildings();
});

window.addEventListener('map3DTerrainChange', (e) => {
    user3DTerrain = e.detail;
    update3DTerrain();
});

window.addEventListener('mapExaggerateChange', (e) => {
    userExaggerate = e.detail;
    if (user3DTerrain) {
        // Re-apply terrain with new exaggeration setting
        ensureTerrain();
    }
});

window.addEventListener('mapPoiLabelsChange', (e) => {
    userPoiLabels = e.detail;
    updatePoiLabels();
});

function updatePoiLabels() {
    try {
        map.setConfigProperty('basemap', 'showPointOfInterestLabels', userPoiLabels);
    } catch (err) {
        console.warn('[Map] Failed to update POI labels:', err.message);
    }
}

function update3DBuildings() {
    try {
        map.setConfigProperty('basemap', 'show3dObjects', user3DBuildings);
        is3dEnabled = user3DBuildings;
    } catch (err) {
        console.warn('[Map] Failed to update 3D buildings:', err.message);
    }
}

function update3DTerrain() {
    if (user3DTerrain) {
        ensureTerrain();
    } else {
        try {
            map.setTerrain(null);
            console.log('[Map] 3D Terrain: disabled');
        } catch (err) {
            console.warn('[Map] Failed to disable terrain:', err.message);
        }
    }
}

// Initialize on Load
export function initMapFeatures() {
    try {
        update3DBuildings();
        update3DTerrain();
        updatePoiLabels();
        hideShieldLayers();
        movePlaceLabelsBelow();
    } catch (err) {
        console.error('[Map] Failed to init features:', err);
    }
}

// Move place/district/neighborhood labels below our transit layers
export function movePlaceLabelsBelow() {
    try {
        const style = map.getStyle();
        if (!style || !style.layers) return;

        // Find our first transit layer (lowest one that should be above place labels)
        const firstTransitLayer =
            map.getLayer('stops-layer-glow') ? 'stops-layer-glow' :
                map.getLayer('stops-layer-circle') ? 'stops-layer-circle' :
                    map.getLayer('metro-layer-glow') ? 'metro-layer-glow' :
                        null;

        if (!firstTransitLayer) return;

        // Find all place/settlement label layers from the Mapbox Standard style
        // These typically have IDs containing 'settlement', 'place', 'neighborhood', etc.
        const placeLabelPatterns = [
            'settlement-subdivision',
            'settlement-minor',
            'settlement-major',
            'place-neighborhood',
            'place-suburb',
            'place-town',
            'place-village',
            'place-city',
            'place-label'
        ];

        style.layers.forEach(layer => {
            const layerId = layer.id;
            const isPlaceLabel = placeLabelPatterns.some(pattern => layerId.includes(pattern));

            if (isPlaceLabel && map.getLayer(layerId)) {
                try {
                    map.moveLayer(layerId, firstTransitLayer);
                    console.log(`[Map] Moved ${layerId} below ${firstTransitLayer}`);
                } catch (e) {
                    // Layer may not exist or can't be moved
                }
            }
        });
    } catch (err) {
        console.warn('[Map] Failed to move place labels:', err.message);
    }
}

// Reverted: decided to keep shields for now
function hideShieldLayers() {
    // No-op
}

export function setupVisuals() {
    if (map.isStyleLoaded()) {
        initMapFeatures();
    } else {
        map.on('style.load', initMapFeatures);
    }

    map.on('load', () => {
        initMapFeatures();

        // Robustness: Retry initialization a few times to catch style loading races
        setTimeout(() => {
            initMapFeatures();
        }, 1000);

        setTimeout(() => {
            initMapFeatures();
        }, 3000);
    });

    // Safari fix: The Mapbox Standard style can override our terrain settings during its
    // complex loading sequence (multiple styledata events). We need to aggressively
    // re-apply our terrain exaggeration whenever the style updates.
    map.on('styledata', () => {
        // Use a small delay to ensure style internal overrides have finished
        setTimeout(() => {
            if (user3DTerrain) {
                ensureTerrain();
            }
        }, 50);
    });

    map.on('styleimagemissing', (e) => {
        const id = e.id;
        if (id === 'stop-selected-icon') {
            const width = 64;
            const height = 64;
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');

            ctx.beginPath();
            ctx.arc(width / 2, height / 2, width / 2 - 2, 0, 2 * Math.PI);
            ctx.fillStyle = '#00B38B';
            ctx.fill();
            ctx.lineWidth = 4;
            ctx.strokeStyle = '#ffffff';
            ctx.stroke();

            const imageData = ctx.getImageData(0, 0, width, height);
            if (!map.hasImage(id)) map.addImage(id, imageData);
        }
    });
}

// --- Icons & Labels ---

let areImagesLoaded = false;
export function setIsImagesLoaded(val) { areImagesLoaded = val; }

export async function loadImages() {
    if (areImagesLoaded) return Promise.resolve();

    // Render at 3x resolution for crispness on Retina/High-DPI screens
    const ICON_SCALE = 3;

    const images = [
        {
            // Layer 1: White circle background - provides the "stroke" effect
            id: 'bus-circle-bg',
            sdf: false,
            svg: `<svg width="${30 * ICON_SCALE}" height="${30 * ICON_SCALE}" viewBox="0 0 30 30" xmlns="http://www.w3.org/2000/svg"><circle cx="15" cy="15" r="13" fill="white" stroke="white" stroke-width="4"/></svg>`
        },
        {
            // Layer 2: Colored solid circle - SDF for dynamic route coloring
            id: 'bus-circle',
            sdf: true,
            svg: `<svg width="${26 * ICON_SCALE}" height="${26 * ICON_SCALE}" viewBox="0 0 26 26" xmlns="http://www.w3.org/2000/svg"><circle cx="13" cy="13" r="13" fill="black"/></svg>`
        },
        {
            // Layer 3: White arrow foreground - non-SDF for crisp edges
            id: 'bus-arrow-fg',
            sdf: false,
            svg: `<svg width="${26 * ICON_SCALE}" height="${26 * ICON_SCALE}" viewBox="0 0 26 26" xmlns="http://www.w3.org/2000/svg"><path d="M12.56 8.09L8.17 15.46C7.86 15.98 8.11 16.67 8.68 16.67H17.75C18.32 16.67 18.59 16.02 18.25 15.46L13.89 8.09C13.58 7.55 12.86 7.58 12.56 8.09Z" fill="white"/></svg>`
        },
        {
            id: 'stop-icon',
            sdf: true,
            svg: `<svg width="${53 * ICON_SCALE}" height="${53 * ICON_SCALE}" viewBox="0 0 53 53" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="26.5" cy="26.5" r="24.5" fill="black"/></svg>`
        },
        {
            id: 'stop-close-up-icon',
            sdf: true,
            svg: `<svg width="${53 * ICON_SCALE}" height="${100 * ICON_SCALE}" viewBox="0 0 53 100" fill="none" xmlns="http://www.w3.org/2000/svg">
<circle cx="26.5" cy="49.3533" r="24.5" fill="black"/>
<path d="M22.1698 4.5C24.0943 1.1667 28.9054 1.16675 30.83 4.5L35.9657 13.3945C37.8902 16.7278 35.4845 20.8944 31.6356 20.8945H21.3651C17.5161 20.8945 15.1096 16.7279 17.0341 13.3945L22.1698 4.5Z" fill="black"/>
</svg>`
        },
        {
            id: 'stop-selected-icon',
            sdf: true,
            svg: `<svg width="${53 * ICON_SCALE}" height="${100 * ICON_SCALE}" viewBox="0 0 53 100" fill="none" xmlns="http://www.w3.org/2000/svg">
<circle cx="26.5" cy="49.3533" r="24.5" fill="black"/>
<path d="M22.1698 4.5C24.0943 1.1667 28.9054 1.16675 30.83 4.5L35.9657 13.3945C37.8902 16.7278 35.4845 20.8944 31.6356 20.8945H21.3651C17.5161 20.8945 15.1096 16.7279 17.0341 13.3945L22.1698 4.5Z" fill="black"/>
</svg>`
        },
        {
            id: 'station-transfer',
            sdf: false,
            svg: `<svg width="${48 * ICON_SCALE}" height="${34 * ICON_SCALE}" viewBox="0 0 48 34" fill="none" xmlns="http://www.w3.org/2000/svg">
<rect x="2" y="2" width="44" height="30" rx="15" fill="white" stroke="black" stroke-width="4"/>
<circle cx="15" cy="17" r="6" fill="#ef4444"/>
<circle cx="33" cy="17" r="6" fill="#22c55e"/>
</svg>`
        }
    ];

    // Generate metro exit icons dynamically using canvas
    const generateExitIcons = () => {
        const size = 64;
        const pixelRatio = 2;
        const exitIcons = [];

        // Generate numbered exit icons (1-10)
        for (let i = 1; i <= 10; i++) {
            const canvas = document.createElement('canvas');
            canvas.width = size * pixelRatio;
            canvas.height = size * pixelRatio;
            const ctx = canvas.getContext('2d');
            ctx.scale(pixelRatio, pixelRatio);

            // Rounded square background
            const radius = 10;
            const padding = 4;
            ctx.beginPath();
            ctx.moveTo(padding + radius, padding);
            ctx.lineTo(size - padding - radius, padding);
            ctx.quadraticCurveTo(size - padding, padding, size - padding, padding + radius);
            ctx.lineTo(size - padding, size - padding - radius);
            ctx.quadraticCurveTo(size - padding, size - padding, size - padding - radius, size - padding);
            ctx.lineTo(padding + radius, size - padding);
            ctx.quadraticCurveTo(padding, size - padding, padding, size - padding - radius);
            ctx.lineTo(padding, padding + radius);
            ctx.quadraticCurveTo(padding, padding, padding + radius, padding);
            ctx.closePath();
            ctx.fillStyle = '#ffffff';
            ctx.fill();
            ctx.strokeStyle = '#333333';
            ctx.lineWidth = 2;
            ctx.stroke();

            // Number text
            ctx.fillStyle = '#333333';
            ctx.font = `bold ${size * 0.5}px Arial`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(String(i), size / 2, size / 2 + 2);

            exitIcons.push({
                id: `exit-${i}`,
                imageData: ctx.getImageData(0, 0, canvas.width, canvas.height),
                pixelRatio
            });
        }

        // Generate generic exit arrow icon (arrow pointing out of square)
        const arrowCanvas = document.createElement('canvas');
        arrowCanvas.width = size * pixelRatio;
        arrowCanvas.height = size * pixelRatio;
        const arrowCtx = arrowCanvas.getContext('2d');
        arrowCtx.scale(pixelRatio, pixelRatio);

        // Rounded square background
        const arrowRadius = 10;
        const arrowPadding = 4;
        arrowCtx.beginPath();
        arrowCtx.moveTo(arrowPadding + arrowRadius, arrowPadding);
        arrowCtx.lineTo(size - arrowPadding - arrowRadius, arrowPadding);
        arrowCtx.quadraticCurveTo(size - arrowPadding, arrowPadding, size - arrowPadding, arrowPadding + arrowRadius);
        arrowCtx.lineTo(size - arrowPadding, size - arrowPadding - arrowRadius);
        arrowCtx.quadraticCurveTo(size - arrowPadding, size - arrowPadding, size - arrowPadding - arrowRadius, size - arrowPadding);
        arrowCtx.lineTo(arrowPadding + arrowRadius, size - arrowPadding);
        arrowCtx.quadraticCurveTo(arrowPadding, size - arrowPadding, arrowPadding, size - arrowPadding - arrowRadius);
        arrowCtx.lineTo(arrowPadding, arrowPadding + arrowRadius);
        arrowCtx.quadraticCurveTo(arrowPadding, arrowPadding, arrowPadding + arrowRadius, arrowPadding);
        arrowCtx.closePath();
        arrowCtx.fillStyle = '#ffffff';
        arrowCtx.fill();
        arrowCtx.strokeStyle = '#333333';
        arrowCtx.lineWidth = 2;
        arrowCtx.stroke();

        // Exit arrow pointing up-right
        arrowCtx.strokeStyle = '#333333';
        arrowCtx.lineWidth = 4;
        arrowCtx.lineCap = 'round';
        arrowCtx.lineJoin = 'round';
        const cx = size / 2;
        const cy = size / 2;
        const arrowSize = 14;
        // Main line (diagonal)
        arrowCtx.beginPath();
        arrowCtx.moveTo(cx - arrowSize * 0.7, cy + arrowSize * 0.7);
        arrowCtx.lineTo(cx + arrowSize * 0.7, cy - arrowSize * 0.7);
        arrowCtx.stroke();
        // Arrow head
        arrowCtx.beginPath();
        arrowCtx.moveTo(cx + arrowSize * 0.2, cy - arrowSize * 0.7);
        arrowCtx.lineTo(cx + arrowSize * 0.7, cy - arrowSize * 0.7);
        arrowCtx.lineTo(cx + arrowSize * 0.7, cy - arrowSize * 0.2);
        arrowCtx.stroke();

        exitIcons.push({
            id: 'exit-arrow',
            imageData: arrowCtx.getImageData(0, 0, arrowCanvas.width, arrowCanvas.height),
            pixelRatio
        });

        return exitIcons;
    };

    // Add exit icons
    const exitIcons = generateExitIcons();
    exitIcons.forEach(icon => {
        if (!map.hasImage(icon.id)) {
            map.addImage(icon.id, icon.imageData, { pixelRatio: icon.pixelRatio });
        }
    });
    console.log('[Map] Generated', exitIcons.length, 'metro exit icons');

    const promises = images.map(img => {
        if (map.hasImage(img.id)) map.removeImage(img.id);

        return new Promise((resolve) => {
            const image = new Image();
            image.onload = () => {
                if (!map.hasImage(img.id)) {
                    map.addImage(img.id, image, { sdf: img.sdf, pixelRatio: ICON_SCALE });
                }
                resolve();
            };
            image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(img.svg);
        });
    });

    await Promise.all(promises);
    areImagesLoaded = true;
}

export function getCircleRadiusExpression(scale = 1) {
    return [
        'interpolate',
        ['linear'],
        ['zoom'],
        12.5, 1.8 * scale,
        16, 7.2 * scale
    ];
}

export function updateMapTheme() {
    if (!map || !map.getStyle()) return;
    const isDark = document.body.classList.contains('dark-mode');
    const labelColor = isDark ? '#ffffff' : '#000000';
    const haloColor = isDark ? '#000000' : '#ffffff';

    if (map.getLayer('metro-layer-label')) {
        map.setPaintProperty('metro-layer-label', 'text-color', labelColor);
        map.setPaintProperty('metro-layer-label', 'text-halo-color', haloColor);
    }
    if (map.getLayer('metro-transfer-layer')) {
        map.setPaintProperty('metro-transfer-layer', 'text-color', labelColor);
        map.setPaintProperty('metro-transfer-layer', 'text-halo-color', haloColor);
    }
    if (map.getLayer('stops-label-selected')) {
        map.setPaintProperty('stops-label-selected', 'text-color', labelColor);
        map.setPaintProperty('stops-label-selected', 'text-halo-color', haloColor);
    }

    if (map.getLayer('stops-layer-circle')) {
        const stopColor = isDark ? '#FFED74' : '#3C3C3C';
        const stopStrokeColor = isDark ? '#FFED74' : '#3C3C3C';
        const stopStrokeWidth = 0.5;
        const stopStrokeOpacity = 0.3;

        map.setPaintProperty('stops-layer-circle', 'circle-color', stopColor);
        map.setPaintProperty('stops-layer-circle', 'circle-stroke-color', stopStrokeColor);
        map.setPaintProperty('stops-layer-circle', 'circle-stroke-width', stopStrokeWidth);
        map.setPaintProperty('stops-layer-circle', 'circle-stroke-opacity', stopStrokeOpacity);
    }

    if (map.getLayer('stops-layer-glow')) {
        const glowColor = isDark ? '#FFED74' : '#3C3C3C';
        map.setPaintProperty('stops-layer-glow', 'circle-opacity', 0.05);
        map.setPaintProperty('stops-layer-glow', 'circle-color', glowColor);
    }
    if (map.getLayer('stops-highlight-glow')) {
        const glowColor = isDark ? '#FFED74' : '#93C5FD'; // Blue glow for light theme
        map.setPaintProperty('stops-highlight-glow', 'circle-opacity', 0.1);
        map.setPaintProperty('stops-highlight-glow', 'circle-color', glowColor);
    }

    const stopIconColor = isDark ? '#FFED74' : '#3C3C3C';
    if (map.getLayer('stops-layer')) {
        map.setPaintProperty('stops-layer', 'icon-color', stopIconColor);
        map.setPaintProperty('stops-layer', 'icon-halo-color', haloColor);
        map.setPaintProperty('stops-layer', 'icon-halo-width', 0.5);
    }
    if (map.getLayer('stops-highlight')) {
        map.setPaintProperty('stops-highlight', 'icon-color', stopIconColor);
        map.setPaintProperty('stops-highlight', 'icon-halo-color', haloColor);
        map.setPaintProperty('stops-highlight', 'icon-halo-width', 0.5);
    }
}

export function addStopsToMap(stops, options = {}) {
    // Note: options like redirectMap, filterManager, updateConnectionLine are needed for interaction setup
    // But interaction logic (setupHoverHandlers) is likely called SEPARATELY in main.js
    // This function focuses on LAYERS.
    // However, it creates a filter connection layer dependent on filterManager?
    // Let's keep it as is.
    const { redirectMap, filterManager, updateConnectionLine } = options;

    const sourcesToClean = ['metro-stops', 'metro-lines-manual', 'stops', 'selected-stop', 'filter-connection'];

    // Exhaustive cleanup: Remove ALL layers using our sources, then remove sources.
    const currentStyle = map.getStyle();
    if (currentStyle && currentStyle.layers) {
        currentStyle.layers.forEach(layer => {
            if (sourcesToClean.includes(layer.source) ||
                layer.id.startsWith('filter-connection-') ||
                layer.id === 'stops-highlight-glow' ||
                layer.id === 'stops-label-selected') {
                try {
                    if (map.getLayer(layer.id)) map.removeLayer(layer.id);
                } catch (e) {
                    console.warn(`[Map] Failed to remove layer ${layer.id}:`, e.message);
                }
            }
        });
    }

    // Now remove the sources
    sourcesToClean.forEach(sourceId => {
        try {
            if (map.getSource(sourceId)) map.removeSource(sourceId);
        } catch (e) {
            console.warn(`[Map] Failed to remove source ${sourceId}:`, e.message);
        }
    });

    const { busStops, metroFeatures } = metro.processMetroStops(stops, stopRotations);
    const metroLines = metro.generateMetroLines(metroFeatures);

    map.addSource('stops', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: busStops },
        cluster: false
    });

    map.addLayer({
        id: 'stops-layer-hit-target',
        type: 'circle',
        source: 'stops',
        slot: 'top',
        paint: {
            'circle-color': '#000000',
            'circle-opacity': 0,
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, 10, 16, 20, 20, 50],
            'circle-stroke-width': 0
        }
    });

    map.addLayer({
        id: 'stops-layer-glow',
        type: 'circle',
        source: 'stops',
        slot: 'top',
        paint: {
            'circle-color': '#000000',
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, 12, 16, 25, 20, 60],
            'circle-opacity': 0,
            'circle-blur': 0.9,
            'circle-emissive-strength': 1
        }
    });

    map.addLayer({
        id: 'stops-layer-circle',
        type: 'circle',
        source: 'stops',
        maxzoom: 15.2,
        slot: 'top',
        paint: {
            'circle-color': '#000000',
            'circle-stroke-color': '#ffffff',
            'circle-stroke-width': 0.5,
            'circle-stroke-opacity': 0.3,
            'circle-radius': getCircleRadiusExpression(1),
            'circle-opacity': 1,
            'circle-emissive-strength': 1
        }
    });

    map.addLayer({
        id: 'stops-layer',
        type: 'symbol',
        source: 'stops',
        minzoom: 15.2,
        slot: 'top',
        layout: {
            'icon-allow-overlap': true,
            'icon-ignore-placement': true,
            'symbol-z-order': 'source',
            'icon-image': ['case', ['==', ['get', 'rotation'], 0], 'stop-icon', 'stop-close-up-icon'],
            'icon-size': ['interpolate', ['linear'], ['zoom'], 15.2, 0.5, 16, 0.6, 18, 0.8],
            'icon-rotate': ['get', 'rotation'],
            'icon-rotation-alignment': 'map'
        },
        paint: {
            'icon-opacity': 1,
            'icon-color': '#000000',
            'icon-halo-color': '#ffffff',
            'icon-halo-width': 0.5,
            'icon-emissive-strength': 1
        }
    });

    map.addSource('selected-stop', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
    });

    map.addLayer({
        id: 'stops-highlight-glow',
        type: 'circle',
        source: 'selected-stop',
        slot: 'top',
        paint: {
            'circle-color': '#000000',
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, 15, 16, 30, 20, 70],
            'circle-opacity': 0,
            'circle-blur': 0.9,
            'circle-emissive-strength': 1
        }
    });

    map.addLayer({
        id: 'stops-highlight',
        type: 'symbol',
        source: 'selected-stop',
        slot: 'top',
        layout: {
            'icon-image': ['case', ['>', ['coalesce', ['get', 'rotation'], 0], 0], 'stop-selected-icon', 'stop-icon'],
            'icon-size': ['case', ['==', ['get', 'mode'], 'SUBWAY'], 1.5, 1.2],
            'icon-allow-overlap': true,
            'icon-ignore-placement': true,
            'icon-rotate': ['coalesce', ['get', 'rotation'], 0],
            'icon-rotation-alignment': 'map'
        },
        paint: {
            'icon-opacity': 1,
            'icon-color': '#000000',
            'icon-halo-color': '#ffffff',
            'icon-halo-width': 0.5,
            'icon-emissive-strength': 1
        }
    });

    map.addSource('filter-connection', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
    });
    map.addLayer({
        id: 'filter-connection-line',
        type: 'line',
        source: 'filter-connection',
        slot: 'top',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
            'line-color': '#2563eb',
            'line-width': 4,
            'line-opacity': 0.8,
            'line-emissive-strength': 1
        }
    });
    if (map.getLayer('stops-layer')) map.moveLayer('filter-connection-line', 'stops-layer');

    // Inline Filter Hover Logic was here (lines 629-676)
    // We should move that to map-interactions.js or setupHoverHandlers?
    // The previous code had it inline in addStopsToMap.
    // Ideally it moves. But for now, let's keep it here IF we have the deps.
    // It depends on `updateConnectionLine` and `proximitySort`.
    // proximitySort is NOT in this file. It was in map-setup.js.
    // I should move proximitySort to this file OR map-interactions.js.
    // Given the structure, `addStopsToMap` purely adding layers is better.
    // The interactions should be setup once in setupHoverHandlers.
    // But this block is ONLY added if `filterManager` is present.
    // I will comment it out here and ensure logic sits in map-interactions.js.
    /*
    if (filterManager && updateConnectionLine) {
         // ... this logic belongs in interactions ...
    }
    */
    // Wait, the original code added the listener HERE. 
    // And it used `proximitySort`.
    // I will remove it from here and rely on `map-interactions.js` to handle all hovers.

    metro.addMetroLayers(map, metroFeatures, metroLines);

    map.addLayer({
        id: 'stops-label-selected',
        type: 'symbol',
        source: 'stops',
        slot: 'top',
        filter: ['in', ['get', 'id'], ['literal', []]],
        layout: {
            'text-field': ['get', 'name'],
            'text-size': 12,
            'text-offset': [0, 1.2],
            'text-anchor': 'top',
            'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
            'text-allow-overlap': false
        },
        paint: {
            'text-color': '#000000',
            'text-halo-color': '#ffffff',
            'text-halo-width': 2,
            'text-emissive-strength': 1
        }
    });

    if (map.getLayer('stops-layer-glow') && map.getLayer('stops-layer-circle')) {
        map.moveLayer('stops-layer-glow', 'stops-layer-circle');
    }
    if (map.getLayer('stops-highlight-glow') && map.getLayer('stops-highlight')) {
        map.moveLayer('stops-highlight-glow', 'stops-highlight');
    }
    if (map.getLayer('metro-lines-layer') && map.getLayer('stops-layer')) {
        map.moveLayer('metro-lines-layer', 'stops-layer');
    }
    if (map.getLayer('stops-highlight')) {
        map.moveLayer('stops-highlight');
    }

    // Move place/district labels below our transit layers
    movePlaceLabelsBelow();

    updateMapTheme();

    // Re-apply filter state if active (updateMapTheme resets layer styles)
    if (filterManager && (filterManager.state.active || filterManager.state.picking)) {
        filterManager.updateMapFilterState();
    }
}

export async function updateLiveBuses(routeId, patternSuffix, color) {
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
            // Layer 1: White circle background for stroke effect
            map.addLayer({
                id: 'live-buses-bg',
                type: 'symbol',
                source: 'live-buses',
                layout: {
                    'icon-image': 'bus-circle-bg',
                    'icon-size': 1.1,
                    'icon-allow-overlap': true,
                    'icon-ignore-placement': true,
                    'icon-rotate': ['coalesce', ['get', 'heading'], 0],
                    'icon-rotation-alignment': 'map'
                }
            });
            // Layer 2: Colored solid circle
            map.addLayer({
                id: 'live-buses-circle',
                type: 'symbol',
                source: 'live-buses',
                layout: {
                    'icon-image': 'bus-circle',
                    'icon-size': 1.0,
                    'icon-allow-overlap': true,
                    'icon-ignore-placement': true,
                    'icon-rotate': ['coalesce', ['get', 'heading'], 0],
                    'icon-rotation-alignment': 'map'
                },
                paint: {
                    'icon-color': ['get', 'color']
                }
            });
            // Layer 3: White arrow on top
            map.addLayer({
                id: 'live-buses-arrow',
                type: 'symbol',
                source: 'live-buses',
                layout: {
                    'icon-image': 'bus-arrow-fg',
                    'icon-size': 1.0,
                    'icon-allow-overlap': true,
                    'icon-ignore-placement': true,
                    'icon-rotate': ['coalesce', ['get', 'heading'], 0],
                    'icon-rotation-alignment': 'map'
                }
            });
        }
    } catch (error) {
        console.error('Failed to update live buses:', error);
    }
}

export function updateStopHoverEffects(hoveredId) {
    // If a stop is currently selected (Focused Session), do NOT reset global opacity.
    if (window.currentStopId) return;

    if (!map || !map.getStyle()) return;
    const isDark = document.body.classList.contains('dark-mode');

    const baseStopColor = isDark ? '#FFED74' : '#3C3C3C';
    const baseStopStrokeColor = isDark ? '#FFED74' : '#3C3C3C';
    const hoverColor = isDark ? '#FFFFFF' : '#505050'; // Light Blue for light theme
    const hoverStrokeColor = isDark ? '#FFFFFF' : '#505050';
    const baseGlowOpacity = 0.05;
    const hoverGlowOpacity = 0.7;

    if (map.getLayer('stops-layer-circle')) {
        map.setPaintProperty('stops-layer-circle', 'circle-color', [
            'case',
            ['==', ['get', 'id'], hoveredId], hoverColor,
            baseStopColor
        ]);

        map.setPaintProperty('stops-layer-circle', 'circle-stroke-color', [
            'case',
            ['==', ['get', 'id'], hoveredId], hoverStrokeColor,
            baseStopStrokeColor
        ]);
    }

    if (map.getLayer('stops-layer-glow')) {
        map.setPaintProperty('stops-layer-glow', 'circle-opacity', [
            'case',
            ['==', ['get', 'id'], hoveredId], hoverGlowOpacity,
            baseGlowOpacity
        ]);

        map.setPaintProperty('stops-layer-glow', 'circle-color', [
            'case',
            ['==', ['get', 'id'], hoveredId], hoverColor,
            baseStopColor
        ]);
    }

    if (map.getLayer('stops-layer')) {
        map.setPaintProperty('stops-layer', 'icon-color', [
            'case',
            ['==', ['get', 'id'], hoveredId], hoverColor,
            baseStopColor
        ]);
    }

    if (map.getLayer('metro-layer-circle')) {
        // Use zoom-scaled radius for hover effect
        map.setPaintProperty('metro-layer-circle', 'circle-radius', [
            'interpolate',
            ['linear'],
            ['zoom'],
            10, ['case', ['==', ['get', 'id'], hoveredId], 8, 5],
            12, ['case', ['==', ['get', 'id'], hoveredId], 10, 7],
            14, ['case', ['==', ['get', 'id'], hoveredId], 14, 10],
            16, ['case', ['==', ['get', 'id'], hoveredId], 18, 14]
        ]);
    }
}
