import mapboxgl from 'mapbox-gl';
import * as api from './api.js';
import * as metro from './metro.js';
import stopRotations from './data/stop_bearings.json';

// Initialize Map
mapboxgl.accessToken = api.MAPBOX_TOKEN;

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
            showPointOfInterestLabels: false,
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

export function setMapFocus(active) {
    const isDark = document.body.classList.contains('dark-mode');
    const baseOpacity = isDark ? 0.3 : 0.4;
    const selectedId = window.currentStopId || "";

    const opacityExpr = active ? [
        'case',
        ['==', ['get', 'id'], selectedId], 1.0,
        baseOpacity
    ] : 1.0;

    const labelColor = isDark ? '#ffffff' : '#000000';
    const haloColor = isDark ? '#000000' : '#ffffff';

    if (map.getLayer('stops-layer')) {
        map.setPaintProperty('stops-layer', 'icon-opacity', opacityExpr);
    }
    if (map.getLayer('stops-layer-circle')) {
        map.setPaintProperty('stops-layer-circle', 'circle-opacity', opacityExpr);
        map.setPaintProperty('stops-layer-circle', 'circle-stroke-opacity', opacityExpr);
    }
    if (map.getLayer('metro-layer-circle')) {
        // Opacity: Highlight selected, dim others if active
        const metroOpacity = active ? [
            'case',
            ['==', ['get', 'id'], selectedId], 1.0,
            0.4
        ] : 1.0;

        map.setPaintProperty('metro-layer-circle', 'circle-opacity', metroOpacity);
        map.setPaintProperty('metro-layer-circle', 'circle-stroke-opacity', metroOpacity);

        // Radius: Enlarge selected
        const radiusExpr = [
            'interpolate',
            ['linear'],
            ['zoom'],
            10, ['case', ['==', ['get', 'id'], selectedId], 6, 3],
            14, ['case', ['==', ['get', 'id'], selectedId], 13, 8],
            16, ['case', ['==', ['get', 'id'], selectedId], 17, 12]
        ];
        map.setPaintProperty('metro-layer-circle', 'circle-radius', radiusExpr);

        // Sync Overlay Layer for Hover Effect (30% white tint)
        if (map.getLayer('metro-layer-overlay')) {
            map.setPaintProperty('metro-layer-overlay', 'circle-radius', radiusExpr);
        }
    }
    if (map.getLayer('metro-lines-layer')) {
        map.setPaintProperty('metro-lines-layer', 'line-opacity', active ? 0.3 : 0.8);
    }
    if (map.getLayer('metro-layer-label')) {
        map.setPaintProperty('metro-layer-label', 'text-color', labelColor);
        map.setPaintProperty('metro-layer-label', 'text-halo-color', haloColor);
        map.setPaintProperty('metro-layer-label', 'text-opacity', opacityExpr);
    }

    if (map.getLayer('metro-transfer-layer')) {
        map.setPaintProperty('metro-transfer-layer', 'icon-opacity', opacityExpr);
        map.setPaintProperty('metro-transfer-layer', 'text-opacity', opacityExpr);
        map.setPaintProperty('metro-transfer-layer', 'text-color', labelColor);
        map.setPaintProperty('metro-transfer-layer', 'text-halo-color', haloColor);
    }

    if (map.getLayer('stops-label-selected')) {
        map.setPaintProperty('stops-label-selected', 'text-opacity', opacityExpr);
        map.setPaintProperty('stops-label-selected', 'text-color', labelColor);
        map.setPaintProperty('stops-label-selected', 'text-halo-color', haloColor);
    }

    if (map.getLayer('stops-highlight')) {
        map.setPaintProperty('stops-highlight', 'icon-opacity', 1.0);
    }
}

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

// --- 3D Buildings & Theme-Based Lighting ---
let is3dEnabled = false;
let currentLightPreset = initialLightPreset;

const PERMANENT_CONFIG = {
    showPointOfInterestLabels: false,
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
    } catch (err) {
        console.warn('[Map] ensureTerrain error:', err.message);
    }
}

// User preferences for 3D features (read from localStorage, default true)
let user3DBuildings = localStorage.getItem('show3DBuildings') !== 'false';
let user3DTerrain = localStorage.getItem('show3DTerrain') !== 'false';
let userExaggerate = localStorage.getItem('exaggerateTerrain') === 'true';

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
function initMapFeatures() {
    try {
        update3DBuildings();
        update3DTerrain();
        hideShieldLayers();
    } catch (err) {
        console.error('[Map] Failed to init features:', err);
    }
}

// Reverted: decided to keep shields for now
function hideShieldLayers() {
    // No-op
}

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

const geolocate = new mapboxgl.GeolocateControl({
    positionOptions: {
        enableHighAccuracy: true,
        timeout: 15000 // Increased for mobile reliability
    },
    trackUserLocation: true,
    showUserHeading: true, // Always request heading - indicator only shows when compass data is available
    showAccuracyCircle: true
});

// Defensive fix for minified Mapbox GL JS bug where it expects this to exist
if (!geolocate._onGeolocateStop) {
    geolocate._onGeolocateStop = () => { };
}

