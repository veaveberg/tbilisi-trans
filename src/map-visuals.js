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
    let styledataTerrainTimer = null;
    map.on('styledata', () => {
        if (styledataTerrainTimer) return;
        // Use a small delay to ensure style internal overrides have finished
        styledataTerrainTimer = setTimeout(() => {
            styledataTerrainTimer = null;
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
        },
        {
            id: 'route-plaque',
            sdf: true,
            svg: `<svg width="${40 * ICON_SCALE}" height="${24 * ICON_SCALE}" viewBox="0 0 40 24" xmlns="http://www.w3.org/2000/svg"><rect x="2" y="2" width="36" height="20" rx="8" fill="black"/></svg>`
        }
    ];

    // Generate metro exit icons dynamically using canvas
    const generateExitIcons = () => {
        const size = 64;
        const pixelRatio = 2;
        const exitIcons = [];

        // Colors for the two metro lines
        const colors = [
            { name: 'red', fill: '#ef4444', text: '#ffffff' },
            { name: 'green', fill: '#22c55e', text: '#ffffff' }
        ];

        colors.forEach(({ name, fill, text }) => {
            // Generate numbered exit icons (1-10) for each color
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
                ctx.fillStyle = fill;
                ctx.fill();

                // Number text
                ctx.fillStyle = text;
                ctx.font = `bold ${size * 0.5}px Arial`;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(String(i), size / 2, size / 2 + 2);

                exitIcons.push({
                    id: `exit-${name}-${i}`,
                    imageData: ctx.getImageData(0, 0, canvas.width, canvas.height),
                    pixelRatio
                });
            }

            // Generate generic exit arrow icon for each color
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
            arrowCtx.fillStyle = fill;
            arrowCtx.fill();

            // Lucide log-out icon
            // Scaled to fit within the icon area
            const scale = (size - arrowPadding * 2) / 24; // Lucide icons are 24x24
            const offsetX = arrowPadding;
            const offsetY = arrowPadding;

            arrowCtx.strokeStyle = text;
            arrowCtx.lineWidth = 2.5 / scale * scale; // Maintain consistent stroke
            arrowCtx.lineCap = 'round';
            arrowCtx.lineJoin = 'round';

            // Door frame path: M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4
            arrowCtx.beginPath();
            arrowCtx.moveTo(offsetX + 9 * scale, offsetY + 21 * scale);
            arrowCtx.lineTo(offsetX + 5 * scale, offsetY + 21 * scale);
            arrowCtx.arc(offsetX + 5 * scale, offsetY + 19 * scale, 2 * scale, Math.PI / 2, Math.PI);
            arrowCtx.lineTo(offsetX + 3 * scale, offsetY + 5 * scale);
            arrowCtx.arc(offsetX + 5 * scale, offsetY + 5 * scale, 2 * scale, Math.PI, -Math.PI / 2);
            arrowCtx.lineTo(offsetX + 9 * scale, offsetY + 3 * scale);
            arrowCtx.stroke();

            // Arrow line: line x1="21" x2="9" y1="12" y2="12"
            arrowCtx.beginPath();
            arrowCtx.moveTo(offsetX + 9 * scale, offsetY + 12 * scale);
            arrowCtx.lineTo(offsetX + 21 * scale, offsetY + 12 * scale);
            arrowCtx.stroke();

            // Arrow head: polyline points="16 17 21 12 16 7"
            arrowCtx.beginPath();
            arrowCtx.moveTo(offsetX + 16 * scale, offsetY + 17 * scale);
            arrowCtx.lineTo(offsetX + 21 * scale, offsetY + 12 * scale);
            arrowCtx.lineTo(offsetX + 16 * scale, offsetY + 7 * scale);
            arrowCtx.stroke();

            exitIcons.push({
                id: `exit-${name}-arrow`,
                imageData: arrowCtx.getImageData(0, 0, arrowCanvas.width, arrowCanvas.height),
                pixelRatio
            });
        });

        return exitIcons;
    };

    // Generate themed stop icons with strokes for closeup view
    const generateThemedStopIcons = () => {
        const pixelRatio = 3;
        const icons = [];

        // Original SVG path for the pointer/arrow
        const pointerPathStr = "M22.1698 4.5C24.0943 1.1667 28.9054 1.16675 30.83 4.5L35.9657 13.3945C37.8902 16.7278 35.4845 20.8944 31.6356 20.8945H21.3651C17.5161 20.8945 15.1096 16.7279 17.0341 13.3945L22.1698 4.5Z";

        // Theme configurations
        const themes = [
            { suffix: 'dark', fill: '#FFED74', stroke: '#D4C45A' },    // Dark theme base
            { suffix: 'light', fill: '#3C3C3C', stroke: '#5C5C5C' },   // Light theme base
            { suffix: 'hover-dark', fill: '#FFFFFF', stroke: '#E5E7EB' }, // Dark theme hover
            { suffix: 'hover-light', fill: '#898989', stroke: '#FFFFFF' }, // Light theme hover
            { suffix: 'gondola-dark', fill: '#60A5FA', stroke: '#3B82F6' }, // Gondola default dark (blue)
            { suffix: 'gondola-light', fill: '#2563EB', stroke: '#1D4ED8' }, // Gondola default light (blue)
            { suffix: 'gondola-manual-dark', fill: '#2DD4BF', stroke: '#14B8A6' }, // Manual/provider gondola dark (teal)
            { suffix: 'gondola-manual-light', fill: '#0D9488', stroke: '#0F766E' } // Manual/provider gondola light (teal)
        ];

        themes.forEach(({ suffix, fill, stroke }) => {
            // Simple circle icon (for stops without rotation)
            const circleSize = 53;
            const circleCanvas = document.createElement('canvas');
            circleCanvas.width = circleSize * pixelRatio;
            circleCanvas.height = circleSize * pixelRatio;
            const circleCtx = circleCanvas.getContext('2d');
            circleCtx.scale(pixelRatio, pixelRatio);

            // Draw circle with stroke - Exact match for r=24.5
            circleCtx.beginPath();
            circleCtx.arc(26.5, 26.5, 24.5, 0, 2 * Math.PI);
            circleCtx.fillStyle = fill;
            circleCtx.fill();
            circleCtx.strokeStyle = stroke;
            circleCtx.lineWidth = 2.5;
            circleCtx.stroke();

            icons.push({
                id: `stop-icon-${suffix}`,
                imageData: circleCtx.getImageData(0, 0, circleCanvas.width, circleCanvas.height),
                pixelRatio
            });

            // Close-up icon with arrow pointer
            const closeupWidth = 53;
            const closeupHeight = 100;
            const closeupCanvas = document.createElement('canvas');
            closeupCanvas.width = closeupWidth * pixelRatio;
            closeupCanvas.height = closeupHeight * pixelRatio;
            const closeupCtx = closeupCanvas.getContext('2d');
            closeupCtx.scale(pixelRatio, pixelRatio);

            // Create Path2D for the exact pointer shape
            const pointerPath = new Path2D(pointerPathStr);

            // Draw the arrow/pointer at top
            closeupCtx.fillStyle = fill;
            closeupCtx.fill(pointerPath);
            closeupCtx.strokeStyle = stroke;
            closeupCtx.lineWidth = 2;
            closeupCtx.stroke(pointerPath);

            // Draw circle - Exact match for cy=49.3533, r=24.5
            closeupCtx.beginPath();
            closeupCtx.arc(26.5, 49.3533, 24.5, 0, 2 * Math.PI);
            closeupCtx.fillStyle = fill;
            closeupCtx.fill();
            closeupCtx.strokeStyle = stroke;
            closeupCtx.lineWidth = 2.5;
            closeupCtx.stroke();

            icons.push({
                id: `stop-close-up-icon-${suffix}`,
                imageData: closeupCtx.getImageData(0, 0, closeupCanvas.width, closeupCanvas.height),
                pixelRatio
            });

            // Selected icon (same as close-up)
            icons.push({
                id: `stop-selected-icon-${suffix}`,
                imageData: closeupCtx.getImageData(0, 0, closeupCanvas.width, closeupCanvas.height),
                pixelRatio
            });
        });

        return icons;
    };

    // Add exit icons
    const exitIcons = generateExitIcons();
    exitIcons.forEach(icon => {
        if (!map.hasImage(icon.id)) {
            map.addImage(icon.id, icon.imageData, { pixelRatio: icon.pixelRatio });
        }
    });
    console.log('[Map] Generated', exitIcons.length, 'metro exit icons');

    // Add themed stop icons
    const themedStopIcons = generateThemedStopIcons();
    themedStopIcons.forEach(icon => {
        if (!map.hasImage(icon.id)) {
            map.addImage(icon.id, icon.imageData, { pixelRatio: icon.pixelRatio });
        }
    });
    console.log('[Map] Generated', themedStopIcons.length, 'themed stop icons');

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
    const manualGondolaExpr = [
        'all',
        ['==', ['get', 'mode'], 'GONDOLA'],
        ['any',
            ['==', ['get', 'source'], 'config'],
            ['==', ['get', '_source'], 'config'],
            ['==', ['get', 'provider'], 'manual-gondola'],
            ['==', ['get', 'ticketProvider'], 'manual-gondola']
        ]
    ];
    const theme = {
        label: isDark ? '#ffffff' : '#000000',
        halo: isDark ? '#000000' : '#ffffff',
        stop: isDark ? '#FFED74' : '#3C3C3C',
        stopStroke: isDark ? '#D4C45A' : '#5C5C5C',
        gondolaStop: isDark ? '#60A5FA' : '#2563EB',
        gondolaStopStroke: isDark ? '#3B82F6' : '#1D4ED8',
        manualGondolaStop: isDark ? '#2DD4BF' : '#0D9488',
        manualGondolaStopStroke: isDark ? '#14B8A6' : '#0F766E',
        glow: isDark ? '#FFED74' : '#3C3C3C',
        highlightGlow: isDark ? '#FFED74' : '#93C5FD',
        suffix: isDark ? 'dark' : 'light'
    };

    // Update Label Layers
    const labelLayers = ['metro-layer-label', 'metro-transfer-layer', 'stops-label-selected', 'filter-connection-label-sub'];
    labelLayers.forEach(id => {
        if (map.getLayer(id)) {
            if (id === 'filter-connection-label-sub') {
                map.setPaintProperty(id, 'text-color', theme.label);
            } else {
                map.setPaintProperty(id, 'text-color', theme.label);
            }
            map.setPaintProperty(id, 'text-halo-color', theme.halo);
        }
    });

    // Update Stop Circle Layers
    if (map.getLayer('stops-layer-circle')) {
        map.setPaintProperty('stops-layer-circle', 'circle-color', [
            'case',
            manualGondolaExpr, theme.manualGondolaStop,
            ['==', ['get', 'mode'], 'GONDOLA'], theme.gondolaStop,
            theme.stop
        ]);
        map.setPaintProperty('stops-layer-circle', 'circle-stroke-color', [
            'case',
            manualGondolaExpr, theme.manualGondolaStopStroke,
            ['==', ['get', 'mode'], 'GONDOLA'], theme.gondolaStopStroke,
            theme.stopStroke
        ]);
        map.setPaintProperty('stops-layer-circle', 'circle-stroke-width', 1.5);
        map.setPaintProperty('stops-layer-circle', 'circle-stroke-opacity', 1);
    }
    if (map.getLayer('stops-layer-circle-hover')) {
        map.setPaintProperty('stops-layer-circle-hover', 'circle-color', [
            'case',
            manualGondolaExpr, theme.manualGondolaStop,
            ['==', ['get', 'mode'], 'GONDOLA'], theme.gondolaStop,
            theme.stop
        ]);
        map.setPaintProperty('stops-layer-circle-hover', 'circle-stroke-color', [
            'case',
            manualGondolaExpr, theme.manualGondolaStopStroke,
            ['==', ['get', 'mode'], 'GONDOLA'], theme.gondolaStopStroke,
            theme.stopStroke
        ]);
        map.setPaintProperty('stops-layer-circle-hover', 'circle-stroke-width', 1.5);
    }

    // Update Glow Layers
    if (map.getLayer('stops-layer-glow')) {
        map.setPaintProperty('stops-layer-glow', 'circle-color', [
            'case',
            manualGondolaExpr, theme.manualGondolaStop,
            ['==', ['get', 'mode'], 'GONDOLA'], theme.gondolaStop,
            theme.glow
        ]);
        map.setPaintProperty('stops-layer-glow', 'circle-opacity', 0.05);
    }
    if (map.getLayer('stops-highlight-glow')) {
        map.setPaintProperty('stops-highlight-glow', 'circle-color', theme.highlightGlow);
        map.setPaintProperty('stops-highlight-glow', 'circle-opacity', 0.1);
    }

    // Update Symbol Layers (Close-up)
    const iconImage = [
        'case',
        manualGondolaExpr,
        ['case', ['==', ['get', 'rotation'], 0], `stop-icon-gondola-manual-${theme.suffix}`, `stop-close-up-icon-gondola-manual-${theme.suffix}`],
        ['==', ['get', 'mode'], 'GONDOLA'],
        ['case', ['==', ['get', 'rotation'], 0], `stop-icon-gondola-${theme.suffix}`, `stop-close-up-icon-gondola-${theme.suffix}`],
        ['case', ['==', ['get', 'rotation'], 0], `stop-icon-${theme.suffix}`, `stop-close-up-icon-${theme.suffix}`]
    ];
    if (map.getLayer('stops-layer')) {
        map.setLayoutProperty('stops-layer', 'icon-image', iconImage);
    }
    if (map.getLayer('stops-layer-hover')) {
        // Hover image update handled in updateStopHoverEffects
    }
    if (map.getLayer('stops-highlight')) {
        const highlightImage = [
            'case',
            manualGondolaExpr,
            ['case', ['>', ['coalesce', ['get', 'rotation'], 0], 0], `stop-selected-icon-gondola-manual-${theme.suffix}`, `stop-icon-gondola-manual-${theme.suffix}`],
            ['==', ['get', 'mode'], 'GONDOLA'],
            ['case', ['>', ['coalesce', ['get', 'rotation'], 0], 0], `stop-selected-icon-gondola-${theme.suffix}`, `stop-icon-gondola-${theme.suffix}`],
            ['case', ['>', ['coalesce', ['get', 'rotation'], 0], 0], `stop-selected-icon-${theme.suffix}`, `stop-icon-${theme.suffix}`]
        ];
        map.setLayoutProperty('stops-highlight', 'icon-image', highlightImage);
    }

    // Update Minibus Segments Color
    if (map.getLayer('minibus-segments-layer')) {
        const minibusColor = isDark ? '#80caff' : '#2563eb';
        const emissive = isDark ? 0.8 : 0;
        map.setPaintProperty('minibus-segments-layer', 'line-color', minibusColor);
        map.setPaintProperty('minibus-segments-layer', 'line-emissive-strength', emissive);
    }
}

