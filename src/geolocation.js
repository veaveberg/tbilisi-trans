import mapboxgl from 'mapbox-gl';
import { Capacitor, registerPlugin } from '@capacitor/core';

import iconLocationOff from '/location.svg?url';
import iconLocationFollow from '/location.fill.svg?url';
import iconLocationHeading from '/location.north.line.fill.svg?url';
import iconLocationSlashed from '/location.slash.svg?url';

export const LOCATION_STATES = {
    OFF: 'OFF',
    FOLLOW: 'FOLLOW',
    HEADING: 'HEADING'
};

const LOCATION_ICONS = {
    OFF: `<img src="${iconLocationOff}" width="24" height="24">`,
    FOLLOW: `<img src="${iconLocationFollow}" width="24" height="24">`,
    HEADING: `<img src="${iconLocationHeading}" width="24" height="24">`,
    SLASHED: `<img src="${iconLocationSlashed}" width="24" height="24">`
};

// Internal State
let currentLocationState = LOCATION_STATES.OFF;
let lastLocateClickTime = 0;
let lastUserCoords = null;
let isUserInteracting = false;
let isUserRotating = false;
let isDragging = false;
let isPitching = false;
let isReCentering = false;
let isOrientationTrackingStarted = false;
let nativeHeadingListenerPromise = null;
let latestHeading = null;
let latestWebRawHeading = null;
let lastIndicatorRotation = null;
let cumulativeIndicatorRotation = 0;
let displayedIndicatorRotation = null;
let targetIndicatorRotation = null;
let headingIndicatorAnimationFrame = null;
let headingIndicatorAnimationLastTs = null;
let displayedMapBearing = null;
let targetMapBearing = null;
let mapBearingAnimationFrame = null;
let mapBearingAnimationLastTs = null;
let isHeadingSupported = false;
let isWaitingForFirstLocation = false;
let isAutoFlyOnLaunch = false;
let smoothedFollowCoords = null;
let pendingStartupFollow = false;
let markerRecoveryToken = 0;

const TBILISI_REGION_BBOX = Object.freeze({
    west: 44.5,
    south: 41.5,
    east: 45.1,
    north: 42.0
});
const FOLLOW_SMOOTHING_FACTOR = 0.35;
const FOLLOW_SNAP_DISTANCE_METERS = 250;
const LOCATION_MARKER_ANIMATION_MS = 650;
const LOCATION_MARKER_SNAP_DISTANCE_METERS = 1000;
const HEADING_INDICATOR_SMOOTHING_MS = 120;
const HEADING_MAP_BEARING_SMOOTHING_MS = 260;
const NativeGeolocation = registerPlugin('NativeGeolocation');
const isNative = typeof Capacitor !== 'undefined' && Capacitor.isNativePlatform();
const nativeWatchCallbacks = new Map();
let nativeWatchListenerPromise = null;
let markerAnimationFrame = null;
let markerAnimationCoords = null;

function toNativeGeolocationOptions(options) {
    return {
        enableHighAccuracy: !!options?.enableHighAccuracy,
        timeout: typeof options?.timeout === 'number' ? options.timeout : undefined,
        maximumAge: typeof options?.maximumAge === 'number' ? options.maximumAge : undefined
    };
}

function normalizeGeolocationError(err) {
    return {
        code: typeof err?.code === 'number' ? err.code : 2,
        message: err?.message || 'Unable to determine current location.'
    };
}

function normalizeGeolocationPosition(position) {
    return {
        coords: {
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            accuracy: position.coords.accuracy,
            altitude: position.coords.altitude ?? null,
            altitudeAccuracy: position.coords.altitudeAccuracy ?? null,
            heading: position.coords.heading ?? null,
            speed: position.coords.speed ?? null
        },
        timestamp: position.timestamp
    };
}

function normalizeHeadingDegrees(value) {
    if (!Number.isFinite(value)) return 0;
    return ((value % 360) + 360) % 360;
}

function unwrapDegreesNear(target, reference) {
    let unwrapped = target;
    while (unwrapped - reference > 180) unwrapped -= 360;
    while (unwrapped - reference < -180) unwrapped += 360;
    return unwrapped;
}

function hasUserLocationMarker() {
    return !!document.querySelector('.mapboxgl-user-location-dot, .mapboxgl-user-location-marker');
}

function getFallbackPositionFromLastCoords() {
    if (!lastUserCoords) return null;
    return {
        coords: {
            longitude: lastUserCoords.lng,
            latitude: lastUserCoords.lat,
            accuracy: Number.isFinite(geolocate?._accuracy) ? geolocate._accuracy : 0
        },
        timestamp: Date.now()
    };
}

function repairUserLocationMarker(map, position = null) {
    if (hasUserLocationMarker()) return true;

    const markerPosition = position || geolocate?._lastKnownPosition || getFallbackPositionFromLastCoords();
    if (!map || !markerPosition?.coords || typeof geolocate?._updateMarker !== 'function') return false;

    try {
        geolocate._updateMarker(markerPosition);
        if (typeof geolocate._updateMarkerRotation === 'function') {
            geolocate._updateMarkerRotation();
        }
        updateHeadingIndicator(map);
    } catch (e) {
        return false;
    }

    return hasUserLocationMarker();
}

function triggerGeolocateWithoutStoppingActiveWatch(map, options = {}) {
    if (!isNative) {
        geolocate.trigger();
        return true;
    }

    const watchState = geolocate?._watchState;

    if (watchState === 'OFF' || watchState === undefined) {
        geolocate.trigger();
        return true;
    }

    if (watchState === 'BACKGROUND' && !options.suppressCameraUpdate) {
        geolocate.trigger();
        return true;
    }

    // With trackUserLocation enabled, Mapbox's trigger() is a toggle.
    // Calling it while ACTIVE_LOCK/WAITING_ACTIVE turns the watch off and removes the marker.
    return repairUserLocationMarker(map);
}