map.addControl(geolocate);

// Tracking variables
let lastLocateClickTime = 0;
let lastUserCoords = null;
let isUserInteracting = false;
let isUserRotating = false;
let isDragging = false; // Explicit flag for drag gesture
let isPitching = false; // Explicit flag for pitch/tilt gesture
let isReCentering = false; // Moved to module scope for geolocate handler access

// Listen for programmatic pitch from 3D toggle button
window.addEventListener('programmaticPitch', (e) => {
    isPitching = e.detail;
});

geolocate.on('error', (e) => {
    const error = e.error || e;
    const code = error.code;
    const message = error.message || '';
    const timeSinceClick = Date.now() - lastLocateClickTime;

    console.error('[Location] Error:', { code, message, timeSinceClick, original: e });

    // Guard: Don't reset state if this is a quick error during initial trigger
    // (user clicked, we set FOLLOW, but permission was denied before first geolocate event)
    // We only reset if we were actually tracking (had received at least one position)
    const wasTracking = lastUserCoords !== null;

    if (!wasTracking && timeSinceClick < 3000) {
        console.log('[Location] Ignoring error during initial permission request');
        // Don't reset - let the explicit permission dialog error handlers do that
    } else {
        // State reset
        currentLocationState = LOCATION_STATES.OFF;
        const locateBtn = document.getElementById('locate-me');
        if (locateBtn) updateLocationIcon(locateBtn);
    }

    // 1. Silent rejection check (iOS / Safari / Unsecure context)
    if (!code && !message && timeSinceClick < 3000) {
        if (!isSecureContext()) {
            alert('Location request failed. This app requires a secure (HTTPS) connection to access your location.');
        } else {
            const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
            const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;

            if (isSafari && isMac) {
                alert('Location failed silently. On Mac Safari, please check: \n1. System Settings -> Privacy & Security -> Location Services (Enable for Safari)\n2. Safari Menu -> Settings for This Website -> Location (Set to Allow)');
            } else if (isSafari) {
                alert('Location failed silently. On iOS Safari, please check: \n1. Settings -> Privacy -> Location Services (Enable)\n2. Settings -> Safari -> Location (Set to Allow)');
            } else {
                alert('Location request failed silently. This usually happens if "Location Services" are disabled in System Settings or if the connection is untrusted.');
            }
        }
        return;
    }

    // 2. Background/Ignorable errors
    if (!code && !message) {
        console.log('[Location] Background interruption ignored');
        return;
    }

    // 3. Explicit W3C Errors
    if (code === 1) { // PERMISSION_DENIED
        alert('Location access denied. Please enable location permissions for this site in your browser settings.');
    } else if (code === 2) { // POSITION_UNAVAILABLE
        alert('Location unavailable. Your device could not determine its position. Check your GPS/network signal.');
    } else if (code === 3) { // TIMEOUT
        alert('Location request timed out. Please try again in a moment.');
    } else {
        alert(`Location error (${code || 'unknown'}): ${message || 'No details'}`);
    }
});

// SUCCESS Handler: Sync internal state with actual tracking
let isOrientationTrackingStarted = false;
let latestHeading = null;

function startPersistentOrientationTracking() {
    if (isOrientationTrackingStarted) return;

    const onOrientation = (e) => {
        // High priority: Use webkitCompassHeading for iOS (Absolute)
        // Fallback: alpha if absolute: true
        let heading = e.webkitCompassHeading;
        if (heading === undefined || heading === null) {
            if (e.absolute) heading = 360 - e.alpha;
        }

        if (heading === undefined || heading === null) return;
        latestHeading = heading;

        // Throttle bearing updates to once per 100ms to avoid race conditions with drag
        const now = Date.now();
        if (!onOrientation.lastUpdate || now - onOrientation.lastUpdate > 100) {
            onOrientation.lastUpdate = now;
            // Apply to map ONLY if we are in HEADING state and user is NOT interacting
            // (Pitch/tilt is allowed - it doesn't affect center or bearing, but we skip during programmatic pitch)
            if (currentLocationState === LOCATION_STATES.HEADING && !isUserRotating && !isUserInteracting && !isDragging && !isPitching && !isReCentering) {
                map.easeTo({ bearing: heading, duration: 150, easing: (t) => t });
            }
        }
    };

    window.addEventListener('deviceorientation', onOrientation);
    window.addEventListener('deviceorientationabsolute', onOrientation);
    isOrientationTrackingStarted = true;
}

// Track if we're waiting for first location
let isWaitingForFirstLocation = false;
let isAutoShowingMarker = false; // Flag to show marker without centering

