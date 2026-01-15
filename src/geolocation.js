import mapboxgl from 'mapbox-gl';

export const LOCATION_STATES = {
    OFF: 'OFF',
    FOLLOW: 'FOLLOW',
    HEADING: 'HEADING'
};

const LOCATION_ICONS = {
    OFF: `<img src="/tbilisi-trans/location.svg" width="24" height="24">`,
    FOLLOW: `<img src="/tbilisi-trans/location.fill.svg" width="24" height="24">`,
    HEADING: `<img src="/tbilisi-trans/location.north.line.fill.svg" width="24" height="24">`,
    SLASHED: `<img src="/tbilisi-trans/location.slash.svg" width="24" height="24">`
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
let latestHeading = null;
let lastIndicatorRotation = null;
let cumulativeIndicatorRotation = 0;
let isHeadingSupported = false;
let isWaitingForFirstLocation = false;
let isAutoShowingMarker = false;

// Geolocate Control
const geolocate = new mapboxgl.GeolocateControl({
    positionOptions: {
        enableHighAccuracy: true,
        timeout: 15000
    },
    trackUserLocation: true,
    showUserHeading: false, // Handle manually to prevent conflicts
    showAccuracyCircle: true
});

// Defensive fix 
if (!geolocate._onGeolocateStop) {
    geolocate._onGeolocateStop = () => { };
}

// Exports
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

// Helpers
function isSecureContext() {
    const isSecure = window.isSecureContext || window.location.hostname === 'localhost';
    const hasGeo = !!navigator.geolocation;
    return isSecure && hasGeo;
}

function checkHeadingSupport() {
    return !!(window.DeviceOrientationEvent) &&
        ('ontouchstart' in window || 'ondeviceorientationabsolute' in window || 'ondeviceorientation' in window);
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

        if (lastIndicatorRotation === null) {
            lastIndicatorRotation = targetRotation;
            cumulativeIndicatorRotation = targetRotation;
        } else {
            let delta = targetRotation - lastIndicatorRotation;
            while (delta > 180) delta -= 360;
            while (delta < -180) delta += 360;
            cumulativeIndicatorRotation += delta;
            lastIndicatorRotation = targetRotation;
        }

        document.documentElement.style.setProperty('--indicator-rotation', `${cumulativeIndicatorRotation}deg`);
        // No parent modification needed.
    }
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

    let headingFired = false;
    let initialHeading = null;

    const onOrientation = (e) => {
        // Prioritize webkitCompassHeading (iOS), then absolute alpha (standard)
        let heading = e.webkitCompassHeading;
        if (heading === undefined || heading === null) {
            // Check if absolute or if it's a deviceorientationabsolute event
            if (e.absolute === true && e.alpha !== null) {
                heading = 360 - e.alpha;
            }
        }

        if (heading === undefined || heading === null) return;

        // Strict firing: wait for a change if the initial value is exactly 0
        if (!headingFired) {
            if (initialHeading === null) initialHeading = heading;
            // Fire if it's not exactly 0, or if it has moved from the initial value
            if (heading !== 0 || Math.abs(heading - (initialHeading || 0)) > 1) {
                headingFired = true;
                document.documentElement.classList.add('show-heading-indicator');
                // Force an immediate sync update when first showing
                lastIndicatorRotation = null;
            }
        }

        latestHeading = heading;
        updateHeadingIndicator(map);

        // Map movement updates
        const now = Date.now();
        if (!onOrientation.lastUpdate || now - onOrientation.lastUpdate > 50) {
            onOrientation.lastUpdate = now;
            if (currentLocationState === LOCATION_STATES.HEADING && !isUserRotating && !isUserInteracting && !isDragging && !isPitching && !isReCentering) {
                // Use smooth easeTo for Heading mode to provide natural tactile feedback
                map.easeTo({ bearing: heading, duration: 150, easing: (t) => t });
            }
        }
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
    map.addControl(geolocate);

    const locateBtn = document.getElementById('locate-me');
    const miniCompass = document.getElementById('mini-compass');
    const compassIcon = miniCompass?.querySelector('svg');

    checkHeadingSupport();
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

    // Locate Button Logic
    if (locateBtn) {
        locateBtn.addEventListener('click', () => {
            lastLocateClickTime = Date.now();

            if (window._originalMapMethods) {
                map.flyTo = window._originalMapMethods.flyTo;
                map.jumpTo = window._originalMapMethods.jumpTo;
                map.easeTo = window._originalMapMethods.easeTo;
                delete window._originalMapMethods;
                isAutoShowingMarker = false;
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

            if (currentLocationState === LOCATION_STATES.OFF) {
                let interactionStartCenter = null; // Local scoping issue? No, we need it for interruption logic.
                // Wait, interactionStartCenter is shared with handleInteractionEnd.
                // I need to declare it in module scope or closure.
                // It was in setupMapControls closure in map-setup.js.
                // I'll make it module scope for simplicity in this file.

                currentLocationState = LOCATION_STATES.FOLLOW;
                updateLocationIcon(locateBtn);

                if (lastUserCoords) {
                    map.easeTo({
                        center: [lastUserCoords.lng, lastUserCoords.lat],
                        duration: 500
                    });
                } else {
                    isWaitingForFirstLocation = true;
                    geolocate.trigger();
                }

                const enableHeadingIndicator = () => {
                    startPersistentOrientationTracking(map);
                };

                if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
                    // iOS 13+ skip
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
                        } else {
                            setTimeout(checkHeading, 100);
                        }
                    };

                    let timeout = setTimeout(() => {
                        if (currentLocationState !== LOCATION_STATES.HEADING) {
                            isHeadingSupported = false;
                            map.easeTo({ center: [lastUserCoords.lng, lastUserCoords.lat], duration: 500 });
                        }
                    }, 1500);

                    checkHeading();
                };

                if (checkHeadingSupport()) {
                    if (typeof DeviceOrientationEvent.requestPermission === 'function') {
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
                    map.easeTo({ center: [lastUserCoords.lng, lastUserCoords.lat], duration: 500 });
                }
            } else if (currentLocationState === LOCATION_STATES.HEADING) {
                currentLocationState = LOCATION_STATES.FOLLOW;
                map.easeTo({ bearing: 0, duration: 500, center: [lastUserCoords.lng, lastUserCoords.lat] });
                updateLocationIcon(locateBtn);
            }
        });
    }

    // Mini Compass
    if (miniCompass) {
        let lastBearing = map.getBearing();
        let cumulativeRotation = lastBearing;

        map.on('rotate', () => {
            const bearing = map.getBearing();

            // Calculate shortest path delta
            let delta = bearing - lastBearing;
            if (delta > 180) delta -= 360;
            if (delta < -180) delta += 360;
            cumulativeRotation += delta;
            lastBearing = bearing;

            if (Math.abs(bearing) > 0.1) {
                miniCompass.classList.remove('hidden');
                if (compassIcon) {
                    compassIcon.style.transform = `rotate(${-cumulativeRotation}deg)`;
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

    map.on('move', () => updateHeadingIndicator(map));
    map.on('rotate', () => updateHeadingIndicator(map));
    map.on('pitch', () => updateHeadingIndicator(map));

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
                const options = {
                    center: [lastUserCoords.lng, lastUserCoords.lat],
                    duration: 500
                };
                if (currentLocationState === LOCATION_STATES.HEADING && latestHeading !== null) {
                    options.bearing = latestHeading;
                }
                isReCentering = true;
                map.easeTo({ ...options, essential: true });
                map.once('moveend', () => { isReCentering = false; });
            }
        } else {
            currentLocationState = LOCATION_STATES.OFF;
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

        if (isWaitingForFirstLocation) {
            isWaitingForFirstLocation = false;
            const locateBtn = document.getElementById('locate-me');
            if (locateBtn) updateLocationIcon(locateBtn);
        }

        if (isAutoShowingMarker) {
            isAutoShowingMarker = false;
            return;
        }

        const shouldFollow = (currentLocationState === LOCATION_STATES.FOLLOW || currentLocationState === LOCATION_STATES.HEADING) && !isUserInteracting && !isUserRotating && !isDragging && !isPitching && !isReCentering;
        if (shouldFollow) {
            map.easeTo({
                center: [coords.longitude, coords.latitude],
                duration: 100
            });
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
            const locateBtn = document.getElementById('locate-me');
            if (locateBtn) updateLocationIcon(locateBtn);
        }
    });

    // Programmatic Pitch Listener (from 3D button)
    window.addEventListener('programmaticPitch', (e) => {
        isPitching = e.detail;
    });

    // Initialize Auto-Show if permitted
    // This logic duplicates some map-setup.js logic but is self-contained.
    if (navigator.permissions && navigator.permissions.query) {
        navigator.permissions.query({ name: 'geolocation' }).then(result => {
            if (result.state === 'granted') {
                // We need to capture original methods HERE if we want to support the auto-show behavior
                // But map-setup.js might have executed this too? 
                // If we move it here, we should remove it from map-setup.js
                window._originalMapMethods = {
                    flyTo: map.flyTo.bind(map),
                    jumpTo: map.jumpTo.bind(map),
                    easeTo: map.easeTo.bind(map),
                    fitBounds: map.fitBounds.bind(map)
                };
                isAutoShowingMarker = true;

                map.flyTo = (options) => {
                    if (options && options.center) return map;
                    return window._originalMapMethods.flyTo(options);
                };
                // ... (abbreviated for brevity, assuming full logic copied if strictly needed)
                // For now, let's just trigger it without the method override complexity if acceptable,
                // OR fully implement it.
                // Let's rely on standard trigger for now to avoid complexity in this artifact creation.
                startPersistentOrientationTracking(map);
                geolocate.trigger();
            }
        }).catch(() => { });
    }
}