export function addStopsToMap(stops, options = {}) {
    // Note: options like redirectMap, filterManager, updateConnectionLine are needed for interaction setup
    // But interaction logic (setupHoverHandlers) is likely called SEPARATELY in main.js
    // This function focuses on LAYERS.
    // However, it creates a filter connection layer dependent on filterManager?
    // Let's keep it as is.
    const { redirectMap, filterManager, updateConnectionLine } = options;

    const sourcesToClean = [
        'metro-stops',
        'metro-schematic-source',
        'metro-exits',
        'metro-lines-manual',
        'stops',
        'selected-stop',
        'filter-connection'
    ];

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
            'circle-stroke-color': '#555555',
            'circle-stroke-width': 1.5,
            'circle-stroke-opacity': 1,
            'circle-radius': getCircleRadiusExpression(1),
            'circle-opacity': 1,
            'circle-emissive-strength': 1
        }
    });

    // Hover layer: renders above stops-layer-circle to pop hovered stop to top
    map.addLayer({
        id: 'stops-layer-circle-hover',
        type: 'circle',
        source: 'stops',
        maxzoom: 15.2,
        slot: 'top',
        filter: ['==', ['get', 'id'], ''], // Initially hidden (no match)
        paint: {
            'circle-color': '#000000',
            'circle-stroke-color': '#555555',
            'circle-stroke-width': 1.5,
            'circle-stroke-opacity': 1,
            'circle-radius': getCircleRadiusExpression(1),
            'circle-opacity': 1,
            'circle-emissive-strength': 1
        }
    });

    const isDark = document.body.classList.contains('dark-mode');
    const themeSuffix = isDark ? 'dark' : 'light';

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
            'icon-image': [
                'case',
                ['all',
                    ['==', ['get', 'mode'], 'GONDOLA'],
                    ['any',
                        ['==', ['get', 'source'], 'config'],
                        ['==', ['get', '_source'], 'config'],
                        ['==', ['get', 'provider'], 'manual-gondola'],
                        ['==', ['get', 'ticketProvider'], 'manual-gondola']
                    ]
                ],
                ['case', ['==', ['get', 'rotation'], 0], `stop-icon-gondola-manual-${themeSuffix}`, `stop-close-up-icon-gondola-manual-${themeSuffix}`],
                ['==', ['get', 'mode'], 'GONDOLA'],
                ['case', ['==', ['get', 'rotation'], 0], `stop-icon-gondola-${themeSuffix}`, `stop-close-up-icon-gondola-${themeSuffix}`],
                ['case', ['==', ['get', 'rotation'], 0], `stop-icon-${themeSuffix}`, `stop-close-up-icon-${themeSuffix}`]
            ],
            'icon-size': ['interpolate', ['linear'], ['zoom'], 15.2, 0.5, 16, 0.6, 18, 0.8],
            'icon-rotate': ['get', 'rotation'],
            'icon-rotation-alignment': 'map'
        },
        paint: {
            'icon-opacity': 1,
            'icon-emissive-strength': 1
        }
    });

    // Hover symbol layer: renders above stops-layer to pop hovered stop to top at high zoom
    map.addLayer({
        id: 'stops-layer-hover',
        type: 'symbol',
        source: 'stops',
        minzoom: 15.2,
        slot: 'top',
        filter: ['==', ['get', 'id'], ''], // Initially hidden (no match)
        layout: {
            'icon-allow-overlap': true,
            'icon-ignore-placement': true,
            'symbol-z-order': 'source',
            'icon-image': [
                'case',
                ['all',
                    ['==', ['get', 'mode'], 'GONDOLA'],
                    ['any',
                        ['==', ['get', 'source'], 'config'],
                        ['==', ['get', '_source'], 'config'],
                        ['==', ['get', 'provider'], 'manual-gondola'],
                        ['==', ['get', 'ticketProvider'], 'manual-gondola']
                    ]
                ],
                ['case', ['==', ['get', 'rotation'], 0], `stop-icon-gondola-manual-${themeSuffix}`, `stop-close-up-icon-gondola-manual-${themeSuffix}`],
                ['==', ['get', 'mode'], 'GONDOLA'],
                ['case', ['==', ['get', 'rotation'], 0], `stop-icon-gondola-${themeSuffix}`, `stop-close-up-icon-gondola-${themeSuffix}`],
                ['case', ['==', ['get', 'rotation'], 0], `stop-icon-${themeSuffix}`, `stop-close-up-icon-${themeSuffix}`]
            ],
            'icon-size': ['interpolate', ['linear'], ['zoom'], 15.2, 0.5, 16, 0.6, 18, 0.8],
            'icon-rotate': ['get', 'rotation'],
            'icon-rotation-alignment': 'map'
        },
        paint: {
            'icon-opacity': 1,
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
            'icon-image': [
                'case',
                ['all',
                    ['==', ['get', 'mode'], 'GONDOLA'],
                    ['any',
                        ['==', ['get', 'source'], 'config'],
                        ['==', ['get', '_source'], 'config'],
                        ['==', ['get', 'provider'], 'manual-gondola'],
                        ['==', ['get', 'ticketProvider'], 'manual-gondola']
                    ]
                ],
                ['case', ['>', ['coalesce', ['get', 'rotation'], 0], 0], `stop-selected-icon-gondola-manual-${themeSuffix}`, `stop-icon-gondola-manual-${themeSuffix}`],
                ['==', ['get', 'mode'], 'GONDOLA'],
                ['case', ['>', ['coalesce', ['get', 'rotation'], 0], 0], `stop-selected-icon-gondola-${themeSuffix}`, `stop-icon-gondola-${themeSuffix}`],
                ['case', ['>', ['coalesce', ['get', 'rotation'], 0], 0], `stop-selected-icon-${themeSuffix}`, `stop-icon-${themeSuffix}`]
            ],
            'icon-size': ['case', ['==', ['get', 'mode'], 'SUBWAY'], 1.5, 1.2],
            'icon-allow-overlap': true,
            'icon-ignore-placement': true,
            'icon-rotate': ['coalesce', ['get', 'rotation'], 0],
            'icon-rotation-alignment': 'map'
        },
        paint: {
            'icon-opacity': 1,
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

    map.addLayer({
        id: 'filter-connection-label',
        type: 'symbol',
        source: 'filter-connection',
        slot: 'top',
        filter: ['all', ['==', ['geometry-type'], 'Point'], ['has', 'label']],
        layout: {
            'symbol-placement': 'point',
            'text-field': ['get', 'label'],
            'text-font': ['Open Sans Semibold', 'Arial Unicode MS Bold'],
            'text-size': 13,
            'text-justify': 'center',
            'text-anchor': 'center',
            'text-allow-overlap': true,
            'text-padding': 2,
            'text-offset': ['case', ['has', 'labelOffset'], ['get', 'labelOffset'], ['literal', [0, 0]]],
            'icon-image': 'route-plaque',
            'icon-text-fit': 'both',
            'icon-text-fit-padding': [6, 10, 6, 10],
            'icon-allow-overlap': true,
            'icon-padding': 2,
            'text-rotation-alignment': 'viewport',
            'icon-rotation-alignment': 'viewport'
        },
        paint: {
            'text-color': '#ffffff',
            'text-halo-color': 'rgba(0,0,0,0)',
            'icon-color': ['get', 'color'],
            'icon-opacity': 0.95
        }
    });

    map.addLayer({
        id: 'filter-connection-label-sub',
        type: 'symbol',
        source: 'filter-connection',
        slot: 'top',
        filter: ['all', ['==', ['geometry-type'], 'Point'], ['has', 'subLabel']],
        layout: {
            'symbol-placement': 'point',
            'text-field': ['get', 'subLabel'],
            'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
            'text-size': 12,
            'text-justify': 'center',
            'text-anchor': 'center',
            'text-allow-overlap': true,
            'text-padding': 2,
            'text-offset': ['case', ['has', 'subLabelOffset'], ['get', 'subLabelOffset'], ['literal', [0, 2.8]]],
            'text-rotation-alignment': 'viewport'
        },
        paint: {
            'text-color': '#ffffff',
            'text-halo-color': 'rgba(0,0,0,0)',
            'text-opacity': 1
        }
    });

    metro.addMetroLayers(map, metroFeatures, metroLines, stops);

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
    // Move hover layers to very top so hovered stop always renders above all other stops
    if (map.getLayer('stops-layer-circle-hover')) {
        map.moveLayer('stops-layer-circle-hover');
    }
    if (map.getLayer('stops-layer-hover')) {
        map.moveLayer('stops-layer-hover');
    }

    // Move metro exits even higher than bus stops
    if (map.getLayer('metro-exits-glow')) {
        map.moveLayer('metro-exits-glow');
    }
    if (map.getLayer('metro-exits-layer')) {
        map.moveLayer('metro-exits-layer');
    }

    // Ensure segment center labels are also on top
    if (map.getLayer('metro-segment-center-label')) {
        map.moveLayer('metro-segment-center-label');
    }

    // Move place/district labels below our transit layers
    movePlaceLabelsBelow();

    updateMapTheme();

    // Re-apply filter state if active (updateMapTheme resets layer styles)
    if (filterManager && (filterManager.state.active || filterManager.state.picking)) {
        filterManager.updateMapFilterState();
    }
}

function ensureLiveBusLayers() {
    if (!map.getSource('live-buses')) {
        map.addSource('live-buses', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    }

    if (!map.getLayer('live-buses-bg')) {
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
    }

    if (!map.getLayer('live-buses-circle')) {
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
    }

    if (!map.getLayer('live-buses-arrow')) {
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

    // Keep live buses above stop markers
    if (map.getLayer('live-buses-bg')) map.moveLayer('live-buses-bg');
    if (map.getLayer('live-buses-circle')) map.moveLayer('live-buses-circle');
    if (map.getLayer('live-buses-arrow')) map.moveLayer('live-buses-arrow');

    if (!map.__liveBusHandlersAttached) {
        map.__liveBusHandlersAttached = true;
        const onEnter = () => { map.getCanvas().style.cursor = 'pointer'; };
        const onLeave = () => { map.getCanvas().style.cursor = ''; };
        map.on('mouseenter', 'live-buses-circle', onEnter);
        map.on('mouseleave', 'live-buses-circle', onLeave);
        map.on('click', 'live-buses-circle', (e) => {
            const f = e?.features?.[0];
            const id = f?.properties?.id;
            if (!id) return;
            toggleLiveBusFollow(String(id));
        });
    }
}

let liveBusAnimationId = null;
let liveBusLastFeatures = new Map(); // vehicleId -> feature
let liveBusCurrentFeatures = new Map(); // vehicleId -> feature (current animated frame)
const liveBusLineCache = new Map(); // lineKey -> { coords, cumDist, total }
const LIVE_BUS_UPDATE_INTERVAL_MS = 5000;
const LIVE_BUS_ANIMATION_MS = 1200;
let liveBusFollowId = null;

function easeInOutCubic(t) {
    return t < 0.5
        ? 4 * t * t * t
        : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function buildLiveBusFeature(id, lon, lat, heading, color, extraProps = null) {
    return {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [lon, lat] },
        properties: { id, heading, color, ...(extraProps || {}) }
    };
}

function normalizeHeading(deg) {
    if (!Number.isFinite(deg)) return null;
    const h = deg % 360;
    return h < 0 ? h + 360 : h;
}

function interpolateHeading(a, b, t) {
    const ha = normalizeHeading(a);
    const hb = normalizeHeading(b);
    if (ha === null && hb === null) return null;
    if (ha === null) return hb;
    if (hb === null) return ha;
    let delta = hb - ha;
    if (delta > 180) delta -= 360;
    if (delta < -180) delta += 360;
    const out = ha + delta * t;
    return normalizeHeading(out);
}

function easeOutCubic(t) {
    return 1 - Math.pow(1 - t, 3);
}

function haversineMeters(a, b) {
    const toRad = (deg) => deg * (Math.PI / 180);
    const dLat = toRad(b[1] - a[1]);
    const dLon = toRad(b[0] - a[0]);
    const lat1 = toRad(a[1]);
    const lat2 = toRad(b[1]);
    const sinLat = Math.sin(dLat / 2);
    const sinLon = Math.sin(dLon / 2);
    const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon;
    return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

function buildLineMeta(coords) {
    const cumDist = [0];
    let total = 0;
    for (let i = 1; i < coords.length; i += 1) {
        total += haversineMeters(coords[i - 1], coords[i]);
        cumDist.push(total);
    }
    return { coords, cumDist, total };
}

function pointAlongLine(meta, fraction) {
    if (!meta || !meta.coords || meta.coords.length === 0) return null;
    if (meta.coords.length === 1) return meta.coords[0];
    const f = Math.max(0, Math.min(1, fraction));
    const target = meta.total * f;
    const cum = meta.cumDist;
    let idx = 0;
    while (idx < cum.length - 1 && cum[idx + 1] < target) idx += 1;
    const segStart = meta.coords[idx];
    const segEnd = meta.coords[idx + 1] || segStart;
    const segLen = cum[idx + 1] - cum[idx];
    if (segLen <= 0) return segStart;
    const t = (target - cum[idx]) / segLen;
    return [
        segStart[0] + (segEnd[0] - segStart[0]) * t,
        segStart[1] + (segEnd[1] - segStart[1]) * t
    ];
}

function setLiveBusData(features = []) {
    ensureLiveBusLayers();
    if (map.getSource('live-buses')) {
        map.getSource('live-buses').setData({ type: 'FeatureCollection', features });
    }
}

function offsetPointByHeading(lon, lat, headingDeg, meters) {
    if (!Number.isFinite(headingDeg) || !Number.isFinite(lon) || !Number.isFinite(lat)) return [lon, lat];
    const R = 6371000;
    const brng = (headingDeg * Math.PI) / 180;
    const lat1 = (lat * Math.PI) / 180;
    const lon1 = (lon * Math.PI) / 180;
    const dr = meters / R;
    const lat2 = Math.asin(Math.sin(lat1) * Math.cos(dr) + Math.cos(lat1) * Math.sin(dr) * Math.cos(brng));
    const lon2 = lon1 + Math.atan2(Math.sin(brng) * Math.sin(dr) * Math.cos(lat1), Math.cos(dr) - Math.sin(lat1) * Math.sin(lat2));
    return [(lon2 * 180) / Math.PI, (lat2 * 180) / Math.PI];
}

export function renderLiveBuses(features = []) {
    try {
        if (!Array.isArray(features) || features.length === 0) {
            if (liveBusAnimationId) cancelAnimationFrame(liveBusAnimationId);
            liveBusAnimationId = null;
            liveBusLastFeatures.clear();
            liveBusCurrentFeatures.clear();
            setLiveBusData([]);
            return;
        }

        const nextById = new Map();
        features.forEach((f) => {
            const id = f?.properties?.id;
            if (!id) return;
            nextById.set(String(id), f);
        });

        const startById = new Map();
        nextById.forEach((next, id) => {
            const current = liveBusCurrentFeatures.get(id);
            const prev = liveBusLastFeatures.get(id);
            if (current?.geometry && next?.geometry) {
                startById.set(id, current);
            } else if (prev?.geometry && next?.geometry) {
                startById.set(id, prev);
            } else {
                startById.set(id, next);
            }
        });

        if (liveBusAnimationId) cancelAnimationFrame(liveBusAnimationId);
        const startTime = performance.now();
        const totalMs = Math.min(LIVE_BUS_ANIMATION_MS, LIVE_BUS_UPDATE_INTERVAL_MS);

        const animate = (now) => {
            const elapsed = now - startTime;
            const t = Math.max(0, Math.min(1, elapsed / totalMs));
            const k = easeInOutCubic(t);
            const blended = [];

            nextById.forEach((next, id) => {
                const start = startById.get(id) || next;
                const startProps = start.properties || {};
                const endProps = next.properties || {};
                const lineKey = endProps._lineKey || startProps._lineKey || null;
                const hasLine = lineKey && liveBusLineCache.has(lineKey) &&
                    Number.isFinite(startProps._lineFrac) && Number.isFinite(endProps._lineFrac);

                if (hasLine) {
                    const rawDelta = endProps._lineFrac - startProps._lineFrac;
                    if (Math.abs(rawDelta) > 0.35) {
                        blended.push(next);
                        return;
                    }
                    const meta = liveBusLineCache.get(lineKey);
                    const frac = Math.max(0, Math.min(1, startProps._lineFrac + (rawDelta * k)));
                    const point = pointAlongLine(meta, frac) || next.geometry?.coordinates || start.geometry?.coordinates;
                    blended.push(buildLiveBusFeature(
                        id,
                        point[0],
                        point[1],
                        interpolateHeading(startProps.heading, endProps.heading, k),
                        endProps.color,
                        {
                            _ts: endProps._ts,
                            _lineKey: lineKey,
                            _lineFrac: frac
                        }
                    ));
                    return;
                }

                const a = start.geometry?.coordinates || next.geometry?.coordinates;
                const b = next.geometry?.coordinates || a;
                const lon = a[0] + (b[0] - a[0]) * k;
                const lat = a[1] + (b[1] - a[1]) * k;
                blended.push(buildLiveBusFeature(
                    id,
                    lon,
                    lat,
                    interpolateHeading(startProps.heading, endProps.heading, k),
                    endProps.color,
                    {
                        _ts: endProps._ts,
                        _lineKey: endProps._lineKey ?? startProps._lineKey ?? null,
                        _lineFrac: Number.isFinite(endProps._lineFrac) ? endProps._lineFrac : null
                    }
                ));
            });

            setLiveBusData(blended);
            liveBusCurrentFeatures = new Map();
            blended.forEach((f) => {
                const fid = f?.properties?.id;
                if (fid) liveBusCurrentFeatures.set(String(fid), f);
            });

            if (liveBusFollowId) {
                const follow = liveBusCurrentFeatures.get(String(liveBusFollowId));
                const coords = follow?.geometry?.coordinates;
                if (coords && Number.isFinite(coords[0]) && Number.isFinite(coords[1])) {
                    map.easeTo({ center: coords, duration: 300, easing: (x) => x * (2 - x) });
                }
            }

            if (t < 1) {
                liveBusAnimationId = requestAnimationFrame(animate);
                return;
            }

            liveBusAnimationId = null;
            setLiveBusData(features);
            liveBusCurrentFeatures = new Map(nextById);
            liveBusLastFeatures = new Map(nextById);
        };

        liveBusAnimationId = requestAnimationFrame(animate);

        if (liveBusFollowId) {
            const follow = nextById.get(String(liveBusFollowId));
            const coords = follow?.geometry?.coordinates;
            if (coords && Number.isFinite(coords[0]) && Number.isFinite(coords[1])) {
                map.easeTo({ center: coords, duration: 300, easing: (x) => x * (2 - x) });
            }
        }
    } catch (error) {
        console.error('Failed to render live buses:', error);
    }
}

export function registerLiveBusLine(lineKey, coords) {
    if (!lineKey || !Array.isArray(coords) || coords.length < 2) return;
    if (liveBusLineCache.has(lineKey)) return;
    liveBusLineCache.set(lineKey, buildLineMeta(coords));
}

export function clearLiveBuses() {
    if (liveBusAnimationId) cancelAnimationFrame(liveBusAnimationId);
    liveBusAnimationId = null;
    liveBusLastFeatures.clear();
    liveBusCurrentFeatures.clear();
    liveBusFollowId = null;
    setLiveBusData([]);
}

export function holdLiveBuses() {
    if (liveBusAnimationId) cancelAnimationFrame(liveBusAnimationId);
    liveBusAnimationId = null;
}

function applyLiveBusOpacity() {
    const opacityExpr = liveBusFollowId
        ? ['case', ['==', ['get', 'id'], String(liveBusFollowId)], 1.0, 0.5]
        : 1.0;
    if (map.getLayer('live-buses-bg')) {
        map.setPaintProperty('live-buses-bg', 'icon-opacity', opacityExpr);
    }
    if (map.getLayer('live-buses-circle')) {
        map.setPaintProperty('live-buses-circle', 'icon-opacity', opacityExpr);
    }
    if (map.getLayer('live-buses-arrow')) {
        map.setPaintProperty('live-buses-arrow', 'icon-opacity', opacityExpr);
    }
}

export function toggleLiveBusFollow(busId) {
    // Follow mode temporarily disabled.
    liveBusFollowId = null;
    applyLiveBusOpacity();
}

export async function updateLiveBuses(routeId, patternSuffix, color, options = {}) {
    try {
        if (typeof options.shouldRender === 'function' && !options.shouldRender()) {
            return;
        }
        const positionsData = await api.fetchBusPositionsV3(routeId, patternSuffix);
        if (typeof options.shouldRender === 'function' && !options.shouldRender()) {
            return;
        }
        const buses = positionsData[patternSuffix] || [];
        const nowTs = Date.now();
        const features = buses.map(bus => ({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [bus.lon, bus.lat] },
            properties: {
                heading: bus.heading,
                id: bus.vehicleId,
                color: color,
                _ts: nowTs
            }
        }));
        renderLiveBuses(features);
    } catch (error) {
        console.error('Failed to update live buses:', error);
    }
}

export function updateStopHoverEffects(hoveredId) {
    if (!map || !map.getStyle()) return;
    const filterModeActive = window.isFilterModeActive === true;
    if (window.currentStopId && !filterModeActive) return;

    const isDark = document.body.classList.contains('dark-mode');
    const safeHoveredId = hoveredId ?? '';
    const manualGondolaExpr = [
        'all',
        ['==', ['get', 'mode'], 'GONDOLA'],
        ['any',
            ['==', ['get', 'source'], 'config'],
            ['==', ['get', '_source'], 'config'],
            ['==', ['get', 'provider'], 'manual-gondola'],
            ['==', ['get', 'ticketProvider'], 'manual-gondola']
        ]
    ];

    // Theme values
    const colors = {
        base: isDark ? '#FFED74' : '#3C3C3C',
        baseStroke: isDark ? '#D4C45A' : '#5C5C5C',
        gondolaBase: isDark ? '#60A5FA' : '#2563EB',
        gondolaStroke: isDark ? '#3B82F6' : '#1D4ED8',
        manualGondolaBase: isDark ? '#2DD4BF' : '#0D9488',
        manualGondolaStroke: isDark ? '#14B8A6' : '#0F766E',
        hover: isDark ? '#FFFFFF' : '#898989',
        hoverStroke: isDark ? '#E5E7EB' : '#FFFFFF',
        glowBase: 0.05,
        glowHover: 0.7
    };

    // Update Circle Layers
    if (map.getLayer('stops-layer-circle')) {
        map.setPaintProperty('stops-layer-circle', 'circle-color', [
            'case',
            ['==', ['get', 'id'], safeHoveredId], colors.hover,
            manualGondolaExpr, colors.manualGondolaBase,
            ['==', ['get', 'mode'], 'GONDOLA'], colors.gondolaBase,
            colors.base
        ]);
        map.setPaintProperty('stops-layer-circle', 'circle-stroke-color', [
            'case',
            ['==', ['get', 'id'], safeHoveredId], colors.hoverStroke,
            manualGondolaExpr, colors.manualGondolaStroke,
            ['==', ['get', 'mode'], 'GONDOLA'], colors.gondolaStroke,
            colors.baseStroke
        ]);
    }

    if (map.getLayer('stops-layer-circle-hover')) {
        map.setFilter('stops-layer-circle-hover', ['==', ['get', 'id'], safeHoveredId]);
        map.setPaintProperty('stops-layer-circle-hover', 'circle-color', [
            'case',
            ['==', ['get', 'id'], safeHoveredId], colors.hover,
            manualGondolaExpr, colors.manualGondolaBase,
            ['==', ['get', 'mode'], 'GONDOLA'], colors.gondolaBase,
            colors.base
        ]);
        map.setPaintProperty('stops-layer-circle-hover', 'circle-stroke-color', [
            'case',
            ['==', ['get', 'id'], safeHoveredId], colors.hoverStroke,
            manualGondolaExpr, colors.manualGondolaStroke,
            ['==', ['get', 'mode'], 'GONDOLA'], colors.gondolaStroke,
            colors.baseStroke
        ]);
    }

    // Update Glow Layers
    if (map.getLayer('stops-layer-glow')) {
        map.setPaintProperty('stops-layer-glow', 'circle-opacity', ['case', ['==', ['get', 'id'], safeHoveredId], colors.glowHover, colors.glowBase]);
        map.setPaintProperty('stops-layer-glow', 'circle-color', [
            'case',
            ['==', ['get', 'id'], safeHoveredId], colors.hover,
            manualGondolaExpr, colors.manualGondolaBase,
            ['==', ['get', 'mode'], 'GONDOLA'], colors.gondolaBase,
            colors.base
        ]);
    }

    // Update Symbol Layers (Close-up)
    if (map.getLayer('stops-layer-hover')) {
        map.setFilter('stops-layer-hover', ['==', ['get', 'id'], safeHoveredId]);
        const hoverSuffix = isDark ? 'hover-dark' : 'hover-light';
        const gondolaSuffix = isDark ? 'gondola-dark' : 'gondola-light';
        const gondolaManualSuffix = isDark ? 'gondola-manual-dark' : 'gondola-manual-light';
        map.setLayoutProperty('stops-layer-hover', 'icon-image', [
            'case',
            manualGondolaExpr,
            ['case', ['==', ['get', 'rotation'], 0], `stop-icon-${gondolaManualSuffix}`, `stop-close-up-icon-${gondolaManualSuffix}`],
            ['==', ['get', 'mode'], 'GONDOLA'],
            ['case', ['==', ['get', 'rotation'], 0], `stop-icon-${gondolaSuffix}`, `stop-close-up-icon-${gondolaSuffix}`],
            ['case', ['==', ['get', 'rotation'], 0], `stop-icon-${hoverSuffix}`, `stop-close-up-icon-${hoverSuffix}`]
        ]);
    }

    // Metro circle radius hover effect
    if (map.getLayer('metro-layer-circle')) {
        map.setPaintProperty('metro-layer-circle', 'circle-radius', [
            'interpolate', ['linear'], ['zoom'],
            10, ['case', ['==', ['get', 'id'], safeHoveredId], 8, 5],
            12, ['case', ['==', ['get', 'id'], safeHoveredId], 10, 7],
            14, ['case', ['==', ['get', 'id'], safeHoveredId], 14, 10],
            16, ['case', ['==', ['get', 'id'], safeHoveredId], 18, 14]
        ]);
    }
}