// Auto-trigger location on launch if permission was already granted
// Shows the location marker but doesn't enter follow mode or center the map
if (navigator.permissions && navigator.permissions.query) {
    navigator.permissions.query({ name: 'geolocation' }).then(result => {
        if (result.state === 'granted') {
            // Store original methods to restore later when user explicitly clicks locate
            window._originalMapMethods = {
                flyTo: map.flyTo.bind(map),
                jumpTo: map.jumpTo.bind(map),
                easeTo: map.easeTo.bind(map)
            };

            isAutoShowingMarker = true;
            // Override map methods to prevent centering - stays until user clicks locate
            map.flyTo = () => map; // No-op
            map.jumpTo = () => map; // No-op
            map.easeTo = () => map; // No-op

            geolocate.trigger();

            // Don't restore methods here - they'll be restored when user clicks locate button

            // Probe for compass data to show heading indicator if available
            let hasRealCompass = false;
            const probeHandler = (e) => {
                const hasAlpha = e.alpha !== null && e.alpha !== undefined;
                const hasHeading = e.webkitCompassHeading !== null && e.webkitCompassHeading !== undefined;
                if (hasAlpha || hasHeading) {
                    hasRealCompass = true;
                    document.documentElement.classList.add('show-heading-indicator');
                    window.removeEventListener('deviceorientation', probeHandler);
                    window.removeEventListener('deviceorientationabsolute', probeHandler);
                }
            };
            window.addEventListener('deviceorientation', probeHandler);
            window.addEventListener('deviceorientationabsolute', probeHandler);

            // Timeout: cleanup listeners (indicator is hidden by default, no action needed)
            setTimeout(() => {
                window.removeEventListener('deviceorientation', probeHandler);
                window.removeEventListener('deviceorientationabsolute', probeHandler);
            }, 1000);
        }
    }).catch(() => {
        // Permissions API not supported or failed - don't auto-trigger
    });
}

geolocate.on('geolocate', (e) => {
    const coords = e.coords;
    lastUserCoords = { lng: coords.longitude, lat: coords.latitude };

    // If we were waiting for first location, now we can update the icon
    if (isWaitingForFirstLocation) {
        isWaitingForFirstLocation = false;
        const locateBtn = document.getElementById('locate-me');
        if (locateBtn) updateLocationIcon(locateBtn);
    }

    // If auto-showing marker, clear the flag and don't center
    if (isAutoShowingMarker) {
        isAutoShowingMarker = false;
        return; // Skip centering the map
    }

    // Persistence: If we are in FOLLOW or HEADING mode, ensure the map actually follows
    // even if Mapbox's internal "ACTIVE_LOCK" was broken by zoom/drag.
    // Guard: Don't snap mid-drag, mid-rotation, mid-zoom, mid-pitch, or during a re-centering animation
    const shouldFollow = (currentLocationState === LOCATION_STATES.FOLLOW || currentLocationState === LOCATION_STATES.HEADING) && !isUserInteracting && !isUserRotating && !isDragging && !isPitching && !isReCentering;
    if (shouldFollow) {
        map.easeTo({
            center: [coords.longitude, coords.latitude],
            duration: 100 // Short duration for a "sticky" feel
        });
    }
});

geolocate.on('trackuserlocationstart', () => {
    // We wait for 'geolocate' event to turn the icon blue
});

geolocate.on('trackuserlocationend', () => {
    // We let our own state machine (currentLocationState) and dragend fuzzy logic
    // determine when to actually turn off the blue marker icon.
});

export const LOCATION_STATES = {
    OFF: 'OFF',
    FOLLOW: 'FOLLOW',
    HEADING: 'HEADING'
};

export function isTrackingActive() {
    return currentLocationState === LOCATION_STATES.FOLLOW || currentLocationState === LOCATION_STATES.HEADING;
}

export function isUserInteractingWithMap() {
    return isUserInteracting || isUserRotating;
}

export function stopTracking() {
    if (currentLocationState !== LOCATION_STATES.OFF) {
        currentLocationState = LOCATION_STATES.OFF;
        const locateBtn = document.getElementById('locate-me');
        if (locateBtn) updateLocationIcon(locateBtn);
    }
}

const LOCATION_ICONS = {
    OFF: `<img src="/tbilisi-trans/location.svg" width="24" height="24">`,
    FOLLOW: `<img src="/tbilisi-trans/location.fill.svg" width="24" height="24">`,
    HEADING: `<img src="/tbilisi-trans/location.north.line.fill.svg" width="24" height="24">`,
    SLASHED: `<img src="/tbilisi-trans/location.slash.svg" width="24" height="24">`
};

let currentLocationState = LOCATION_STATES.OFF;
let isHeadingSupported = false;

function isSecureContext() {
    const isSecure = window.isSecureContext || window.location.hostname === 'localhost';
    const hasGeo = !!navigator.geolocation;
    return isSecure && hasGeo;
}

async function checkLocationPermission() {
    if (!isSecureContext()) return 'denied';
    if (!navigator.permissions || !navigator.permissions.query) return 'prompt';
    try {
        const result = await navigator.permissions.query({ name: 'geolocation' });
        return result.state;
    } catch (e) {
        return 'prompt';
    }
}

function checkHeadingSupport() {
    // Check for DeviceOrientationEvent and webkitCompassHeading support (iOS)
    return !!(window.DeviceOrientationEvent) &&
        ('ontouchstart' in window || 'ondeviceorientationabsolute' in window || 'ondeviceorientation' in window);
}