function scheduleMissingMarkerRecovery(map, options = {}) {
    const {
        preserveCurrentZoom = false,
        suppressCameraUpdate = false,
        attempt = 1,
        maxAttempts = 2,
        delayMs = 450
    } = options;

    const token = ++markerRecoveryToken;
    setTimeout(() => {
        if (token !== markerRecoveryToken) return;
        if (document.hidden) return;
        if (!lastUserCoords) return;
        if (hasUserLocationMarker()) return;

        try { map?.resize?.(); } catch (e) { }
        if (repairUserLocationMarker(map)) return;

        refreshLocationMarker(map, {
            preserveCurrentZoom,
            suppressCameraUpdate,
            repairMissingMarker: false
        }).catch(() => { });

        if (attempt < maxAttempts) {
            scheduleMissingMarkerRecovery(map, {
                preserveCurrentZoom,
                suppressCameraUpdate,
                attempt: attempt + 1,
                maxAttempts,
                delayMs: delayMs * 2
            });
        }
    }, delayMs);
}

function ensureNativeWatchListener() {
    if (!nativeWatchListenerPromise) {
        nativeWatchListenerPromise = NativeGeolocation.addListener('watchPosition', (event) => {
            const handlers = nativeWatchCallbacks.get(event?.id);
            if (!handlers) return;
            if (event?.error) {
                handlers.error?.(normalizeGeolocationError(event.error));
                return;
            }
            if (event?.position) {
                handlers.success(normalizeGeolocationPosition(event.position));
            }
        }).catch(() => null);
    }
    return nativeWatchListenerPromise;
}

function handleHeadingUpdate(map, heading) {
    if (heading === undefined || heading === null) return;

    document.documentElement.classList.add('show-heading-indicator');
    if (lastIndicatorRotation === null) {
        lastIndicatorRotation = null;
    }

    latestHeading = heading;
    isHeadingSupported = true;
    updateHeadingIndicator(map);

    const now = Date.now();
    if (!handleHeadingUpdate.lastUpdate || now - handleHeadingUpdate.lastUpdate > 50) {
        handleHeadingUpdate.lastUpdate = now;
        if (currentLocationState === LOCATION_STATES.HEADING && !isUserRotating && !isUserInteracting && !isDragging && !isPitching) {
            setHeadingMapBearing(map, latestHeading);
        }
    }
}

const nativeGeolocation = {
    getCurrentPosition: async (success, error, options) => {
        try {
            const position = await NativeGeolocation.getCurrentPosition(toNativeGeolocationOptions(options));
            success(normalizeGeolocationPosition(position));
        } catch (err) {
            error?.(normalizeGeolocationError(err));
        }
    },
    watchPosition: (success, error, options) => {
        const id = `native-watch-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        nativeWatchCallbacks.set(id, { success, error });
        ensureNativeWatchListener().finally(() => {
            NativeGeolocation.watchPosition({
                id,
                ...toNativeGeolocationOptions(options)
            }).catch((err) => {
                const handlers = nativeWatchCallbacks.get(id);
                if (!handlers) return;
                handlers.error?.(normalizeGeolocationError(err));
                nativeWatchCallbacks.delete(id);
            });
        });
        return id;
    },
    clearWatch: (id) => {
        nativeWatchCallbacks.delete(id);
        NativeGeolocation.clearWatch({ id }).catch(() => { });
    }
};

// Geolocate Control
const geolocate = new mapboxgl.GeolocateControl({
    positionOptions: {
        enableHighAccuracy: true,
        timeout: 15000
    },
    trackUserLocation: true,
    followUserLocation: false,
    showUserHeading: false, // Handle manually to prevent conflicts
    showAccuracyCircle: true,
    fitBoundsOptions: {
        maxZoom: 18
    },
    geolocation: isNative ? nativeGeolocation : navigator.geolocation
});

// Defensive fix 
if (!geolocate._onGeolocateStop) {
    geolocate._onGeolocateStop = () => { };
}
if (isNative) {
    geolocate._checkGeolocationSupport = (callback) => {
        geolocate._supportsGeolocation = true;
        callback(true);
    };
}
// Own location camera behavior in this module. Mapbox's default GeolocateControl
// camera uses fitBounds around GPS accuracy, which can jump to zoom 18 on app resume.
if (typeof geolocate._updateCamera === 'function') {
    geolocate._updateCamera = () => { };
}

// Exports
export function isTrackingActive() {
    return currentLocationState === LOCATION_STATES.FOLLOW || currentLocationState === LOCATION_STATES.HEADING;
}

export function getLastUserCoords() {
    return lastUserCoords;
}

export function isUserInteractingWithMap() {
    return isUserInteracting || isUserRotating;
}

export function stopTracking() {
    if (currentLocationState !== LOCATION_STATES.OFF) {
        currentLocationState = LOCATION_STATES.OFF;
        stopHeadingMapBearingAnimation();
        smoothedFollowCoords = null;
        const locateBtn = document.getElementById('locate-me');
        if (locateBtn) updateLocationIcon(locateBtn);
    }
}

export async function refreshLocationMarker(map, options = {}) {
    const {
        activateFollow = false,
        preserveCurrentZoom = false,
        suppressCameraUpdate = false,
        recenterAfterUpdate = false,
        repairMissingMarker = true
    } = options;
    if (!isSecureContext()) return false;

    if (activateFollow && currentLocationState === LOCATION_STATES.OFF) {
        currentLocationState = LOCATION_STATES.FOLLOW;
        updateLocationIcon(document.getElementById('locate-me'));
    }

    if (isNative) {
        try {
            const perms = await NativeGeolocation.checkPermissions();
            if (perms?.location !== 'granted') return false;
        } catch (e) {
            return false;
        }

        let restoreFitBoundsZoom = null;
        if (preserveCurrentZoom) {
            const fitBoundsOptions = geolocate?.options?.fitBoundsOptions;
            const currentZoom = map?.getZoom?.();
            if (fitBoundsOptions && Number.isFinite(currentZoom)) {
                const previousMaxZoom = fitBoundsOptions.maxZoom;
                fitBoundsOptions.maxZoom = currentZoom;
                restoreFitBoundsZoom = () => {
                    fitBoundsOptions.maxZoom = previousMaxZoom;
                };
                if (typeof geolocate.once === 'function') {
                    geolocate.once('geolocate', restoreFitBoundsZoom);
                    geolocate.once('error', restoreFitBoundsZoom);
                }
                setTimeout(() => {
                    restoreFitBoundsZoom?.();
                    restoreFitBoundsZoom = null;
                }, 2000);
            }
        }

        try { map?.resize?.(); } catch (e) { }
        startPersistentOrientationTracking(map);
        triggerGeolocateWithoutStoppingActiveWatch(map, { suppressCameraUpdate });
        if (recenterAfterUpdate) {
            scheduleFollowCameraSync(map, { delayMs: 150, force: true, duration: 250 });
            scheduleFollowCameraSync(map, { delayMs: 650, force: true, duration: 250 });
        }
        if (repairMissingMarker) {
            scheduleMissingMarkerRecovery(map, { preserveCurrentZoom, suppressCameraUpdate });
        }
        return true;
    }

    if (!(navigator.permissions && navigator.permissions.query)) return false;

    try {
        const result = await navigator.permissions.query({ name: 'geolocation' });
        if (result.state !== 'granted') return false;
    } catch (e) {
        return false;
    }

    geolocate.trigger();
    if (recenterAfterUpdate) {
        scheduleFollowCameraSync(map, { delayMs: 150, force: true, duration: 250 });
        scheduleFollowCameraSync(map, { delayMs: 650, force: true, duration: 250 });
    }
    return true;
}

// Helpers
function isSecureContext() {
    if (isNative) return true;
    const isSecure = window.isSecureContext || window.location.hostname === 'localhost';
    const hasGeo = !!navigator.geolocation;
    return isSecure && hasGeo;
}

function checkHeadingSupport() {
    if (isNative) return true;
    return !!(window.DeviceOrientationEvent) &&
        ('ontouchstart' in window || 'ondeviceorientationabsolute' in window || 'ondeviceorientation' in window);
}

function isWithinTbilisiRegion(lng, lat) {
    return lng >= TBILISI_REGION_BBOX.west &&
        lng <= TBILISI_REGION_BBOX.east &&
        lat >= TBILISI_REGION_BBOX.south &&
        lat <= TBILISI_REGION_BBOX.north;
}

function distanceMeters(a, b) {
    const toRad = (deg) => deg * (Math.PI / 180);
    const earthRadiusMeters = 6371000;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const lat1 = toRad(a.lat);
    const lat2 = toRad(b.lat);

    const h = Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    return 2 * earthRadiusMeters * Math.asin(Math.min(1, Math.sqrt(h)));
}

function easeOutCubic(t) {
    return 1 - Math.pow(1 - t, 3);
}

function createAnimatedPosition(position, lng, lat) {
    return {
        ...position,
        coords: {
            longitude: lng,
            latitude: lat,
            accuracy: position.coords.accuracy,
            altitude: position.coords.altitude ?? null,
            altitudeAccuracy: position.coords.altitudeAccuracy ?? null,
            heading: position.coords.heading ?? null,
            speed: position.coords.speed ?? null
        }
    };
}

function installSmoothLocationMarkerUpdates() {
    if (geolocate.__smoothMarkerUpdatesInstalled || typeof geolocate._updateMarker !== 'function') return;

    const originalUpdateMarker = geolocate._updateMarker.bind(geolocate);
    geolocate._updateMarker = (position) => {
        if (!position?.coords) {
            if (markerAnimationFrame !== null) {
                cancelAnimationFrame(markerAnimationFrame);
                markerAnimationFrame = null;
            }
            markerAnimationCoords = null;
            originalUpdateMarker(position);
            return;
        }

        const targetCoords = {
            lng: position.coords.longitude,
            lat: position.coords.latitude
        };
        const startCoords = markerAnimationCoords;
        const shouldSnap = !startCoords ||
            document.hidden ||
            distanceMeters(startCoords, targetCoords) > LOCATION_MARKER_SNAP_DISTANCE_METERS;

        if (markerAnimationFrame !== null) {
            cancelAnimationFrame(markerAnimationFrame);
            markerAnimationFrame = null;
        }

        if (shouldSnap) {
            markerAnimationCoords = { ...targetCoords };
            originalUpdateMarker(position);
            return;
        }

        const startedAt = performance.now();
        const animate = (now) => {
            const progress = Math.min(1, (now - startedAt) / LOCATION_MARKER_ANIMATION_MS);
            const eased = easeOutCubic(progress);
            const lng = startCoords.lng + (targetCoords.lng - startCoords.lng) * eased;
            const lat = startCoords.lat + (targetCoords.lat - startCoords.lat) * eased;

            originalUpdateMarker(createAnimatedPosition(position, lng, lat));

            if (progress < 1) {
                markerAnimationFrame = requestAnimationFrame(animate);
            } else {
                markerAnimationFrame = null;
                markerAnimationCoords = { ...targetCoords };
                originalUpdateMarker(position);
            }
        };

        markerAnimationFrame = requestAnimationFrame(animate);
    };
    geolocate.__smoothMarkerUpdatesInstalled = true;
}

function getSmoothedFollowCoords(nextCoords) {
    if (!smoothedFollowCoords) {
        smoothedFollowCoords = { ...nextCoords };
        return smoothedFollowCoords;
    }

    const jumpDistance = distanceMeters(smoothedFollowCoords, nextCoords);
    if (jumpDistance > FOLLOW_SNAP_DISTANCE_METERS) {
        smoothedFollowCoords = { ...nextCoords };
        return smoothedFollowCoords;
    }

    smoothedFollowCoords = {
        lng: smoothedFollowCoords.lng + (nextCoords.lng - smoothedFollowCoords.lng) * FOLLOW_SMOOTHING_FACTOR,
        lat: smoothedFollowCoords.lat + (nextCoords.lat - smoothedFollowCoords.lat) * FOLLOW_SMOOTHING_FACTOR
    };
    return smoothedFollowCoords;
}

function getCenteringOffset() {
    const panels = ['info-panel', 'route-info', 'directions-panel'];
    let visiblePanel = null;
    for (const id of panels) {
        const p = document.getElementById(id);
        if (!p || p.classList.contains('hidden')) continue;
        const style = window.getComputedStyle(p);
        if (style.display === 'none' || style.visibility === 'hidden' || p.getClientRects().length === 0) {
            continue;
        }
        visiblePanel = p;
        break;
    }

    if (!visiblePanel) {
        return [0, 0];
    }

    let bottomPadding = 0;
    let method = '';
    if (visiblePanel.classList.contains('sheet-collapsed')) {
        bottomPadding = 80;
        method = 'sheet-collapsed';
    } else if (visiblePanel.classList.contains('sheet-peek')) {
        bottomPadding = window.innerHeight * 0.25;
        method = 'sheet-peek';
    } else if (visiblePanel.classList.contains('sheet-half')) {
        bottomPadding = window.innerHeight * 0.483;
        method = 'sheet-half';
    } else if (visiblePanel.classList.contains('sheet-full')) {
        bottomPadding = window.innerHeight * 0.92;
        method = 'sheet-full';
    } else {
        const rect = visiblePanel.getBoundingClientRect();
        if (rect.height > 0 && rect.top > 0) {
            bottomPadding = Math.max(0, window.innerHeight - rect.top);
            method = `bounding-rect (height:${rect.height}, top:${rect.top})`;
        } else {
            bottomPadding = Math.min(visiblePanel.offsetHeight || 220, window.innerHeight * 0.42);
            method = `fallback (offsetHeight:${visiblePanel.offsetHeight})`;
        }
    }

    const offset = [0, -(bottomPadding / 2)];

    return offset;
}

function isFollowModeActive() {
    return currentLocationState === LOCATION_STATES.FOLLOW || currentLocationState === LOCATION_STATES.HEADING;
}

function isFollowCameraBlocked() {
    return isUserInteracting || isUserRotating || isDragging || isPitching || isReCentering;
}

function centerFollowCamera(map, options = {}) {
    const {
        duration = 500,
        force = false,
        useSmoothing = false
    } = options;

    if (!map || !lastUserCoords || !isFollowModeActive()) return false;
    if (!force && isFollowCameraBlocked()) return false;

    const targetCoords = useSmoothing
        ? getSmoothedFollowCoords(lastUserCoords)
        : lastUserCoords;
    const cameraOptions = {
        center: [targetCoords.lng, targetCoords.lat],
        offset: getCenteringOffset(),
        duration,
        easing: (t) => t * (2 - t),
        essential: true
    };

    if (currentLocationState === LOCATION_STATES.HEADING && latestHeading !== null) {
        setHeadingMapBearing(map, latestHeading);
    }

    isReCentering = true;
    map.easeTo(cameraOptions);
    map.once('moveend', () => { isReCentering = false; });
    setTimeout(() => { isReCentering = false; }, Math.max(duration + 250, 750));
    return true;
}

function scheduleFollowCameraSync(map, options = {}) {
    const {
        delayMs = 0,
        force = false,
        duration = 500,
        useSmoothing = false
    } = options;

    if (!isFollowModeActive() || !lastUserCoords) return;

    setTimeout(() => {
        centerFollowCamera(map, { force, duration, useSmoothing });
    }, delayMs);
}

// Helper to parse rotation from a transform string (matrix or rotate)
function getRotationFromTransform(transform) {
    if (!transform || transform === 'none') return 0;

    // Handle matrix(a, b, c, d, tx, ty)
    if (transform.startsWith('matrix')) {
        const values = transform.match(/matrix\(([^)]+)\)/);
        if (values && values[1]) {
            const [a, b] = values[1].split(',').map(parseFloat);
            return Math.round(Math.atan2(b, a) * (180 / Math.PI));
        }
    }
    // Handle rotate(deg)
    else if (transform.includes('rotate')) {
        const match = transform.match(/rotate\(([^d]+)deg\)/);
        if (match && match[1]) return parseFloat(match[1]);
    }
    return 0;
}

function setHeadingIndicatorRotation(rotation, options = {}) {
    const { snap = false } = options;
    targetIndicatorRotation = rotation;

    if (snap || displayedIndicatorRotation === null || document.hidden) {
        displayedIndicatorRotation = rotation;
        headingIndicatorAnimationLastTs = null;
        if (headingIndicatorAnimationFrame !== null) {
            cancelAnimationFrame(headingIndicatorAnimationFrame);
            headingIndicatorAnimationFrame = null;
        }
        document.documentElement.style.setProperty('--indicator-rotation', `${displayedIndicatorRotation}deg`);
        return;
    }

    if (headingIndicatorAnimationFrame !== null) return;

    const animate = (timestamp) => {
        if (headingIndicatorAnimationLastTs === null) {
            headingIndicatorAnimationLastTs = timestamp;
        }

        const elapsed = Math.max(0, timestamp - headingIndicatorAnimationLastTs);
        headingIndicatorAnimationLastTs = timestamp;
        const progress = 1 - Math.exp(-elapsed / HEADING_INDICATOR_SMOOTHING_MS);
        displayedIndicatorRotation += (targetIndicatorRotation - displayedIndicatorRotation) * progress;
        document.documentElement.style.setProperty('--indicator-rotation', `${displayedIndicatorRotation}deg`);

        if (Math.abs(targetIndicatorRotation - displayedIndicatorRotation) < 0.05) {
            displayedIndicatorRotation = targetIndicatorRotation;
            document.documentElement.style.setProperty('--indicator-rotation', `${displayedIndicatorRotation}deg`);
            headingIndicatorAnimationFrame = null;
            headingIndicatorAnimationLastTs = null;
            return;
        }

        headingIndicatorAnimationFrame = requestAnimationFrame(animate);
    };

    headingIndicatorAnimationFrame = requestAnimationFrame(animate);
}

function setHeadingMapBearing(map, bearing, options = {}) {
    const { snap = false } = options;
    if (!map || !Number.isFinite(bearing)) return;

    const currentBearing = Number.isFinite(displayedMapBearing) ? displayedMapBearing : map.getBearing();
    if (displayedMapBearing === null) {
        displayedMapBearing = currentBearing;
    }
    targetMapBearing = unwrapDegreesNear(bearing, currentBearing);

    if (snap || document.hidden) {
        displayedMapBearing = targetMapBearing;
        mapBearingAnimationLastTs = null;
        if (mapBearingAnimationFrame !== null) {
            cancelAnimationFrame(mapBearingAnimationFrame);
            mapBearingAnimationFrame = null;
        }
        map.setBearing(displayedMapBearing);
        return;
    }

    if (mapBearingAnimationFrame !== null) return;

    const animate = (timestamp) => {
        if (currentLocationState !== LOCATION_STATES.HEADING || isUserRotating || isUserInteracting || isDragging || isPitching) {
            mapBearingAnimationFrame = null;
            mapBearingAnimationLastTs = null;
            displayedMapBearing = map.getBearing();
            return;
        }

        if (mapBearingAnimationLastTs === null) {
            mapBearingAnimationLastTs = timestamp;
        }

        const elapsed = Math.max(0, timestamp - mapBearingAnimationLastTs);
        mapBearingAnimationLastTs = timestamp;
        const progress = 1 - Math.exp(-elapsed / HEADING_MAP_BEARING_SMOOTHING_MS);
        displayedMapBearing += (targetMapBearing - displayedMapBearing) * progress;
        map.setBearing(displayedMapBearing);

        if (Math.abs(targetMapBearing - displayedMapBearing) < 0.05) {
            displayedMapBearing = targetMapBearing;
            map.setBearing(displayedMapBearing);
            mapBearingAnimationFrame = null;
            mapBearingAnimationLastTs = null;
            return;
        }

        mapBearingAnimationFrame = requestAnimationFrame(animate);
    };

    mapBearingAnimationFrame = requestAnimationFrame(animate);
}

function stopHeadingMapBearingAnimation() {
    if (mapBearingAnimationFrame !== null) {
        cancelAnimationFrame(mapBearingAnimationFrame);
        mapBearingAnimationFrame = null;
    }
    mapBearingAnimationLastTs = null;
    displayedMapBearing = null;
    targetMapBearing = null;
}

function updateHeadingIndicator(map) {
    if (latestHeading === null) return;

    const indicator = document.querySelector('.mapboxgl-user-location-heading');
    const marker = document.querySelector('.mapboxgl-user-location-marker');

    if (!indicator && marker) {
        const newIndicator = document.createElement('div');
        newIndicator.className = 'mapboxgl-user-location-heading';
        marker.appendChild(newIndicator);
    }

    const currentIndicator = indicator || document.querySelector('.mapboxgl-user-location-heading');
    if (currentIndicator) {
        // Mapbox keeps the parent marker "North Up" (rotated by -bearing).
        // To point to our heading, we just need to apply the absolute heading relative to North.
        // Visual Result = -Bearing (Parent) + Heading (Child) = Heading - Bearing (Correct Screen Angle).
        const targetRotation = latestHeading;

        const shouldSnap = lastIndicatorRotation === null;
        if (shouldSnap) {
            lastIndicatorRotation = targetRotation;
            cumulativeIndicatorRotation = targetRotation;
        } else {
            let delta = targetRotation - lastIndicatorRotation;
            while (delta > 180) delta -= 360;
            while (delta < -180) delta += 360;
            cumulativeIndicatorRotation += delta;
            lastIndicatorRotation = targetRotation;
        }

        setHeadingIndicatorRotation(cumulativeIndicatorRotation, { snap: shouldSnap });
        // No parent modification needed.
    }
}

function updateMapLocationHash(map) {
    const center = map.getCenter();
    const zoom = map.getZoom();
    const hash = `#${zoom.toFixed(2)}/${center.lat.toFixed(5)}/${center.lng.toFixed(5)}`;
    history.replaceState(null, '', location.pathname + hash);
}

function updateLocationIcon(btn) {
    if (!btn) return;

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

function startPersistentOrientationTracking(map) {
    if (isOrientationTrackingStarted) return;

    if (isNative) {
        nativeHeadingListenerPromise = nativeHeadingListenerPromise || NativeGeolocation.addListener('headingUpdate', (event) => {
            handleHeadingUpdate(map, event?.heading);
        }).catch(() => null);

        nativeHeadingListenerPromise.finally(() => {
            NativeGeolocation.startHeadingUpdates().catch(() => { });
        });
        isOrientationTrackingStarted = true;
        return;
    }

    const onOrientation = (e) => {
        // Prioritize webkitCompassHeading (iOS), then absolute alpha (fallback).
        let rawHeading = e.webkitCompassHeading;
        if (rawHeading === undefined || rawHeading === null) {
            // Check if absolute or if it's a deviceorientationabsolute event
            if (e.absolute === true && e.alpha !== null) {
                rawHeading = 360 - e.alpha;
            }
        }

        if (rawHeading === undefined || rawHeading === null) return;

        latestWebRawHeading = rawHeading;
        const heading = normalizeHeadingDegrees(rawHeading);

        // Force an immediate sync update when first showing
        if (!document.documentElement.classList.contains('show-heading-indicator')) {
            lastIndicatorRotation = null;
        }
        handleHeadingUpdate(map, heading);
    };

    // Use absolute orientation if available, fallback to standard
    if ('ondeviceorientationabsolute' in window) {
        window.addEventListener('deviceorientationabsolute', onOrientation);
    } else {
        window.addEventListener('deviceorientation', onOrientation);
    }
    isOrientationTrackingStarted = true;
}

// Main Setup Function
export function setupGeolocation(map) {
    installSmoothLocationMarkerUpdates();
    map.addControl(geolocate);

    const locateBtn = document.getElementById('locate-me');
    const miniCompass = document.getElementById('mini-compass');
    const compassIcon = miniCompass?.querySelector('svg');

    checkHeadingSupport();
    if (!isNative && localStorage.getItem('compassPermissionGranted') === 'true') {
        startPersistentOrientationTracking(map);
    }
    updateLocationIcon(locateBtn);

    // Zoom Controls
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

    // Canvas Listeners (Touch Interruption)
    const mapCanvas = map.getCanvas();
    mapCanvas.addEventListener('touchstart', (e) => {
        if (e.touches.length === 1) {
            isUserInteracting = true;
            isDragging = true;
        }
    }, { passive: true });
    mapCanvas.addEventListener('touchend', () => {
        setTimeout(() => {
            isUserInteracting = false;
            isDragging = false;
            scheduleFollowCameraSync(map, { delayMs: 0 });
        }, 50);
    }, { passive: true });
    mapCanvas.addEventListener('touchcancel', () => {
        setTimeout(() => {
            isUserInteracting = false;
            isDragging = false;
            scheduleFollowCameraSync(map, { delayMs: 0 });
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
            scheduleFollowCameraSync(map, { delayMs: 0 });
        }, 50);
    });

    // Locate Button Logic
    if (locateBtn) {
        locateBtn.addEventListener('click', () => {
            lastLocateClickTime = Date.now();

            if (!isNative && checkHeadingSupport() && typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
                const granted = localStorage.getItem('compassPermissionGranted') === 'true';
                if (!granted) {
                    // Defer permission prompt so UI state updates immediately.
                    setTimeout(() => {
                        DeviceOrientationEvent.requestPermission()
                            .then(res => {
                                if (res === 'granted') {
                                    localStorage.setItem('compassPermissionGranted', 'true');
                                    startPersistentOrientationTracking(map);
                                }
                            })
                            .catch(() => { });
                    }, 0);
                }
            }

            if (!isSecureContext()) {
                if (!navigator.geolocation) {
                    alert('Geolocation is disabled by your browser. If you see a "Not Secure" warning in the address bar, this is likely why. Please "Trust" the certificate to continue.');
                } else {
                    alert('Location services require a secure (HTTPS) connection.');
                }
                locateBtn.innerHTML = LOCATION_ICONS.SLASHED;
                return;
            }

            if (isNative && lastUserCoords && !hasUserLocationMarker()) {
                repairUserLocationMarker(map);
                refreshLocationMarker(map, {
                    preserveCurrentZoom: true,
                    suppressCameraUpdate: true
                }).catch(() => { });
            }

            if (currentLocationState === LOCATION_STATES.OFF) {
                let interactionStartCenter = null; // Local scoping issue? No, we need it for interruption logic.
                // Wait, interactionStartCenter is shared with handleInteractionEnd.
                // I need to declare it in module scope or closure.
                // It was in setupMapControls closure in map-setup.js.
                // I'll make it module scope for simplicity in this file.

                currentLocationState = LOCATION_STATES.FOLLOW;
                updateLocationIcon(locateBtn);
                isWaitingForFirstLocation = true;
                smoothedFollowCoords = lastUserCoords ? { ...lastUserCoords } : null;

                if (lastUserCoords) {
                    centerFollowCamera(map, { force: true, duration: 500 });
                    if (isNative) {
                        refreshLocationMarker(map, {
                            activateFollow: true,
                            preserveCurrentZoom: true,
                            suppressCameraUpdate: true
                        }).catch(() => { });
                    }
                } else {
                    triggerGeolocateWithoutStoppingActiveWatch(map);
                }

                const enableHeadingIndicator = () => {
                    startPersistentOrientationTracking(map);
                };

                if (isNative) {
                    enableHeadingIndicator();
                } else if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
                    DeviceOrientationEvent.requestPermission()
                        .then(res => {
                            if (res === 'granted') {
                                localStorage.setItem('compassPermissionGranted', 'true');
                                enableHeadingIndicator();
                            }
                        })
                        .catch(() => { });
                } else {
                    enableHeadingIndicator();
                }

            } else if (currentLocationState === LOCATION_STATES.FOLLOW) {
                // To Heading
                const attemptHeadingTransition = () => {
                    startPersistentOrientationTracking(map);
                    const checkHeading = () => {
                        if (latestHeading !== null) {
                            isHeadingSupported = true;
                            // Note: we keep geolocate.options.showUserHeading false 
                            // because we handle the element ourselves.
                            currentLocationState = LOCATION_STATES.HEADING;
                            updateLocationIcon(locateBtn);
                            setHeadingMapBearing(map, latestHeading);
                        } else {
                            setTimeout(checkHeading, 100);
                        }
                    };

                    let timeout = setTimeout(() => {
                        if (currentLocationState !== LOCATION_STATES.HEADING) {
                            isHeadingSupported = false;
                            centerFollowCamera(map, { force: true, duration: 500 });
                        }
                    }, 1500);

                    checkHeading();
                };

                if (checkHeadingSupport()) {
                    if (isNative) {
                        attemptHeadingTransition();
                    } else if (typeof DeviceOrientationEvent.requestPermission === 'function') {
                        DeviceOrientationEvent.requestPermission()
                            .then(res => {
                                if (res === 'granted') {
                                    localStorage.setItem('compassPermissionGranted', 'true');
                                    attemptHeadingTransition();
                                }
                            })
                            .catch(e => console.error('Compass fail:', e));
                    } else {
                        attemptHeadingTransition();
                    }
                } else {
                    centerFollowCamera(map, { force: true, duration: 500 });
                }
            } else if (currentLocationState === LOCATION_STATES.HEADING) {
                currentLocationState = LOCATION_STATES.FOLLOW;
                stopHeadingMapBearingAnimation();
                const cameraOptions = { bearing: 0, duration: 500, essential: true };
                if (lastUserCoords) {
                    cameraOptions.center = [lastUserCoords.lng, lastUserCoords.lat];
                    cameraOptions.offset = getCenteringOffset();
                }
                map.easeTo(cameraOptions);
                updateLocationIcon(locateBtn);
            }
        });
    }

    // Mini Compass
    if (miniCompass) {
        let lastBearing = map.getBearing();
        let cumulativeRotation = lastBearing;
        let compassFadeTimeout = null;

        const showCompass = () => {
            if (compassFadeTimeout) {
                clearTimeout(compassFadeTimeout);
                compassFadeTimeout = null;
            }
            if (!miniCompass.classList.contains('hidden')) {
                miniCompass.classList.remove('fading-out');
                return;
            }
            miniCompass.classList.add('fading-out');
            miniCompass.classList.remove('hidden');
            requestAnimationFrame(() => miniCompass.classList.remove('fading-out'));
        };

        const hideCompass = () => {
            if (miniCompass.classList.contains('hidden') || miniCompass.classList.contains('fading-out')) return;
            miniCompass.classList.add('fading-out');
            compassFadeTimeout = setTimeout(() => {
                miniCompass.classList.add('hidden');
                miniCompass.classList.remove('fading-out');
                compassFadeTimeout = null;
            }, 220);
        };

        map.on('rotate', () => {
            const bearing = map.getBearing();

            // Calculate shortest path delta
            let delta = bearing - lastBearing;
            if (delta > 180) delta -= 360;
            if (delta < -180) delta += 360;
            cumulativeRotation += delta;
            lastBearing = bearing;

            if (Math.abs(bearing) > 0.1) {
                showCompass();
                if (compassIcon) {
                    compassIcon.style.transform = `rotate(${-cumulativeRotation}deg)`;
                }
            } else {
                hideCompass();
            }
        });
        miniCompass.addEventListener('click', () => {
            map.easeTo({ bearing: 0, duration: 500 });
            if (currentLocationState === LOCATION_STATES.HEADING) {
                currentLocationState = LOCATION_STATES.FOLLOW;
                stopHeadingMapBearingAnimation();
                updateLocationIcon(locateBtn);
            }
        });
    }

    map.on('move', () => updateHeadingIndicator(map));
    map.on('rotate', () => updateHeadingIndicator(map));
    map.on('pitch', () => updateHeadingIndicator(map));
    window.addEventListener('orientationchange', () => {
        if (latestWebRawHeading !== null) {
            latestHeading = normalizeHeadingDegrees(latestWebRawHeading);
        }
        if (latestHeading !== null) {
            updateHeadingIndicator(map);
            if (currentLocationState === LOCATION_STATES.HEADING && !isUserRotating && !isUserInteracting && !isDragging && !isPitching) {
                setHeadingMapBearing(map, latestHeading);
            }
        }
        scheduleFollowCameraSync(map, { delayMs: 80, force: true, duration: 0 });
        scheduleFollowCameraSync(map, { delayMs: 350, force: true, duration: 250 });
    });
    map.on('resize', () => {
        scheduleFollowCameraSync(map, { delayMs: 50, force: true, duration: 0 });
        scheduleFollowCameraSync(map, { delayMs: 250, force: true, duration: 250 });
    });

    // Initialize bearing immediately
    updateHeadingIndicator(map);

    // Interruption Logic
    let interactionStartCenter = null;
    let wasManualRotation = false;

    const startManualInteraction = () => {
        if (!interactionStartCenter) {
            interactionStartCenter = map.getCenter();
        }
    };

    const handleInteractionEnd = () => {
        if (isUserInteracting || isUserRotating || isReCentering) return;

        if (currentLocationState === LOCATION_STATES.OFF) {
            interactionStartCenter = null;
            return;
        }

        let manualPixelDist = 0;
        let wasManualInteraction = false;
        if (interactionStartCenter) {
            wasManualInteraction = true;
            const currentCenterPixel = map.project(map.getCenter());
            const startCenterPixel = map.project(interactionStartCenter);
            const dx = currentCenterPixel.x - startCenterPixel.x;
            const dy = currentCenterPixel.y - startCenterPixel.y;
            manualPixelDist = Math.sqrt(dx * dx + dy * dy);
            interactionStartCenter = null;
        }

        if (!wasManualInteraction || manualPixelDist < 40) {
            if (lastUserCoords && wasManualInteraction && manualPixelDist > 1) {
                centerFollowCamera(map, { force: true, duration: 500 });
            }
        } else {
            currentLocationState = LOCATION_STATES.OFF;
            stopHeadingMapBearingAnimation();
            smoothedFollowCoords = null;
            updateLocationIcon(locateBtn);
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
            wasManualRotation = true;
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
        if (wasManualRotation) {
            wasManualRotation = false;
            if (currentLocationState === LOCATION_STATES.HEADING) {
                currentLocationState = LOCATION_STATES.FOLLOW;
                stopHeadingMapBearingAnimation();
                updateLocationIcon(document.getElementById('locate-me'));
            } else if (currentLocationState !== LOCATION_STATES.OFF) {
                handleInteractionEnd();
            }
        }
    });

    map.on('pitchstart', (e) => {
        if (e.originalEvent) isPitching = true;
    });
    map.on('pitchend', () => {
        isPitching = false;
    });

    // Geolocate Event Listener
    geolocate.on('geolocate', (e) => {
        const coords = e.coords;
        lastUserCoords = { lng: coords.longitude, lat: coords.latitude };
        repairUserLocationMarker(map, e);

        if (isWaitingForFirstLocation) {
            isWaitingForFirstLocation = false;
            const locateBtn = document.getElementById('locate-me');
            if (locateBtn) updateLocationIcon(locateBtn);
        }

        if (isAutoFlyOnLaunch) {
            isAutoFlyOnLaunch = false;
            if (isWithinTbilisiRegion(coords.longitude, coords.latitude)) {
                pendingStartupFollow = true;
                const targetZoom = 16;
                map.jumpTo({
                    center: [coords.longitude, coords.latitude],
                    offset: getCenteringOffset(),
                    zoom: targetZoom
                });
                smoothedFollowCoords = { lng: coords.longitude, lat: coords.latitude };
                if (pendingStartupFollow && currentLocationState === LOCATION_STATES.OFF) {
                    currentLocationState = LOCATION_STATES.FOLLOW;
                    updateLocationIcon(document.getElementById('locate-me'));
                }
                pendingStartupFollow = false;
                updateMapLocationHash(map);
            } else {
                pendingStartupFollow = false;
            }
            return;
        }

        const shouldFollow = (currentLocationState === LOCATION_STATES.FOLLOW || currentLocationState === LOCATION_STATES.HEADING) && !isUserInteracting && !isUserRotating && !isDragging && !isPitching && !isReCentering;
        if (shouldFollow) {
            centerFollowCamera(map, { duration: 500, useSmoothing: true });
        } else {
            smoothedFollowCoords = null;
            scheduleFollowCameraSync(map, { delayMs: 150 });
            scheduleFollowCameraSync(map, { delayMs: 650 });
        }
    });

    geolocate.on('error', (e) => {
        // Simple error handling for now - can expand if needed
        console.error('[Geolocation] Error', e);
        const timeSinceClick = Date.now() - lastLocateClickTime;
        const wasTracking = lastUserCoords !== null;

        if (!wasTracking && timeSinceClick < 3000) {
            // Ignore quick errors
        } else {
            currentLocationState = LOCATION_STATES.OFF;
            stopHeadingMapBearingAnimation();
            const locateBtn = document.getElementById('locate-me');
            if (locateBtn) updateLocationIcon(locateBtn);
        }
    });

    // Programmatic Pitch Listener (from 3D button)
    window.addEventListener('programmaticPitch', (e) => {
        isPitching = e.detail;
    });

    // Initialize Auto-Show if permitted (iOS or WebView)
    const autoShowIfGranted = async () => {
        if (!isSecureContext()) return;

        const path = window.location?.pathname || '';
        const hash = window.location?.hash || '';
        const hashParts = hash.replace('#', '').split('/');
        const hasMapHash = hashParts.length >= 3 &&
            !Number.isNaN(parseFloat(hashParts[0])) &&
            !Number.isNaN(parseFloat(hashParts[1])) &&
            !Number.isNaN(parseFloat(hashParts[2]));
        const hasDeepLink = path.includes('/stop') ||
            path.includes('/bus') ||
            path.includes('/filtered') ||
            path.includes('/segment') ||
            path.includes('/directions') ||
            hasMapHash ||
            !!window.currentStopId;

        // Do not auto-center or trigger geolocation on deep links.
        isAutoFlyOnLaunch = !hasDeepLink;
        if (hasDeepLink) return;

        if (localStorage.getItem('compassPermissionGranted') === 'true') {
            startPersistentOrientationTracking(map);
        }

        if (isNative) {
            try {
                const perms = await NativeGeolocation.checkPermissions();
                if (perms?.location === 'denied') return;
            } catch (e) { }

            await refreshLocationMarker(map, { suppressCameraUpdate: true });
            return;
        }

        let granted = false;
        if (navigator.permissions && navigator.permissions.query) {
            try {
                const result = await navigator.permissions.query({ name: 'geolocation' });
                granted = result.state === 'granted';
            } catch (e) { }
        }

        if (!granted) return;
        // Prevent GeolocateControl internals from recentering before our region gate runs.
        await refreshLocationMarker(map, { activateFollow: true, suppressCameraUpdate: true });
    };

    const runInitialLocationRefresh = () => {
        setTimeout(() => {
            autoShowIfGranted().catch(() => { });
        }, 0);
    };

    if (map.loaded()) {
        runInitialLocationRefresh();
    } else {
        map.once('load', runInitialLocationRefresh);
    }
}