function updateLocationIcon(btn) {
    if (!btn) return;

    // Check if we already have the "smashed" state which is set by click guard
    if (btn.innerHTML.includes('location.slash.svg') && currentLocationState === LOCATION_STATES.OFF) {
        return;
    }

    if (currentLocationState === LOCATION_STATES.OFF) {
        btn.innerHTML = LOCATION_ICONS.OFF;
        btn.classList.remove('active');
    } else if (currentLocationState === LOCATION_STATES.FOLLOW) {
        btn.innerHTML = LOCATION_ICONS.FOLLOW;
        btn.classList.add('active');
    } else if (currentLocationState === LOCATION_STATES.HEADING) {
        btn.innerHTML = LOCATION_ICONS.HEADING;
        btn.classList.add('active');
    }
}

export function setupMapControls() {
    const locateBtn = document.getElementById('locate-me');
    const miniCompass = document.getElementById('mini-compass');
    const compassIcon = miniCompass?.querySelector('svg');

    checkHeadingSupport();
    updateLocationIcon(locateBtn);

    // Zoom buttons need to manually set interaction flag since programmatic zooms
    // don't have originalEvent, so the guards in zoomstart won't activate
    document.getElementById('zoom-in')?.addEventListener('click', () => {
        isUserInteracting = true;
        map.zoomIn();
        map.once('zoomend', () => { isUserInteracting = false; });
    });
    document.getElementById('zoom-out')?.addEventListener('click', () => {
        isUserInteracting = true;
        map.zoomOut();
        map.once('zoomend', () => { isUserInteracting = false; });
    });

    // Hook into touch events directly on the map canvas to set flags EARLY
    // (before Mapbox's internal handlers and before compass/geolocate can interfere)
    const mapCanvas = map.getCanvas();
    mapCanvas.addEventListener('touchstart', (e) => {
        // Only set flags for single-finger touches (actual drags)
        // Two-finger gestures (pitch/rotate) should not block compass updates
        if (e.touches.length === 1) {
            isUserInteracting = true;
            isDragging = true;
        }
    }, { passive: true });
    mapCanvas.addEventListener('touchend', () => {
        // Small delay to let dragend fire first and do its calculations
        setTimeout(() => {
            isUserInteracting = false;
            isDragging = false;
        }, 50);
    }, { passive: true });
    mapCanvas.addEventListener('mousedown', () => {
        isUserInteracting = true;
        isDragging = true;
    });
    mapCanvas.addEventListener('mouseup', () => {
        setTimeout(() => {
            isUserInteracting = false;
            isDragging = false;
        }, 50);
    });

    if (locateBtn) {
        locateBtn.addEventListener('click', () => {
            lastLocateClickTime = Date.now();

            // Restore original map methods if they were overridden by auto-show
            if (window._originalMapMethods) {
                map.flyTo = window._originalMapMethods.flyTo;
                map.jumpTo = window._originalMapMethods.jumpTo;
                map.easeTo = window._originalMapMethods.easeTo;
                delete window._originalMapMethods;
                isAutoShowingMarker = false;
            }

            // 1. Strict Security Guard & Probe
            if (!isSecureContext()) {
                if (!navigator.geolocation) {
                    alert('Geolocation is disabled by your browser. If you see a "Not Secure" warning in the address bar, this is likely why. Please "Trust" the certificate to continue.');
                } else {
                    alert('Location services require a secure (HTTPS) connection.');
                }
                locateBtn.innerHTML = LOCATION_ICONS.SLASHED;
                return;
            }

            // 2. Action Logic
            if (currentLocationState === LOCATION_STATES.OFF) {
                // Clear any stale interaction state from previous panning
                interactionStartCenter = null;

                // Set FOLLOW state and update icon
                currentLocationState = LOCATION_STATES.FOLLOW;
                updateLocationIcon(locateBtn);

                // If we already have location from auto-show, just center the map
                if (lastUserCoords) {
                    map.easeTo({
                        center: [lastUserCoords.lng, lastUserCoords.lat],
                        duration: 500
                    });
                } else {
                    // First time - need to trigger geolocate
                    isWaitingForFirstLocation = true;
                    geolocate.trigger();
                }

                // Also request compass permission and enable heading indicator (blue slice)
                // This allows the user to see their heading direction from the start
                const enableHeadingIndicator = () => {
                    startPersistentOrientationTracking();

                    // Track if we received valid compass data
                    let hasRealCompass = false;

                    // Probe for valid compass data
                    const probeHandler = (e) => {
                        const hasAlpha = e.alpha !== null && e.alpha !== undefined;
                        const hasHeading = e.webkitCompassHeading !== null && e.webkitCompassHeading !== undefined;
                        if (hasAlpha || hasHeading) {
                            hasRealCompass = true;
                            // Add the show class when compass detected
                            document.documentElement.classList.add('show-heading-indicator');
                            window.removeEventListener('deviceorientation', probeHandler);
                            window.removeEventListener('deviceorientationabsolute', probeHandler);
                        }
                    };
                    window.addEventListener('deviceorientation', probeHandler);
                    window.addEventListener('deviceorientationabsolute', probeHandler);

                    // Timeout: cleanup listeners (indicator is hidden by default)
                    setTimeout(() => {
                        window.removeEventListener('deviceorientation', probeHandler);
                        window.removeEventListener('deviceorientationabsolute', probeHandler);
                    }, 1000);
                };

                if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
                    // iOS 13+ - needs explicit permission request
                    DeviceOrientationEvent.requestPermission()
                        .then(res => {
                            if (res === 'granted') {
                                enableHeadingIndicator();
                            }
                        })
                        .catch(e => console.warn('[Location] Compass permission request failed:', e));
                } else {
                    // Non-iOS - just enable it directly
                    enableHeadingIndicator();
                }
            } else if (currentLocationState === LOCATION_STATES.FOLLOW) {
                // To Heading - SYNC for iOS permission chain
                const attemptHeadingTransition = () => {
                    // Start persistent tracking if supported
                    startPersistentOrientationTracking();

                    // Probe for data support once
                    let probeReceived = false;
                    const probeHandler = (e) => {
                        const hasAlpha = e.alpha !== null && e.alpha !== undefined;
                        const hasHeading = e.webkitCompassHeading !== null && e.webkitCompassHeading !== undefined;
                        if (hasAlpha || hasHeading) {
                            probeReceived = true;
                            cleanup();
                            console.log('[Location] Heading hardware CONFIRMED');
                            isHeadingSupported = true;
                            geolocate.options.showUserHeading = true;
                            currentLocationState = LOCATION_STATES.HEADING;
                            updateLocationIcon(locateBtn);
                        }
                    };

                    const cleanup = () => {
                        window.removeEventListener('deviceorientation', probeHandler);
                        window.removeEventListener('deviceorientationabsolute', probeHandler);
                    };

                    window.addEventListener('deviceorientation', probeHandler);
                    window.addEventListener('deviceorientationabsolute', probeHandler);

                    setTimeout(() => {
                        if (!probeReceived) {
                            cleanup();
                            console.warn('[Location] Heading probe TIMEOUT');
                            isHeadingSupported = false;
                            map.easeTo({ center: [lastUserCoords.lng, lastUserCoords.lat], duration: 500 });
                        }
                    }, 1000);
                };

                if (checkHeadingSupport()) {
                    if (typeof DeviceOrientationEvent.requestPermission === 'function') {
                        DeviceOrientationEvent.requestPermission()
                            .then(res => {
                                if (res === 'granted') {
                                    attemptHeadingTransition();
                                } else {
                                    console.warn('[Location] Compass permission denied');
                                }
                            })
                            .catch(e => console.error('Compass fail:', e));
                    } else {
                        attemptHeadingTransition();
                    }
                } else {
                    console.log('[Location] Heading not supported by browser API');
                    map.easeTo({ center: [lastUserCoords.lng, lastUserCoords.lat], duration: 500 });
                }
            } else if (currentLocationState === LOCATION_STATES.HEADING) {
                // From HEADING back to FOLLOW
                currentLocationState = LOCATION_STATES.FOLLOW;
                map.easeTo({ bearing: 0, duration: 500, center: [lastUserCoords.lng, lastUserCoords.lat] });
                updateLocationIcon(locateBtn);
            }
        });
    }

    if (miniCompass) {
        map.on('rotate', () => {
            const bearing = map.getBearing();
            if (Math.abs(bearing) > 0.1) {
                miniCompass.classList.remove('hidden');
                if (compassIcon) {
                    compassIcon.style.transform = `rotate(${-bearing}deg)`;
                }
            } else {
                miniCompass.classList.add('hidden');
            }
        });

        miniCompass.addEventListener('click', () => {
            map.easeTo({ bearing: 0, duration: 500 });
            if (currentLocationState === LOCATION_STATES.HEADING) {
                currentLocationState = LOCATION_STATES.FOLLOW;
                updateLocationIcon(locateBtn);
            }
        });
    }

    // Fuzzy Re-centering / Unfollow handler
    let interactionStartCenter = null; // Track where the camera was when manual interaction started

    const handleInteractionEnd = () => {
        // If some other interaction is still active, don't snap back yet
        if (isUserInteracting || isUserRotating || isReCentering) return;

        const previousState = currentLocationState;

        if (currentLocationState === LOCATION_STATES.OFF) {
            // Clear any stale interaction state when in OFF mode
            interactionStartCenter = null;
            return;
        }

        // Calculate how much the USER manually moved the map
        // (Ignoring programmatic moves like flying animations)
        let manualPixelDist = 0;
        let wasManualInteraction = false;
        if (interactionStartCenter) {
            wasManualInteraction = true;
            const currentCenterPixel = map.project(map.getCenter());
            const startCenterPixel = map.project(interactionStartCenter);
            const dx = currentCenterPixel.x - startCenterPixel.x;
            const dy = currentCenterPixel.y - startCenterPixel.y;
            manualPixelDist = Math.sqrt(dx * dx + dy * dy);
            interactionStartCenter = null; // Reset for next time
        }

        // 1. If it was a programmatic move (like the initial "Locate Me" flyTo),
        // or a very small manual nudge (< 40px), we stay in the tracking state.
        if (!wasManualInteraction || manualPixelDist < 40) {
            // State is already correct, no change needed

            // Only attempt to snap back if we have accurate coords AND the center actually moved
            if (lastUserCoords && wasManualInteraction && manualPixelDist > 1) {
                const options = {
                    center: [lastUserCoords.lng, lastUserCoords.lat],
                    duration: 500
                };

                // If in heading mode, also snap bearing back immediately
                if (currentLocationState === LOCATION_STATES.HEADING && latestHeading !== null) {
                    options.bearing = latestHeading;
                }

                isReCentering = true;
                map.easeTo({
                    ...options,
                    essential: true
                });

                // Reset after the transition
                map.once('moveend', () => {
                    isReCentering = false;
                });
            }
        } else {
            // 2. Truly dragged away significantly (> 40px manual camera shift)
            currentLocationState = LOCATION_STATES.OFF;
            updateLocationIcon(locateBtn);
        }
    };

    // Manual interruption detection
    // Note: We use e.originalEvent to distinguish manual gestures from zoom buttons
    let wasManualRotation = false; // Track if the current rotation started from user gesture

    const startManualInteraction = () => {
        if (!interactionStartCenter) {
            interactionStartCenter = map.getCenter();
        }
    };

    map.on('dragstart', (e) => {
        if (e.originalEvent) {
            isUserInteracting = true;
            isDragging = true;
            startManualInteraction();
        }
    });

    map.on('rotatestart', (e) => {
        if (e.originalEvent) {
            isUserRotating = true;
            wasManualRotation = true; // Track that this was a manual rotation
            startManualInteraction();
        }
    });

    map.on('zoomstart', (e) => {
        if (e.originalEvent) {
            isUserInteracting = true;
            startManualInteraction();
        }
    });

    map.on('zoomend', () => {
        isUserInteracting = false;
        // Zoom no longer triggers detachment
        if (currentLocationState !== LOCATION_STATES.OFF) {
            handleInteractionEnd();
        }
    });
    map.on('dragend', () => {
        isUserInteracting = false;
        isDragging = false;
        handleInteractionEnd();
    });
    map.on('rotateend', () => {
        isUserRotating = false;
        // If user manually rotated in HEADING mode, disengage HEADING (go to FOLLOW)
        // This allows free rotation while still tracking location
        if (wasManualRotation) {
            wasManualRotation = false;
            if (currentLocationState === LOCATION_STATES.HEADING) {
                currentLocationState = LOCATION_STATES.FOLLOW;
                updateLocationIcon(document.getElementById('locate-me'));
                // Don't call handleInteractionEnd - we've already handled the state change
            } else if (currentLocationState !== LOCATION_STATES.OFF) {
                handleInteractionEnd();
            }
        }
    });

    map.on('pitchstart', (e) => {
        if (e.originalEvent) {
            isPitching = true;
        }
    });

    map.on('pitchend', () => {
        isPitching = false;
    });
}

function getDistance(c1, c2) {
    const R = 6371e3;
    const p1 = c1.lat * Math.PI / 180;
    const p2 = c2.lat * Math.PI / 180;
    const dp = (c2.lat - c1.lat) * Math.PI / 180;
    const dl = (c2.lng - c1.lng) * Math.PI / 180;
    const a = Math.sin(dp / 2) * Math.sin(dp / 2) +
        Math.cos(p1) * Math.cos(p2) *
        Math.sin(dl / 2) * Math.sin(dl / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

// --- Refactored Functions ---

let areImagesLoaded = false;
export function setIsImagesLoaded(val) { areImagesLoaded = val; }

export async function loadImages(map) {
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
            sdf: false,
            svg: `<svg width="${53 * ICON_SCALE}" height="${53 * ICON_SCALE}" viewBox="0 0 53 53" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="26.5" cy="26.5" r="24.5" fill="black" stroke="white" stroke-width="4"/></svg>`
        },
        {
            id: 'stop-close-up-icon',
            sdf: false,
            svg: `<svg width="${53 * ICON_SCALE}" height="${100 * ICON_SCALE}" viewBox="0 0 53 100" fill="none" xmlns="http://www.w3.org/2000/svg">
<circle cx="26.5" cy="49.3533" r="24.5" fill="black" stroke="white" stroke-width="4"/>
<path d="M22.1698 4.5C24.0943 1.1667 28.9054 1.16675 30.83 4.5L35.9657 13.3945C37.8902 16.7278 35.4845 20.8944 31.6356 20.8945H21.3651C17.5161 20.8945 15.1096 16.7279 17.0341 13.3945L22.1698 4.5Z" fill="black" stroke="white" stroke-width="4"/>
</svg>`
        },
        {
            id: 'stop-selected-icon',
            sdf: false,
            svg: `<svg width="${53 * ICON_SCALE}" height="${100 * ICON_SCALE}" viewBox="0 0 53 100" fill="none" xmlns="http://www.w3.org/2000/svg">
<circle cx="26.5" cy="49.3533" r="24.5" fill="black" stroke="white" stroke-width="4"/>
<path d="M22.1698 4.5C24.0943 1.1667 28.9054 1.16675 30.83 4.5L35.9657 13.3945C37.8902 16.7278 35.4845 20.8944 31.6356 20.8945H21.3651C17.5161 20.8945 15.1096 16.7279 17.0341 13.3945L22.1698 4.5Z" fill="black" stroke="white" stroke-width="4"/>
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
        const stopColor = isDark ? '#FFED74' : '#000000';
        const stopStrokeColor = isDark ? '#FFED74' : '#ffffff';
        const stopStrokeWidth = isDark ? 0.5 : 2.1;
        const stopStrokeOpacity = isDark ? 0.3 : 1;

        map.setPaintProperty('stops-layer-circle', 'circle-color', stopColor);
        map.setPaintProperty('stops-layer-circle', 'circle-stroke-color', stopStrokeColor);
        map.setPaintProperty('stops-layer-circle', 'circle-stroke-width', stopStrokeWidth);
        map.setPaintProperty('stops-layer-circle', 'circle-stroke-opacity', stopStrokeOpacity);
    }

    if (map.getLayer('stops-layer-glow')) {
        map.setPaintProperty('stops-layer-glow', 'circle-opacity', isDark ? 0.05 : 0);
    }
}

export function addStopsToMap(stops, options = {}) {
    const { redirectMap, filterManager, updateConnectionLine } = options;

    // Cleanup existing layers/sources
    const layers = ['metro-layer-label', 'metro-layer-circle', 'metro-transfer-layer', 'metro-layer-overlay', 'metro-lines-layer', 'stops-layer', 'stops-layer-hit-target', 'stops-layer-circle', 'stops-layer-glow', 'stops-label-selected', 'stops-highlight', 'filter-connection-line'];
    const sources = ['metro-stops', 'metro-lines-manual', 'stops', 'selected-stop', 'filter-connection'];

    layers.forEach(id => { if (map.getLayer(id)) map.removeLayer(id); });
    sources.forEach(id => { if (map.getSource(id)) map.removeSource(id); });

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
        paint: {
            'circle-color': '#FFED74',
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, 12, 16, 20, 18, 25],
            'circle-opacity': 0,
            'circle-blur': 0.8,
            'circle-emissive-strength': 1
        }
    });

    map.addLayer({
        id: 'stops-layer-circle',
        type: 'circle',
        source: 'stops',
        maxzoom: 15.2,
        paint: {
            'circle-color': '#000000',
            'circle-stroke-color': '#ffffff',
            'circle-stroke-width': 2.1,
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
            'icon-emissive-strength': 1
        }
    });

    map.addSource('selected-stop', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
    });

    map.addLayer({
        id: 'stops-highlight',
        type: 'symbol',
        source: 'selected-stop',
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
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
            'line-color': '#2563eb',
            'line-width': 4,
            'line-opacity': 0.8,
            'line-emissive-strength': 1
        }
    });
    if (map.getLayer('stops-layer')) map.moveLayer('filter-connection-line', 'stops-layer');

    if (filterManager && updateConnectionLine) {
        const hoverLayers = ['stops-layer', 'stops-layer-circle', 'stops-layer-hit-target'];
        hoverLayers.forEach(layerId => {
            map.on('mousemove', layerId, (e) => {
                if (filterManager.state.picking) {
                    let selectedFeature = null;
                    for (const f of e.features) {
                        const p = f.properties;
                        const normId = (redirectMap && redirectMap.get(p.id)) || p.id;
                        if (filterManager.state.reachableStopIds.has(normId) || filterManager.state.targetIds.has(normId)) {
                            selectedFeature = f;
                            break;
                        }
                    }
                    if (selectedFeature) {
                        updateConnectionLine(filterManager.state.originId, filterManager.state.targetIds, true, selectedFeature.properties.id);
                    }
                }
            });
            map.on('mouseleave', layerId, () => {
                if (filterManager.state.picking) {
                    updateConnectionLine(filterManager.state.originId, filterManager.state.targetIds, false);
                }
            });
        });
    }

    metro.addMetroLayers(map, metroFeatures, metroLines);

    map.addLayer({
        id: 'stops-label-selected',
        type: 'symbol',
        source: 'stops',
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
    if (map.getLayer('metro-lines-layer') && map.getLayer('stops-layer')) {
        map.moveLayer('metro-lines-layer', 'stops-layer');
    }
    if (map.getLayer('stops-highlight')) {
        map.moveLayer('stops-highlight');
    }

    updateMapTheme();
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
                    'icon-rotate': ['get', 'heading'],
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
                    'icon-rotate': ['get', 'heading'],
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
                    'icon-rotate': ['get', 'heading'],
                    'icon-rotation-alignment': 'map'
                }
            });
        }
    } catch (error) {
        console.error('Failed to update live buses:', error);
    }
}

// Hover State & Logic
let lastHoveredStopId = null;
let hoverTimeout = null;

export function updateStopHoverEffects(hoveredId) {
    // If a stop is currently selected (Focused Session), do NOT reset global opacity.
    if (window.currentStopId) return;

    if (!map || !map.getStyle()) return;
    const isDark = document.body.classList.contains('dark-mode');

    const baseStopColor = isDark ? '#FFED74' : '#000000';
    const baseStopStrokeColor = isDark ? '#FFED74' : '#ffffff';
    const baseGlowOpacity = isDark ? 0.05 : 0;

    if (map.getLayer('stops-layer-circle')) {
        const hoverColor = isDark ? '#FFFFFF' : '#FFED74';
        map.setPaintProperty('stops-layer-circle', 'circle-color', [
            'case',
            ['==', ['get', 'id'], hoveredId], hoverColor,
            baseStopColor
        ]);

        if (!isDark) {
            map.setPaintProperty('stops-layer-circle', 'circle-stroke-color', [
                'case',
                ['==', ['get', 'id'], hoveredId], '#000000',
                baseStopStrokeColor
            ]);
        }
    }

    if (map.getLayer('stops-layer-glow')) {
        const hoverGlowOpacity = 0.7;
        map.setPaintProperty('stops-layer-glow', 'circle-opacity', [
            'case',
            ['==', ['get', 'id'], hoveredId], hoverGlowOpacity,
            baseGlowOpacity
        ]);
    }

    if (map.getLayer('stops-layer')) {
        map.setPaintProperty('stops-layer', 'icon-opacity', [
            'case',
            ['==', ['get', 'id'], hoveredId], 0.85,
            1
        ]);
    }

    if (map.getLayer('metro-layer-circle')) {
        map.setPaintProperty('metro-layer-circle', 'circle-radius', [
            'case',
            ['==', ['get', 'id'], hoveredId], 6,
            4
        ]);
    }
}

function proximitySort(features, point) {
    if (!features || features.length === 0) return null;
    return features.sort((a, b) => {
        const pA = map.project(a.geometry.coordinates);
        const pB = map.project(b.geometry.coordinates);
        const distA = Math.hypot(pA.x - point.x, pA.y - point.y);
        const distB = Math.hypot(pB.x - point.x, pB.y - point.y);
        return distA - distB;
    });
}

export function setupHoverHandlers(context) {
    const { ALL_STOP_LAYERS, setFilterOpacity, filterManager } = context;

    map.on('mousemove', ALL_STOP_LAYERS, (e) => {
        if (window.ignoreMapClicks || window.isPickModeActive) return;

        // Filter out unreachable stops if Filter is Active
        let features = e.features;
        if (filterManager && (filterManager.state.active || filterManager.state.picking)) {
            const reachable = filterManager.state.reachableStopIds;
            features = features.filter(f => {
                const id = f.properties.id;
                // Keep Origin, Reachable, or Target (though targets are usually reachable)
                return id === filterManager.state.originId || reachable.has(id);
            });
            if (features.length === 0) {
                map.getCanvas().style.cursor = '';
                return;
            }
        }

        map.getCanvas().style.cursor = 'pointer';

        // Prioritize Metro Features
        const metroFeature = features.find(f => f.layer.id.startsWith('metro-'));

        let bestFeature;
        if (metroFeature) {
            bestFeature = metroFeature;
        } else {
            const sorted = proximitySort(features, e.point);
            bestFeature = sorted ? sorted[0] : null;
        }

        if (!bestFeature) return;

        const currentId = bestFeature.properties.id;

        if (lastHoveredStopId !== currentId) {
            lastHoveredStopId = currentId;
            updateStopHoverEffects(currentId);
            if (setFilterOpacity) setFilterOpacity(true);
        }

        if (hoverTimeout) {
            clearTimeout(hoverTimeout);
            hoverTimeout = null;
        }
    });

    map.on('mouseleave', ALL_STOP_LAYERS, () => {
        map.getCanvas().style.cursor = '';
        if (hoverTimeout) clearTimeout(hoverTimeout);
        hoverTimeout = setTimeout(() => {
            lastHoveredStopId = null;
            updateStopHoverEffects(null);
            if (setFilterOpacity) setFilterOpacity(false);
        }, 50);
    });
}

export function setupClickHandlers(context) {
    const { ALL_STOP_LAYERS, filterManager, showStopInfo, applyFilter } = context;

    map.on('click', ALL_STOP_LAYERS, (e) => {
        if (window.ignoreMapClicks) return;

        // Filter out unreachable stops if Filter is Active
        let features = e.features;
        if (filterManager && (filterManager.state.active || filterManager.state.picking)) {
            const reachable = filterManager.state.reachableStopIds;
            features = features.filter(f => {
                const id = f.properties.id;
                // Keep Origin, Reachable, or Target
                return id === filterManager.state.originId || reachable.has(id);
            });
            if (features.length === 0) return;
        }

        const sorted = proximitySort(features, e.point);
        const bestFeature = sorted ? sorted[0] : null;

        if (!bestFeature) return;

        // Build stop object with coordinates from geometry (not in properties)
        const coords = bestFeature.geometry.coordinates;
        const stop = {
            ...bestFeature.properties,
            lon: coords[0],
            lat: coords[1]
        };
        console.log('[Map] Clicked:', stop.id, stop.name);

        if (filterManager && filterManager.state.picking) {
            // In pick mode, toggle as destination
            applyFilter(stop.id);
        } else {
            // Normal selection
            showStopInfo(stop, true, true);
        }
    });
}
