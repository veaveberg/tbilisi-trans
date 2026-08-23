import './performance-recorder.js';
import './css/base.css';
import './css/map-ui.css';
import './css/search.css';
import './css/panels.css';
import './css/transit.css';
import './css/metro.css';
import './css/editor.css';
import './css/components.css';
import './css/street-screen.css';
import mapboxgl from 'mapbox-gl';

import { Router } from './router.js';
import * as api from './api.js';
import { RouteGeometry } from './route-geometry.js';
import { setSheetState, setPanelState, closeAllPanels, setupPanelDrag } from './panel-manager.js';
import * as metro from './metro.js';
const { handleMetroStop } = metro;
import { setupGeolocation, isTrackingActive, stopTracking, isUserInteractingWithMap, LOCATION_STATES, refreshLocationMarker } from './geolocation.js';
import { map, getMapHash } from './map-setup.js';
import { setupVisuals, loadImages, addStopsToMap, updateMapTheme, getCircleRadiusExpression, updateLiveBuses, renderLiveBuses, registerLiveBusLine, clearLiveBuses, holdLiveBuses, refreshLiveBusTheme, decorateLiveBusFeatures, setMapLightPreset } from './map-visuals.js';
import { setMapFocus, refreshMapFocusDimTheme, setupHoverHandlers, setupClickHandlers, clearStopHoverState, consumeMapTapForSearch, runMapAction, resolvePlaceClickDetails } from './map-interactions.js';
import stopRotations from './data/stop_bearings.json';
import { db } from './db.js';
import { historyManager, addToHistory, popHistory, clearHistory, updateBackButtons, peekHistory } from './history.js';
import { hydrateRouteDetails } from './fetch.js';
import { setupEditTools, getEditState, setEditPickMode } from './dev-tools.js';
import * as arrivals from './arrivals.js';
import { arrivalsController } from './arrivals-controller.js';
import { getIntervalDescription, invalidateIntervalDataCache, loadIntervalData } from './intervals.js';
import { invalidateFareDataCache, loadFareData } from './fares.js';
import { initMinibusSegmentsEditor, loadMinibusSegmentEditsFromFile } from './minibus-segments-editor.js';
import { StreetScreenController } from './street-screen.js';
import { applyDirectionsUrlState, initDirectionsUI, isDirectionsContextActive, redrawActiveDirections, setPoint } from './directions.js';
import { flyToPointInView, beginMapCameraIntent, invalidateMapCameraIntent, isCurrentMapCameraIntent, getBandPadding, getCameraOrientation } from './map-camera.js';

import iconFilterOutline from './assets/icons/line.3.horizontal.decrease.circle.svg';
// import iconFilterFill from './assets/icons/line.3.horizontal.decrease.circle.fill.svg'; // Only used in FilterManager now? No, need check.


import { initSettings, settings, simplifyNumber, shouldShowRoute, openNativeFavoritesMenu, openSheetForCurrentPath, getNativeSettingsPlugin } from './settings.js';
import { initICloudHistorySync } from './icloud-sync.js';
import { checkRouteDataUpdates, getOtaDataFileText } from './ota-data.js';
import { favoritesManager } from './favorites.js';
import {
    applyStaticText,
    formatFilteredStopCount,
    formatFilteredSubtitle as formatFavoriteFilterSubtitle,
    getCurrentStopNamesLanguage,
    initI18n,
    onLanguageChange,
    t
} from './i18n.ts';

// --- Global State Declarations (Hoisted) ---
// These must be declared before api.fetchRoutes calls onRoutesLoaded
let allStops = [];
let rawStops = [];
let allRoutes = [];
let stopToRoutesMap = new Map();
const hydratedStops = new Set();
let lastRouteUpdateId = 0;
const redirectMap = new Map();

function cancelPendingFilterBounds() {
    window._pendingFilterBounds = null;
    window._pendingFilterBoundsCameraRequestId = null;
    window._pendingFilterBoundsScheduled = false;
}

function invalidateScheduledMapCamera() {
    invalidateMapCameraIntent();
    cancelPendingFilterBounds();
}

const getPublicWebBaseUrl = () => {
    const configured = import.meta.env.VITE_PUBLIC_WEB_BASE_URL;
    if (configured && typeof configured === 'string') {
        return configured.replace(/\/+$/, '');
    }
    return 'https://veaveberg.github.io/tbilisi-trans';
};

const shouldUsePublicWebUrl = () => {
    const cap = window.Capacitor;
    if (cap?.isNativePlatform?.()) return true;

    const href = window.location.href;
    if (href.startsWith('capacitor://')) return true;

    const host = window.location.hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
};

const buildCurrentUrl = () => {
    let url = window.location.href;
    if (shouldUsePublicWebUrl()) {
        const pathname = `${window.location.pathname || '/'}${window.location.hash || ''}`;
        url = `${getPublicWebBaseUrl()}${pathname}`;
    }
    return url;
};

// --- Mobile Detection & Zoom Adjust ---
initI18n();
const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
window.addEventListener('pageScaleChange', (e) => {
    const scale = e.detail;
    document.documentElement.style.setProperty('--ui-scale', scale);
    document.documentElement.classList.toggle('ui-scaled-down', scale < 1);
});

// Prevent focus-induced viewport scrolling on mobile
window.addEventListener('scroll', () => {
    if (window.scrollY !== 0 || window.scrollX !== 0) {
        window.scrollTo(0, 0);
    }
});
window.addEventListener('focusin', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') {
        setTimeout(() => {
            window.scrollTo(0, 0);
            document.body.scrollTop = 0;
        }, 0);
    }
});
const hubMap = new Map();
const hubSourcesMap = new Map();
const mergeSourcesMap = new Map();

let busUpdateInterval = null;
let filterBusUpdateInterval = null;
let filterBusUpdateToken = 0;
let activeLiveBusSession = 0;
let hasSkippedInitialPageShow = false;
let wasTrackingBeforePause = false;
let trackingZoomBeforePause = null;
let filterBusUpdateInFlight = false;
let filterBusUpdateQueued = false;
const filterBusThrottle = new Map(); // routeId -> { lastTs, failCount, cooldownUntil }
let stopRouteChipLiveBusInterval = null;
let stopRouteChipLiveBusToken = 0;
let stopRouteChipLiveBusInFlight = false;
let stopRouteChipLiveBusQueuedRequest = null;
const stopRouteChipLiveBusThrottle = new Map(); // routeId -> { lastTs, failCount, cooldownUntil }
let liveBusRequestGateTs = 0;
const LIVE_BUS_REQUEST_INTERVAL_MS = 1000;
const IOS_NATIVE_CACHE_VERSION_KEY = 'iosNativeCacheVersion';
let streetScreenController = null;
// State declarations

async function maybeRunNativeUpgradeCleanup() {
    try {
        const cap = window.Capacitor;
        const isNative = cap?.isNativePlatform?.() && (cap?.getPlatform?.() === 'ios' || cap?.getPlatform?.() === 'android');
        if (!isNative || typeof localStorage === 'undefined') return;

        const appInfo = await cap?.Plugins?.App?.getInfo?.();
        if (!appInfo) return;

        const currentVersion = `${appInfo.version || '0'}:${appInfo.build || '0'}`;
        const previousVersion = localStorage.getItem(IOS_NATIVE_CACHE_VERSION_KEY);
        if (previousVersion === currentVersion) return;

        console.log('[Native iOS] App version changed. Clearing volatile web caches.', {
            previousVersion,
            currentVersion
        });

        try {
            await api.clearAllCaches();
        } catch (err) {
            console.warn('[Native iOS] Failed to clear IndexedDB caches on upgrade', err);
        }

        try {
            sessionStorage.clear();
        } catch (err) {
            console.warn('[Native iOS] Failed to clear sessionStorage on upgrade', err);
        }

        try {
            if ('serviceWorker' in navigator) {
                const registrations = await navigator.serviceWorker.getRegistrations();
                await Promise.allSettled(registrations.map((r) => r.unregister()));
            }
        } catch (err) {
            console.warn('[Native iOS] Failed to unregister service workers on upgrade', err);
        }

        try {
            if (window.caches?.keys) {
                const keys = await window.caches.keys();
                await Promise.allSettled(keys.map((key) => window.caches.delete(key)));
            }
        } catch (err) {
            console.warn('[Native iOS] Failed to clear CacheStorage on upgrade', err);
        }

        localStorage.setItem(IOS_NATIVE_CACHE_VERSION_KEY, currentVersion);

        if (typeof window !== 'undefined' && !window.__didReloadAfterNativeCacheCleanup) {
            window.__didReloadAfterNativeCacheCleanup = true;
            window.location.reload();
        }
    } catch (err) {
        console.warn('[Native iOS] Upgrade cleanup check failed', err);
    }
}

function shouldShowMinibusSegmentsLayer() {
    return settings.showMinibuses && settings.showMinibusSegments;
}

function resetLiveBusSession({ clear = true } = {}) {
    activeLiveBusSession += 1;
    filterBusUpdateToken += 1;
    stopRouteChipLiveBusToken += 1;
    stopRouteChipLiveBusQueuedRequest = null;
    if (busUpdateInterval) {
        clearInterval(busUpdateInterval);
        busUpdateInterval = null;
    }
    if (filterBusUpdateInterval) {
        clearInterval(filterBusUpdateInterval);
        filterBusUpdateInterval = null;
    }
    if (stopRouteChipLiveBusInterval) {
        clearInterval(stopRouteChipLiveBusInterval);
        stopRouteChipLiveBusInterval = null;
    }
    if (clear) {
        clearLiveBuses();
    }
    return activeLiveBusSession;
}

// Initialize Settings
initSettings({
    onUpdate: () => {
        // Re-render Views
        if (window.currentStopId && !document.getElementById('info-panel')?.classList.contains('metro-mode')) {
            // If we have cached lastArrivals, re-render
            if (window.lastArrivals) {
                arrivals.renderArrivals(window.lastArrivals, window.currentStopId);
            }
        }
        if (filterManager) {
            filterManager.recalculateFilter(window.currentStopId, window.lastArrivals, window.lastRoutes);
        }
    }
});

onLanguageChange((change) => {
    if (change.target === 'stops') {
        refreshLanguageData();
        return;
    }

    if (change.target !== 'ui') return;

    applyStaticText();
    syncFavoriteButtonState();

    const isMetroCard = document.getElementById('info-panel')?.classList.contains('metro-mode');
    if (isMetroCard && window.currentStopId) {
        const metroStop = findStopById(window.currentStopId);
        if (metroStop) {
            void showStopInfo(metroStop, false, false, false, { forceRoutesRefresh: true });
        }
    } else if (window.currentStopId && window.lastArrivals) {
        arrivals.renderArrivals(window.lastArrivals, window.currentStopId);
    }

    if (filterManager) {
        filterManager.recalculateFilter(window.currentStopId, window.lastArrivals, window.lastRoutes);
    }
});

initICloudHistorySync();
maybeRunNativeUpgradeCleanup();

try {
    const cap = window.Capacitor;
    const ns = cap?.Plugins?.NativeSettings;
    if (cap?.isNativePlatform?.() && cap?.getPlatform?.() === 'ios' && ns?.warmUI) {
        ns.warmUI().catch(() => { });
    }
} catch (e) { }

// Native app bundles should not rely on PWA service workers; clear any previously registered ones.
try {
    const cap = window.Capacitor;
    if (cap?.isNativePlatform?.() && 'serviceWorker' in navigator) {
        navigator.serviceWorker.getRegistrations()
            .then((registrations) => Promise.allSettled(registrations.map((r) => r.unregister())))
            .catch(() => { });
        if (window.caches?.keys) {
            window.caches.keys()
                .then((keys) => Promise.allSettled(keys.map((key) => window.caches.delete(key))))
                .catch(() => { });
        }
    }
} catch (e) { }

// Background refresh for cached schedules (local dev proxy only)
api.maybeRefreshScheduleCache();
window.forceRefreshScheduleCache = api.forceRefreshScheduleCache;

// Setup Map Controls
// Setup Geolocation & Map Interactions
setupGeolocation(map);
setupVisuals();

document.addEventListener('sheet:closed', () => {
    try { clearStopHoverState(); } catch (err) { console.error('Clear Hover Error', err); }

    const infoPanel = document.getElementById('info-panel');
    const routePanel = document.getElementById('route-info');
    const directionsPanel = document.getElementById('directions-panel');
    const infoHidden = infoPanel ? infoPanel.classList.contains('hidden') : true;
    const routeHidden = routePanel ? routePanel.classList.contains('hidden') : true;
    const directionsHidden = directionsPanel ? directionsPanel.classList.contains('hidden') : true;

    if (infoHidden && routeHidden && directionsHidden) {
        window.currentStopId = null;
        window.currentStopMode = null;
        clearSelectedMinibusSegments();
        try { setMapFocus(false); } catch (err) { console.error('Reset Focus Error', err); }
    }
});

document.addEventListener('sheet:closed', (event) => {
    if (event.detail?.panelId !== 'directions-panel') return;
    resetLiveBusSession();
});

function canApplyRouteDataRefreshImmediately() {
    const infoPanel = document.getElementById('info-panel');
    const routePanel = document.getElementById('route-info');
    const directionsPanel = document.getElementById('directions-panel');
    const infoHidden = !infoPanel || infoPanel.classList.contains('hidden');
    const routeHidden = !routePanel || routePanel.classList.contains('hidden');
    const directionsHidden = !directionsPanel || directionsPanel.classList.contains('hidden');

    return infoHidden
        && routeHidden
        && directionsHidden
        && !window.currentStopId
        && !window.currentRoute
        && !isDirectionsContextActive();
}

window.addEventListener('routeDataRefreshResult', (event) => {
    if (event.detail?.status === 'updated') {
        if (canApplyRouteDataRefreshImmediately()) {
            void (async () => {
                const didReload = await reloadActiveTransitData('ota-idle-map', { invalidateStaticCaches: true });
                if (!didReload) {
                    hasPendingOtaTransitDataRefresh = true;
                }
            })();
            return;
        }

        hasPendingOtaTransitDataRefresh = true;
        console.log('[OTA] Route data update will be applied on the next UI transition');
    }
});

document.addEventListener('sheet:state-changed', (event) => {
    const panelId = event.detail?.panelId || 'sheet';
    const state = event.detail?.state || 'unknown';
    void consumePendingOtaTransitDataRefresh(`sheet:${panelId}:${state}`);
});

async function checkNativeRouteDataOnStartup() {
    try {
        const result = await checkRouteDataUpdates();
        if (result?.status === 'updated') {
            console.log('[OTA] Startup route data update downloaded', result);
            window.dispatchEvent(new CustomEvent('routeDataRefreshResult', { detail: result }));
        } else if (result?.status === 'upToDate') {
            console.log('[OTA] Startup route data check: up to date', result);
        }
    } catch (err) {
        console.warn('[OTA] Startup route data check failed', err);
    }
}

void checkNativeRouteDataOnStartup();

// Initial Router State Handling
Router.init();
const initialState = Router.parse();
Router.onPopState = () => {
    handleDeepLinks();
};

// Metro Editor (Lazily loaded)
window.startMetroEditor = async () => {
    const { initMetroEditor } = await import('./metro-editor.js');
    initMetroEditor(map, allStops);
};

// --- OPTIMIZED INITIALIZATION ---
let isRouterLogicExecuted = false;
let deepLinkHandlingPromise = null;

function runWhenMapReady(callback) {
    // Route and stop data is loaded from within the map's `load` handler. At
    // that point `initializeMapData` has already created the app layers, even
    // though Mapbox may keep both loaded checks false while tiles settle.
    // Waiting for a second `load` event in that state leaves deep links idle.
    if (map.getStyle()) {
        callback();
    } else {
        map.once('load', callback);
    }
}

function onRoutesLoaded(data) {
    if (!data) return;

    // Deep Check for 497
    const r497 = data.find(r => r.shortName === '497' || r.id.includes('minibusR24335'));
    if (r497) {
        console.log('[API DEBUG] onRoutesLoaded 497 check:', { id: r497.id, hasOv: !!r497._overrides });
    }

    allRoutes = data; // Always update global data
    window.__streetScreenAllRoutes = allRoutes;
    applyRouteOverrides(); // Apply overrides immediately after loading

    if (isRouterLogicExecuted) return; // Only run initial routing once
    isRouterLogicExecuted = true;

    // console.log('[Init] Router Logic Executing with', data.length, 'routes');

    // 2. Direct Route (Bus only)
    if (initialState.type === 'route' && initialState.shortName) {
        const execute = () => {
            api.fetchV3Routes().then(() => {
                const routeObj = resolveRouteByShortName(initialState.shortName, { preferBus: true });
                if (routeObj) {
                    showRouteOnMap(routeObj, true, {
                        initialDirectionIndex: initialState.direction,
                        fitToRoute: true,
                        routeSource: 'deepLink'
                    });
                }
            });
        };
        runWhenMapReady(execute);
    }

    // 3. Compact Directions Link
    else if (initialState.type === 'directions') {
        const executeDirectionsDeepLink = async () => {
            applyDirectionsUrlState(initialState, { syncUrl: false, openSheet: true });
            isDeepLinkHandled = true;
        };
        runWhenMapReady(executeDirectionsDeepLink);
    }

    // 4. Stop / Nested / Filter (Delegated to handleDeepLinks)
    // We delegate all stop-based logic to handleDeepLinks to ensure redirects (merged stops) are processed correctly.
    // Wait for map to be loaded AND stops to be available before processing
    else if (initialState.stopId) {
        const executeStopDeepLink = async () => {
            if (isDeepLinkHandled) return;
            // Wait until allStops is populated (stops load separately from routes)
            if (allStops.length === 0) {
                // Retry after a short delay - stops might still be loading
                setTimeout(executeStopDeepLink, 100);
                return;
            }
            const success = await handleDeepLinks();
            if (success) isDeepLinkHandled = true;
        };
        runWhenMapReady(executeStopDeepLink);
    }
}

// Consolidated loading logic is now inside map.on('load') to avoid race conditions.
let staticPreloadPromise = null;
let staticPreloadScheduled = false;

function runStaticRouteDetailsPreload() {
    if (staticPreloadPromise) return staticPreloadPromise;

    staticPreloadPromise = api.preloadStaticRoutesDetails().then(() => {
        if (window.allStops && window.allStops.length > 0) {
            addStopsToMap(window.allStops, { redirectMap, filterManager, updateConnectionLine });
        }
    });

    return staticPreloadPromise;
}

function scheduleStaticRouteDetailsPreload() {
    if (staticPreloadScheduled || staticPreloadPromise) return;
    staticPreloadScheduled = true;

    const startPreload = () => {
        setTimeout(() => {
            runStaticRouteDetailsPreload().catch((error) => {
                console.warn('[Load] Static route details preload failed:', error);
            });
        }, 1500);
    };

    if ('requestIdleCallback' in window) {
        window.requestIdleCallback(startPreload, { timeout: 4000 });
    } else {
        setTimeout(startPreload, 2500);
    }
}

window.addEventListener('static-routes-loaded', () => {
    if (window.allStops && window.allStops.length > 0) {
        addStopsToMap(window.allStops, { redirectMap, filterManager, updateConnectionLine });
    }
});

// Update URL hash when map movement ends (including inertia)
const updateURLHash = () => {
    // Skip hash updates when a stop or route card is open
    // (the stop/route URL itself leads to the correct location)
    const infoPanel = document.getElementById('info-panel');
    const routePanel = document.getElementById('route-info');
    if (isDirectionsContextActive()) {
        return;
    }
    if ((infoPanel && !infoPanel.classList.contains('hidden')) ||
        (routePanel && !routePanel.classList.contains('hidden'))) {
        return;
    }

    // Throttle updates in follow mode to avoid excessive history changes
    if (isTrackingActive()) {
        const now = Date.now();
        if (now - (window.lastFollowHashUpdate || 0) < 10000) return;
        window.lastFollowHashUpdate = now;
    }
    Router.updateMapLocation(getMapHash());
};

map.on('moveend', updateURLHash);
map.on('dragend', updateURLHash); // Also update on dragend since moveend doesn't always fire

// Initialize Filter Icon
const initialFilterBtn = document.getElementById('filter-routes-toggle');
if (initialFilterBtn) {
    initialFilterBtn.querySelector('.filter-icon').src = iconFilterOutline;
}


// State
// State declarations moved to top to avoid TDZ errors
// (allStops, allRoutes, etc.)

// Bus Interval

// Bus Interval



function getEquivalentStops(id, includeHubs = true) {
    if (includeHubs) {
        const parent = hubMap.get(id) || id;
        const children = hubSourcesMap.get(parent);
        if (children) {
            // If it's a hub, return all children.
            return Array.from(children);
        }
    }
    // Check Redirects
    const set = new Set();
    set.add(id);
    if (redirectMap.has(id)) set.add(redirectMap.get(id));
    if (mergeSourcesMap.has(id)) mergeSourcesMap.get(id).forEach(s => set.add(s));
    return Array.from(set);
}

function getSelectedRouteFilterShortNamesForStop(stopId = window.currentStopId) {
    const selectedRouteIds = Array.from(arrivals.getSelectedStopRouteFilterIds(stopId) || []);
    if (!selectedRouteIds.length) return [];

    const shortNames = selectedRouteIds
        .map((routeId) => {
            const route = allRoutes.find(r => String(r.id) === String(routeId));
            return route?.shortName ? String(route.shortName).trim() : null;
        })
        .filter(Boolean);

    return Array.from(new Set(shortNames)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

function resolveRouteFilterIdsForStop(routeShortNames = [], stopId = window.currentStopId) {
    if (!Array.isArray(routeShortNames) || routeShortNames.length === 0) return [];
    const resolvedIds = routeShortNames
        .map((shortName) => resolveRouteByShortName(shortName, {
            preferredStopId: stopId,
            preferBus: true
        })?.id)
        .filter(Boolean)
        .map(id => String(id));
    return Array.from(new Set(resolvedIds));
}

function extractNumericStopIdValue(value) {
    const match = String(value ?? '').match(/\d+/);
    if (!match) return null;
    const parsed = Number.parseInt(match[0], 10);
    return Number.isFinite(parsed) ? parsed : null;
}

function getCanonicalMergedStopId(stopId) {
    const currentId = String(stopId || '').trim();
    if (!currentId) return currentId;
    const equivalentIds = getEquivalentStops(currentId, false);
    const ids = new Set([currentId, ...equivalentIds.map(id => String(id))]);
    let best = null;

    ids.forEach((id) => {
        const stop = allStops.find(s => String(s.id) === String(id));
        const raw = String(stop?.id || id).trim();
        const numeric = extractNumericStopIdValue(stop?.code || raw);
        if (numeric === null) return;
        if (!best || numeric < best.numeric) {
            best = { raw, numeric };
        }
    });

    return best?.raw || currentId;
}

function updateCurrentStopDeepLink() {
    if (!window.currentStopId) return;
    const canonicalStopId = getCanonicalMergedStopId(window.currentStopId);
    Router.updateStop(
        canonicalStopId,
        !!filterManager?.state?.active,
        Array.from(filterManager?.state?.targetIds || []),
        '',
        getSelectedRouteFilterShortNamesForStop(canonicalStopId),
        { board: !!streetScreenController?.isOpen }
    );
}

// --- Navigation History ---
// Moved to history.js
let isInFavoritesBackContext = false;

function setFavoritesBackContext(enabled) {
    isInFavoritesBackContext = !!enabled;
    applyFavoritesBackButtonsIfNeeded();
}

function applyFavoritesBackButtonsIfNeeded() {
    if (!isInFavoritesBackContext) return;
    const backPanel = document.getElementById('back-panel');
    const backRoute = document.getElementById('back-route-info');
    if (backPanel) backPanel.classList.remove('hidden');
    if (backRoute) backRoute.classList.remove('hidden');
}

async function handleBack() {
    if (isInFavoritesBackContext) {
        isInFavoritesBackContext = false;
        await openNativeFavoritesMenu();
        return;
    }

    if (filterManager?.state?.context === 'segment' && (filterManager.state.active || filterManager.state.picking)) {
        filterManager.clearFilter(getActiveStopId(), { restoreStop: false });
        return;
    }

    const previous = popHistory();
    if (previous) {
        if (previous.type === 'stop') {
            const filterState = previous.data?._filterState;
            const routeChipFilterIds = Array.isArray(previous.data?._routeChipFilterIds)
                ? previous.data._routeChipFilterIds
                : [];
            // Restore map view to stop
            // Restore persistence zoom if available
            if (previous.data.savedZoom) {
                window.savedZoom = previous.data.savedZoom; // Temporary global handoff (or modify showStopInfo)
                // Actually easier to just modify showStopInfo to respect it from the object property
            }
            if (filterState?.active && filterState.targetIds && filterState.targetIds.length > 0) {
                await showStopInfo(previous.data, false, false, false); // no history, no flyTo, no URL yet
                arrivals.setStopRouteFilterIds(routeChipFilterIds, previous.data.id);
                await filterManager.toggleFilterMode(previous.data.id, null, null, { forceEnable: true, skipFlyTo: true });
                filterManager.state.targetIds = new Set(filterState.targetIds);
                await filterManager.refreshRouteFilter(previous.data.id, window.lastArrivals, window.lastRoutes);
                fitFilterBounds(previous.data, filterState.targetIds);
            } else {
                await showStopInfo(previous.data, false, true, true, { forceRoutesRefresh: true }); // ensure route chips render
                arrivals.setStopRouteFilterIds(routeChipFilterIds, previous.data.id);
                if (window.lastArrivals) {
                    arrivals.renderArrivals(window.lastArrivals, previous.data.id);
                }
            }
        } else if (previous.type === 'route') {
            showRouteOnMap(previous.data, false, { preserveBounds: true });
        } else if (previous.type === 'segment') {
            const ids = previous.data?.segmentIds || [];
            if (ids.length > 0 && typeof window.openSegmentCardForIds === 'function') {
                window.openSegmentCardForIds(ids);
            }
        }
    } else {
        // If going back to nothing (empty stack), clear everything
        stopEditing(true); // Persist and Close Edit Mode
        closeAllPanels();
        // Reset Map Focus
        setMapFocus(false);
        clearStopHoverState();
        // Clear Route
        clearRoute();
        // Clear Highlight
        if (map.getSource('selected-stop')) {
            map.getSource('selected-stop').setData({ type: 'FeatureCollection', features: [] });
        }
        window.currentStopId = null;
    }
}

// --- Filter Manager ---
import { FilterManager, generatePathSignature } from './filter-manager.js';
import { createFilterTravelTimeHelper } from './filter-travel-time.js';

let filterManager;

const dataProvider = {
    getAllStops: () => allStops,
    getRawStops: () => rawStops,
    getAllRoutes: () => allRoutes,
    getRedirectMap: () => redirectMap,
    getHubMap: () => hubMap,
    getHubSourcesMap: () => hubSourcesMap,
    getMergeSourcesMap: () => mergeSourcesMap,
    getStopToRoutesMap: () => stopToRoutesMap,
    getHydratedStops: () => hydratedStops,
    getEditState: getEditState,
    getRouteDisplayColor: getRouteDisplayColor,
    resolveRouteByShortName: resolveRouteByShortName
};

const ALL_STOP_LAYERS = [
    'stops-layer',
    'stops-layer-hover',
    'stops-layer-circle',
    'stops-layer-circle-hover',
    'stops-layer-hit-target',
    'metro-layer-circle',
    'metro-layer-label',
    'metro-transfer-layer',
    'metro-layer-overlay',
    'metro-exits-layer',
    'metro-segment-center-label'
];

// Explicit Metro Hover Logic (Pop Effect / Overlay)
// Moved to map-interactions.js
// Call this after map load or in Setup


const uiCallbacks = {
    renderArrivals: arrivals.renderArrivals,
    renderAllRoutes,
    setSheetState,
    updateConnectionLine,
    showStopInfo,
    applySegmentFilter: (routeIds, patternMap) => {
        if (typeof window.updateSegmentCardFilteredRoutes === 'function') {
            window.updateSegmentCardFilteredRoutes(routeIds, patternMap);
        }
    },
    updateFilterLiveBuses: (routeIds, patternMap) => {
        startFilterLiveBuses(routeIds, patternMap);
    },
    clearFilterLiveBuses: () => {
        clearFilterLiveBuses();
    },
    getCircleRadiusExpression: (scale) => getCircleRadiusExpression(scale)
};

// Lazy Init to ensure Map is ready? Or just init immediately.
// Map is imported. Router is imported.
filterManager = new FilterManager({ map, router: Router, dataProvider, uiCallbacks });
window.dataProvider = dataProvider;

// Initialize Arrivals Module with dependencies
arrivals.initArrivals({
    getEquivalentStops,
    mergeSourcesMap,
    stopToRoutesMap,
    renderAllRoutes,
    getRouteDisplayColor,
    getPatternHeadsign,
    allRoutes: () => allRoutes,
    // renderArrivals dependencies
    filterManager,
    showRouteOnMap,
    RouteGeometry,
    v3RoutesMap: () => v3RoutesMap,
    getVirtualPatterns: api.getVirtualPatterns,
    updateStopRouteChipLiveBuses
});

// Initialize Hover Handlers
setupHoverHandlers({
    ALL_STOP_LAYERS,
    setFilterOpacity: (dim) => {
        const opacity = dim ? 0.3 : 0.8;
        if (map.getLayer('filter-connection-line')) {
            map.setPaintProperty('filter-connection-line', 'line-opacity', opacity);
        }
        const style = map.getStyle();
        if (style && style.layers) {
            style.layers.forEach(l => {
                if (l.id.startsWith('filter-connection-') && l.type === 'line') {
                    map.setPaintProperty(l.id, 'line-opacity', opacity);
                }
            });
        }
    },
    filterManager: filterManager, // Pass Manager
    updateConnectionLine: updateConnectionLine // Pass function for hover preview
});

const getActiveStopId = () => (
    window.currentStopId ||
    arrivalsController?.stopId ||
    window._lastRenderedStopId ||
    (window.lastArrivals && window.lastArrivals[0] && (window.lastArrivals[0]._sourceStopId || window.lastArrivals[0].stopId)) ||
    null
);

// Initialize Click Handlers
setupClickHandlers({
    ALL_STOP_LAYERS,
    filterManager,
    showStopInfo,
    applyFilter: (targetId) => filterManager.applyFilter(targetId, getActiveStopId(), window.lastArrivals, window.lastRoutes),
    getStopById: (id) => allStops.find(s => s.id === id)
});

// Forwarding functions for UI event handlers
window.toggleFilterMode = () => {
    const top = peekHistory();
    const isSegment = top && top.type === 'segment';
    const allowedRouteIds = isSegment && Array.isArray(top.data?.allowedRouteIds)
        ? top.data.allowedRouteIds
        : null;
    const originOverride = isSegment && top.data?.filterOriginStopId
        ? String(top.data.filterOriginStopId)
        : null;
    const originIdsOverride = isSegment && Array.isArray(top.data?.filterOriginStopIds)
        ? top.data.filterOriginStopIds
        : null;
    const originIdsFallback = isSegment && Array.isArray(top.data?.filterOriginFallbackStopIds)
        ? top.data.filterOriginFallbackStopIds
        : null;
    const originId = originOverride || getActiveStopId();
    return filterManager.toggleFilterMode(originId, window.isPickModeActive, setEditPickMode, {
        allowedRouteIds,
        originIdsOverride,
        originIdsFallback,
        context: isSegment ? 'segment' : 'stop'
    });
};
window.applyFilter = (targetId) => filterManager.applyFilter(targetId, getActiveStopId(), window.lastArrivals, window.lastRoutes);
window.clearFilter = (stopId = getActiveStopId(), options = {}) => filterManager.clearFilter(stopId, options);
window.getSelectedStopRouteFilterIds = (stopId = getActiveStopId()) => arrivals.getSelectedStopRouteFilterIds(stopId);
window.getSelectedStopRouteFilterShortNames = (stopId = getActiveStopId()) => getSelectedRouteFilterShortNamesForStop(stopId);
window.resetStopRouteFilter = (stopId = getActiveStopId()) => arrivals.resetStopRouteFilter(stopId);
window.updateCurrentStopDeepLink = () => updateCurrentStopDeepLink();

function shuffleInPlace(items) {
    const out = Array.isArray(items) ? items.slice() : [];
    for (let i = out.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}

function resolveRouteForArrival(arrival) {
    if (!arrival) return null;
    const arrivalId = String(arrival.id || '').trim();
    const arrivalShortName = String(arrival.shortName || '').trim();
    return allRoutes.find((route) => String(route.id) === arrivalId)
        || allRoutes.find((route) => String(route.id) === String(arrival.routeId || '').trim())
        || allRoutes.find((route) => String(route.shortName) === arrivalShortName)
        || null;
}

function normalizeScheduleHourKey(hour) {
    const parsed = Number.parseInt(hour, 10);
    if (!Number.isFinite(parsed)) return '10';
    return String(Math.max(0, Math.min(23, parsed))).padStart(2, '0');
}

function buildDemoArrivalFromSchedule(route, timeText, minuteValue, stopId) {
    const routeLabel = route?.customShortName || route?.shortName || String(route?.id || '');
    const headsign = route?.longName || route?.customLongName || route?.shortName || routeLabel;
    const minuteNumber = Number.parseInt(minuteValue, 10);
    const safeMinute = Number.isFinite(minuteNumber) ? Math.max(0, Math.min(59, minuteNumber)) : 0;

    return {
        shortName: route?.shortName || routeLabel,
        id: route?.id || routeLabel,
        displayShortName: routeLabel,
        headsign,
        realtime: true,
        realtimeArrivalMinutes: safeMinute,
        scheduledArrivalMinutes: safeMinute,
        scheduledTime: timeText,
        patternSuffix: null,
        _source: route?._source,
        _sourceStopId: stopId
    };
}

async function collectScheduleDemoArrivals(stop, sampleHour = 10) {
    const hourKey = normalizeScheduleHourKey(sampleHour);
    const equivalentIds = getEquivalentStops(stop.id, false);
    const routeIds = new Set();

    equivalentIds.forEach((eqId) => {
        api.getRoutesForStopStatic(eqId).forEach((routeId) => routeIds.add(routeId));
    });

    const allStopRoutes = Array.from(routeIds)
        .map((routeId) => allRoutes.find((route) => String(route.id) === String(routeId)))
        .filter(Boolean);

    const perRouteSchedules = await Promise.allSettled(allStopRoutes.map(async (route) => {
        const grouped = await arrivals.getFullScheduleGrouped(route.shortName, stop.id, route.id, null, { strategy: 'cache-only' });
        if (!grouped?.grouped) return [];

        const minutes = grouped.grouped[hourKey] || [];
        return minutes.map((minuteValue) => {
            const timeText = `${hourKey}:${String(minuteValue).padStart(2, '0')}`;
            return buildDemoArrivalFromSchedule(route, timeText, minuteValue, stop.id);
        });
    }));

    const pool = perRouteSchedules
        .flatMap((result) => (result.status === 'fulfilled' && Array.isArray(result.value) ? result.value : []))
        .filter(Boolean);

    return pool;
}

async function showRandomArrivalsFromStop(stopId = 806, count = 15) {
    const normalizedStopId = String(stopId || '').trim();
    const sampleSize = Number.isFinite(Number(count)) ? Math.max(1, Math.floor(Number(count))) : 15;
    const candidateStopIds = new Set([normalizedStopId, ...getEquivalentStops(normalizedStopId, false).map((id) => String(id))]);
    const stop = allStops.find((entry) => candidateStopIds.has(String(entry.id)) || candidateStopIds.has(String(entry.code)));

    if (!stop) {
        console.warn(`[DemoArrivals] Stop ${normalizedStopId} was not found in loaded stop data.`);
        return [];
    }

    const previousState = {
        stopId: window.currentStopId,
        mode: window.currentStopMode,
        lastArrivals: Array.isArray(window.lastArrivals) ? window.lastArrivals.slice() : [],
        lastRoutes: Array.isArray(window.lastRoutes) ? window.lastRoutes.slice() : [],
        renderedStopId: window._lastRenderedStopId,
        controllerStopId: arrivalsController?.stopId ?? null
    };
    window.__demoArrivalsBoardSnapshot = previousState;

    try {
        arrivalsController?.pause?.();
        if (arrivalsController) {
            arrivalsController.stopId = null;
        }
    } catch (err) { }

    // Put the app into the requested stop context without changing history or URL state.
    await showStopInfo(stop, false, false, false, { suppressPanel: true });

    let fetchedArrivals = [];
    try {
        fetchedArrivals = await collectScheduleDemoArrivals(stop, 10);
    } catch (err) {
        console.error('[DemoArrivals] Failed to load scheduled arrivals for demo board.', err);
        return [];
    }

    if (!Array.isArray(fetchedArrivals) || fetchedArrivals.length === 0) {
        console.warn(`[DemoArrivals] No scheduled 10am arrivals returned for stop ${stop.id}.`);
        window.lastArrivals = [];
        window.lastRoutes = [];
        arrivals.renderArrivals([], stop.id);
        return [];
    }

    const tenAmPool = fetchedArrivals.filter((arrival) => {
        const scheduledTime = String(arrival.scheduledTime || '').trim();
        return scheduledTime.startsWith('10:');
    });
    const samplePool = tenAmPool.length > 0 ? tenAmPool : fetchedArrivals;

    const sampled = shuffleInPlace(samplePool)
        .slice(0, sampleSize)
        .sort((a, b) => {
            const timeA = a.realtimeArrivalMinutes !== undefined && a.realtimeArrivalMinutes !== null
                ? a.realtimeArrivalMinutes
                : a.scheduledArrivalMinutes;
            const timeB = b.realtimeArrivalMinutes !== undefined && b.realtimeArrivalMinutes !== null
                ? b.realtimeArrivalMinutes
                : b.scheduledArrivalMinutes;
            return (Number.isFinite(timeA) ? timeA : 9999) - (Number.isFinite(timeB) ? timeB : 9999);
        });

    const sampledRouteIds = new Set();
    const sampledRoutes = [];
    sampled.forEach((arrival) => {
        const route = resolveRouteForArrival(arrival);
        const routeId = String(route?.id || arrival?.id || '').trim();
        if (!routeId || sampledRouteIds.has(routeId)) return;
        sampledRouteIds.add(routeId);
        if (route) sampledRoutes.push(route);
    });

    window.lastRoutes = sampledRoutes;
    window.lastArrivals = sampled;
    arrivals.resetStopRouteFilter(stop.id);
    arrivals.renderArrivals(sampled, stop.id);

    if (streetScreenController) {
        if (!streetScreenController.isOpen) {
            await streetScreenController.open({ syncUrl: false });
        } else {
            await streetScreenController.syncModel();
        }
    }

    console.log(`[DemoArrivals] Showing ${sampled.length} random arrivals from stop ${stop.id}.`);
    console.table(sampled.map((arrival) => ({
        route: arrival.shortName || arrival.id,
        headsign: arrival.headsign || '',
        minutes: arrival.realtimeArrivalMinutes ?? arrival.scheduledArrivalMinutes ?? null,
        realtime: !!arrival.realtime
    })));

    return sampled;
}

window.showRandomArrivalsFromStop = showRandomArrivalsFromStop;
window.showDemoArrivalsFromStop = showRandomArrivalsFromStop;
window.restoreArrivalsBoard = async () => {
    const snapshot = window.__demoArrivalsBoardSnapshot;
    if (!snapshot) {
        console.warn('[DemoArrivals] No demo board snapshot is available to restore.');
        return false;
    }

    window.currentStopId = snapshot.stopId ?? null;
    window.currentStopMode = snapshot.mode ?? null;
    window._lastRenderedStopId = snapshot.renderedStopId ?? null;
    window.lastArrivals = Array.isArray(snapshot.lastArrivals) ? snapshot.lastArrivals.slice() : [];
    window.lastRoutes = Array.isArray(snapshot.lastRoutes) ? snapshot.lastRoutes.slice() : [];
    arrivals.resetStopRouteFilter(window.currentStopId);
    arrivals.renderArrivals(window.lastArrivals, window.currentStopId);

    if (streetScreenController?.isOpen) {
        await streetScreenController.syncModel();
    }

    try {
        if (snapshot.controllerStopId) {
            arrivalsController.stopId = snapshot.controllerStopId;
            arrivalsController.arrivals = Array.isArray(snapshot.lastArrivals) ? snapshot.lastArrivals.slice() : [];
            arrivalsController.timestamp = Date.now();
            arrivalsController.resume?.();
            arrivalsController.refresh?.();
        }
    } catch (err) { }

    console.log('[DemoArrivals] Restored the previous arrivals board state.');
    return true;
};

import { RouteFilterColorManager } from './color-manager.js';

import { dismissSearch, isSearchActive, setupSearch, showPlaceInfoSheet } from './search.js';
import { ThemeManager } from './theme.js';

// Global Theme Manager
let themeManager;
let selectedMinibusSegmentIds = new Set();

function clearSelectedMinibusSegments() {
    if (!map.getSource('minibus-segments')) {
        selectedMinibusSegmentIds.clear();
        return;
    }
    selectedMinibusSegmentIds.forEach((id) => {
        if (id === undefined || id === null) return;
        try {
            map.setFeatureState({ source: 'minibus-segments', id }, { selected: false });
        } catch (e) { }
    });
    selectedMinibusSegmentIds.clear();
}

function setSelectedMinibusSegments(ids) {
    clearSelectedMinibusSegments();
    if (!Array.isArray(ids) || ids.length === 0) return;
    ids.forEach((id) => {
        if (id === undefined || id === null) return;
        selectedMinibusSegmentIds.add(id);
        try {
            map.setFeatureState({ source: 'minibus-segments', id }, { selected: true });
        } catch (e) { }
    });
}

// Legacy function cleanup
// toggleFilterMode, updateMapFilterState, ensureLazyRoutesForStop, refreshRouteFilter, applyFilter, clearFilter 
// are now handled by filterManager.
// We need to remove the definitions.

// Re-export specific hook for map updates from filter manager
function updateMapFilterState() {
    filterManager.updateMapFilterState();
}

// Back Button Listeners
document.getElementById('back-panel')?.addEventListener('click', handleBack);
document.getElementById('back-route-info')?.addEventListener('click', handleBack);

// App Lifecycle: Pause all activity when backgrounded
function pauseAppActivity() {
    wasTrackingBeforePause = isTrackingActive();
    trackingZoomBeforePause = wasTrackingBeforePause ? map.getZoom() : null;
    try { arrivalsController.pause(); } catch (e) { }
    try { arrivals.stopArrivalsCountdown(); } catch (e) { }
    if (busUpdateInterval) {
        clearInterval(busUpdateInterval);
        busUpdateInterval = null;
    }
}

function resumeAppActivity() {
    if (document.hidden) return;
    const hasOpenStop = !!window.currentStopId;
    if (hasOpenStop) {
        try { arrivals.markArrivalsLiveDataStale(); } catch (e) { }
    }
    try { arrivals.startArrivalsCountdown(); } catch (e) { }
    try { arrivalsController.resume(); } catch (e) { }
    if (hasOpenStop) {
        try { arrivalsController.refresh(); } catch (e) { }
    }
    if (wasTrackingBeforePause) {
        try {
            refreshLocationMarker(map, {
                preserveCurrentZoom: true,
                suppressCameraUpdate: true,
                recenterAfterUpdate: true
            });
        } catch (e) { }
        if (typeof trackingZoomBeforePause === 'number') {
            setTimeout(() => {
                if (!isTrackingActive()) return;
                const currentZoom = map.getZoom();
                if (Math.abs(currentZoom - trackingZoomBeforePause) > 0.05) {
                    map.easeTo({
                        zoom: trackingZoomBeforePause,
                        duration: 250,
                        easing: (t) => t
                    });
                }
            }, 700);
        }
    }
    try {
        const routePanel = document.getElementById('route-info');
        if (window.currentRoute && routePanel && !routePanel.classList.contains('hidden')) {
            updateRouteView(window.currentRoute, { preserveBounds: true });
        }
    } catch (e) { }
}

document.addEventListener('visibilitychange', () => {
    if (document.hidden) pauseAppActivity();
    else resumeAppActivity();
});
window.addEventListener('pagehide', pauseAppActivity);
window.addEventListener('pageshow', (event) => {
    if (!hasSkippedInitialPageShow && !event.persisted) {
        hasSkippedInitialPageShow = true;
        return;
    }
    resumeAppActivity();
});

// --- Search History ---


// Initialize map data
// --- Map Initialization & Data Loading ---
let isSearchInitialized = false;
let areImagesLoaded = false;
let isDeepLinkHandled = false;
let isLanguageRefreshInFlight = false;
let hasPendingOtaTransitDataRefresh = false;
let isTransitDataRefreshInFlight = false;

async function initializeMapData(stopsData, routesData) {
    if (!stopsData || !routesData) return;

    // console.log('[Main] Initializing Map Data...');

    // 1. Update Globals
    rawStops = stopsData;
    allRoutes = routesData;
    window.__streetScreenAllRoutes = allRoutes;
    window.allStops = allStops; // Debug support
    applyRouteOverrides(); // Ensure overrides are applied to fresh data


    // 2. Map Images, Config & Layers (Populates allStops from rawStops)
    if (!areImagesLoaded) {
        await loadImages(map);
        areImagesLoaded = true;
    }
    await refreshStopsLayer();

    // 3. Index Routes (Clear and Rebuild)
    stopToRoutesMap.clear();
    hydratedStops.clear();
    allRoutes.forEach(route => {
        if (route.stops) {
            route.stops.forEach(stopId => {
                const targetId = redirectMap.get(stopId) || stopId;
                if (!stopToRoutesMap.has(targetId)) stopToRoutesMap.set(targetId, []);
                if (!stopToRoutesMap.get(targetId).includes(route)) {
                    stopToRoutesMap.get(targetId).push(route);
                }
            });
        }
    });

    // 4. Setup Search (Run Once)
    if (!isSearchInitialized) {
        setupSearch({
            onRouteSelect: (route) => showRouteOnMap(route, true, { routeSource: 'search' }),
            onStopSelect: (stop) => showStopInfo(stop, true, true)
        }, {
            getAllStops: () => allStops,
            getAllRoutes: () => allRoutes
        });
        isSearchInitialized = true;

        // 4b. Map POI clicks — reuse the exact same place info sheet
        const POI_FEATURESET = { featuresetId: 'poi', importId: 'basemap' };

        map.on('click', POI_FEATURESET, (e) => {
            if (consumeMapTapForSearch(e)) return;
            // Stops take priority — if a stop is under the cursor, ignore the POI click
            const validStopLayers = ALL_STOP_LAYERS.filter(id => map.getLayer(id));
            if (map.queryRenderedFeatures(e.point, { layers: validStopLayers }).length > 0) return;

            stopTracking();
            if (e.originalEvent) e.originalEvent._clickHandled = true;

            const feature = e.features?.[0];
            if (!feature) return;

            // Retrieve coordinates from geometry to snap exactly, fallback to click point
            let lng = e.lngLat.lng;
            let lat = e.lngLat.lat;
            if (feature.geometry && feature.geometry.type === 'Point' && Array.isArray(feature.geometry.coordinates)) {
                lng = feature.geometry.coordinates[0];
                lat = feature.geometry.coordinates[1];
            }

            const cameraIntentId = flyToPointInView([lng, lat], {
                zoom: 17,
                bottomAnchorSelector: '#info-panel',
                duration: 900,
                radiusMeters: 10
            });

            runMapAction(e, () => {
                // Drop a highlighted red marker directly at the snapped coordinates
                if (window._searchPlaceMarker) {
                    window._searchPlaceMarker.remove();
                    window._searchPlaceMarker = null;
                }
                window._searchPlaceMarker = new mapboxgl.Marker({ color: '#e74c3c' })
                    .setLngLat([lng, lat])
                    .addTo(map);

                void (async () => {
                    const place = await resolvePlaceClickDetails({
                        feature,
                        center: [lng, lat],
                        name: feature.properties?.name || feature.properties?.name_en || feature.properties?.name_primary,
                        assumePoi: true
                    });
                    if (!isCurrentMapCameraIntent(cameraIntentId)) {
                        return;
                    }

                    showPlaceInfoSheet({
                        text: place.hasRealName ? place.text : place.address,
                        place_name: place.description,
                        center: place.center,
                        extent: null,
                        placeType: place.placeType
                    });
                })().catch((err) => {
                    console.error('[Map] Failed to resolve POI click details:', err);
                });
            });
        });

        map.on('mouseenter', POI_FEATURESET, (e) => {
            if (isSearchActive()) {
                map.getCanvas().style.cursor = '';
                return;
            }
            // Don't override the stop pointer cursor
            const validStopLayers = ALL_STOP_LAYERS.filter(id => map.getLayer(id));
            if (map.queryRenderedFeatures(e.point, { layers: validStopLayers }).length > 0) return;
            map.getCanvas().style.cursor = 'pointer';
        });
        map.on('mouseleave', POI_FEATURESET, () => {
            map.getCanvas().style.cursor = '';
        });
    }

    // 5. Map Visuals
    window.dispatchEvent(new CustomEvent('map-data-initialized'));

    // 6. Final UI
    document.body.classList.remove('loading');
    setTimeout(() => {
        map.resize();
        if (isDirectionsContextActive()) {
            redrawActiveDirections();
        }
        // This fixes the issue where "Fresh Load" resets the layer styles, undoing deep link dimming.
        if (window.currentStopId) {
            const parsed = Router.parse();
            const shouldFocus = !(parsed?.filterActive || window.isFilterModeActive || (filterManager && (filterManager.state.active || filterManager.state.picking)));
            if (shouldFocus) setMapFocus(true);

            // Also restore stop highlight marker (may have been cleared by addStopsToMap)
            const highlightStop = allStops.find(s => String(s.id) === String(window.currentStopId));
            if (highlightStop && highlightStop.lon && highlightStop.lat && map.getSource('selected-stop')) {
                map.getSource('selected-stop').setData({
                    type: 'FeatureCollection',
                    features: [{
                        type: 'Feature',
                        geometry: { type: 'Point', coordinates: [highlightStop.lon, highlightStop.lat] },
                        properties: highlightStop
                    }]
                });
                if (map.getLayer('stops-highlight')) map.moveLayer('stops-highlight');
            }
        }
    }, 100);

    // 7. Router / Deep Links
    if (!isDeepLinkHandled) {
        const success = await handleDeepLinks();
        if (success) {
            isDeepLinkHandled = true;

            Router.onPopState = () => {
                handleDeepLinks();
            };
        }
    } else {
        // Deep link already handled (e.g. by Fast Load).
        // If we just reloaded fresh data, we MUST re-apply the filter to the new objects.
        if (filterManager.state.active && filterManager.state.originId) {
            // console.log('[Main] Fresh data loaded while Filter Active. Re-applying...');
            // Use refreshRouteFilter, which now includes hydration logic
            filterManager.refreshRouteFilter(filterManager.state.originId);
        }
    }

    // console.log('[Main] Initialization Complete');
} // End of initializeMapData

function findStopById(stopId) {
    if (!stopId) return null;
    const target = String(stopId);
    return allStops.find((stop) => String(stop.id) === target) || null;
}

function findRouteByIdentity(routeId, routeShortName, routes = allRoutes) {
    return routes.find((route) =>
        (routeId && String(route.id) === String(routeId)) ||
        (routeShortName && String(route.shortName) === String(routeShortName))
    ) || null;
}

async function reloadActiveTransitData(reason = 'manual', options = {}) {
    if (isTransitDataRefreshInFlight) return false;
    isTransitDataRefreshInFlight = true;
    try {
        if (options.applyStaticText) {
            applyStaticText();
        }
        syncFavoriteButtonState();

        const stopPanelVisible = !document.getElementById('info-panel')?.classList.contains('hidden');
        const routePanelVisible = !document.getElementById('route-info')?.classList.contains('hidden');
        const activeStopId = window.currentStopId ? String(window.currentStopId) : null;
        const activeRouteId = window.currentRoute?.id ? String(window.currentRoute.id) : null;
        const activeRouteShortName = window.currentRoute?.shortName ? String(window.currentRoute.shortName) : null;

        if (options.invalidateStaticCaches) {
            api.invalidateStaticTransitDataCaches();
            invalidateIntervalDataCache();
            invalidateFareDataCache();
            arrivals.invalidateArrivalBottomInfo();
            cachedStopsConfig = null;
            window.stopsConfig = null;
            routesConfig = { routeOverrides: {} };
            window.routesConfig = routesConfig;
            await loadRoutesConfig();
            await loadIntervalData();
            await loadFareData();
        }

        const [stops, routes] = await Promise.all([
            api.fetchStops({ strategy: 'network-only' }),
            api.fetchRoutes({ strategy: 'network-only' })
        ]);

        await initializeMapData(stops, routes);
        if (options.invalidateStaticCaches) {
            await api.preloadStaticRoutesDetails();
        }
        onRoutesLoaded(routes);

        if (routePanelVisible && (activeRouteId || activeRouteShortName)) {
            const nextRoute = findRouteByIdentity(activeRouteId, activeRouteShortName, routes);
            if (nextRoute) {
                await showRouteOnMap(nextRoute, false, { preserveBounds: true, suppressPanel: false, fitToRoute: false });
            }
        } else if (stopPanelVisible && activeStopId) {
            const nextStop = stops.find((stop) => String(stop.id) === activeStopId);
            if (nextStop) {
                await showStopInfo(nextStop, false, false, false, { forceRoutesRefresh: true });
            }
        }
        console.log(`[Data] Reloaded active transit data (${reason})`);
        scheduleStaticRouteDetailsPreload();
        return true;
    } catch (error) {
        console.error(`[Data] Failed to reload active transit data (${reason})`, error);
        return false;
    } finally {
        isTransitDataRefreshInFlight = false;
    }
}

async function consumePendingOtaTransitDataRefresh(reason) {
    if (!hasPendingOtaTransitDataRefresh || isTransitDataRefreshInFlight) return false;
    hasPendingOtaTransitDataRefresh = false;
    const didReload = await reloadActiveTransitData(reason, { invalidateStaticCaches: true });
    if (!didReload) {
        hasPendingOtaTransitDataRefresh = true;
    }
    return didReload;
}

async function refreshLanguageData() {
    if (isLanguageRefreshInFlight) return;
    isLanguageRefreshInFlight = true;

    try {
        if (hasPendingOtaTransitDataRefresh) {
            hasPendingOtaTransitDataRefresh = false;
            const didReload = await reloadActiveTransitData('language-change:ota', {
                applyStaticText: true,
                invalidateStaticCaches: true
            });
            if (!didReload) {
                hasPendingOtaTransitDataRefresh = true;
            }
        } else {
            await reloadActiveTransitData('language-change', { applyStaticText: true });
        }
    } finally {
        isLanguageRefreshInFlight = false;
    }
}



// Image Loading Function
// Render at 3x resolution for crispness on Retina/High-DPI screens
// Image Loading Function Moved to map-setup.js

// Redundant stops-highlight initialization removed. 
// Handled by addStopsToMap for better consistency and cleanup.

// Removed pendingRequests (moved to api.js)



// ... (keep this replacement near imports later)

// --- Map Initialization ---
function startNativeSplashReveal() {
    const overlay = document.getElementById('splash-overlay');
    if (overlay) overlay.remove();

    // On native: trigger the native zoom-reveal animation via the registered plugin
    try {
        const ns = getNativeSettingsPlugin();
        if (ns && typeof ns.hideSplash === 'function') {
            ns.hideSplash();
            return;
        }
    } catch (e) {
        console.warn('[Splash] Failed to call native hideSplash:', e);
    }

    // Fallback: also hide Capacitor's built-in splash
    try {
        const splash = window.Capacitor?.Plugins?.SplashScreen;
        if (splash && typeof splash.hide === 'function') splash.hide();
    } catch (e) { }
}

map.on('load', async () => {
    startNativeSplashReveal();

    // Initialize Theme Manager FIRST (Before any UI rendering to prevent theme flicker)
    themeManager = new ThemeManager(map);
    themeManager.init();

    // Listen for Manual Changes from Settings
    window.addEventListener('manualThemeChange', (e) => {
        const newTheme = e.detail;
        console.log('[Theme] Manual Switch:', newTheme);
        themeManager.setTheme(newTheme);
    });

    // Unified Loading Path
    const loadAllAtOnce = async () => {
        // 1. FAST PATH
        try {
            const [stops, routes] = await Promise.all([
                api.fetchStops({ strategy: 'cache-only' }),
                api.fetchRoutes({ strategy: 'cache-only' })
            ]);
            if (stops && routes) {
                console.log('[Load] Fast data loaded');
                await initializeMapData(stops, routes);
                onRoutesLoaded(routes);
                scheduleStaticRouteDetailsPreload();
            }
        } catch (e) { console.warn('Fast Load Failed', e); }

        // 2. FRESH PATH
        try {
            const [stops, routes] = await Promise.all([
                api.fetchStops(),
                api.fetchRoutes()
            ]);
            console.log('[Load] Fresh data loaded');
            await initializeMapData(stops, routes);
            onRoutesLoaded(routes);
            scheduleStaticRouteDetailsPreload();
        } catch (e) { console.error('Fresh Load Failed', e); }
    };

    loadAllAtOnce();
    loadMinibusSegments();
});

async function loadMinibusSegments() {
    try {
        const basePath = import.meta.env.BASE_URL.endsWith('/') ? import.meta.env.BASE_URL : `${import.meta.env.BASE_URL}/`;
        const response = await fetch(`${basePath}data/long_segments.geojson`);
        if (!response.ok) return;
        const data = await response.json();
        // Determine starting ID based on existing traffic (to avoid conflicts)? Safe enough to use large numbers or just local 0-index since source is specific.
        data.features.forEach((f, i) => {
            f.id = i;
        });

        const editsFromFile = await loadMinibusSegmentEditsFromFile(basePath);
        const renderedData = initMinibusSegmentsEditor(map, data, {
            sourceId: 'minibus-segments',
            layerId: 'minibus-segments-layer',
            edits: editsFromFile || undefined
        });
        window.minibusSegmentsData = renderedData;

        if (map.getSource('minibus-segments')) {
            map.getSource('minibus-segments').setData(renderedData);
        } else {
            map.addSource('minibus-segments', {
                type: 'geojson',
                data: renderedData
            });

            // 1. Check Initial Setting (Default: Hidden)
            const isVisible = shouldShowMinibusSegmentsLayer();

            // Add minibus layer BEFORE stops to ensure it's underneath
            const beforeId = map.getLayer('stops-layer-glow') ? 'stops-layer-glow' : undefined;

            map.addLayer({
                id: 'minibus-segments-layer',
                type: 'line',
                source: 'minibus-segments',
                layout: {
                    'line-join': 'round',
                    'line-cap': 'round',
                    'visibility': isVisible ? 'visible' : 'none'
                },
                paint: {
                    // Much brighter blue for dark mode (#80caff) with emissive strength to pop against dark map
                    'line-color': document.body.classList.contains('dark-mode') ? '#80caff' : '#2563eb',
                    'line-emissive-strength': document.body.classList.contains('dark-mode') ? 0.8 : 0,
                    'line-width': [
                        'case',
                        ['boolean', ['feature-state', 'selected'], false],
                        12,
                        ['boolean', ['feature-state', 'hover'], false],
                        12,
                        8
                    ],
                    'line-opacity': [
                        'case',
                        ['boolean', ['feature-state', 'selected'], false],
                        0.9,
                        ['boolean', ['feature-state', 'hover'], false],
                        0.8,
                        0.5
                    ]
                }
            }, beforeId);

            // Hover listeners are now handled centrally in map-interactions.js via setupHoverHandlers
            // to ensure mutual exclusivity with stops.

            const normalizeRouteIdForMatch = (id) => String(id || '')
                .replace(/^\d+:/, '')
                .replace(/^[rR]/, '');
            const normalizeStopNameForMatch = (name) => String(name || '')
                .toLowerCase()
                .replace(/[^a-z0-9\u10A0-\u10FF]+/g, '')
                .trim();

            const resolveSegmentEndpointStopIds = (segment, route) => {
                if (!route?.id || !api.getStaticRouteDetails) {
                    return { fromStopId: null, toStopId: null };
                }
                const details = api.getStaticRouteDetails(route.id);
                if (!details?._stopsOfPatterns?.length) {
                    return { fromStopId: null, toStopId: null };
                }

                const fullEntries = details._stopsOfPatterns.filter(x => x?.stop?.id);
                let entries = fullEntries;
                if (segment.patternSuffix) {
                    const scoped = fullEntries.filter(entry =>
                        Array.isArray(entry.patternSuffixes) && entry.patternSuffixes.includes(segment.patternSuffix)
                    );
                    if (scoped.length > 0) entries = scoped;
                }

                const seen = new Set();
                const stops = entries
                    .map(entry => entry.stop)
                    .filter(stop => {
                        const id = String(stop.id || '');
                        if (!id || seen.has(id)) return false;
                        seen.add(id);
                        return true;
                    });

                const pickByName = (targetName) => {
                    const targetNorm = normalizeStopNameForMatch(targetName);
                    if (!targetNorm) return null;

                    const exact = stops.find(stop => normalizeStopNameForMatch(stop.name) === targetNorm);
                    if (exact) return String(exact.id);

                    const partial = stops.find(stop => {
                        const nameNorm = normalizeStopNameForMatch(stop.name);
                        return nameNorm.includes(targetNorm) || targetNorm.includes(nameNorm);
                    });
                    return partial ? String(partial.id) : null;
                };

                let fromStopId = pickByName(segment.from);
                let toStopId = pickByName(segment.to);

                const pattern = details.patterns?.find(p => p.patternSuffix === segment.patternSuffix) || details.patterns?.[0];
                if (!fromStopId) fromStopId = pattern?.firstStop?.id ? String(pattern.firstStop.id) : null;
                if (!toStopId) toStopId = pattern?.lastStop?.id ? String(pattern.lastStop.id) : null;

                return { fromStopId, toStopId };
            };

            const formatSegmentArrivalValue = (arrivalData) => {
                if (!arrivalData) return '—';
                if (arrivalData.realtime === true && Number.isFinite(arrivalData.realtimeArrivalMinutes)) {
                    return `${Math.max(0, Math.round(arrivalData.realtimeArrivalMinutes))}'`;
                }
                if (Number.isFinite(arrivalData.scheduledArrivalMinutes)) {
                    return `${arrivals.formatScheduledTime(arrivalData.scheduledArrivalMinutes)}˚`;
                }
                return '—';
            };

            const pickBestArrivalForSegmentStop = (arrivalsAtStop, route, stopId, targetDirectionIndex) => {
                if (!Array.isArray(arrivalsAtStop) || arrivalsAtStop.length === 0) return null;

                const routeNormId = normalizeRouteIdForMatch(route?.id);
                const routeShort = String(route?.shortName || '');
                const candidates = arrivalsAtStop.filter(a => {
                    const aNormId = normalizeRouteIdForMatch(a.id || a.routeId || '');
                    return aNormId === routeNormId || String(a.shortName || '') === routeShort;
                });
                if (candidates.length === 0) return null;

                const scored = candidates.map((a) => {
                    const info = arrivals.resolveDirectionForStop(a, route, stopId);
                    const minutes = (a.realtime === true && Number.isFinite(a.realtimeArrivalMinutes))
                        ? a.realtimeArrivalMinutes
                        : a.scheduledArrivalMinutes;
                    return { arrival: a, directionIndex: info.directionIndex, minutes: Number(minutes) };
                }).filter(x => Number.isFinite(x.minutes));

                if (Number.isInteger(targetDirectionIndex)) {
                    const dirMatched = scored
                        .filter(x => x.directionIndex === targetDirectionIndex)
                        .sort((a, b) => a.minutes - b.minutes);
                    if (dirMatched.length > 0) return dirMatched[0].arrival;
                }

                scored.sort((a, b) => a.minutes - b.minutes);
                return scored.length > 0 ? scored[0].arrival : null;
            };

            const buildSegmentRoutesFromFeatures = (features) => {
                const segmentRoutes = [];
                const seenRoutes = new Set();

                features.forEach(f => {
                    const props = f.properties || {};
                    if (props.routeRoutes) {
                        try {
                            const routes = typeof props.routeRoutes === 'string' ? JSON.parse(props.routeRoutes) : props.routeRoutes;
                            routes.forEach(r => {
                                const routeNumber = r.routeNumber || r.shortName;
                                const key = `${routeNumber}_${r.from || ''}_${r.to || ''}_${r.routeId || ''}_${r.patternSuffix || ''}`;
                                if (!seenRoutes.has(key)) {
                                    seenRoutes.add(key);
                                    segmentRoutes.push({
                                        routeNumber,
                                        routeId: r.routeId || null,
                                        patternSuffix: r.patternSuffix || null,
                                        from: r.from || '',
                                        to: r.to || ''
                                    });
                                }
                            });
                        } catch (err) { }
                    } else if (props.routeNumber) {
                        const key = `${props.routeNumber}_${props.from || ''}_${props.to || ''}_${props.routeId || ''}_${props.patternSuffix || ''}`;
                        if (!seenRoutes.has(key)) {
                            seenRoutes.add(key);
                            segmentRoutes.push({
                                routeNumber: props.routeNumber,
                                routeId: props.routeId || null,
                                patternSuffix: props.patternSuffix || null,
                                from: props.from || '',
                                to: props.to || ''
                            });
                        }
                    }
                });

                return segmentRoutes;
            };

            const getSegmentIdsFromFeatures = (features) => {
                const ids = [];
                features.forEach(f => {
                    if (f && f.id !== undefined && f.id !== null) {
                        ids.push(String(f.id));
                    }
                });
                return Array.from(new Set(ids)).sort();
            };

            const getSegmentFeaturesByIds = (ids) => {
                const wanted = new Set((ids || []).map(id => String(id)));
                if (!window.minibusSegmentsData?.features || wanted.size === 0) return [];
                return window.minibusSegmentsData.features.filter(f => wanted.has(String(f.id)));
            };

            const getSegmentBounds = (features) => {
                if (!Array.isArray(features) || features.length === 0) return null;
                const bounds = new mapboxgl.LngLatBounds();
                let hasPoint = false;
                features.forEach(f => {
                    const geom = f?.geometry;
                    if (!geom || !Array.isArray(geom.coordinates)) return;
                    if (geom.type === 'LineString') {
                        geom.coordinates.forEach(coord => {
                            if (Array.isArray(coord) && coord.length >= 2) {
                                bounds.extend(coord);
                                hasPoint = true;
                            }
                        });
                    } else if (geom.type === 'MultiLineString') {
                        geom.coordinates.forEach(line => {
                            if (!Array.isArray(line)) return;
                            line.forEach(coord => {
                                if (Array.isArray(coord) && coord.length >= 2) {
                                    bounds.extend(coord);
                                    hasPoint = true;
                                }
                            });
                        });
                    }
                });
                return hasPoint ? bounds : null;
            };

            const openSegmentCardForIds = (segmentIds) => {
                const featuresById = getSegmentFeaturesByIds(segmentIds);
                if (!featuresById.length) return false;
                const routes = buildSegmentRoutesFromFeatures(featuresById);
                if (!routes.length) return false;
                showSegmentCard(routes, { updateURL: false, segmentIds, segmentFeatures: featuresById });
                return true;
            };

            // Add popup on click (Radius Search)
            map.on('click', (e) => {
                if (window.minibusSegmentsEditor && window.minibusSegmentsEditor.isActive()) return;
                // Check if we hit a stop first - prioritize stops!
                const validStopLayers = ALL_STOP_LAYERS.filter(id => map.getLayer(id));
                const stopFeatures = map.queryRenderedFeatures(e.point, { layers: validStopLayers });
                if (stopFeatures.length > 0) return;

                // Restrict to Hover: Only open if we are currently hovering a segment
                // This check is now handled by the central hover handler in map-interactions.js
                // which sets window.hoveredMinibusSegmentId
                if (window.hoveredMinibusSegmentId === null) return;

                if (e.originalEvent) e.originalEvent._clickHandled = true;

                console.log('[Map Click] at', e.point);
                // Radius in pixels (approx 25m at zoom 15 is ~10px, zoom 16 ~20px)
                // Let's use 20px for a generous touch area.
                const bbox = [
                    [e.point.x - 20, e.point.y - 20],
                    [e.point.x + 20, e.point.y + 20]
                ];

                const features = map.queryRenderedFeatures(bbox, { layers: ['minibus-segments-layer'] });
                console.log('[Map Click] features found:', features.length);

                if (features.length === 0) return;

                // Stop prop if we found something (optional, but good if other clicks exist)
                // e.originalEvent.stopPropagation(); 

                const segmentRoutes = buildSegmentRoutesFromFeatures(features);
                const segmentIds = getSegmentIdsFromFeatures(features);

                if (segmentRoutes.length === 0) return;

                // Open Segment Card instead of Popup
                console.log('[Map Click] Opening Segment Card with routes:', segmentRoutes);
                showSegmentCard(segmentRoutes, { updateURL: true, segmentIds, segmentFeatures: features });
            });

            function showSegmentCard(routes, options = {}) {
                console.log('[showSegmentCard] Invoked with:', routes.length, 'routes');
                const { updateURL = true, segmentIds = [], segmentFeatures = [] } = options;

                // --- CLEANUP STOP STATE ---
                if (window.busUpdateInterval) { // It seems busUpdateInterval is global
                    clearInterval(window.busUpdateInterval);
                    window.busUpdateInterval = null;
                }
                // Also clear the singleton controller which manages Phase 2 + Refresh
                if (arrivalsController) {
                    arrivalsController.clear();
                }

                stopTracking(); // Stop GPS if active on stop
                clearRoute();
                window.currentStopId = null;

                const panel = document.getElementById('info-panel');
                const nameEl = document.getElementById('stop-name');
                const listEl = document.getElementById('arrivals-list');
                const filterBtn = document.getElementById('filter-routes-toggle');
                const editBtn = document.getElementById('btn-edit-stop');
                let segmentOriginStopId = null;
                const segmentOriginStopIds = new Set();
                const segmentEndStopIds = new Set();

                // 1. Open Sheet
                setSheetState(document.getElementById('route-info'), 'hidden'); // Close route info if open
                setSheetState(panel, 'half');

                // 2. Set Title & Hide Controls
                nameEl.textContent = 'Minibus Segment';
                if (editBtn) editBtn.classList.add('hidden');
                if (updateURL) {
                    Router.updateSegment(segmentIds);
                }

                // Anchor filter origin(s) to the previous stop of each segment route (if resolvable)
                routes.forEach(routeEntry => {
                    const realById = routeEntry.routeId
                        ? allRoutes.find(x => normalizeRouteIdForMatch(x.id) === normalizeRouteIdForMatch(routeEntry.routeId))
                        : null;
                    const realRoute = realById || allRoutes.find(x => String(x.shortName) === String(routeEntry.routeNumber));
                    if (!realRoute) return;
                    const endpoints = resolveSegmentEndpointStopIds(routeEntry, realRoute);
                    const originId = endpoints.fromStopId || null;
                    if (originId) segmentOriginStopIds.add(String(originId));
                    const endId = endpoints.toStopId || null;
                    if (endId) segmentEndStopIds.add(String(endId));
                });
                if (segmentOriginStopIds.size > 0) {
                    segmentOriginStopId = Array.from(segmentOriginStopIds)[0];
                }
                window.currentStopId = null;
                window.currentStopMode = null;
                let segmentAllowedRouteIds = [];
                if (filterManager?.state) {
                    filterManager.state.context = 'segment';
                    filterManager.state.originIdsOverride = segmentEndStopIds.size > 0 ? new Set(segmentEndStopIds) : null;
                    filterManager.state.originIdsFallback = segmentOriginStopIds.size > 0 ? new Set(segmentOriginStopIds) : null;
                    const allowed = new Set();
                    const allowedPatterns = new Map();
                    routes.forEach(routeEntry => {
                        const realById = routeEntry.routeId
                            ? allRoutes.find(x => normalizeRouteIdForMatch(x.id) === normalizeRouteIdForMatch(routeEntry.routeId))
                            : null;
                        const realRoute = realById || allRoutes.find(x => String(x.shortName) === String(routeEntry.routeNumber));
                        if (realRoute?.id) {
                            allowed.add(String(realRoute.id));
                            const routeKey = String(realRoute.id);
                            const suffix = routeEntry.patternSuffix;
                            if (suffix) {
                                if (!allowedPatterns.has(routeKey)) allowedPatterns.set(routeKey, new Set());
                                const suffixes = new Set([suffix]);
                                const details = api.getStaticRouteDetails ? api.getStaticRouteDetails(realRoute.id) : null;
                                if (details && Array.isArray(details.patterns)) {
                                    const hasExact = details.patterns.some(p => p.patternSuffix === suffix);
                                    if (!hasExact) {
                                        const base = suffix.split('_PART')[0];
                                        details.patterns.forEach(p => {
                                            if (!p?.patternSuffix) return;
                                            if (p.patternSuffix === base || p.patternSuffix.startsWith(`${base}_PART`)) {
                                                suffixes.add(p.patternSuffix);
                                            }
                                        });
                                    }
                                }
                                const setForRoute = allowedPatterns.get(routeKey);
                                suffixes.forEach(sfx => setForRoute.add(sfx));
                            }
                        }
                    });
                    segmentAllowedRouteIds = Array.from(allowed);
                    filterManager.state.allowedRouteIds = allowed.size > 0 ? allowed : null;
                    filterManager.state.allowedPatternSuffixes = allowedPatterns.size > 0 ? allowedPatterns : null;
                }
                addToHistory('segment', {
                    id: segmentIds.join('-'),
                    segmentIds: [...segmentIds],
                    segmentFeatures: segmentFeatures.map(f => ({
                        id: f.id,
                        geometry: f.geometry,
                        properties: f.properties
                    })),
                    allowedRouteIds: segmentAllowedRouteIds,
                    filterOriginStopId: segmentEndStopIds.size > 0 ? String(Array.from(segmentEndStopIds)[0]) : null,
                    filterOriginStopIds: Array.from(segmentEndStopIds),
                    filterOriginFallbackStopIds: Array.from(segmentOriginStopIds)
                });
                setSelectedMinibusSegments(segmentIds);
                if (filterBtn) {
                    if (segmentOriginStopId) {
                        filterBtn.classList.remove('hidden');
                        const iconEl = filterBtn.querySelector('.filter-icon');
                        const textEl = filterBtn.querySelector('.filter-text');
                        if (iconEl) iconEl.src = iconFilterOutline;
                        if (textEl) textEl.textContent = t('filterRoutes');
                    } else {
                        filterBtn.classList.add('hidden');
                    }
                }

                const bounds = getSegmentBounds(segmentFeatures);
                if (bounds && !bounds.isEmpty()) {
                    const rawPanelHeight = panel ? panel.offsetHeight : 200;
                    const maxPadding = Math.min(window.innerHeight * 0.4, 300);
                    const panelHeight = Math.min(rawPanelHeight, maxPadding);
                    map.fitBounds(bounds, {
                        padding: {
                            top: 100,
                            bottom: panelHeight + 60,
                            left: 50,
                            right: 50
                        },
                        maxZoom: 16,
                        duration: 900,
                        retainPadding: false,
                        ...getCameraOrientation()
                    });
                }

                const resolveRealRouteFromEntry = (entry) => {
                    const realById = entry.routeId
                        ? allRoutes.find(x => normalizeRouteIdForMatch(x.id) === normalizeRouteIdForMatch(entry.routeId))
                        : null;
                    return realById || allRoutes.find(x => String(x.shortName) === String(entry.routeNumber)) || null;
                };

                const buildRouteObjects = (entries) => entries.map(entry => {
                    const real = resolveRealRouteFromEntry(entry);
                    return real || { shortName: entry.routeNumber };
                });

                const stopArrivalsPromiseCache = new Map();
                const getStopArrivals = async (stopId) => {
                    if (!stopId) return [];
                    const key = String(stopId);
                    if (stopArrivalsPromiseCache.has(key)) return stopArrivalsPromiseCache.get(key);

                    const p = (async () => {
                        try {
                            const liveOrScheduled = await arrivals.fetchArrivals(stopId);
                            if (Array.isArray(liveOrScheduled) && liveOrScheduled.length > 0) return liveOrScheduled;
                        } catch (err) { }
                        try {
                            return await arrivals.fetchArrivalsOptimistic(stopId);
                        } catch (err) {
                            return [];
                        }
                    })();

                    stopArrivalsPromiseCache.set(key, p);
                    return p;
                };

                const renderSegmentArrivalsList = (entries) => {
                    listEl.innerHTML = '';
                    renderAllRoutes(buildRouteObjects(entries), []);

                    if (entries.length === 0) {
                        const empty = document.createElement('div');
                        empty.className = 'empty';
                        empty.textContent = t('noRoutesForSelectedDestination');
                        listEl.appendChild(empty);
                        return;
                    }

                    entries.sort((a, b) => String(a.routeNumber).localeCompare(String(b.routeNumber), undefined, { numeric: true }));

                    entries.forEach(r => {
                    const item = document.createElement('div');
                    item.className = 'arrival-item';
                    item.style.display = 'flex';
                    item.style.opacity = '1';

                    const realRoute = resolveRealRouteFromEntry(r);
                    let color = 'var(--primary)';
                    let headingText = r.to || t('destination');
                    let targetHeadsign = r.to || '';
                    if (realRoute) {
                        color = getRouteDisplayColor(realRoute);
                    }

                    item.innerHTML = `
                         <div class="arrival-card-left">
                             <div class="arrival-card-top">
                                 <div class="route-number" style="color: ${color}">${simplifyNumber(r.routeNumber)}</div>
                                 <div class="destination" title="${headingText}">${headingText}</div>
                             </div>
                             <div class="arrival-card-bottom">
                                 <div class="schedule-times">${t('fromStopTime', r.from || t('previousStop'), '—')}</div>
                                 <div class="schedule-times">${t('toStopTime', r.to || t('nextStop'), '—')}</div>
                             </div>
                         </div>
                         <div class="arrival-card-right">
                             <div class="time-container">
                                 <div class="led-text scheduled-time" style="color:#d9534f">—</div>
                             </div>
                         </div>
                     `;

                    // Click behavior: Show route on map
                    if (realRoute) {
                        item.onclick = () => {
                            showRouteOnMap(realRoute, true, {
                                targetHeadsign
                            });
                        };
                    }

                    listEl.appendChild(item);

                    if (!realRoute) return;

                    (async () => {
                        const endpointStops = resolveSegmentEndpointStopIds(r, realRoute);
                        const anchorStopId = endpointStops.fromStopId || endpointStops.toStopId;
                        let targetDirectionIndex = null;

                        if (anchorStopId) {
                            const isLoopRoute = realRoute?._overrides?.isLoop === true ||
                                realRoute?.isLoop === true ||
                                realRoute?._overrides?.isLoop === 'true';
                            let info = null;

                            if (!isLoopRoute) {
                                const dirs = arrivals.getValidDirectionsForStop(realRoute.id, anchorStopId);
                                const dirIndex = Array.isArray(dirs) && dirs.length ? dirs[0] : null;
                                if (Number.isInteger(dirIndex)) {
                                    targetDirectionIndex = dirIndex;
                                    info = arrivals.resolveDirectionForStop({
                                        id: realRoute.id,
                                        shortName: realRoute.shortName,
                                        directionIndex: dirIndex
                                    }, realRoute, anchorStopId);
                                }
                            }

                            if (!info) {
                                info = arrivals.resolveDirectionForStop({
                                    id: realRoute.id,
                                    shortName: realRoute.shortName,
                                    patternSuffix: r.patternSuffix || undefined
                                }, realRoute, anchorStopId);
                                targetDirectionIndex = info.directionIndex;
                            }

                            if (info?.headsign) {
                                headingText = info.headsign;
                                targetHeadsign = info.headsign;
                            }
                        }

                        const [fromArrivals, toArrivals] = await Promise.all([
                            getStopArrivals(endpointStops.fromStopId),
                            getStopArrivals(endpointStops.toStopId)
                        ]);

                        const fromArrival = pickBestArrivalForSegmentStop(fromArrivals, realRoute, endpointStops.fromStopId, targetDirectionIndex);
                        const toArrival = pickBestArrivalForSegmentStop(toArrivals, realRoute, endpointStops.toStopId, targetDirectionIndex);

                        if (!item.isConnected) return;

                        const fromEl = item.querySelector('.segment-time-from');
                        if (fromEl) fromEl.textContent = formatSegmentArrivalValue(fromArrival);

                        const toEl = item.querySelector('.segment-time-to');
                        if (toEl) toEl.textContent = formatSegmentArrivalValue(toArrival);

                        const destinationEl = item.querySelector('.destination');
                        if (destinationEl) {
                            destinationEl.textContent = headingText;
                            destinationEl.title = headingText;
                        }

                        const primaryTimeEl = item.querySelector('.arrival-card-right .led-text');
                        if (primaryTimeEl) {
                            primaryTimeEl.textContent = formatSegmentArrivalValue(toArrival) || '—';
                        }
                    })();
                });
                };

                const applySegmentFilterToCard = (filteredRouteIds, patternMap) => {
                    if (!Array.isArray(filteredRouteIds)) {
                        renderSegmentArrivalsList(routes);
                        return;
                    }
                    const allowedSet = new Set(filteredRouteIds.map(id => String(id)));
                    const filtered = routes.filter(entry => {
                        const real = resolveRealRouteFromEntry(entry);
                        const id = real?.id ? String(real.id) : null;
                        if (!id || !allowedSet.has(id)) return false;
                        if (patternMap && patternMap instanceof Map) {
                            const allowedPatterns = patternMap.get(id);
                            if (allowedPatterns && allowedPatterns.size > 0) {
                                if (entry.patternSuffix) {
                                    return allowedPatterns.has(entry.patternSuffix);
                                }
                                return true;
                            }
                        }
                        return true;
                    });
                    renderSegmentArrivalsList(filtered);
                };

                window.updateSegmentCardFilteredRoutes = applySegmentFilterToCard;

                // 3. Render segment arrivals with stop-card UI
                renderSegmentArrivalsList(routes);

                // Clear any selected stop Highlight if we were on one
                if (map.getSource('selected-stop')) {
                    map.getSource('selected-stop').setData({ type: 'FeatureCollection', features: [] });
                }
                window.currentStopId = null;
            }

            // Expose for deep links
            window.openSegmentCardForIds = openSegmentCardForIds;

            // Change cursor
            map.on('mouseenter', 'minibus-segments-layer', () => {
                map.getCanvas().style.cursor = 'pointer';
            });
            map.on('mouseleave', 'minibus-segments-layer', () => {
                map.getCanvas().style.cursor = '';
            });
        }
        // console.log(`[Map] Loaded ${data.features.length} minibus segments`);
    } catch (e) {
        console.warn('[Map] Failed to load minibus segments:', e);
    }
}

// Listener for Toggle
window.addEventListener('minibusSegmentsChange', (e) => {
    const visible = e.detail;
    if (map.getLayer('minibus-segments-layer')) {
        map.setLayoutProperty('minibus-segments-layer', 'visibility', visible ? 'visible' : 'none');
    }
    if (window.minibusSegmentsEditor) {
        window.minibusSegmentsEditor.setShowMinibusMode(visible);
    }
});

// ---// Theme Switching Listener
window.addEventListener('themeChanged', (e) => {
    const { theme, lightPreset } = e.detail;
    // console.log(`[Theme] Switching to: ${theme} (Preset: ${lightPreset})`);

    // 1. Update the map's light preset
    setMapLightPreset(lightPreset);
    refreshMapFocusDimTheme();
    refreshLiveBusTheme();

    // 2. Update custom label colors (Metro, etc.) after a brief delay
    setTimeout(() => {
        updateMapTheme();

        // 3. Re-apply filter state if active (updateMapTheme resets layer styles)
        if (filterManager && (filterManager.state.active || filterManager.state.picking)) {
            filterManager.updateMapFilterState();
        }
    }, 50);

    // 4. Refresh UI elements if panels are open
    setTimeout(() => {
        const stopPanelVisible = !document.getElementById('info-panel').classList.contains('hidden');
        const routePanelVisible = !document.getElementById('route-info').classList.contains('hidden');

        if (window.currentStopId && window.lastArrivals && stopPanelVisible) {
            arrivals.renderArrivals(window.lastArrivals, window.currentStopId);
        }
        if (window.currentRoute && routePanelVisible) {
            updateRouteView(window.currentRoute, { suppressPanel: true });
        }
        if (isDirectionsContextActive()) {
            redrawActiveDirections();
        }
    }, 100);
});

function restoreMapLayers() {
    // 1. Restore Images
    // Ensure we await this or handle it synchronously if possible, but loadImages is async
    // Since we are inside an event handler, we can just fire it.
    loadImages(map).then(() => {
        // Redraw layers if needed, but addStopsToMap usually handles source/layer adding.
        // If layers are added before images, they might be blank until images load.
        // Mapbox handles this gracefully usually.
    });

    // 2. Restore Stops & Routes Layers
    if (window.allStops) {
        addStopsToMap(window.allStops, { redirectMap, filterManager, updateConnectionLine });
    }

    // 2.5 Ensure Selected Stop Source & Layer Exist (Critical for Style Reload)
    // Redundant check removed as addStopsToMap handles source creation.

    // 3. Restore Active Route (Only if actually active/open)
    if (currentRoute) {
        // console.log('[Restore] Re-plotting active route:', currentRoute.shortName);
        // Suppress panel if we have an active stop (Nested view) 
        // OR if we just want to restore the map lines without altering UI state too much
        const hasActiveStop = !!window.currentStopId;
        showRouteOnMap(currentRoute, false, { preserveBounds: true, suppressPanel: hasActiveStop });
    }

    // 4. Restore Active Stop Selection & Focus
    if (window.currentStopId) {
        // console.log('[Restore] Restoring active stop selection:', window.currentStopId);

        // Restore Destination Markers if active filter
        if (filterManager.state.active && filterManager.state.targetIds.size > 0) {
            filterManager.refreshRouteFilter(window.currentStopId);
        }

        // Restore Selection Highlight
        const stop = allStops.find(s => s.id === window.currentStopId);
        if (stop && map.getSource('selected-stop')) {
            map.getSource('selected-stop').setData({
                type: 'FeatureCollection',
                features: [{
                    type: 'Feature',
                    geometry: { type: 'Point', coordinates: [stop.lon, stop.lat] },
                    properties: { ...stop, mode: stop.vehicleMode || 'BUS' }
                }]
            });
        }

        // Restore Dimming/Focus
        // Wait for layers to settle? No, we just added them.
        setMapFocus(true);
    }
}

// Modify fetchWithCache to use db
// API Functions Moved to api.js






const GREEN_LINE_STOPS = [
    'State University', 'Vazha-Pshavela', 'Vazha Pshavela', 'Delisi', 'Medical University', 'Technical University', 'Tsereteli', 'Station Square 2'
];

// Handle Initial URL State (Deep Links)
function fitFilterBounds(originStop, targetIds) {
    if (!originStop || !targetIds || targetIds.size === 0 && !Array.isArray(targetIds)) return;

    const bounds = new mapboxgl.LngLatBounds();
    if (originStop.lon && originStop.lat) {
        bounds.extend([parseFloat(originStop.lon), parseFloat(originStop.lat)]);
    }

    let targetCount = 0;
    const targets = targetIds instanceof Set ? Array.from(targetIds) : targetIds;
    targets.forEach(targetId => {
        const targetStop = allStops.find(s => s.id === targetId);
        if (targetStop && targetStop.lon && targetStop.lat) {
            bounds.extend([parseFloat(targetStop.lon), parseFloat(targetStop.lat)]);
            targetCount++;
        }
    });

    if (bounds.isEmpty() || targetCount === 0) return;

    // Store the bounds to fit - only the last one will be used
    window._pendingFilterBounds = bounds;
    window._pendingFilterBoundsCameraRequestId = beginMapCameraIntent();

    // Schedule fitBounds to run when map is idle (only once)
    if (!window._pendingFilterBoundsScheduled) {
        window._pendingFilterBoundsScheduled = true;

        const fitWhenReady = () => {
            const cameraRequestId = window._pendingFilterBoundsCameraRequestId;
            if (isCurrentMapCameraIntent(cameraRequestId) && window._pendingFilterBounds) {
                const b = window._pendingFilterBounds;

                // Get panel height for bottom padding, but cap it to avoid overflow
                const panel = document.getElementById('info-panel');
                const rawPanelHeight = panel ? panel.offsetHeight : 200;
                const maxPadding = Math.min(window.innerHeight * 0.4, 300);
                const panelHeight = Math.min(rawPanelHeight, maxPadding);

                const camera = map.cameraForBounds(b, {
                    padding: {
                        top: 100,
                        bottom: panelHeight + 60,
                        left: 50,
                        right: 50
                    },
                    maxZoom: 16,
                    ...getCameraOrientation()
                });
                if (camera) {
                    map.flyTo({
                        ...camera,
                        ...getCameraOrientation(),
                        duration: 1200
                    });
                }

                cancelPendingFilterBounds();
            }
        };

        map.once('idle', fitWhenReady);
        setTimeout(() => {
            const cameraRequestId = window._pendingFilterBoundsCameraRequestId;
            if (isCurrentMapCameraIntent(cameraRequestId) && window._pendingFilterBounds) {
                fitWhenReady();
            }
        }, 2000);
    }
}

function handleDeepLinks() {
    if (deepLinkHandlingPromise) return deepLinkHandlingPromise;
    const promise = handleDeepLinksInternal().finally(() => {
        if (deepLinkHandlingPromise === promise) deepLinkHandlingPromise = null;
    });
    deepLinkHandlingPromise = promise;
    return promise;
}

async function handleDeepLinksInternal() {
    const state = Router.parse();
    if (state.type === 'special') {
        return openSheetForCurrentPath();
    }
    if (state.type === 'directions') {
        applyDirectionsUrlState(state, { syncUrl: false, openSheet: true });
        return true;
    }
    if (state.type === 'segment' && Array.isArray(state.segmentIds) && state.segmentIds.length > 0) {
        const tryOpen = () => {
            if (typeof window.openSegmentCardForIds === 'function') {
                const success = window.openSegmentCardForIds(state.segmentIds);
                if (success) return true;
            }
            return false;
        };
        if (tryOpen()) return true;
        setTimeout(() => {
            tryOpen();
        }, 200);
        return true;
    }
    if (state.stopId) {
        const rawStopId = state.stopId;
        // Router might force '1:' prefix for nested routes, but internal IDs might be '3955'
        const cleanId = String(rawStopId).replace(/^1:/, '');
        const prefixedStopId = rawStopId.includes(':') ? rawStopId : `1:${cleanId}`;

        // Check Redirects for both forms
        const normStopId =
            redirectMap.get(rawStopId) ||
            redirectMap.get(cleanId) ||
            redirectMap.get(prefixedStopId) ||
            rawStopId;

        // Try stripped and prefixed candidates so manual/virtual stops like
        // GONDOLA_MANUAL_4 still resolve from public URLs such as /stopGONDOLA_MANUAL_4.
        const stop = allStops.find(s =>
            String(s.id) === String(normStopId) ||
            String(s.id) === String(prefixedStopId) ||
            String(s.id) === String(cleanId) ||
            String(s.id) === String(rawStopId)
        );

        // console.log(`[DeepLink] Processing Stop: ${rawStopId} -> ${normStopId}. Found=${!!stop}`);
        if (stop) {
            // If an existing filter is active on a different origin, clear it before applying deep link state
            if (filterManager && filterManager.state.active && String(filterManager.state.originId) !== String(normStopId)) {
                filterManager.clearFilter(filterManager.state.originId, { restoreStop: false });
            }
            const routeChipFilterIds = resolveRouteFilterIdsForStop(state.routeFilterShortNames || [], stop.id);

            // Check for Filtered State
            if (state.filterActive && state.targetIds && state.targetIds.length > 0) {
                // console.log('[DeepLink] Applying Filter:', state.targetIds);

                // 2. Show Stop (Suppress URL update, NO FlyTo to avoid conflict with Filter flyTo)
                await showStopInfo(stop, false, false, false);
                arrivals.setStopRouteFilterIds(routeChipFilterIds, stop.id);

                // 3. Apply Filter Logic
                // We need to trigger the filter mode fully
                // Use forceEnable to prevent toggle-off if called twice (e.g., Fast Load then Fresh Load)
                // Use skipFlyTo because we'll use fitBounds after targets are set to show the full filtered area
                await filterManager.toggleFilterMode(normStopId, null, null, { forceEnable: true, skipFlyTo: true });

                // Then apply specific targets if any
                if (state.targetIds && state.targetIds.length > 0) {
                    state.targetIds.forEach(tid => {
                        // Normalize Target ID (e.g. '930' -> '1:930')
                        const normTid = redirectMap.get(tid) || tid;
                        // Add all equivalent stops (matching applyFilter behavior)
                        // This ensures merged stops, hub stops, and redirects are all included
                        const equivalentStops = getEquivalentStops(normTid);
                        console.log(`[DeepLink] Target ${tid} -> normalized: ${normTid}, equivalents: [${equivalentStops.join(', ')}]`);
                        equivalentStops.forEach(eqId => filterManager.state.targetIds.add(eqId));
                    });
                    console.log(`[DeepLink] Final targetIds: [${Array.from(filterManager.state.targetIds).join(', ')}]`);
                    // Ensure static route details are available before applying filter
                    await api.preloadStaticRoutesDetails();
                    // Trigger refresh to apply
                    await filterManager.refreshRouteFilter(normStopId);
                    // Ensure colors/filtered routes settle after async data/arrivals load
                    setTimeout(() => {
                        if (filterManager.state.active && filterManager.state.originId) {
                            filterManager.refreshRouteFilter(filterManager.state.originId, window.lastArrivals, window.lastRoutes);
                        }
                    }, 400);
                }

                // 4. Update UI Button State
                const filterBtn = document.getElementById('filter-routes-toggle');
                if (filterBtn) filterBtn.classList.add('active');

                // 5. Fit map to show origin and all destination stops
                fitFilterBounds(stop, filterManager.state.targetIds);
            } else if (routeChipFilterIds.length > 0) {
                await showStopInfo(stop, true, !state.shortName, false, { suppressPanel: !!state.shortName });
                arrivals.setStopRouteFilterIds(routeChipFilterIds, stop.id);
                if (window.lastArrivals) {
                    arrivals.renderArrivals(window.lastArrivals, stop.id);
                }
            } else {
                // Standard Stop View (or nested route - suppress panel if route follows)
                // addToStack=true: Ensure Stop is in internal history so "Back" works
                // updateURL=false: Deep link URL is already set, don't overwrite yet
                // suppressPanel: If we have a nested route, don't show stop panel - only set up state
                await showStopInfo(stop, true, !state.shortName, false, { suppressPanel: !!state.shortName });
            }

            if (state.board && !state.shortName) {
                await streetScreenController?.open({ syncUrl: false });
            }

            // Handle Nested Route (Bus) found in URL
            if (state.shortName) {
                // Fetch V3 routes and ensure we wait for it
                // We use 'await' here to ensure the Route UI triggers after Stop UI is ready
                // but since api.fetchV3Routes is async, we can just chain it.
                // Note: showRouteOnMap is async too.
                try {
                    await api.fetchV3Routes();
                    const route = resolveRouteByShortName(state.shortName, {
                        preferredSource: stop._source,
                        preferredStopId: stop.id,
                        preferBus: true
                    });
                    if (route) {
                        // Fix for Zoom Out issue:
                        // showStopInfo uses flyTo, so map.getZoom() immediately after is unstable (still zooming).
                        // We must explicitly tell showRouteOnMap what the "previous" (Stop) zoom was intended to be (16 or higher).
                        const intendedStopZoom = map.getZoom() > 16 ? map.getZoom() : 16;

                        // Show Route
                        // addToStack=true: Add Route to history (Stop -> Route)
                        // fromStopId: Helps with direction matching
                        // centerOnStop: Fly to stop location since we're coming from a deep link
                        await showRouteOnMap(route, true, {
                            initialDirectionIndex: state.direction,
                            fromStopId: stop.id,
                            startZoom: intendedStopZoom,
                            routeSource: 'deepLink',
                            centerOnStop: { lat: stop.lat, lon: stop.lon }, // Fly to stop on deep link
                            preserveBounds: true
                        });
                    } else {
                        console.warn(`[DeepLink] Route ${state.shortName} not found in allRoutes.`);
                    }
                } catch (e) {
                    console.error('[DeepLink] Failed to load nested route:', e);
                }
            }
            return true; // Successfully handled
        } else {
            console.warn(`[DeepLink] Stop ${state.stopId} not found in data.`);
            return false; // Failed to find stop (retry later?)
        }
    }
    // Note: Route deep links are handled by onRoutesLoaded logic
    return true; // Nothing to handle
}

// Expose for native Universal Links handling
window.handleDeepLinks = handleDeepLinks;


// Listen for Theme Changes
window.addEventListener('manualThemeChange', () => {
    if (map && map.getStyle()) {
        updateMapTheme();
        // Re-apply filter state if active (updateMapTheme resets layer styles)
        if (filterManager && (filterManager.state.active || filterManager.state.picking)) {
            filterManager.updateMapFilterState();
        }
    }
});






// Handle touch/drag logic for panels
setupPanelDrag('info-panel');
setupPanelDrag('route-info');
setupPanelDrag('directions-panel');
initDirectionsUI();


// Zoom Logic for Reset Button
const resetBtn = document.getElementById('reset-view');
const HOME_REGION_BBOX = Object.freeze({
    west: 44.5,
    south: 41.5,
    east: 45.1,
    north: 42.0
});
const HOME_CENTER = Object.freeze({
    lng: 44.78,
    lat: 41.72
});
const RETURN_ANIMATION_MAX_DISTANCE_METERS = 30000;

function isWithinHomeRegion(lng, lat) {
    return lng >= HOME_REGION_BBOX.west &&
        lng <= HOME_REGION_BBOX.east &&
        lat >= HOME_REGION_BBOX.south &&
        lat <= HOME_REGION_BBOX.north;
}

function distanceMetersBetweenPoints(a, b) {
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

resetBtn.addEventListener('click', () => {
    stopTracking();
    const center = map.getCenter();
    const current = { lng: center.lng, lat: center.lat };
    const distanceToHome = distanceMetersBetweenPoints(current, HOME_CENTER);

    if (distanceToHome <= RETURN_ANIMATION_MAX_DISTANCE_METERS) {
        map.flyTo({ center: [HOME_CENTER.lng, HOME_CENTER.lat], zoom: 12 });
    } else {
        map.jumpTo({ center: [HOME_CENTER.lng, HOME_CENTER.lat], zoom: 12 });
    }
});

map.on('moveend', () => {
    const zoom = map.getZoom();
    const center = map.getCenter();
    const outsideHomeRegion = !isWithinHomeRegion(center.lng, center.lat);
    if (zoom < 10 || outsideHomeRegion) {
        resetBtn.classList.remove('hidden');
    } else {
        resetBtn.classList.add('hidden');
    }
});


function areStopIdsEquivalent(idA, idB) {
    const a = String(idA || '').trim();
    const b = String(idB || '').trim();
    if (!a || !b) return false;
    if (a === b) return true;
    const cleanA = a.includes(':') ? a.split(':').pop() : a;
    const cleanB = b.includes(':') ? b.split(':').pop() : b;
    if (cleanA === cleanB) return true;
    const canonicalA = getCanonicalMergedStopId(a);
    const canonicalB = getCanonicalMergedStopId(b);
    if (canonicalA === canonicalB) return true;
    const equivA = typeof getEquivalentStops === 'function' ? getEquivalentStops(a, false) : [];
    const equivCleanA = equivA.map(id => String(id).includes(':') ? String(id).split(':').pop() : String(id));
    if (equivCleanA.includes(cleanB) || equivCleanA.includes(b)) return true;
    const equivB = typeof getEquivalentStops === 'function' ? getEquivalentStops(b, false) : [];
    const equivCleanB = equivB.map(id => String(id).includes(':') ? String(id).split(':').pop() : String(id));
    if (equivCleanB.includes(cleanA) || equivCleanB.includes(a)) return true;
    return false;
}

async function showStopInfo(stop, addToStack = true, flyToStop = false, updateURL = true, options = {}) {
    const didApplyOtaRefresh = await consumePendingOtaTransitDataRefresh('open-stop-card');
    if (didApplyOtaRefresh && stop?.id) {
        stop = findStopById(stop.id) || stop;
    }

    closeAllMoreMenus();
    invalidateScheduledMapCamera();
    invalidateMapCameraIntent();
    const { suppressPanel = false, forceRoutesRefresh = false, fromFavorites = false } = options;

    if (window._searchPlaceMarker) {
        window._searchPlaceMarker.remove();
        window._searchPlaceMarker = null;
    }

    // Stop location tracking if we are selecting something specific
    stopTracking();
    if (filterManager?.state) {
        filterManager.state.allowedRouteIds = null;
        filterManager.state.originIdsOverride = null;
        filterManager.state.context = 'stop';
        filterManager.state.allowedPatternSuffixes = null;
    }
    clearSelectedMinibusSegments();
    if (!stop) return;

    const canonicalStopId = stop.id ? getCanonicalMergedStopId(stop.id) : null;
    const canonicalStop = canonicalStopId
        ? allStops.find((entry) => String(entry.id) === String(canonicalStopId)) || stop
        : stop;
    if (canonicalStop && canonicalStop.id) {
        stop = canonicalStop;
    }

    const prevStopId = window.currentStopId;
    if (stop.id) {
        window.currentStopId = String(stop.id);
        window.currentStopMode = stop.vehicleMode;
    }
    syncFavoriteButtonState();
    if (fromFavorites) {
        setFavoritesBackContext(true);
    }

    // Enable Focus Mode (Dim others) unless filter view is active/picking
    if (!(filterManager && (filterManager.state.active || filterManager.state.picking))) {
        setMapFocus(true);
    }

    if (addToStack) {
        const historyStop = filterManager?.state?.active && String(filterManager.state.originId) === String(stop.id) ? {
            ...stop,
            _filterState: {
                active: true,
                originId: filterManager.state.originId,
                targetIds: Array.from(filterManager.state.targetIds || [])
            },
            _routeChipFilterIds: Array.from(arrivals.getSelectedStopRouteFilterIds(stop.id))
        } : {
            ...stop,
            _routeChipFilterIds: Array.from(arrivals.getSelectedStopRouteFilterIds(stop.id))
        };
        addToHistory('stop', historyStop);
    }

    // Sync URL (Router)
    if (updateURL) {
        Router.updateStop(
            canonicalStopId,
            filterManager.state.active,
            Array.from(filterManager.state.targetIds),
            '',
            getSelectedRouteFilterShortNamesForStop(canonicalStopId)
        );
    }

    // Explicitly clean up any route layers when showing a stop
    resetLiveBusSession();
    currentRoute = null;
    window.currentRoute = null;

    // Robust Layer Cleanup
    const style = map.getStyle();
    if (style && style.layers) {
        const layersToRemove = style.layers
            .filter(layer => layer.id.startsWith('route') || layer.id.startsWith('live-buses'))
            .map(layer => layer.id);

        layersToRemove.forEach(id => {
            if (map.getLayer(id)) map.removeLayer(id);
        });
    }
    // Set sources to empty collections instead of removing them, to avoid "source missing" errors
    ['route', 'route-stops', 'live-buses'].forEach(id => {
        if (map.getSource(id)) map.getSource(id).setData({ type: 'FeatureCollection', features: [] });
    });

    let flyTarget = null;

    if (stop.id) {
        if (window.selectDevStop) window.selectDevStop(stop.id);

        const isMetro = stop.vehicleMode === 'SUBWAY';

        console.log('[showStopInfo] flyToStop:', flyToStop, 'stop.lon:', stop.lon, 'stop.lat:', stop.lat);
        if (flyToStop && stop.lon && stop.lat) {
            const currentZoom = map.getZoom();
            // Zoom in closer for metro (to see segment labels)
            let targetZoom = stop.savedZoom || (currentZoom > 16 ? currentZoom : 16);
            if (isMetro) targetZoom = Math.max(targetZoom, 17.5);

            // If it's a metro station, try to center on the platform segment if we have that info
            let targetLon = stop.lon;
            let targetLat = stop.lat;
            if (isMetro && stop.segmentCenterLon && stop.segmentCenterLat) {
                targetLon = stop.segmentCenterLon;
                targetLat = stop.segmentCenterLat;
            }

            flyTarget = {
                center: [targetLon, targetLat],
                zoom: targetZoom
            };
        }

        if (stop.lon && stop.lat) {
            const feature = {
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [stop.lon, stop.lat] },
                properties: stop
            };

            // Ensure source and layer exist (may not exist yet during early deep link processing)
            if (!map.getSource('selected-stop')) {
                map.addSource('selected-stop', {
                    type: 'geojson',
                    data: { type: 'FeatureCollection', features: [] }
                });
            }
            if (!map.getLayer('stops-highlight')) {
                const themeSuffix = document.body.classList.contains('dark-mode') ? 'dark' : 'light';
                map.addLayer({
                    id: 'stops-highlight',
                    type: 'symbol',
                    source: 'selected-stop',
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
                            ['case',
                                ['>', ['coalesce', ['get', 'rotation'], 0], 0], `stop-selected-icon-gondola-manual-${themeSuffix}`,
                                `stop-icon-gondola-manual-${themeSuffix}`
                            ],
                            ['==', ['get', 'mode'], 'GONDOLA'],
                            ['case',
                                ['>', ['coalesce', ['get', 'rotation'], 0], 0], `stop-selected-icon-gondola-${themeSuffix}`,
                                `stop-icon-gondola-${themeSuffix}`
                            ],
                            ['case',
                                ['>', ['coalesce', ['get', 'rotation'], 0], 0], `stop-selected-icon-${themeSuffix}`,
                                `stop-icon-${themeSuffix}`
                            ]
                        ],
                        'icon-size': [
                            'case',
                            ['==', ['get', 'mode'], 'SUBWAY'], 1.5,
                            1.2
                        ],
                        'icon-allow-overlap': true,
                        'icon-ignore-placement': true,
                        'icon-rotate': ['coalesce', ['get', 'rotation'], 0],
                        'icon-rotation-alignment': 'map'
                    },
                    paint: {
                        'icon-opacity': 1
                    }
                });
            }

            // For Metro stations, we hide the main highlight marker as requested
            const highlightOpacity = isMetro ? 0 : 1;
            map.setPaintProperty('stops-highlight', 'icon-opacity', highlightOpacity);
            if (map.getLayer('stops-highlight-glow')) {
                map.setPaintProperty('stops-highlight-glow', 'circle-opacity', isMetro ? 0 : 0.1);
            }

            map.getSource('selected-stop').setData({
                type: 'FeatureCollection',
                features: [feature]
            });
            if (map.getLayer('stops-highlight')) map.moveLayer('stops-highlight');
        } else {
            const refreshedStop = allStops.find(s => s.id === stop.id);
            if (refreshedStop && refreshedStop.lat) {
                stop.lat = refreshedStop.lat;
                stop.lon = refreshedStop.lon;
                stop.name = refreshedStop.name;
                return showStopInfo(stop, addToStack, flyToStop, updateURL);
            }
        }
    }

    // If suppressPanel is true, we skip all UI rendering - just set up state and highlight
    if (suppressPanel) {
        return;
    }

    const panel = document.getElementById('info-panel');
    
    // Restore Stop UI elements and hide Place details
    const placeDetails = document.getElementById('place-details');
    if (placeDetails) placeDetails.classList.add('hidden');

    const arrivalsList = document.getElementById('arrivals-list');
    const filterBtn = document.getElementById('filter-routes-toggle');
    const stopMoreBtn = document.getElementById('stop-more-btn');
    const headerExtension = document.getElementById('header-extension');

    if (arrivalsList) arrivalsList.classList.remove('hidden');
    if (filterBtn) filterBtn.classList.remove('hidden');
    if (stopMoreBtn) stopMoreBtn.classList.remove('hidden');
    if (headerExtension) headerExtension.classList.remove('hidden');

    const nameEl = document.getElementById('stop-name');
    const listEl = document.getElementById('arrivals-list');
    const isDifferentStop = String(prevStopId) !== String(stop.id);

    if (isDifferentStop && listEl) {
        listEl.innerHTML = '';
        listEl.scrollTop = 0;
        window._lastRenderedStopId = null;
    }

    setSheetState(document.getElementById('route-info'), 'hidden');
    nameEl.textContent = stop.name || 'Unknown Stop';

    panel.classList.remove('metro-mode');

    // arrivals.renderArrivals handles clearing/diffing smoothly
    // Just ensure the loading indicator is visible if we have no data yet
    if (!window.lastArrivals || window.lastArrivals.length === 0) {
        // We'll call renderArrivals([]) below which will ensure indicator
    }

    const existingHeader = panel.querySelector('.metro-header');
    if (existingHeader) existingHeader.remove();

    if (headerExtension) headerExtension.innerHTML = '';

    const isMetro = stop.mode === 'SUBWAY' || (stop.id && (stop.id.startsWith('1:metro') || stop.id.includes('metro') || stop.id.includes('Metro')));
    const isGondola = String(stop.mode || stop.vehicleMode || '').toUpperCase() === 'GONDOLA';
    const gondolaInfo = String(stop.gondolaInfo || '').trim();
    if (isGondola && headerExtension && gondolaInfo) {
        headerExtension.innerHTML = `
            <div class="gondola-info-card">
                <div class="gondola-info-content">${formatGondolaInfoHtml(gondolaInfo)}</div>
            </div>
        `;
    }

    const editBtn = document.getElementById('btn-edit-stop');
    const stopDirsContainer = document.getElementById('stop-directions-container');

    if (isMetro) {
        if (stopDirsContainer) stopDirsContainer.classList.add('hidden');
        if (editBtn) editBtn.classList.add('hidden');
        if (filterBtn) filterBtn.classList.add('hidden');

        // Metro has its own card renderer and returns early below. Run the
        // shared stop-centering action here so metro marker taps behave like
        // bus-stop taps as well.
        if (flyTarget) {
            requestAnimationFrame(() => {
                flyToPointInView(flyTarget.center, {
                    zoom: flyTarget.zoom,
                    bottomAnchorSelector: '#info-panel',
                    duration: 900,
                    radiusMeters: 12
                });
            });
        }

        handleMetroStop(stop, panel, nameEl, listEl, {
            allRoutes,
            stopToRoutesMap,
            setSheetState,
            updateBackButtons,
            showRouteOnMap
        });
        applyFavoritesBackButtonsIfNeeded();
        return;
    } else {
        if (stopDirsContainer) stopDirsContainer.classList.remove('hidden');
        const hasWriteAccess = (location.hostname === 'localhost' || location.hostname.startsWith('192.168.')) && import.meta.env.DEV;
        if (editBtn) {
            editBtn.classList.toggle('hidden', !hasWriteAccess);
        }
        if (filterBtn) {
            filterBtn.classList.remove('hidden');
            const textEl = filterBtn.querySelector('.filter-text');
            if (textEl) textEl.textContent = t('filterByDestination');
        }

        const stopDirFromBtn = document.getElementById('stop-dir-from');
        const stopDirToBtn = document.getElementById('stop-dir-to');
        if (stopDirFromBtn && stopDirToBtn) {
            const newFromBtn = stopDirFromBtn.cloneNode(true);
            const newToBtn = stopDirToBtn.cloneNode(true);
            stopDirFromBtn.parentNode.replaceChild(newFromBtn, stopDirFromBtn);
            stopDirToBtn.parentNode.replaceChild(newToBtn, stopDirToBtn);

            newFromBtn.addEventListener('click', () => {
                setPoint('from', {
                    lat: stop.lat,
                    lng: stop.lon,
                    label: stop.name
                });
                setSheetState(panel, 'hidden');
            });

            newToBtn.addEventListener('click', () => {
                setPoint('to', {
                    lat: stop.lat,
                    lng: stop.lon,
                    label: stop.name
                });
                setSheetState(panel, 'hidden');
            });
        }
    }

    setSheetState(panel, 'half');
    updateBackButtons();
    applyFavoritesBackButtonsIfNeeded();

    if (flyTarget) {
        requestAnimationFrame(() => {
            if (!flyTarget) return;
            console.log('[showStopInfo] Executing flyTo to:', flyTarget.center[0], flyTarget.center[1]);
            flyToPointInView(flyTarget.center, {
                zoom: flyTarget.zoom,
                bottomAnchorSelector: '#info-panel',
                duration: 900,
                radiusMeters: 12
            });
        });
    }

    // Gondola stops: show arrivals only when the API returns real data for this exact stop.
    // Skip static/equivalent stop fallbacks to avoid unrelated route leakage.
    if (isGondola) {
        arrivalsController.clear();

        const equivalentIds = getEquivalentStops(stop.id, false);
        equivalentIds.forEach(id => {
            stopToRoutesMap.set(id, []);
        });
        window.lastRoutes = [];
        window.lastArrivals = [];

        arrivals.updateArrivalsLoadingState(false);
        arrivals.renderArrivals([], stop.id);
        return;
    }

    // --- UNIFIED ARRIVALS LOADING ---
    // Route chips (static, instant)
    if (isDifferentStop) {
        arrivals.resetStopRouteFilter(stop.id);
        window.lastRoutes = [];
        window.lastArrivals = [];

        // Pre-select route filter if clicking a boarding or transfer stop in directions mode
        if (isDirectionsContextActive() && stop.id) {
            console.log(`[DirectionsFilter] Directions active. Clicked stop ID: ${stop.id}`);
            const transferPoints = typeof window.getActiveDirectionsTransferPoints === 'function'
                ? window.getActiveDirectionsTransferPoints()
                : [];
            console.log(`[DirectionsFilter] Active directions transferPoints:`, JSON.stringify(transferPoints));
            const clickedStopCanonical = getCanonicalMergedStopId(stop.id);
            console.log(`[DirectionsFilter] Clicked stop canonical ID: ${clickedStopCanonical}`);
            const matchedPt = transferPoints.find(p => p.stopId && areStopIdsEquivalent(p.stopId, stop.id));
            console.log(`[DirectionsFilter] matchedPt:`, matchedPt);
            
            if (matchedPt) {
                let routeShortNames = [];
                
                // Attempt to read route short names from the rendered directions results list in DOM
                const resultsContainer = document.getElementById('directions-results');
                if (resultsContainer) {
                    const selectedOption = resultsContainer.querySelector('.directions-route-option.selected');
                    if (selectedOption) {
                        const legElements = Array.from(selectedOption.querySelectorAll('.directions-leg-item'));
                        const matchedLeg = legElements.find(el => {
                            const legStopId = el.getAttribute('data-stop-id');
                            return legStopId && areStopIdsEquivalent(legStopId, stop.id);
                        });
                        if (matchedLeg) {
                            const routeSpans = matchedLeg.querySelectorAll('.directions-leg-route-num');
                            routeShortNames = Array.from(routeSpans).map(span => {
                                return span.dataset.routeShortName || (span.firstChild ? span.firstChild.textContent.trim() : span.textContent.trim()).split(' ')[0];
                            }).filter(Boolean);
                            console.log(`[DirectionsFilter] Retrieved route short names from DOM:`, routeShortNames);
                        }
                    }
                }
                
                // Fallback to the primary route if DOM lookup yielded nothing
                if (routeShortNames.length === 0 && matchedPt.filterRouteShortName) {
                    routeShortNames = [matchedPt.filterRouteShortName];
                    console.log(`[DirectionsFilter] Fallback to primary route short name:`, routeShortNames);
                }
                
                if (routeShortNames.length > 0) {
                    const resolvedRouteIds = [];
                    routeShortNames.forEach(shortName => {
                        const resolvedRoute = resolveRouteByShortName(shortName, {
                            preferredStopId: stop.id,
                            preferBus: matchedPt.filterRouteMode !== 'SUBWAY'
                        });
                        console.log(`[DirectionsFilter] Resolved route for ${shortName}:`, resolvedRoute);
                        if (resolvedRoute && resolvedRoute.id) {
                            resolvedRouteIds.push(String(resolvedRoute.id));
                        }
                    });
                    if (resolvedRouteIds.length > 0) {
                        console.log(`[DirectionsFilter] Auto-applying filters for route IDs:`, resolvedRouteIds, `(Stop: ${stop.id})`);
                        arrivals.setStopRouteFilterIds(resolvedRouteIds, stop.id);
                    } else {
                        console.log(`[DirectionsFilter] Could not resolve any route IDs for shortNames:`, routeShortNames);
                    }
                }
            } else {
                console.log(`[DirectionsFilter] Clicked stop is not a boarding or transfer stop.`);
            }
        }
    }
    if (isDifferentStop || forceRoutesRefresh) {
        const equivalentIds = getEquivalentStops(stop.id, false);
        const staticIdsSet = new Set();
        equivalentIds.forEach(id => {
            if (!stopToRoutesMap.has(id)) stopToRoutesMap.set(id, []);
            const currentList = stopToRoutesMap.get(id);
            const rids = api.getRoutesForStopStatic(id);
            rids.forEach(rid => {
                staticIdsSet.add(rid);
                if (!currentList.some(r => r.id === rid)) {
                    const r = allRoutes.find(route => route.id === rid);
                    if (r) currentList.push(r);
                }
            });
        });
        const staticIds = Array.from(staticIdsSet);
        const optRoutes = staticIds
            .map(rid => allRoutes.find(route => route.id === rid))
            .filter(Boolean);
        window.lastRoutes = optRoutes;
    }

    if (isDifferentStop) {
        arrivals.renderArrivals([], stop.id);
    }

    // Arrivals loading via controller (handles scheduled → live with loading bar)
    arrivalsController.selectStop(stop.id);

    // Live route fetch in parallel (updates stopToRoutesMap for chips/scheduled items)
    // This is fire-and-forget - arrivals controller handles the main data flow
    if (isDifferentStop) {
        const equivalentIds = getEquivalentStops(stop.id, false);
        Promise.all(equivalentIds.map(id => {
            if (hydratedStops.has(id)) {
                return Promise.resolve(stopToRoutesMap.get(id) || []);
            }
            const isRustaviStop = /^r\d/.test(id);
            const sourceToUse = isRustaviStop ? 'rustavi' : stop._source;

            return api.fetchStopRoutes(id, sourceToUse).then(fetchedRoutes => {
                const currentList = [];
                if (fetchedRoutes && Array.isArray(fetchedRoutes)) {
                    fetchedRoutes.forEach(fr => {
                        const fetchedSource = fr._source || sourceToUse || (fr.id && String(fr.id).startsWith('r') ? 'rustavi' : 'tbilisi');
                        let canonical = allRoutes.find(r => String(r.shortName) === String(fr.shortName) && r._source === fetchedSource);
                        if (!canonical && fr.id) canonical = allRoutes.find(r => r.id === fr.id);
                        if (!canonical) {
                            canonical = resolveRouteByShortName(fr.shortName, {
                                preferredSource: fetchedSource,
                                preferredId: fr.id,
                                preferredStopId: id,
                                preferBus: true
                            });
                        }
                        const routeToAdd = canonical || fr;
                        if (!currentList.includes(routeToAdd)) currentList.push(routeToAdd);
                    });
                }
                stopToRoutesMap.set(id, currentList);
                hydratedStops.add(id);
                if (String(window.currentStopId) === String(stop.id)) {
                    arrivals.renderArrivals(window.lastArrivals || [], stop.id);
                }
                return currentList;
            }).catch(err => {
                console.warn(`[RouteFetch] Failed for ${id}:`, err);
                return stopToRoutesMap.get(id) || [];
            });
        })).then(results => {
            // Update lastRoutes silently - don't re-render, controller handles that
            if (window.currentStopId === String(stop.id)) {
                const allFetchedRoutes = results.flat();
                stopToRoutesMap.set(stop.id, allFetchedRoutes);
                window.lastRoutes = allFetchedRoutes;
            }
        });
    }
}

window.showStopInfo = showStopInfo;

function getRouteDisplayColor(route) {
    if (!route) return 'var(--primary)';
    const isDark = document.body.classList.contains('dark-mode');

    // 1. Filter Manager Priority (Selection/Common Routes)
    if (filterManager && filterManager.state && filterManager.state.active) {
        const routeId = route.id || (resolveRouteByShortName(route.shortName, {
            preferredSource: route._source,
            preferredId: route.id
        }) || {}).id;
        if (routeId && filterManager.state.filteredRoutes.includes(routeId)) {
            const filterColor = RouteFilterColorManager.getColorForRoute(routeId);
            if (filterColor) return filterColor;
        }
    }

    // 2. Identify Rustavi
    const isRustavi = route._source === 'rustavi' || (route.id && (String(route.id).startsWith('r') || String(route.id).startsWith('rustavi:')));
    if (isRustavi) {
        // Rustavi: Distinct Indigo
        if (isDark) return '#818cf8'; // Lighter Indigo
        return '#4f46e5'; // Deep Indigo
    }

    // 3. Identify Minibus (Tbilisi)
    const s = String(route.shortName);
    const isMinibus = (s.startsWith('4') || s.startsWith('5')) && s.length === 3;

    if (isMinibus && isDark) {
        // Brighten minibus blue for dark mode
        return '#0a84ff'; // Vibrant Apple Blue
    }

    const rawColor = route.color || '2563eb';
    if (rawColor === '2563eb') return 'var(--primary)';

    return rawColor.startsWith('#') ? rawColor : `#${rawColor}`;
}

function cssColorToHex(input) {
    if (typeof input !== 'string') return '';
    const raw = input.trim();
    if (!raw) return '';
    if (/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(raw)) return raw;

    const match = raw.match(/^rgba?\(([^)]+)\)$/i);
    if (!match) return '';
    const parts = match[1].split(',').map((p) => p.trim());
    if (parts.length < 3) return '';
    const r = Number(parts[0]);
    const g = Number(parts[1]);
    const b = Number(parts[2]);
    if (![r, g, b].every((n) => Number.isFinite(n))) return '';
    const clamp = (n) => Math.max(0, Math.min(255, Math.round(n)));
    const toHex = (n) => clamp(n).toString(16).padStart(2, '0');
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
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

function lineLength(coords) {
    let total = 0;
    for (let i = 1; i < coords.length; i += 1) {
        total += haversineMeters(coords[i - 1], coords[i]);
    }
    return total;
}

function nearestFractionOnLine(coords, lngLat) {
    const total = lineLength(coords);
    if (!total) return 0;
    const xScale = Math.cos((lngLat.lat * Math.PI) / 180);
    const toXY = (c) => ({ x: c[0] * xScale, y: c[1] });
    const p = { x: lngLat.lng * xScale, y: lngLat.lat };
    let best = { dist: Infinity, fraction: 0 };
    let traveled = 0;
    for (let i = 1; i < coords.length; i += 1) {
        const a = coords[i - 1];
        const b = coords[i];
        const aXY = toXY(a);
        const bXY = toXY(b);
        const abx = bXY.x - aXY.x;
        const aby = bXY.y - aXY.y;
        const abLen2 = abx * abx + aby * aby;
        if (abLen2 === 0) continue;
        const apx = p.x - aXY.x;
        const apy = p.y - aXY.y;
        let t = (apx * abx + apy * aby) / abLen2;
        t = clamp(t, 0, 1);
        const proj = { x: aXY.x + abx * t, y: aXY.y + aby * t };
        const dx = p.x - proj.x;
        const dy = p.y - proj.y;
        const dist2 = dx * dx + dy * dy;
        const segLen = haversineMeters(a, b);
        const along = traveled + segLen * t;
        if (dist2 < best.dist) {
            best = { dist: dist2, fraction: along / total };
        }
        traveled += segLen;
    }
    return clamp(best.fraction, 0, 1);
}

function getPatternPolyline(routeId, suffix) {
    const route = allRoutes.find(r => String(r.id) === String(routeId));
    if (!route || !route._details || !Array.isArray(route._details.patterns)) return null;
    const pattern = route._details.patterns.find(p =>
        String(p.patternSuffix || p.suffix) === String(suffix)
    );
    if (pattern && !pattern.suffix && pattern.patternSuffix) {
        pattern.suffix = pattern.patternSuffix;
    }
    const coords = pattern?._decodedPolyline;
    return coords && Array.isArray(coords) && coords.length >= 2 ? { route, pattern, coords } : null;
}

function getRoutePatternSuffixesForLiveBuses(routeId, stopId = null) {
    const route = allRoutes.find(r => String(r.id) === String(routeId));
    const details = route?._details || api.getStaticRouteDetails?.(routeId) || null;
    if (!details) return [];

    const stopKey = stopId ? String(stopId) : '';
    if (stopKey && Array.isArray(details._stopsOfPatterns)) {
        const stopEntry = details._stopsOfPatterns.find(entry => {
            const entryStopId = String(entry?.stop?.id || entry?.stop || '');
            return entryStopId === stopKey || arrivals.normalizeRouteId(entryStopId) === arrivals.normalizeRouteId(stopKey);
        });
        const scoped = Array.isArray(stopEntry?.patternSuffixes) ? stopEntry.patternSuffixes.filter(Boolean) : [];
        if (scoped.length > 0) return Array.from(new Set(scoped));
    }

    const suffixes = Array.isArray(details.patterns)
        ? details.patterns.map(p => p?.patternSuffix || p?.suffix).filter(Boolean)
        : [];
    return Array.from(new Set(suffixes));
}

function buildRoutePatternMap(routeIds = [], stopId = null) {
    const patternMap = new Map();
    (Array.isArray(routeIds) ? routeIds : []).forEach(routeId => {
        const rid = String(routeId || '').trim();
        if (!rid) return;
        const suffixes = getRoutePatternSuffixesForLiveBuses(rid, stopId);
        if (suffixes.length > 0) patternMap.set(rid, new Set(suffixes));
    });
    return patternMap;
}

async function collectLiveBusFeatures(routeIds, patternMap, throttleMap) {
    if (!Array.isArray(routeIds) || routeIds.length === 0) {
        return { features: [], hadError: false };
    }
    if (!(patternMap instanceof Map)) {
        return { features: [], hadError: false };
    }

    const features = [];
    const tasks = [];
    const uniqueByVehicle = new Map();
    let hadError = false;

    const nowTs = Date.now();
    const MAX_ROUTES = 8;
    let scheduled = 0;
    routeIds.forEach(routeId => {
        if (scheduled >= MAX_ROUTES) return;
        const rid = String(routeId);
        const throttle = throttleMap.get(rid) || { lastTs: 0, failCount: 0, cooldownUntil: 0 };
        if (throttle.cooldownUntil && nowTs < throttle.cooldownUntil) return;
        if (nowTs - throttle.lastTs < 2000) return;
        throttle.lastTs = nowTs;
        throttleMap.set(rid, throttle);
        const suffixesSet = patternMap.get(rid);
        if (!suffixesSet || suffixesSet.size === 0) return;
        const suffixes = Array.from(suffixesSet);
        const color = getFilterRouteColor(rid);
        const routeObj = allRoutes.find(r => String(r.id) === rid);
        const routeLabel = simplifyNumber(routeObj?.shortName || routeObj?.number || rid);

        tasks.push(async () => {
            try {
                const data = await api.fetchBusPositionsV3Multi(rid, suffixes);
                const throttleState = throttleMap.get(rid) || { lastTs: nowTs, failCount: 0, cooldownUntil: 0 };
                throttleState.failCount = 0;
                throttleState.cooldownUntil = 0;
                throttleMap.set(rid, throttleState);
                suffixes.forEach((suffix) => {
                    const buses = data && data[suffix] ? data[suffix] : [];
                    const lineInfo = getPatternPolyline(rid, suffix);
                    const lineKey = lineInfo ? `${rid}:${suffix}` : null;
                    if (lineInfo && lineKey) {
                        registerLiveBusLine(lineKey, lineInfo.coords);
                    } else if (lineInfo && lineInfo.pattern && !lineInfo.pattern._fetchingPolyline) {
                        RouteGeometry.fetchAndCacheGeometry(lineInfo.route, lineInfo.pattern, { strategy: 'cache-only' });
                    }
                    buses.forEach(bus => {
                        if (!bus || !Number.isFinite(bus.lon) || !Number.isFinite(bus.lat)) return;
                        const key = bus.vehicleId ? String(bus.vehicleId) : `${rid}:${suffix}:${bus.lon}:${bus.lat}`;
                        if (uniqueByVehicle.has(key)) return;
                        uniqueByVehicle.set(key, true);
                        const fraction = (lineInfo && lineInfo.coords)
                            ? nearestFractionOnLine(lineInfo.coords, { lng: bus.lon, lat: bus.lat })
                            : null;
                        features.push({
                            type: 'Feature',
                            geometry: { type: 'Point', coordinates: [bus.lon, bus.lat] },
                            properties: {
                                heading: bus.heading,
                                id: bus.vehicleId || key,
                                color,
                                routeLabel,
                                _ts: nowTs,
                                _lineKey: lineKey,
                                _lineFrac: Number.isFinite(fraction) ? fraction : null
                            }
                        });
                    });
                });
            } catch {
                hadError = true;
                const throttleState = throttleMap.get(rid) || { lastTs: nowTs, failCount: 0, cooldownUntil: 0 };
                throttleState.failCount += 1;
                if (throttleState.failCount >= 2) {
                    throttleState.cooldownUntil = nowTs + Math.min(60000, 5000 * throttleState.failCount);
                }
                throttleMap.set(rid, throttleState);
            }
        });
        scheduled += 1;
    });

    if (tasks.length === 0) {
        return { features: [], hadError };
    }

    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
    for (let i = 0; i < tasks.length; i += 1) {
        const now = Date.now();
        const wait = Math.max(0, liveBusRequestGateTs - now);
        if (wait > 0) await sleep(wait);
        liveBusRequestGateTs = Date.now() + LIVE_BUS_REQUEST_INTERVAL_MS;
        await tasks[i]();
    }

    return { features: decorateLiveBusFeatures(features), hadError };
}

function isRoutePanelVisible() {
    const panel = document.getElementById('route-info');
    return !!(panel && !panel.classList.contains('hidden'));
}

function clearFilterLiveBuses() {
    filterBusUpdateToken += 1;
    filterBusUpdateQueued = false;
    if (filterBusUpdateInterval) {
        clearInterval(filterBusUpdateInterval);
        filterBusUpdateInterval = null;
    }
    if (!window.currentRoute || !isRoutePanelVisible()) {
        clearLiveBuses();
    }
}

function getFilterRouteColor(routeId) {
    const id = String(routeId);
    const direct = RouteFilterColorManager.getColorForRoute(id);
    if (direct) return direct;
    const routeObj = allRoutes.find(r => String(r.id) === id);
    return getRouteDisplayColor(routeObj) || '#888888';
}

async function updateFilteredLiveBuses(routeIds, patternMap) {
    if (filterBusUpdateInFlight) {
        filterBusUpdateQueued = true;
        return;
    }
    filterBusUpdateInFlight = true;
    try {
        if (!filterManager?.state?.active || !filterManager.state.targetIds || filterManager.state.targetIds.size === 0) {
            clearFilterLiveBuses();
            return;
        }
        if (window.currentRoute && isRoutePanelVisible()) return;

        const requestToken = ++filterBusUpdateToken;
        const { features, hadError } = await collectLiveBusFeatures(routeIds, patternMap, filterBusThrottle);
        if (requestToken !== filterBusUpdateToken) return;
        if (features.length === 0 && hadError) {
            holdLiveBuses();
            return;
        }
        renderLiveBuses(features);
    } finally {
        filterBusUpdateInFlight = false;
        if (filterBusUpdateQueued) {
            filterBusUpdateQueued = false;
            updateFilteredLiveBuses(
                filterManager?.state?.filteredRoutes,
                filterManager?.state?.filteredRoutePatterns
            );
        }
    }
}

function startFilterLiveBuses(routeIds, patternMap) {
    clearFilterLiveBuses();
    updateFilteredLiveBuses(routeIds, patternMap);
    filterBusUpdateInterval = setInterval(() => {
        if (document.hidden) return;
        updateFilteredLiveBuses(filterManager?.state?.filteredRoutes, filterManager?.state?.filteredRoutePatterns);
    }, 5000);
}

function clearStopRouteChipLiveBuses() {
    stopRouteChipLiveBusToken += 1;
    stopRouteChipLiveBusQueuedRequest = null;
    if (stopRouteChipLiveBusInterval) {
        clearInterval(stopRouteChipLiveBusInterval);
        stopRouteChipLiveBusInterval = null;
    }
    if (!window.currentRoute || !isRoutePanelVisible()) {
        clearLiveBuses();
    }
}

async function updateStopRouteChipLiveBuses(stopId, routeIds = []) {
    stopRouteChipLiveBusToken += 1;
    if (stopRouteChipLiveBusInterval) {
        clearInterval(stopRouteChipLiveBusInterval);
        stopRouteChipLiveBusInterval = null;
    }

    if (filterManager?.state?.active || isRoutePanelVisible()) {
        return;
    }
    if (stopRouteChipLiveBusInFlight) {
        stopRouteChipLiveBusQueuedRequest = {
            stopId: stopId ? String(stopId) : null,
            routeIds: Array.isArray(routeIds) ? Array.from(routeIds) : []
        };
        return;
    }
    stopRouteChipLiveBusInFlight = true;
    try {
        if (!Array.isArray(routeIds) || routeIds.length === 0) {
            clearStopRouteChipLiveBuses();
            return;
        }

        const patternMap = buildRoutePatternMap(routeIds, stopId);
        if (!(patternMap instanceof Map) || patternMap.size === 0) {
            clearStopRouteChipLiveBuses();
            return;
        }

        const requestToken = ++stopRouteChipLiveBusToken;
        const { features, hadError } = await collectLiveBusFeatures(routeIds, patternMap, stopRouteChipLiveBusThrottle);
        if (requestToken !== stopRouteChipLiveBusToken) return;
        if (features.length === 0 && hadError) {
            holdLiveBuses();
            return;
        }
        renderLiveBuses(features);

        if (!stopRouteChipLiveBusInterval) {
            stopRouteChipLiveBusInterval = setInterval(() => {
                if (document.hidden) return;
                updateStopRouteChipLiveBuses(stopId, Array.from(routeIds || []));
            }, 5000);
        }
    } finally {
        stopRouteChipLiveBusInFlight = false;
        if (stopRouteChipLiveBusQueuedRequest) {
            const queued = stopRouteChipLiveBusQueuedRequest;
            stopRouteChipLiveBusQueuedRequest = null;
            updateStopRouteChipLiveBuses(queued.stopId, queued.routeIds);
        }
    }
}

function resolveRouteFavoriteColor(route) {
    const rawRouteColor = String(route?.color || '').trim();
    if (/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(rawRouteColor)) {
        return rawRouteColor;
    }
    if (/^([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(rawRouteColor)) {
        return `#${rawRouteColor}`;
    }

    const fromDisplay = typeof getRouteDisplayColor === 'function'
        ? cssColorToHex(String(getRouteDisplayColor(route) || ''))
        : '';
    if (fromDisplay) return fromDisplay;

    const routeInfoNumber = document.getElementById('route-info-number');
    const inlineColor = cssColorToHex(routeInfoNumber?.style?.color || '');
    if (inlineColor) return inlineColor;
    const computedColor = routeInfoNumber ? cssColorToHex(getComputedStyle(routeInfoNumber).color) : '';
    if (computedColor) return computedColor;

    return '#2563eb';
}

function getPatternHeadsign(route, directionIndex, defaultHeadsign) {
    if (!route) return defaultHeadsign;

    // Priority: 1. Match by full ID 2. Match by normalized ID 3. Match by shortName
    const norm = (id) => String(id || '').replace(/^\d+:/, '').replace(/^[rR]/, '');
    const matchedRoute = allRoutes.find(r => String(r.id) === String(route.id)) ||
        allRoutes.find(r => norm(r.id) === norm(route.id)) ||
        resolveRouteByShortName(route.shortName, {
            preferredSource: route._source,
            preferredId: route.id,
            preferBus: !isRailLikeMode(route.mode)
        });

    const overrides = (matchedRoute && matchedRoute._overrides) ? matchedRoute._overrides : route._overrides;

    if (overrides && overrides.destinations) {
        const destObj = overrides.destinations[directionIndex];
        if (destObj && destObj.headsign) {
            const locale = getCurrentStopNamesLanguage();
            const res = destObj.headsign[locale] || destObj.headsign.en || destObj.headsign.ka || defaultHeadsign;
            if (res && res !== defaultHeadsign) {
                // console.log(`[HeadsignDebug] Applied override: "${defaultHeadsign}" -> "${res}"`);
            }
            return res;
        }
    }

    // 2. Fallback to parsing from longName if headsign is missing or default
    if (!defaultHeadsign || defaultHeadsign === route.longName) {
        // Use LoopUtils or similar if needed, but for now just return what we have
        return defaultHeadsign;
    }

    return defaultHeadsign;
}

function renderAllRoutes(routesInput, arrivalsInput) {
    const stopId = window.currentStopId;
    const equivalentIds = stopId ? getEquivalentStops(stopId, false) : [];
    const blocklist = api.getArrivalsBlocklist ? api.getArrivalsBlocklist() : null;
    const isBlocked = (shortName) => {
        if (!blocklist || blocklist.size === 0) return false;
        return equivalentIds.some(eqId => {
            const blockedRoutes = blocklist.get(eqId);
            return blockedRoutes && blockedRoutes.has(String(shortName));
        });
    };

    // Deduplicate Routes (Prioritize Parent aka first fetched)
    const uniqueRoutesMap = new Map();

    if (routesInput && Array.isArray(routesInput)) {
        routesInput.forEach(r => {
            if (!r) return;
            if (isBlocked(r.shortName)) return;

            // 1. Resolve Real Route (with overrides) from allRoutes
            let realRoute = r;
            if (r.id) {
                // Try to find by ID (handling stripped prefix)
                const cleanId = r.id.includes(':') ? r.id.split(':')[1] : r.id;
                const found = allRoutes.find(x => x.id === cleanId || x.id === r.id);
                if (found) realRoute = found;
            } else if (r.shortName) {
                // Fallback by shortName with source/mode-aware resolution
                const found = resolveRouteByShortName(r.shortName, {
                    preferredSource: r._source,
                    preferredId: r.id,
                    preferredStopId: window.currentStopId,
                    preferBus: true
                });
                if (found) realRoute = found;
            }

            const key = routeUniqKey(realRoute) || String(r.shortName || '');
            if (realRoute && realRoute.shortName && key && !uniqueRoutesMap.has(key)) {
                uniqueRoutesMap.set(key, realRoute);
            }
        });
    }


    // Merge with arrivals for robustness
    if (arrivalsInput && arrivalsInput.length > 0) {
        arrivalsInput.forEach(arr => {
            if (isBlocked(arr.shortName)) return;
            // Resolve Arrival to Real Route Logic (Similar to renderArrivals)
            let resolvedRoute = null;

            if (v3RoutesMap && v3RoutesMap.has(String(arr.shortName))) {
                const mappedId = v3RoutesMap.get(String(arr.shortName));
                const cleanId = mappedId.includes(':') ? mappedId.split(':')[1] : mappedId;
                resolvedRoute = allRoutes.find(x => x.id === cleanId || x.id === mappedId);
            }

            if (!resolvedRoute) {
                resolvedRoute = resolveRouteByShortName(arr.shortName, {
                    preferredStopId: window.currentStopId,
                    preferBus: true
                });
            }

            const newRoute = resolvedRoute || { shortName: arr.shortName, id: null, color: '2563eb' };
            const key = routeUniqKey(newRoute) || `unknown:${String(arr.shortName)}`;
            if (!uniqueRoutesMap.has(key)) {
                uniqueRoutesMap.set(key, newRoute);
            }
        });
    }

    // Convert back to array
    let routesForStop = Array.from(uniqueRoutesMap.values());

    if (routesForStop.length > 0) {
        const validRouteIdsForStop = routesForStop
            .map(route => route.id || (resolveRouteByShortName(route.shortName, {
                preferredSource: route._source,
                preferredId: route.id,
                preferredStopId: window.currentStopId,
                preferBus: true
            }) || {}).id)
            .filter(Boolean)
            .map(id => String(id));
        const selectedRouteIds = arrivals.pruneStopRouteFilterIds(validRouteIdsForStop, window.currentStopId);
        const isStopRouteFilterActive = selectedRouteIds.size > 0;
        const resetIconSrc = document.querySelector('#edit-restore-en img')?.getAttribute('src') || '/arrow.counterclockwise.circle.fill.svg';
        // Advanced Sorting:
        // 1. If Filter Active: Matches First
        // 2. Numeric ShortName

        routesForStop.sort((a, b) => {
            if (filterManager.state.active) {
                const idA = a.id || (resolveRouteByShortName(a.shortName, {
                    preferredSource: a._source,
                    preferredId: a.id
                }) || {}).id;
                const idB = b.id || (resolveRouteByShortName(b.shortName, {
                    preferredSource: b._source,
                    preferredId: b.id
                }) || {}).id;

                const matchA = idA && filterManager.state.filteredRoutes.includes(idA);
                const matchB = idB && filterManager.state.filteredRoutes.includes(idB);

                if (matchA && !matchB) return -1; // A comes first
                if (!matchA && matchB) return 1;  // B comes first
            }

            // Source Sort: Rustavi goes to bottom
            const isRustaviA = a._source === 'rustavi' || (a.id && a.id.startsWith('rustavi:'));
            const isRustaviB = b._source === 'rustavi' || (b.id && b.id.startsWith('rustavi:'));

            if (isRustaviA && !isRustaviB) return 1;
            if (!isRustaviA && isRustaviB) return -1;

            // Numeric Sort
            return (parseInt(a.shortName) || 0) - (parseInt(b.shortName) || 0);
        });

        const container = document.createElement('div');
        container.className = 'all-routes-container';

        const tilesContainer = document.createElement('div');
        tilesContainer.className = 'route-tiles-container';

        routesForStop.forEach(route => {
            // Apply Show Minibuses Filter
            if (!shouldShowRoute(route.shortName, route)) return;

            const tile = document.createElement('button');
            tile.className = 'route-tile';

            // Prefer Valid Custom Alias > ShortName
            const displayName = route.customShortName || route.shortName;
            tile.textContent = simplifyNumber(displayName);

            const displayColor = getRouteDisplayColor(route);
            tile.style.backgroundColor = `color-mix(in srgb, ${displayColor}, transparent 88%)`;
            tile.style.color = displayColor;
            tile.style.fontWeight = '700';
            const realId = route.id || (resolveRouteByShortName(route.shortName, {
                preferredSource: route._source,
                preferredId: route.id,
                preferredStopId: window.currentStopId,
                preferBus: true
            }) || {}).id;
            const isSelectedByRouteFilter = !!(realId && selectedRouteIds.has(String(realId)));
            if (isSelectedByRouteFilter) {
                tile.classList.add('selected');
            } else if (isStopRouteFilterActive) {
                tile.classList.add('route-filter-dimmed');
            }

            // Apply Dimming (don't hide)
            if (filterManager.state.active) {
                if (!realId || !filterManager.state.filteredRoutes.includes(realId)) {
                    if (isStopRouteFilterActive) {
                        tile.classList.add('route-filter-extra-dimmed');
                    } else {
                        tile.classList.add('dimmed');
                    }
                } else {
                    // Apply Filter Color
                    const filterColor = RouteFilterColorManager.getColorForRoute(realId);
                    if (filterColor) {
                        tile.style.backgroundColor = `${filterColor} 20`; // Hex + opacity
                        tile.style.color = filterColor;
                    }
                    if (isStopRouteFilterActive && !isSelectedByRouteFilter) {
                        tile.classList.add('route-filter-dimmed');
                    }
                }
            }

            tile.addEventListener('click', (e) => {
                e.stopPropagation();
                if (!realId) return;
                arrivals.toggleStopRouteFilter(realId, window.currentStopId);
                updateCurrentStopDeepLink();
                arrivals.renderArrivals(window.lastArrivals || [], window.currentStopId);
            });
            tilesContainer.appendChild(tile);
        });

        if (selectedRouteIds.size > 0) {
            const resetSlot = document.createElement('div');
            resetSlot.className = 'route-filter-reset-slot';

            const resetTile = document.createElement('button');
            resetTile.className = 'route-filter-reset-btn';
            resetTile.setAttribute('type', 'button');
            resetTile.setAttribute('aria-label', 'Reset route filter');
            resetTile.innerHTML = `<img src="${resetIconSrc}" alt="Reset route filter">`;
            resetTile.addEventListener('click', (e) => {
                e.stopPropagation();
                arrivals.resetStopRouteFilter(window.currentStopId);
                updateCurrentStopDeepLink();
                arrivals.renderArrivals(window.lastArrivals || [], window.currentStopId);
            });
            resetSlot.appendChild(resetTile);
            tilesContainer.appendChild(resetSlot);
        }

        // Add invisible spacers to fill the last row (prevents last row chips from stretching)
        // We add enough spacers to fill a full row (max ~10 items at 42px min-width in 450px container)
        for (let i = 0; i < 10; i++) {
            const spacer = document.createElement('div');
            spacer.className = 'route-tile-spacer';
            spacer.setAttribute('aria-hidden', 'true');
            tilesContainer.appendChild(spacer);
        }

        container.appendChild(tilesContainer);
        return container;
    }
    return null;
}

// --- Arrivals Functions ---
// NOTE: fetchArrivals, fetchV3Routes, getV3Schedule, parseSchedule,
//       formatScheduledTime, getMinutesFromNow, sortArrivalsList
//       moved to arrivals.js module

// V3 Routes Map (populated by arrivals.fetchV3Routes via api.js)
// Used by renderAllRoutes for route resolution
let v3RoutesMap = null;
let cachedStopsConfig = null;

function escapeHtml(str) {
    return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function formatGondolaInfoHtml(text) {
    const escaped = escapeHtml(text).replace(/\r?\n/g, '<br>');
    const withLinks = escaped.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
    return withLinks.replace(/(^|[\s>])(\+?\d[\d\s().-]{6,}\d)(?=$|[\s<])/g, '$1<a href="tel:$2">$2</a>');
}

function inferRouteSource(route) {
    if (!route) return null;
    if (route._source) return route._source;
    const rid = String(route.id || '');
    if (rid.startsWith('r') || rid.startsWith('rustavi:')) return 'rustavi';
    if (rid.startsWith('k') || rid.startsWith('kutaisi:')) return 'kutaisi';
    if (rid.startsWith('b') || rid.startsWith('batumi:')) return 'batumi';
    return rid ? 'tbilisi' : null;
}

function isRailLikeMode(mode) {
    const m = String(mode || '').toUpperCase();
    return m === 'SUBWAY' || m === 'GONDOLA';
}

function routeUniqKey(route) {
    if (!route || !route.shortName) return null;
    const source = inferRouteSource(route) || 'unknown';
    return `${source}:${String(route.shortName)}`;
}

function resolveRouteByShortName(shortName, options = {}) {
    const target = String(shortName || '').trim();
    if (!target) return null;

    const candidates = allRoutes.filter(r => String(r.shortName) === target);
    if (!candidates.length) return null;

    const preferredSource = options.preferredSource || null;
    const preferredId = options.preferredId ? String(options.preferredId) : null;
    const preferBus = options.preferBus !== false;
    const preferredStopId = options.preferredStopId ? String(options.preferredStopId) : null;
    const preferredStopIds = preferredStopId ? getEquivalentStops(preferredStopId, false).map(id => String(id)) : [];
    const preferredStopNorms = new Set(
        preferredStopIds.map(id => id.replace(/^rustavi:/i, '').replace(/^[rR]/, '').replace(/^\d+:/, ''))
    );

    let best = null;
    let bestScore = -Infinity;

    for (const c of candidates) {
        let score = 0;
        const source = inferRouteSource(c);
        const mode = String(c.mode || '').toUpperCase();
        const cId = String(c.id || '');

        if (preferredId && cId === preferredId) score += 120;
        if (preferredSource && source === preferredSource) score += 60;
        if (preferBus && mode === 'BUS') score += 45;
        if (preferBus && isRailLikeMode(mode)) score -= 35;
        if (!preferBus && isRailLikeMode(mode)) score += 15;

        if (preferredStopNorms.size > 0 && Array.isArray(c.stops) && c.stops.length > 0) {
            const hasStop = c.stops.some(sid => {
                const sidStr = String(sid || '');
                const sidNorm = sidStr.replace(/^rustavi:/i, '').replace(/^[rR]/, '').replace(/^\d+:/, '');
                return preferredStopNorms.has(sidNorm);
            });
            if (hasStop) score += 55;
        }

        if (score > bestScore) {
            bestScore = score;
            best = c;
        }
    }

    return best || candidates[0];
}



// --- REUSABLE: Refresh Stops Logic (Apply Overrides/Merges) ---
async function refreshStopsLayer(useLocalConfig = false) {
    if (!rawStops || rawStops.length === 0) return;

    let stopsConfigToUse;

    if (useLocalConfig && window.stopsConfig) {
        // Use the in-memory config (already updated by EditTools)
        stopsConfigToUse = window.stopsConfig;
        console.log('[Main] Refreshing with LOCAL stops config...');
    } else if (cachedStopsConfig) {
        stopsConfigToUse = cachedStopsConfig;
        console.log('[Main] Using cached stops config...');
    } else {
        // Reload from files (Standard Load)
        try {
            let csvText = await getOtaDataFileText('stops_overrides.csv');
            if (!csvText) {
                const basePath = import.meta.env.BASE_URL.endsWith('/') ? import.meta.env.BASE_URL : `${import.meta.env.BASE_URL}/`;
                const file = `${basePath}data/stops_overrides.csv`;

                const res = await fetch(`${file}?t=${Date.now()}`);
                if (res.ok) {
                    csvText = await res.text();
                    console.log(`[Main] Fetched ${file}: ${csvText.length} chars, Type: ${res.headers.get('content-type')}`);
                } else {
                    console.warn(`[Main] Failed to fetch ${file}: ${res.status}`);
                }
            }

            // Parse CSV and extract overrides
            const { parseCSV, extractOverrides } = await import('./csv-parser.js');

            stopsConfigToUse = {
                overrides: {},
                merges: {},
                hubs: {}
            };

            if (csvText) {
                const rows = parseCSV(csvText);
                const fileOverrides = extractOverrides(rows, 'id');

                // Merge into global config
                Object.keys(fileOverrides).forEach(id => {
                    const override = fileOverrides[id];

                    // Handle merges
                    if (override.mergeParent) {
                        stopsConfigToUse.merges[id] = override.mergeParent;
                        delete override.mergeParent;
                    }

                    // Handle hubs
                    if (override.hubTarget) {
                        const hubId = override.hubTarget;
                        if (!stopsConfigToUse.hubs[hubId]) {
                            stopsConfigToUse.hubs[hubId] = [];
                        }
                        if (!stopsConfigToUse.hubs[hubId].includes(id)) {
                            stopsConfigToUse.hubs[hubId].push(id);
                        }
                        delete override.hubTarget;
                    }

                    // Store remaining overrides
                    if (Object.keys(override).length > 0) {
                        stopsConfigToUse.overrides[id] = override;
                    }
                });
            }

            console.log('[Main] Loaded stops config from multiple CSVs:',
                Object.keys(stopsConfigToUse.overrides).length, 'overrides,',
                Object.keys(stopsConfigToUse.merges).length, 'merges,',
                Object.keys(stopsConfigToUse.hubs).length, 'hubs');

            // DEBUG: Log sample data
            const sampleMerges = Object.entries(stopsConfigToUse.merges).slice(0, 5);
            // console.log('[Main DEBUG] Sample merges (pre-norm):', JSON.stringify(sampleMerges));
            const sampleOverrides = Object.entries(stopsConfigToUse.overrides).slice(0, 5);
            // console.log('[Main DEBUG] Sample overrides (pre-norm):', sampleOverrides.map(([k, v]) => `${k}: rot=${v.rotation}`));
            cachedStopsConfig = stopsConfigToUse;
        } catch (e) {
            console.error('[Main] Failed to load stops config:', e);
            stopsConfigToUse = { overrides: {}, merges: {}, hubs: {} };
        }
    }

    // Update Global Ref
    window.stopsConfig = stopsConfigToUse;

    // Reset Maps
    redirectMap.clear();
    mergeSourcesMap.clear();
    hubMap.clear();
    hubSourcesMap.clear();

    // --- Normalize Config IDs (Handle new prefix logic) ---
    // Since config file might use '1:' prefix (Tbilisi) or others, and we now use stripped/prefixed IDs (e.g. 801, r43),
    // we must try to match config IDs to the actual loaded IDs in `rawStops`.

    // Create lookup set for valid IDs
    // Note: freshStops isn't defined yet in the original code? 
    // Wait, I need to check where `freshStops` is defined. 
    // It is defined at line 2678: `const freshStops = rawStops.map...`
    // I should move `freshStops` definition UP before this block.
    // Or just use `rawStops`. rawStops is available.

    const validStopIds = new Set(rawStops.map(s => s.id));

    const normalizeConfigId = (rawId) => {
        if (!rawId) return rawId;
        if (validStopIds.has(rawId)) return rawId;

        // Try processing with all known source rules
        // api.sources is array of {id, prefix, stripPrefix...}
        if (api.sources) {
            for (const source of api.sources) {
                const processed = api.processId(rawId, source);
                if (validStopIds.has(processed)) return processed;
            }
        }
        return rawId;
    };

    const rawOverrides = stopsConfigToUse?.overrides || {};
    const overrides = {};
    Object.keys(rawOverrides).forEach(k => {
        overrides[normalizeConfigId(k)] = rawOverrides[k];
    });

    const rawMerges = stopsConfigToUse?.merges || {};
    const merges = {};
    Object.keys(rawMerges).forEach(k => {
        merges[normalizeConfigId(k)] = normalizeConfigId(rawMerges[k]);
    });

    const rawHubs = stopsConfigToUse?.hubs || {};
    const hubs = {};
    Object.keys(rawHubs).forEach(k => {
        const normKey = normalizeConfigId(k);
        const members = rawHubs[k];
        if (Array.isArray(members)) {
            hubs[normKey] = members.map(m => normalizeConfigId(m));
        } else {
            hubs[normKey] = members;
        }
    });

    console.log('[Main] Normalization Complete:',
        Object.keys(overrides).length, 'overrides,',
        Object.keys(merges).length, 'merges');

    // Check for Rustavi matches specifically
    const rustaviOverrides = Object.keys(overrides).filter(id => id.startsWith('r'));
    const rustaviMerges = Object.keys(merges).filter(id => id.startsWith('r'));
    console.log('[Main] Rustavi Matches:', rustaviOverrides.length, 'overrides,', rustaviMerges.length, 'merges');
    // console.log('[Main DEBUG] Normalized merges sample:', JSON.stringify(Object.entries(merges).slice(0, 5)));
    // console.log('[Main DEBUG] RedirectMap size:', redirectMap.size, 'Sample entries:', [...redirectMap.entries()].slice(0, 5));

    // Build merge mappings
    // console.warn('[Main DEBUG] FRESH CODE v3 - Starting merge build...');
    try {
        Object.keys(merges).forEach(source => {
            const target = merges[source];
            redirectMap.set(source, target);
            if (!mergeSourcesMap.has(target)) mergeSourcesMap.set(target, []);
            mergeSourcesMap.get(target).push(source);
        });
        // console.warn('[Main DEBUG] Merge build complete. RedirectMap size:', redirectMap.size);
    } catch (e) {
        // console.error('[Main DEBUG] Error in merge build:', e);
    }

    // Build Hub mappings
    // console.warn('[Main DEBUG] Starting hub build...');
    try {
        Object.keys(hubs).forEach(hubId => {
            const members = hubs[hubId];
            if (Array.isArray(members)) {
                members.forEach(memberId => {
                    hubMap.set(memberId, hubId);
                });
                hubSourcesMap.set(hubId, members);
            }
        });
        // console.warn('[Main DEBUG] Hub build complete. HubMap size:', hubMap.size);
    } catch (e) {
        // console.error('[Main DEBUG] Error in hub build:', e);
    }

    // console.warn('[Main DEBUG] ===== AFTER BUILD =====');
    // console.warn('[Main DEBUG] RedirectMap size:', redirectMap.size, 'MergeSourcesMap size:', mergeSourcesMap.size);
    // console.warn('[Main DEBUG] Sample redirectMap entries:', JSON.stringify([...redirectMap.entries()].slice(0, 5)));
    // console.warn('[Main DEBUG] Sample rawStops IDs:', rawStops.slice(0, 5).map(s => s.id));

    // Filter and Override
    const stops = [];
    const seenCoords = new Set();

    // Deep Clone Raw Stops to avoid mutating the source-of-truth indefinitely?
    // Actually, rawStops objects are mutated in the original loop.
    // Better to clone or reset. Since rawStops is fetching fresh, 
    // we should probably re-clone from a "really raw" source if we mutate property 'lat'/'lon'.
    // `Object.assign(stop, ...)` MUTATES `stop`.
    // If rawStops elements are mutated, subsequent refreshes stack.
    // FIX: Map rawStops to NEW objects.
    // Fix: Ensure stops defined in Config (Overrides/Merges) but missing from API are added.
    // This allows "virtual" or "legacy" stops to exist (e.g. 3954 which is a target).
    // Creates a map of existing API stops for fast lookup.
    const freshStops = rawStops.map(s => ({ ...s }));
    const existingIds = new Set(freshStops.map(s => s.id));

    // 1. Check Overrides for missing stops
    Object.keys(overrides).forEach(id => {
        if (!existingIds.has(id)) {
            // console.log(`[Refresh] Injecting Config Stop (Override): ${id}`);
            // Create minimal skeletal stop
            freshStops.push({
                id: id,
                name: "Unknown Stop", // Will be overwritten by override name if present
                lat: 0,
                lon: 0,
                code: id.replace('1:', '').replace('r', ''),
                _source: 'config' // Marker
            });
            existingIds.add(id);
        }
    });

    // 2. Check Merge Targets for missing stops
    // If A merges to B, and B is missing, we must create B.
    Object.values(merges).forEach(targetId => {
        if (!existingIds.has(targetId)) {
            // console.log(`[Refresh] Injecting Config Stop (Merge Target): ${targetId}`);
            freshStops.push({
                id: targetId,
                name: "Merged Stop",
                lat: 0,
                lon: 0,
                code: targetId.replace('1:', '').replace('r', ''),
                _source: 'config'
            });
            existingIds.add(targetId);
        }
    });

    const busStops = [];
    const metroStops = [];
    const stopsWithRoutes = new Set();
    if (Array.isArray(allRoutes)) {
        allRoutes.forEach(route => {
            if (!Array.isArray(route?.stops)) return;
            route.stops.forEach(stopId => {
                const targetId = redirectMap.get(stopId) || stopId;
                stopsWithRoutes.add(String(targetId));
            });
        });
    }

    // Helper to identify Metro
    const isMetroStop = (s) =>
        (s.vehicleMode === 'SUBWAY') ||
        (s.name && s.name.includes('Metro Station')) ||
        (s.id && typeof s.id === 'string' && s.id.startsWith('M:'));

    // ...
    // Clear dynamic maps before rebuilding
    // mergeSourcesMap (defined globally or at top of scope)
    // redirectMap (defined globally or at top of scope)
    // Note: Assuming mergeSourcesMap and redirectMap are available in this scope.
    // They seem to be module-level constants or let variables.

    // DEBUG: Check if specific stops exist
    const stop806 = freshStops.find(s => s.id === '806' || s.id === '1:806');
    const stop813 = freshStops.find(s => s.id === '813' || s.id === '1:813');
    // console.warn('[Main DEBUG] Stop 806 exists?', !!stop806, stop806?.id);
    // console.warn('[Main DEBUG] Stop 813 exists?', !!stop813, stop813?.id);
    // console.warn('[Main DEBUG] All stop IDs containing "806":', freshStops.filter(s => s.id.includes('806')).map(s => s.id));

    freshStops.forEach(stop => {
        // If this stop is merged INTO another, skip adding it to map list
        if (merges[stop.id]) {
            if (stop.id === '806' || stop.id === '826') {
                // console.warn('[Main DEBUG] Stop', stop.id, 'FILTERED by merge ->', merges[stop.id]);
            }
            return;
        }

        // Populate Merge Maps from API-provided Merges
        if (stop.mergedIds && stop.mergedIds.length > 0) {
            const existing = mergeSourcesMap.get(stop.id) || [];
            const combined = [...new Set([...existing, ...stop.mergedIds])];
            mergeSourcesMap.set(stop.id, combined);

            stop.mergedIds.forEach(mergedId => {
                redirectMap.set(mergedId, stop.id);
            });
        }

        // Apply Default Rotations (Standard Config)
        // Normalize rotations map on first use to match App IDs
        if (!window.normalizedRotations) {
            window.normalizedRotations = {};
            // We need to iterate over stopRotations and process keys
            // Use existing `api.processId` logic via `sources`
            // But simpler: just try to match keys to `validStopIds` locally if possible, 
            // OR use the same `normalizeConfigId` logic.
            // Actually, efficient way:
            // Iterate all keys in stopRotations. 
            // Transform key using `normalizeConfigId` logic (which creates App ID from Raw ID).
            // Assign to new map.
            Object.keys(stopRotations).forEach(rawKey => {
                const appKey = normalizeConfigId(rawKey);
                window.normalizedRotations[appKey] = stopRotations[rawKey];
            });
        }

        if (stop.rotation === undefined) {
            stop.rotation = window.normalizedRotations[stop.id] || 0;
        }

        // Apply Override if exists
        if (overrides[stop.id]) {
            const override = { ...overrides[stop.id] };
            if (stop.id === '813') {
                // console.warn('[Main DEBUG] Applying override to stop 813:', override.rotation, override);
            }

            // Special handling for 'name' override (which is {en, ka})
            if (override.name) {
                const locale = getCurrentStopNamesLanguage();

                // If we have an override for this locale, use it.
                // Otherwise, leave the original name (which is presumably correct for the *other* locale, or fallback).
                // Actually, if we override, we likely want to replace it.
                // But `stop.name` starts as the pre-fetched string for the *requested* locale (or fallback).
                if (override.name[locale]) {
                    stop.name = override.name[locale];
                }
                // If override exists but is empty for this locale?
                // `startEditing` logic puts `undefined` if empty.

                // Remove 'name' from the object we pass to Object.assign so it doesn't overwrite with {en, ka}
                delete override.name;
            }

            Object.assign(stop, override);
        }

        // Deduplicate
        const coordKey = `${stop.lat.toFixed(6)},${stop.lon.toFixed(6)}`;
        // if (seenCoords.has(coordKey)) return; // Disable deduplication to ensure all ID targets exist
        seenCoords.add(coordKey);

        if (isMetroStop(stop)) {
            metroStops.push(stop);
        } else {
            stop._hasRoutes = stopsWithRoutes.has(String(stop.id));
            busStops.push(stop);
        }
        stops.push(stop); // allStops keeps everything for search
    });

    // console.log(`[Refresh] Processed Stops: ${freshStops.length} -> ${stops.length}`);
    allStops = stops;
    window.allStops = allStops;

    // UPDATE MAP SOURCES (Delegated to shared function)
    addStopsToMap(allStops, { redirectMap, filterManager, updateConnectionLine });
}
// Search Logic




// Route Plotting
let currentRoute = null;
let currentPatternIndex = 0;
// busUpdateInterval declared at top scope

async function showRouteOnMap(route, addToStack = true, options = {}) {
    const didApplyOtaRefresh = await consumePendingOtaTransitDataRefresh('open-route-card');
    if (didApplyOtaRefresh && route) {
        route = findRouteByIdentity(route.id, route.shortName) || route;
    }

    console.log('[RoutePlot] showRouteOnMap called:', { routeShortName: route?.shortName, routeId: route?.id, addToStack, options });
    invalidateScheduledMapCamera();
    // Stop location tracking if we are selecting something specific
    stopTracking();
    if (filterManager?.state) {
        filterManager.state.allowedRouteIds = null;
        filterManager.state.originIdsOverride = null;
        filterManager.state.context = 'route';
        filterManager.state.allowedPatternSuffixes = null;
    }
    clearSelectedMinibusSegments();
    // Snapshot current Zoom into the previous state (the Stop view) 
    // This allows "Back" to restore the exact zoom level.
    const top = peekHistory();
    if (top && top.type === 'stop') {
        // If explicit startZoom provided (e.g. from Deep Link where map is flying), use it.
        // Otherwise capture current zoom.
        top.data.savedZoom = options.startZoom || map.getZoom();
        console.log('[RoutePlot] Saved stop view zoom level:', top.data.savedZoom);
    }

    if (addToStack) addToHistory('route', route);

    currentRoute = route;
    window.currentRoute = route; // Crucial for Edit Tools
    currentPatternIndex = 0; // Reset to default
    if (options.fromFavorites) {
        setFavoritesBackContext(true);
    }

    // Routes opened from a stop inherit its focused map state. Direct routes
    // from search and deep links need to enable the same dimming themselves.
    if ((options.routeSource === 'search' || options.routeSource === 'deepLink') &&
        !(filterManager && (filterManager.state.active || filterManager.state.picking))) {
        setMapFocus(true);
    }

    // Style wait removed - we're inside map.on('load') so style should be ready

    await updateRouteView(route, options);

    // Update URL
    const nestedStopId = options.fromStopId || window.currentStopId;
    if (nestedStopId) {
        Router.updateNested(nestedStopId, route.shortName, currentPatternIndex);
    } else {
        Router.updateRoute(route.shortName, currentPatternIndex);
    }
}

async function updateRouteView(route, options = {}) {
    closeAllMoreMenus();
    syncFavoriteButtonState();
    const routeName = route?.shortName || route?.customShortName || 'Unknown';
    const routeId = route?.id || 'Unknown';
    try {
        const requestId = ++lastRouteUpdateId; // Start new request
        console.log(`[RoutePlot] Starting route view update for ${routeName} (ID: ${routeId}, requestId: ${requestId})`);
        const liveBusSessionId = resetLiveBusSession();

        // Close route edit panel if open (to prevent showing stale data)
        const routeEditBtn = document.getElementById('btn-edit-route');
        const routeEditBlock = document.getElementById('route-edit-block');
        if (routeEditBtn && routeEditBtn.classList.contains('active')) {
            routeEditBtn.classList.remove('active');
            if (routeEditBlock) {
                routeEditBlock.classList.add('hidden');
                routeEditBlock.style.display = 'none';
            }
        }

        // Close stop info panel (but preserve stop highlight when coming from stop)
        const infoPanel = document.getElementById('info-panel');
        // Temporarily disable highlight clearing by NOT hiding info-panel through setSheetState
        if (!options.suppressPanel) {
            infoPanel.classList.add('hidden');
            infoPanel.classList.remove('sheet-half', 'sheet-full', 'sheet-collapsed');
        }

        // Route Info Card Setup
        const infoCard = document.getElementById('route-info');
        const numberEl = document.getElementById('route-info-number');
        const displayColor = getRouteDisplayColor(route);

        numberEl.textContent = route.customShortName || route.shortName;
        numberEl.style.color = displayColor;
        numberEl.style.backgroundColor = `color-mix(in srgb, ${displayColor}, transparent 88%)`;

        // Logic to Show Edit Button (Restored)
        const editBtn = document.getElementById('btn-edit-route');
        if (editBtn) {
            const isLocalhost = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
            const isPrivateIP = location.hostname.startsWith('192.168.') || location.hostname.startsWith('10.') || location.hostname.startsWith('172.');
            const hasWriteAccess = (isLocalhost || isPrivateIP) && import.meta.env.DEV;

            if (hasWriteAccess) {
                editBtn.style.display = '';
                editBtn.classList.remove('hidden');
            } else {
                editBtn.style.display = 'none';
                editBtn.classList.add('hidden');
            }
        }
        // Show skeleton loading state immediately
        const routeTextEl = document.getElementById('route-info-text');
        const routeBodyEl = document.getElementById('route-info-body');

        routeTextEl.innerHTML = `
            <div class="route-skeleton-details">
                <div class="skeleton skeleton-text short"></div>
                <div class="skeleton skeleton-text heading"></div>
            </div>`;

        routeBodyEl.innerHTML = `
            <div class="route-skeleton-body">
                <div class="skeleton-row">
                    <div class="skeleton skeleton-circle"></div>
                    <div class="skeleton skeleton-text short"></div>
                </div>
                <div class="skeleton-row">
                    <div class="skeleton skeleton-circle"></div>
                    <div class="skeleton skeleton-text short"></div>
                </div>
                <div class="skeleton-row">
                    <div class="skeleton skeleton-circle"></div>
                    <div class="skeleton skeleton-text short"></div>
                </div>
            </div>`;

        window.lastUpdatedRouteId = route.id;

        if (!options.suppressPanel) {
            setSheetState(infoCard, 'half'); // Default to half open
        }
        updateBackButtons(); // Ensure back button state is correct
        applyFavoritesBackButtonsIfNeeded();

        // Clear Filter state before showing route
        if (filterManager.state.active || filterManager.state.picking) {
            filterManager.clearFilter();
        }

        // Clear existing layers robustly (Safe Atomic Removal)
        const style = map.getStyle();
        if (style && style.layers) {
            // Collect IDs first to avoid iteration issues
            const layersToRemove = style.layers
                .filter(layer => layer.id.startsWith('route') || layer.id.startsWith('live-buses'))
                .map(layer => layer.id);

            console.log('[RoutePlot] Removing existing route layers:', layersToRemove);
            layersToRemove.forEach(id => {
                if (map.getLayer(id)) map.removeLayer(id);
            });
        }
        // Explicitly remove sources (Dynamic)
        // Note: map.getStyle().sources returns an object { id: sourceDef }
        const sources = style ? style.sources : {};
        console.log('[RoutePlot] Checking for route/live-bus sources to remove...');
        Object.keys(sources).forEach(id => {
            if (id.startsWith('route') || id.startsWith('live-buses')) {
                if (map.getSource(id)) {
                    console.log(`[RoutePlot] Removing source: ${id}`);
                    map.removeSource(id);
                }
            }
        });

        // Helper to perform the actual rendering based on fetched data
        const renderPhase = async (isOptimistic = false) => {
            const strategy = isOptimistic ? 'cache-only' : 'cache-first';
            console.log(`[RoutePlot] Entering renderPhase (${isOptimistic ? 'Optimistic' : 'Live'}, strategy: ${strategy})`);

            // 1. Fetch Route Details (v3) to get patterns
            let routeDetails;
            try {
                routeDetails = await api.fetchRouteDetailsV3(route.id, { strategy });
            } catch (e) {
                console.warn(`[RoutePlot] fetchRouteDetailsV3 failed for phase ${isOptimistic ? 'Optimistic' : 'Live'}:`, e.message);
                if (!isOptimistic) throw e;
                return false;
            }
            if (!routeDetails) {
                console.warn(`[RoutePlot] No routeDetails returned for route ID ${route.id}`);
                return false;
            }
            if (requestId !== lastRouteUpdateId) {
                console.warn(`[RoutePlot] Aborting renderPhase: requestId mismatch (${requestId} !== ${lastRouteUpdateId})`);
                return false;
            }

            const patterns = routeDetails.patterns || [];
            console.log(`[RoutePlot] Fetched ${patterns.length} raw patterns for route ID ${route.id}`);

            // --- RESTORED LOOP LOGIC ---
            // Pre-process patterns to split loops into virtual directions
            const processedPatterns = [];
            for (const p of patterns) {
                const stops = await api.fetchRouteStopsV3(route.id, p.patternSuffix, { strategy });
                if (RouteGeometry.isLoop(stops, route.shortName)) {
                    let forcedId = null;

                    // Use fresh overrides from details if available, otherwise fallback to route object
                    const activeOverrides = routeDetails._overrides || route._overrides;

                    // Sync overrides to route object for consistency
                    if (routeDetails._overrides) {
                        route._overrides = routeDetails._overrides;
                    }

                    if (activeOverrides) {
                        forcedId = activeOverrides.terminusStopId_override ||
                            activeOverrides.terminusStopId ||
                            activeOverrides.virtualTerminusStopId;
                    }
                    const virtuals = RouteGeometry.generateVirtualPatterns(p, stops, route.longName, forcedId);
                    console.log(`[RoutePlot] Split loop pattern (${p.patternSuffix}) into ${virtuals.length} virtual patterns`);
                    processedPatterns.push(...virtuals);
                } else {
                    processedPatterns.push(p);
                }
            }
            routeDetails.patterns = processedPatterns;
            route.patterns = processedPatterns;
            console.log(`[RoutePlot] Processed patterns count: ${processedPatterns.length}`);
            // ---------------------------

            // Auto-Direction Logic:
            let directionFound = false;
            if (options.initialDirectionIndex !== undefined && processedPatterns[options.initialDirectionIndex]) {
                currentPatternIndex = options.initialDirectionIndex;
                directionFound = true;
                console.log(`[RoutePlot] Selected direction index ${currentPatternIndex} from initialDirectionIndex option`);
            } else if (options.targetHeadsign && processedPatterns.length > 0) {
                const normalizedTarget = options.targetHeadsign.toLowerCase().trim();
                const matchedIndex = processedPatterns.findIndex(p =>
                    p.headsign && p.headsign.toLowerCase().trim() === normalizedTarget
                );
                if (matchedIndex !== -1) {
                    currentPatternIndex = matchedIndex;
                    directionFound = true;
                    console.log(`[RoutePlot] Selected direction index ${currentPatternIndex} matching target headsign "${options.targetHeadsign}"`);
                }
            }

            if (!directionFound && options.fromStopId && processedPatterns.length > 0) {
                try {
                    const stopsPromises = processedPatterns.map(p => api.fetchRouteStopsV3(route.id, p.patternSuffix, { strategy }).then(stops => ({
                        suffix: p.patternSuffix,
                        stops: stops
                    })));

                    const allStopsData = await Promise.all(stopsPromises);
                    if (requestId !== lastRouteUpdateId) {
                        console.warn('[RoutePlot] Aborting pattern matching due to request preemption');
                        return false;
                    }

                    const matchedIndex = processedPatterns.findIndex(p => {
                        const data = allStopsData.find(d => d.suffix === p.patternSuffix);
                        return data && data.stops.some(s => {
                            const normalizeStopId = id => String(id)
                                .replace(/^rustavi:/i, '')
                                .replace(/^[rR]/, '')
                                .replace(/^\d+:/, '');

                            const sId = String(s.id || s.stopId);
                            const normId = redirectMap.get(sId) || sId;
                            const equivs = getEquivalentStops(options.fromStopId);

                            if (equivs.includes(normId)) return true;
                            const normNormId = normalizeStopId(normId);
                            return equivs.some(e => normalizeStopId(e) === normNormId);
                        });
                    });

                    if (matchedIndex !== -1) {
                        currentPatternIndex = matchedIndex;
                        directionFound = true;
                        console.log(`[RoutePlot] Selected direction index ${currentPatternIndex} matching stopId "${options.fromStopId}"`);
                    }
                } catch (e) {
                    console.warn('[RoutePlot] Auto-direction pattern matching failed:', e.message);
                }
            }

            if (!processedPatterns[currentPatternIndex]) {
                currentPatternIndex = 0;
            }

            const currentPattern = processedPatterns[currentPatternIndex];
            console.log(`[RoutePlot] Final selected pattern index: ${currentPatternIndex}, suffix: ${currentPattern?.patternSuffix}`);
            if (!currentPattern) {
                console.warn('[RoutePlot] Aborting: No current pattern found to plot');
                return false;
            }

            // Fetch stops for current pattern to get origin → destination
            const currentPatternStops = await api.fetchRouteStopsV3(route.id, currentPattern.patternSuffix, { strategy });
            if (requestId !== lastRouteUpdateId) {
                console.warn('[RoutePlot] Aborting after currentPatternStops fetch due to preemption');
                return false;
            }

            const destinationHeadsign = getPatternHeadsign(route, currentPatternIndex, currentPattern.headsign);
            let originHeadsign = '';
            if (processedPatterns.length > 1) {
                const otherIdx = processedPatterns.findIndex((p, idx) => idx !== currentPatternIndex);
                if (otherIdx !== -1) {
                    originHeadsign = getPatternHeadsign(route, otherIdx, processedPatterns[otherIdx].headsign);
                }
            }

            if (originHeadsign && destinationHeadsign && originHeadsign !== destinationHeadsign) {
                document.getElementById('route-info-text').innerHTML = `
                    <div class="origin">${originHeadsign} →</div>
                    <div class="destination">${destinationHeadsign}</div>
                `;
            } else {
                document.getElementById('route-info-text').innerHTML = `
                    <div class="destination">${destinationHeadsign || route.longName}</div>
                `;
            }

            const switchBtn = document.getElementById('switch-direction');
            if (processedPatterns.length > 1) {
                switchBtn.classList.remove('hidden');
                switchBtn.onclick = () => {
                    const nextPatternIndex = (currentPatternIndex + 1) % processedPatterns.length;
                    currentPatternIndex = nextPatternIndex;
                    updateRouteView(route, {
                        preserveBounds: true,
                        fromStopId: options.fromStopId,
                        initialDirectionIndex: nextPatternIndex
                    });
                    const nestedStopId = options.fromStopId || window.currentStopId;
                    if (nestedStopId) {
                        Router.updateNested(nestedStopId, route.shortName, nextPatternIndex);
                    } else {
                        Router.updateRoute(route.shortName, nextPatternIndex);
                    }
                };
            } else {
                switchBtn.classList.add('hidden');
            }

            // --- FULL SCHEDULE DISPLAY ---
            const routeBodyEl = document.getElementById('route-info-body');
            if (options.fromStopId) {
                const normalize = id => String(id)
                    .replace(/^rustavi:/i, '')
                    .replace(/^[rR]/, '')
                    .replace(/^\d+:/, '');
                const equivs = new Set(getEquivalentStops(options.fromStopId));
                const equivsNorm = new Set(Array.from(equivs).map(e => normalize(e)));

                const hasStop = currentPatternStops && currentPatternStops.some(s => {
                    const sId = String(s.id || s.stopId);
                    if (sId === String(options.fromStopId)) return true;
                    if (equivs.has(sId) || equivsNorm.has(normalize(sId))) return true;
                    return normalize(sId) === normalize(options.fromStopId);
                });

                if (!hasStop) {
                    routeBodyEl.innerHTML = `
                        <div class="empty warning">
                            <div class="icon">⚠️</div>
                            <div>${t('stopInOtherDirection')}</div>
                            <div class="sub">${t('switchDirectionForSchedule')}</div>
                        </div>`;
                } else {

                    // Helper to render schedule with tabs
                    const renderSchedule = (scheduleIndex = null) => {
                        console.log('[ScheduleDebug] Route card requesting schedule', {
                            routeId: route.id,
                            shortName: route.shortName,
                            fromStopId: options.fromStopId,
                            patternSuffix: currentPattern.patternSuffix,
                            strategy,
                            scheduleIndex,
                            currentPatternIndex,
                            requestId,
                            lastRouteUpdateId
                        });
                        arrivals.getFullScheduleGrouped(route.shortName, options.fromStopId, route.id, currentPattern.patternSuffix, { strategy, scheduleIndex }).then(result => {
                            if (requestId !== lastRouteUpdateId) return;
                            if (!result || !result.grouped || Object.keys(result.grouped).length === 0) {
                                console.warn('[ScheduleDebug] Route card received no grouped schedule', {
                                    routeId: route.id,
                                    shortName: route.shortName,
                                    fromStopId: options.fromStopId,
                                    patternSuffix: currentPattern.patternSuffix,
                                    strategy,
                                    scheduleIndex,
                                    result
                                });
                                routeBodyEl.innerHTML = `<div class="empty">${t('noScheduleData')}</div>`;
                                return;
                            }

                            const { grouped, entries, activeIndex } = result;
                            const currentHour = new Date().getHours();

                            // Build tabs HTML if multiple entries exist
                            let tabsHtml = '';
                            if (entries && entries.length > 1) {
                                tabsHtml = '<div class="schedule-day-tabs">';
                                entries.forEach((entry, idx) => {
                                    const isActive = idx === activeIndex;
                                    const isTodayClass = entry.isToday ? ' is-today' : '';
                                    const interval = (entry.summaryInterval || '').replace(/^, /, '').trim();
                                    tabsHtml += `
                                        <button class="schedule-day-tab${isActive ? ' active' : ''}${isTodayClass}" data-schedule-index="${idx}">
                                            <div class="tab-label">${entry.label}</div>
                                            <div class="tab-summary">
                                                <div class="summary-line">${entry.summaryTimes || ''}</div>
                                                <div class="summary-line">${interval}</div>
                                            </div>
                                        </button>`;
                                });
                                tabsHtml += '</div>';
                            }

                            // Build schedule grid HTML
                            let scheduleHtml = '<div class="route-full-schedule">';
                            Object.keys(grouped).sort((a, b) => {
                                let ha = parseInt(a);
                                let hb = parseInt(b);
                                if (ha < 4) ha += 24;
                                if (hb < 4) hb += 24;
                                return ha - hb;
                            }).forEach(hour => {
                                const isCurrentHour = parseInt(hour) === currentHour;
                                scheduleHtml += `
                                    <div class="schedule-hour-row${isCurrentHour ? ' current-hour' : ''}">
                                        <div class="hour-label">${hour}:</div>
                                        <div class="minutes-list">${grouped[hour].join(' ')}</div>
                                    </div>`;
                            });
                            scheduleHtml += '</div>';

                            // Build "From Station" label
                            let fromLabelHtml = '';
                            if (options.fromStopId) {
                                const stop = allStops.find(s => String(s.id) === String(options.fromStopId));
                                if (stop) {
                                    const cleanName = stop.name.replace(/[12]$/, '').trim();
                                    fromLabelHtml = `<div class="schedule-from-label">${t('fromLabel', cleanName)}</div>`;
                                }
                            }

                            routeBodyEl.innerHTML = fromLabelHtml + tabsHtml + scheduleHtml;

                            // Attach click handlers to tabs
                            routeBodyEl.querySelectorAll('.schedule-day-tab').forEach(tab => {
                                tab.addEventListener('click', (e) => {
                                    const newIndex = parseInt(e.currentTarget.dataset.scheduleIndex);
                                    if (newIndex !== activeIndex) {
                                        renderSchedule(newIndex);
                                    }
                                });
                            });
                        }).catch(err => {
                            if (!isOptimistic) {
                                console.warn('[Schedule] Failed to load full schedule', err);
                                routeBodyEl.innerHTML = `<div class="empty">${t('failedToLoadSchedule')}</div>`;
                            }
                        });
                    };

                    renderSchedule();
                }
            } else {
                routeBodyEl.innerHTML = '';
            }

            if (requestId !== lastRouteUpdateId) return false;

            const patternSuffix = currentPattern.patternSuffix;

            // 2. Fetch Polylines (Current & Ghost)
            const allSuffixes = processedPatterns.map(p => p.patternSuffix).join(',');
            let polylineData;
            try {
                polylineData = await api.fetchRoutePolylineV3(route.id, allSuffixes, { strategy });
            } catch (e) {
                console.warn(`[RoutePlot] fetchRoutePolylineV3 failed for phase ${isOptimistic ? 'Optimistic' : 'Live'}:`, e.message);
                if (!isOptimistic) throw e;
                return false;
            }

            if (!polylineData) {
                console.warn(`[RoutePlot] No polyline data returned for route ID ${route.id}`);
                return false;
            }
            if (requestId !== lastRouteUpdateId) {
                console.warn('[RoutePlot] Aborting before rendering due to preemption');
                return false;
            }

            // Plot Ghost Route
            processedPatterns.forEach(p => {
                if (p.patternSuffix !== patternSuffix) {
                    const ghostEntry = polylineData[p.patternSuffix];
                    let ghostCoords = null;
                    if (Array.isArray(ghostEntry)) ghostCoords = ghostEntry;
                    else if (ghostEntry && ghostEntry.encodedValue) ghostCoords = api.decodePolyline(ghostEntry.encodedValue);

                    if (ghostCoords) {
                        const ghostId = `route-ghost-${p.patternSuffix}`;
                        console.log(`[RoutePlot] Adding/updating ghost route source: ${ghostId} (${ghostCoords.length} points)`);
                        if (!map.getSource(ghostId)) {
                            map.addSource(ghostId, {
                                type: 'geojson',
                                data: { type: 'Feature', geometry: { type: 'LineString', coordinates: ghostCoords } }
                            });
                            map.addLayer({
                                id: ghostId, type: 'line', source: ghostId,
                                layout: { 'line-join': 'round', 'line-cap': 'round' },
                                paint: { 'line-color': getRouteDisplayColor(route), 'line-width': 4, 'line-opacity': 0.3, 'line-emissive-strength': 1 }
                            }, 'stops-layer');
                        }
                    }
                }
            });

            // Plot Current Route
            const currEntry = polylineData[patternSuffix];
            let coordinates = null;
            if (Array.isArray(currEntry)) coordinates = currEntry;
            else if (currEntry && currEntry.encodedValue) coordinates = api.decodePolyline(currEntry.encodedValue);

            console.log(`[RoutePlot] Current route active coordinates status:`, {
                hasCoords: !!coordinates,
                length: coordinates?.length || 0
            });

            // Re-create or update main 'route' source safely
            // Note: If coordinates are missing, we still initialize source to prevent Mapbox error.
            if (!map.getSource('route')) {
                map.addSource('route', {
                    type: 'geojson',
                    data: coordinates 
                        ? { type: 'Feature', geometry: { type: 'LineString', coordinates: coordinates } }
                        : { type: 'FeatureCollection', features: [] }
                });
                console.log('[RoutePlot] Created new "route" map source');
            } else {
                map.getSource('route').setData(
                    coordinates 
                        ? { type: 'Feature', geometry: { type: 'LineString', coordinates: coordinates } }
                        : { type: 'FeatureCollection', features: [] }
                );
                console.log('[RoutePlot] Updated existing "route" map source data');
            }

            if (coordinates && coordinates.length > 0) {
                if (!isOptimistic || !window._routeBoundsFit) {
                    const viewBounds = map.getBounds();
                    const sampleStep = Math.max(1, Math.floor(coordinates.length / 200));
                    let isRouteOnScreen = false;
                    if (viewBounds) {
                        for (let i = 0; i < coordinates.length; i += sampleStep) {
                            const c = coordinates[i];
                            if (viewBounds.contains([c[0], c[1]])) {
                                isRouteOnScreen = true;
                                break;
                            }
                        }
                    }

                    const forceFit = options.fitToRoute || options.routeSource === 'deepLink' || options.routeSource === 'search';
                    const shouldFit = !options.preserveBounds && (forceFit || !isRouteOnScreen);

                    console.log('[RoutePlot] Camera fit assessment:', { isRouteOnScreen, forceFit, shouldFit, preserveBounds: options.preserveBounds });

                    if (shouldFit) {
                        const bounds = new mapboxgl.LngLatBounds();
                        coordinates.forEach(coord => bounds.extend(coord));
                        console.log('[RoutePlot] Fitting bounds (fitBounds) for route:', bounds.toArray());
                        map.fitBounds(bounds, {
                            padding: getBandPadding({ bottomAnchorSelector: '#route-info' }),
                            maxZoom: 15,
                            duration: 1200,
                            retainPadding: false,
                            // Whole-route overviews intentionally flatten the
                            // map, while preserving its current rotation.
                            ...getCameraOrientation(map, { resetPitch: true })
                        });
                        window._routeBoundsFit = true;
                    } else if (options.centerOnStop && options.centerOnStop.lat && options.centerOnStop.lon && !options.preserveBounds) {
                        const center = [options.centerOnStop.lon, options.centerOnStop.lat];
                        console.log('[RoutePlot] Centering on stop:', center);
                        flyToPointInView(center, {
                            zoom: 14,
                            bottomAnchorSelector: '#route-info',
                            duration: 1500,
                            radiusMeters: 12
                        });
                        window._routeBoundsFit = true;
                    } else if (map.getZoom() > 14.5 && !options.preserveBounds) {
                        console.log('[RoutePlot] Easing zoom out to 14');
                        map.easeTo({ zoom: 14, duration: 800 });
                    }
                }
            } else {
                console.warn('[RoutePlot] Active pattern coordinates are missing or empty');
            }

            // 3. Fetch Stops for "Bumps"
            const stopsData = await api.fetchRouteStopsV3(route.id, patternSuffix, { strategy });
            if (requestId !== lastRouteUpdateId) {
                console.warn('[RoutePlot] Aborting before rendering stops due to preemption');
                return false;
            }
            console.log(`[RoutePlot] Fetched ${stopsData?.length || 0} stops for the active pattern`);

            const stopsGeoJSON = {
                type: 'FeatureCollection',
                features: (stopsData || []).map(stop => {
                    const sId = String(stop.id);
                    const normId = redirectMap.get(sId) || sId;
                    const existingStop = allStops.find(s => s.id === normId);
                    const lat = existingStop ? existingStop.lat : stop.lat;
                    const lon = existingStop ? existingStop.lon : stop.lon;
                    return { type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties: { name: stop.name } };
                })
            };

            if (map.getSource('route-stops')) {
                map.getSource('route-stops').setData(stopsGeoJSON);
            } else {
                map.addSource('route-stops', { type: 'geojson', data: stopsGeoJSON });
            }

            // Layers
            if (!map.getLayer('route')) {
                console.log('[RoutePlot] Adding "route" map layer');
                map.addLayer({
                    id: 'route', type: 'line', source: 'route', layout: { 'line-join': 'round', 'line-cap': 'round' },
                    paint: { 'line-color': getRouteDisplayColor(route), 'line-width': 12, 'line-opacity': 0.8, 'line-emissive-strength': 1 }
                });
            }
            if (!map.getLayer('route-stops')) {
                console.log('[RoutePlot] Adding "route-stops" map layer');
                map.addLayer({
                    id: 'route-stops', type: 'circle', source: 'route-stops',
                    paint: { 'circle-color': '#ffffff', 'circle-radius': 3, 'circle-stroke-width': 0, 'circle-opacity': 1, 'circle-emissive-strength': 1 }
                });
            }

            // 4. Start Live Bus Tracking (Only in Phase 2)
            if (!isOptimistic && route.id) {
                const liveColor = getRouteDisplayColor(route);
                const liveRouteLabel = simplifyNumber(route?.shortName || route?.customShortName || route?.id || '');
                const canRenderLiveBuses = () =>
                    liveBusSessionId === activeLiveBusSession &&
                    !!window.currentRoute &&
                    String(window.currentRoute.id) === String(route.id) &&
                    isRoutePanelVisible();
                console.log('[RoutePlot] Starting live bus tracking loop for route ID:', route.id);
                updateLiveBuses(route.id, patternSuffix, liveColor, { shouldRender: canRenderLiveBuses, routeLabel: liveRouteLabel });
                busUpdateInterval = setInterval(() => {
                    if (document.hidden) return;
                    updateLiveBuses(route.id, patternSuffix, liveColor, { shouldRender: canRenderLiveBuses, routeLabel: liveRouteLabel });
                }, 5000);
            }

            // 5. Highlight Stop
            if (options.fromStopId) {
                const highlightStop = allStops.find(s => String(s.id) === String(options.fromStopId));
                if (highlightStop && highlightStop.lon && highlightStop.lat) {
                    console.log(`[RoutePlot] Highlighting stop ID ${options.fromStopId} on map`);
                    if (!map.getSource('selected-stop')) {
                        map.addSource('selected-stop', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
                    }
                    map.getSource('selected-stop').setData({
                        type: 'FeatureCollection',
                        features: [{
                            type: 'Feature',
                            geometry: { type: 'Point', coordinates: [highlightStop.lon, highlightStop.lat] },
                            properties: { rotation: highlightStop.rotation || 0, mode: route.mode }
                        }]
                    });
                    if (!map.getLayer('stops-highlight')) {
                        const themeSuffix = document.body.classList.contains('dark-mode') ? 'dark' : 'light';
                        map.addLayer({
                            id: 'stops-highlight', type: 'symbol', source: 'selected-stop', slot: 'top',
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
                                    ['case',
                                        ['>', ['coalesce', ['get', 'rotation'], 0], 0], `stop-selected-icon-gondola-manual-${themeSuffix}`,
                                        `stop-icon-gondola-manual-${themeSuffix}`
                                    ],
                                    ['==', ['get', 'mode'], 'GONDOLA'],
                                    ['case',
                                        ['>', ['coalesce', ['get', 'rotation'], 0], 0], `stop-selected-icon-gondola-${themeSuffix}`,
                                        `stop-icon-gondola-${themeSuffix}`
                                    ],
                                    ['case',
                                        ['>', ['coalesce', ['get', 'rotation'], 0], 0], `stop-selected-icon-${themeSuffix}`,
                                        `stop-icon-${themeSuffix}`
                                    ]
                                ],
                                'icon-size': ['case', ['==', ['get', 'mode'], 'SUBWAY'], 1.5, 1.2],
                                'icon-allow-overlap': true,
                                'icon-ignore-placement': true,
                                'icon-rotate': ['coalesce', ['get', 'rotation'], 0],
                                'icon-rotation-alignment': 'map'
                            },
                            paint: { 'icon-opacity': 1, 'icon-emissive-strength': 1 }
                        });
                    }
                    map.moveLayer('stops-highlight');
                }
            } else if (map.getSource('selected-stop')) {
                map.getSource('selected-stop').setData({ type: 'FeatureCollection', features: [] });
            }

            console.log('[RoutePlot] Completed renderPhase successfully');
            return true;
        };

        // Execution of Phases
        window._routeBoundsFit = false; // Internal flag to prevent double-fit

        // Phase 1: Optimistic (Silent if fails)
        console.log('[RoutePlot] Launching Phase 1 (Optimistic)');
        const hitCache = await renderPhase(true);
        if (requestId !== lastRouteUpdateId) {
            console.log('[RoutePlot] Request preempted during Phase 1');
            return;
        }

        // Phase 2: Live
        console.log('[RoutePlot] Launching Phase 2 (Live/Network)');
        await renderPhase(false);

        // Move highlight layer to top
        if (map.getLayer('stops-highlight')) {
            map.moveLayer('stops-highlight');
        }

    } catch (error) {
        console.error('CRITICAL: Failed to plot route:', error);
        // Hide the route info card on error
        const infoCard = document.getElementById('route-info');
        if (infoCard) {
            infoCard.classList.add('hidden');
            infoCard.classList.remove('sheet-half', 'sheet-full', 'sheet-collapsed');
        }
        // Clear currentRoute since it failed to load
        currentRoute = null;
        window.currentRoute = null;
        // Try to go back if there's history
        if (window.historyStack && window.historyStack.length > 0) {
            goBack();
        }
    }
}

// updateLiveBuses moved to map-setup.js

// Helper for Sheet State (Mobile)
// Helper for Sheet State (Mobile) - Moved to panel-manager.js
// Helper to toggle panel state - Moved to panel-manager.js

// Filter Button

const filterBtn = document.getElementById('filter-routes-toggle');
if (filterBtn) {
    filterBtn.addEventListener('click', (e) => {
        console.log('[Debug] Filter button clicked');
        e.stopPropagation();
        toggleFilterMode();
    });
} else {
    // Retry if not found immediately (though defer/module should handle it)
    console.warn('[Debug] Filter button not found at init, checking again in 1s');
    setTimeout(() => {
        const fb = document.getElementById('filter-routes-toggle');
        if (fb) fb.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleFilterMode();
        });
    }, 1000);
}

// Prevent map/panel clicks from leaking through button activation.
// Avoid intercepting touchstart so iOS can keep its native double-tap-and-drag zoom gesture.
['mousedown', 'click'].forEach(evt => {
    document.getElementById('close-panel').addEventListener(evt, e => e.stopPropagation(), { passive: false });
    document.getElementById('close-route-info').addEventListener(evt, e => e.stopPropagation(), { passive: false });
    ['stop-more-btn', 'route-more-btn', 'copy-link-btn', 'copy-route-link-btn', 'btn-edit-stop', 'btn-edit-route', 'favorite-stop-btn', 'favorite-route-btn', 'open-street-screen-btn', 'street-screen-close'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.addEventListener(evt, e => e.stopPropagation(), { passive: false });
    });
});

const initMoreMenu = (triggerId, menuId) => {
    const trigger = document.getElementById(triggerId);
    const menu = document.getElementById(menuId);
    if (!trigger || !menu) return;

    const closeMenu = () => menu.classList.add('hidden');

    const isNative = () => {
        const cap = window.Capacitor;
        if (!cap || typeof cap.isNativePlatform !== 'function' || typeof cap.getPlatform !== 'function') return false;
        return cap.isNativePlatform() && (cap.getPlatform() === 'ios' || cap.getPlatform() === 'android');
    };

    const getNativeSettings = () => window.Capacitor?.Plugins?.NativeSettings;

    const getVisibleActions = () => {
        return Array.from(menu.querySelectorAll('button.more-menu-item'))
            .filter((btn) => !btn.classList.contains('hidden') && btn.style.display !== 'none')
            .map((btn) => {
                let text = (btn.textContent || '').trim();
                let symbol = null;
                if (btn.id === 'copy-link-btn' || btn.id === 'copy-route-link-btn') {
                    text = t('copyLink');
                    symbol = 'link';
                }
                if (btn.id === 'favorite-stop-btn' || btn.id === 'favorite-route-btn') {
                    symbol = text === 'Unfavorite' ? 'star.fill' : 'star';
                }
                if (btn.id === 'open-street-screen-btn') {
                    symbol = 'arrow.down.left.and.arrow.up.right';
                }
                return {
                    id: btn.id,
                    title: text || btn.title || btn.id,
                    style: 'default',
                    symbol,
                    accent: text === 'Unfavorite' ? 'yellow' : null
                };
            });
    };

    const getBoardAction = () => ({
        id: 'open-street-screen-btn',
        title: t('streetScreen'),
        style: 'default',
        symbol: 'arrow.down.left.and.arrow.up.right'
    });

    const showNativeMenu = async (event) => {
        const plugin = getNativeSettings();
        if (!plugin || typeof plugin.showActionSheet !== 'function') return false;
        syncFavoriteButtonState();

        const actions = getVisibleActions();
        const copyActionIndex = actions.findIndex((action) => action.id === 'copy-link-btn' || action.id === 'copy-route-link-btn');
        const copyAction = copyActionIndex >= 0 ? actions.splice(copyActionIndex, 1)[0] : null;
        if (menuId === 'stop-more-menu' && !actions.some((action) => action.id === 'open-street-screen-btn')) {
            actions.push(getBoardAction());
        }
        if (copyAction) actions.push(copyAction);
        actions.push({ id: 'native-share-current-url', title: t('share'), style: 'default', symbol: 'square.and.arrow.up' });
        if (!actions.length) return true;

        let res;
        try {
            res = await plugin.showActionSheet({
                actions,
                theme: localStorage.getItem('theme') || 'system',
                anchorX: Number(event?.clientX ?? 0),
                anchorY: Number(event?.clientY ?? 0),
                viewportWidth: window.innerWidth,
                viewportHeight: window.innerHeight
            });
        } catch (err) {
            console.warn('[UI] Native action sheet failed, falling back to web menu:', err);
            return false;
        }

        const actionId = res?.action;
        if (typeof actionId !== 'string') return true;

        try {
            if (actionId === 'favorite-stop-btn') {
                const stopKey = getCurrentStopFavoriteKey();
                if (stopKey) {
                    const nextValue = !favoritesManager.has(stopKey);
                    toggleCurrentFavorite('stop', nextValue);
                }
                return true;
            }
            if (actionId === 'favorite-route-btn') {
                const routeKey = getCurrentRouteFavoriteKey();
                if (routeKey) {
                    const nextValue = !favoritesManager.has(routeKey);
                    toggleCurrentFavorite('route', nextValue);
                }
                return true;
            }
            if (actionId === 'native-share-current-url') {
                if (typeof plugin.shareUrl === 'function') {
                    setTimeout(() => {
                        plugin.shareUrl({
                            url: buildCurrentUrl(),
                            anchorX: Number(event?.clientX ?? 0),
                            anchorY: Number(event?.clientY ?? 0)
                        }).catch((err) => console.warn('[UI] Native share failed:', err));
                    }, 0);
                }
                return true;
            }

            setTimeout(() => {
                const actionBtn = document.getElementById(actionId);
                if (actionBtn) actionBtn.click();
            }, 0);
        } catch (err) {
            const message = err?.message || String(err);
            console.warn('[UI] Native action handler failed:', message, err);
        }
        return true;
    };

    trigger.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (isNative()) {
            const handled = await showNativeMenu(e);
            if (handled) return;
        }
        menu.classList.toggle('hidden');
    });

    menu.addEventListener('click', (e) => {
        const target = e.target instanceof Element ? e.target.closest('button') : null;
        if (target) closeMenu();
    });

    document.addEventListener('click', (e) => {
        if (!(e.target instanceof Node)) return;
        if (!menu.contains(e.target) && !trigger.contains(e.target)) {
            closeMenu();
        }
    });
};

initMoreMenu('stop-more-btn', 'stop-more-menu');
initMoreMenu('route-more-btn', 'route-more-menu');

streetScreenController = new StreetScreenController({
    getCurrentStop: () => {
        const canonicalStopId = getCanonicalMergedStopId(window.currentStopId);
        return allStops.find((stop) => String(stop.id) === String(canonicalStopId)) ||
            allStops.find((stop) => String(stop.id) === String(window.currentStopId)) ||
            null;
    },
    getEquivalentStops: (stopId) => getEquivalentStops(stopId, false),
    getAllStops: () => allStops,
    onOpen: (options = {}) => {
        if (!options.syncUrl || !window.currentStopId) return;
        updateCurrentStopDeepLink();
    },
    onClose: (options = {}) => {
        if (!options.syncUrl || !window.currentStopId) return;
        updateCurrentStopDeepLink();
    }
});
window.__streetScreenAllRoutes = allRoutes;
streetScreenController.init();

function closeAllMoreMenus() {
    ['stop-more-menu', 'route-more-menu'].forEach((id) => {
        const menu = document.getElementById(id);
        if (menu) menu.classList.add('hidden');
    });
}

function buildStopFavoriteKey(stopId, targetIds = []) {
    const base = `stop:${String(stopId)}`;
    if (!Array.isArray(targetIds) || targetIds.length === 0) return base;
    const normalized = Array.from(new Set(targetIds.map(id => String(id).trim()).filter(Boolean))).sort();
    if (!normalized.length) return base;
    return `${base}|filters:${normalized.join(',')}`;
}

function parseStopFavoriteKey(key) {
    if (typeof key !== 'string' || !key.startsWith('stop:')) {
        return { stopId: null, targetIds: [] };
    }
    const raw = key.slice('stop:'.length);
    const marker = '|filters:';
    const markerIndex = raw.indexOf(marker);
    if (markerIndex === -1) {
        return { stopId: raw || null, targetIds: [] };
    }
    const stopId = raw.slice(0, markerIndex) || null;
    const targetsRaw = raw.slice(markerIndex + marker.length);
    const targetIds = targetsRaw.split(',').map(s => s.trim()).filter(Boolean);
    return { stopId, targetIds };
}

function resolveStopNameById(stopId) {
    const stop = allStops.find(s => String(s.id) === String(stopId));
    return stop?.name || String(stopId);
}

function formatFilteredSubtitle(targetIds) {
    if (!Array.isArray(targetIds) || targetIds.length === 0) return '';
    const names = targetIds.slice(0, 3).map(resolveStopNameById);
    return formatFavoriteFilterSubtitle(names);
}

function getCurrentStopFavoriteKey() {
    if (!window.currentStopId) return null;
    const hasActiveFilterForCurrentStop =
        !!(filterManager?.state?.active &&
            String(filterManager.state.originId) === String(window.currentStopId) &&
            filterManager.state.targetIds &&
            filterManager.state.targetIds.size > 0);

    if (hasActiveFilterForCurrentStop) {
        return buildStopFavoriteKey(window.currentStopId, Array.from(filterManager.state.targetIds));
    }
    return buildStopFavoriteKey(window.currentStopId, []);
}

function getCurrentRouteFavoriteKey() {
    const route = window.currentRoute;
    if (!route) return null;
    const stable = route.id || route.shortName || route.customShortName;
    if (!stable) return null;
    return `route:${String(stable)}`;
}

let lastFavoriteMutation = { key: '', value: null, at: 0 };
function shouldSkipDuplicateFavoriteMutation(key, value) {
    const tsNow = Date.now();
    if (
        lastFavoriteMutation.key === key &&
        lastFavoriteMutation.value === value &&
        (tsNow - lastFavoriteMutation.at) < 700
    ) {
        return true;
    }
    lastFavoriteMutation = { key, value, at: tsNow };
    return false;
}

function syncFavoriteButtonState() {
    const stopBtn = document.getElementById('favorite-stop-btn');
    const routeBtn = document.getElementById('favorite-route-btn');
    const stopKey = getCurrentStopFavoriteKey();
    const routeKey = getCurrentRouteFavoriteKey();
    const stopFav = !!(stopKey && favoritesManager.has(stopKey));
    const routeFav = !!(routeKey && favoritesManager.has(routeKey));

    if (stopBtn) {
        stopBtn.textContent = stopFav ? t('unfavorite') : t('favorite');
        stopBtn.title = stopBtn.textContent;
        stopBtn.classList.toggle('is-unfavorite', stopFav);
    }
    if (routeBtn) {
        routeBtn.textContent = routeFav ? t('unfavorite') : t('favorite');
        routeBtn.title = routeBtn.textContent;
        routeBtn.classList.toggle('is-unfavorite', routeFav);
    }
}

function toggleCurrentFavorite(kind, nextValue = null) {
    if (kind === 'stop') {
        const key = getCurrentStopFavoriteKey();
        if (!key) return false;
        const stop = allStops.find(s => String(s.id) === String(window.currentStopId));
        const stopNameFromUI = (document.getElementById('stop-name')?.textContent || '').trim();
        const title = stop?.name || stopNameFromUI || t('stopFallback', String(window.currentStopId));
        const { targetIds } = parseStopFavoriteKey(key);
        const subtitle = targetIds.length > 0
            ? formatFilteredSubtitle(targetIds)
            : (stop?.code ? t('codeLabel', stop.code) : '');
        const desiredValue = nextValue === null ? !favoritesManager.has(key) : !!nextValue;
        if (shouldSkipDuplicateFavoriteMutation(key, desiredValue)) return true;
        favoritesManager.set(key, desiredValue, { title, subtitle });
        syncFavoriteButtonState();
        return true;
    }

    const key = getCurrentRouteFavoriteKey();
    if (!key) return false;
    const route = window.currentRoute || {};
    const routeLabel = route.shortName || route.customShortName || route.id || '';
    const title = String(route.longName || '').trim() || (routeLabel ? `Route ${routeLabel}` : 'Route');
    const subtitle = '';
    const routeColor = resolveRouteFavoriteColor(route);
    const routeNumber = String(route.customShortName || route.shortName || '').trim();
    const desiredValue = nextValue === null ? !favoritesManager.has(key) : !!nextValue;
    if (shouldSkipDuplicateFavoriteMutation(key, desiredValue)) return true;
    if (typeof favoritesManager.set === 'function') {
        favoritesManager.set(key, desiredValue, { title, subtitle, routeNumber, routeColor });
    } else if (desiredValue !== favoritesManager.has(key)) {
        favoritesManager.toggle(key, { title, subtitle, routeNumber, routeColor });
    }
    syncFavoriteButtonState();
    return true;
}

const toggleFavoriteFromButton = (btnId) => {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        toggleCurrentFavorite(btnId === 'favorite-stop-btn' ? 'stop' : 'route');
    });
};

toggleFavoriteFromButton('favorite-stop-btn');
toggleFavoriteFromButton('favorite-route-btn');
favoritesManager.subscribe(() => syncFavoriteButtonState());
window.addEventListener('favoritesClearAllRequest', () => {
    favoritesManager.clearAll();
    syncFavoriteButtonState();
});
window.addEventListener('favoritesRemoveKeyRequest', (event) => {
    const key = typeof event?.detail === 'string' ? event.detail : '';
    if (!key) return;
    favoritesManager.remove(key);
    syncFavoriteButtonState();
});
window.addEventListener('favoritesReorderRequest', (event) => {
    const type = event?.detail?.type;
    const keys = event?.detail?.keys;
    favoritesManager.reorderType(type, keys);
    syncFavoriteButtonState();
});
window.addEventListener('favoritesUpdateSubtitleRequest', (event) => {
    const key = typeof event?.detail?.key === 'string' ? event.detail.key : '';
    const subtitle = typeof event?.detail?.subtitle === 'string' ? event.detail.subtitle : '';
    if (!key) return;
    favoritesManager.updateSubtitle(key, subtitle);
});
window.addEventListener('favoritesUpdateIconRequest', (event) => {
    const key = typeof event?.detail?.key === 'string' ? event.detail.key : '';
    const icon = typeof event?.detail?.icon === 'string' ? event.detail.icon : '';
    if (!key) return;
    favoritesManager.updateStopIcon(key, icon);
});
window.addEventListener('favoritesOpenKeyRequest', async (event) => {
    const key = typeof event?.detail === 'string' ? event.detail : '';
    if (!key) return;

    if (key.startsWith('stop:')) {
        const { stopId, targetIds } = parseStopFavoriteKey(key);
        if (!stopId) return;
        const stop = allStops.find(s => String(s.id) === String(stopId));
        if (stop) {
            await showStopInfo(stop, false, true, true, { fromFavorites: true });
            if (targetIds.length > 0) {
                await filterManager.toggleFilterMode(stop.id, null, null, { forceEnable: true, skipFlyTo: true });
                filterManager.state.targetIds = new Set(targetIds);
                await filterManager.refreshRouteFilter(stop.id, window.lastArrivals, window.lastRoutes);
                fitFilterBounds(stop, targetIds);
            }
        }
        return;
    }

    if (key.startsWith('route:')) {
        const routeKey = key.slice('route:'.length);
        if (!routeKey) return;
        const route = allRoutes.find(r =>
            String(r.id) === routeKey ||
            String(r.shortName) === routeKey ||
            String(r.customShortName || '') === routeKey
        );
        if (route) {
            await showRouteOnMap(route, false, { fromFavorites: true });
        }
    }
});


// Copy Link Buttons Logic
const handleCopyLink = (btnId) => {
    const btn = document.getElementById(btnId);
    if (!btn) return;

    btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        e.preventDefault();

        const url = buildCurrentUrl();

        let success = false;

        try {
            // Context One: Modern API (Secure Contexts)
            if (navigator.clipboard && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(url);
                success = true;
            } else {
                throw new Error('Clipboard API unavailable');
            }
        } catch (err) {
            // Context Two: Fallback (Non-secure / Older Mobile Safari)
            console.warn('[UI] Clipboard API failed, trying fallback:', err);
            if (window.Capacitor?.isNativePlatform?.() && window.Capacitor?.getPlatform?.() === 'ios') {
                console.warn('[UI] Skipping textarea copy fallback on iOS native');
                return;
            }
            try {
                const textArea = document.createElement("textarea");
                textArea.value = url;

                // Ensure it's not visible but part of DOM
                textArea.style.position = "fixed";
                textArea.style.left = "-9999px";
                textArea.style.top = "0";
                document.body.appendChild(textArea);

                textArea.focus();
                textArea.select();

                success = document.execCommand('copy');
                document.body.removeChild(textArea);

                if (!success) console.error('[UI] Fallback copy failed.');
            } catch (fallbackErr) {
                console.error('[UI] Fallback copy error:', fallbackErr);
            }
        }

        if (success) {
            console.log('[UI] URL copied to clipboard:', url);

            // Visual feedback for both icon buttons and menu items
            btn.style.opacity = '1';
            if (!btn.classList.contains('more-menu-item')) {
                btn.style.transform = 'scale(1.1)';
            }

            setTimeout(() => {
                btn.style.opacity = '';
                btn.style.transform = '';
            }, 1000);
        } else {
            // Optional: Shake animation or error indication?
            // For now, failure remains silent to user to avoid spamming alerts, 
            // but we log critical errors.
            alert('Could not copy link. Using a secure (HTTPS) connection?');
        }
    });
};

handleCopyLink('copy-link-btn');
handleCopyLink('copy-route-link-btn');

const openStreetScreenBtn = document.getElementById('open-street-screen-btn');
if (openStreetScreenBtn) {
    openStreetScreenBtn.addEventListener('click', () => {
        closeAllMoreMenus();
        streetScreenController?.open({ syncUrl: true });
    });
}

// Helper to block map clicks briefly
function triggerMapClickLock() {
    window.ignoreMapClicks = true;
    setTimeout(() => {
        window.ignoreMapClicks = false;
    }, 500); // 500ms safety window
}

// Close panel
// Close panel
document.getElementById('close-panel').addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    triggerMapClickLock();
    closeAllMoreMenus();
    setFavoritesBackContext(false);

    console.log('[Debug] Close panel clicked');
    const panel = document.getElementById('info-panel');

    // Close Edit Mode (and persist state)
    if (typeof stopEditing === 'function') stopEditing(true);

    setSheetState(panel, 'hidden');

    try {
        window.currentStopId = null; // Clear Global State
        window.currentStopMode = null;
        window._lastRenderedStopId = null; // Clear arrivals internal state
        window.lastRoutes = [];
        window.lastArrivals = [];
        if (arrivalsController) arrivalsController.clear();
        if (window.arrivalsCountdownTimer) {
            clearInterval(window.arrivalsCountdownTimer);
            window.arrivalsCountdownTimer = null;
        }

        if (window.selectDevStop) window.selectDevStop(null); // Notify DevTools

        try { clearFilter(getActiveStopId(), { restoreStop: false }); } catch (err) { console.error('Clear Filter Error', err); }
        try { clearFilterLiveBuses(); } catch (err) { console.error('Clear Live Buses Error', err); }
        try { clearStopRouteChipLiveBuses(); } catch (err) { console.error('Clear Stop Route Chip Buses Error', err); }
        try { renderLiveBuses([]); } catch (err) { console.error('Render Live Buses Error', err); }

        // Always try to reset map focus
        try { setMapFocus(false); } catch (err) { console.error('Reset Focus Error', err); }
        try { clearStopHoverState(); } catch (err) { console.error('Clear Hover Error', err); }

        // Remove highlight
        if (map.getSource('selected-stop')) {
            map.getSource('selected-stop').setData({ type: 'FeatureCollection', features: [] });
        }
    } catch (err) {
        console.error('Error during close cleanup', err);
    } finally {
        clearHistory(); // Clear history on close
        Router.update(null, false, [], getMapHash());
    }
});

// Close Route Info
// Close Route Info
document.getElementById('close-route-info').addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    triggerMapClickLock();
    closeAllMoreMenus();
    setFavoritesBackContext(false);

    setSheetState(document.getElementById('route-info'), 'hidden');
    try { clearStopHoverState(); } catch (err) { console.error('Clear Hover Error', err); }
    clearHistory(); // Clear history on close
    clearRoute(); // Helper to clear route layers (modified to also reset focus)

    // Also reset URL when closing route info
    Router.update(null, false, [], getMapHash());
});

function clearRoute() {
    // Reset Focus (Make everything opaque again)
    setMapFocus(false);

    resetLiveBusSession();

    // Clear all route layers
    ['route', 'route-stops', 'live-buses-bg', 'live-buses-label', 'live-buses-circle', 'live-buses-arrow'].forEach(id => {
        if (map.getLayer(id)) map.removeLayer(id);
    });
    // Remove source separately if needed or just leave it
    if (map.getSource('live-buses')) map.removeSource('live-buses');
    if (map.getSource('route')) map.removeSource('route');
    if (map.getSource('route-stops')) map.removeSource('route-stops');

    // Clear ghost layers
    const style = map.getStyle();
    if (style && style.layers) {
        style.layers.forEach(layer => {
            if (layer.id.startsWith('route-ghost')) {
                map.removeLayer(layer.id);
                map.removeSource(layer.id);
            }
        });
    }
    // Explicitly clear stop selection when closing route info
    if (map.getSource('selected-stop')) {
        map.getSource('selected-stop').setData({ type: 'FeatureCollection', features: [] });
    }

    // CRITICAL: Clear global state references so we don't accidentally restore them
    currentRoute = null;
    window.currentRoute = null;
}




// Helper to Load SVG as a Raster Image for Mapbox
function loadSvgImage(map, id, url, width = 32, height = 32) {
    const img = new Image(width, height);
    img.crossOrigin = "Anonymous";
    img.onload = () => {
        // Create an intermediate canvas to ensure dimensions
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);

        const imageData = ctx.getImageData(0, 0, width, height);
        if (!map.hasImage(id)) {
            map.addImage(id, imageData, { pixelRatio: 2 }); // Higher pixel ratio for crispness
            console.log(`Debug: Successfully added icon ${id}`);
        }
    };
    img.onerror = (e) => {
        console.error(`Error loading SVG icon ${id}:`, e);
    };
    img.src = url;
}


// Updated Multi-Target Connection Line Logic with Path Separation
// Track last logged state to reduce log spam
let _lastLoggedFilterState = { originId: null, targets: '', isHover: null };

const filterTravelTimeHelper = createFilterTravelTimeHelper({
    getEquivalentStops,
    mergeSourcesMap,
    redirectMap,
    onUpdate: () => updateConnectionLine(filterManager.state.originId, filterManager.state.targetIds, false),
    filterManager
});

function getLabelOffset(key) {
    if (!key) return [0, 0];
    let hash = 0;
    for (let i = 0; i < key.length; i++) {
        hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
    }
    const offsets = [
        [0, 0],
        [0, 2.4],
        [0, -2.4],
        [2.4, 0],
        [-2.4, 0],
        [1.8, 1.8],
        [-1.8, 1.8],
        [1.8, -1.8],
        [-1.8, -1.8],
        [0, 3.2],
        [0, -3.2],
        [3.2, 0],
        [-3.2, 0],
        [2.6, 1.2],
        [-2.6, 1.2],
        [2.6, -1.2],
        [-2.6, -1.2],
        [1.2, 2.6],
        [-1.2, 2.6],
        [1.2, -2.6],
        [-1.2, -2.6]
    ];
    return offsets[hash % offsets.length];
}

function getLabelMidpointFactor(key) {
    if (!key) return 0.5;
    let hash = 0;
    for (let i = 0; i < key.length; i++) {
        hash = (hash * 33 + key.charCodeAt(i)) >>> 0;
    }
    const factors = [0.38, 0.5, 0.62];
    return factors[hash % factors.length];
}

function getLabelCandidateFactors(key) {
    if (!key) return [0.5];
    let hash = 0;
    for (let i = 0; i < key.length; i++) {
        hash = (hash * 29 + key.charCodeAt(i)) >>> 0;
    }
    const base = [0.25, 0.4, 0.55, 0.7];
    const shift = hash % base.length;
    return base.slice(shift).concat(base.slice(0, shift));
}

function distanceMeters(a, b) {
    const lat = (a[1] + b[1]) / 2;
    const mPerDegLat = 111320;
    const mPerDegLon = 111320 * Math.cos(lat * Math.PI / 180);
    const dx = (a[0] - b[0]) * mPerDegLon;
    const dy = (a[1] - b[1]) * mPerDegLat;
    return Math.sqrt(dx * dx + dy * dy);
}

function updateConnectionLine(originId, targetIdsInput, isHover = false, hoverId = null) {
    if (!originId) return;

    const isSegmentContext = filterManager?.state?.context === 'segment';
    const originOverrideSet = isSegmentContext && filterManager?.state?.originIdsOverride instanceof Set
        ? filterManager.state.originIdsOverride
        : null;
    const baseOrigins = originOverrideSet && originOverrideSet.size > 0
        ? Array.from(originOverrideSet)
        : [originId];

    // Normalize Inputs
    let targets = new Set();
    if (targetIdsInput instanceof Set) {
        targets = new Set(targetIdsInput);
    } else if (targetIdsInput) {
        targets.add(targetIdsInput);
    }

    if (isHover && hoverId) {
        targets.add(hoverId); // Add the hover target to the set to be drawn
    }

    const originStop = baseOrigins
        .map(id => allStops.find(s => s.id === id))
        .find(Boolean) || null;
    if (!originStop && !isSegmentContext) return;

    // State change tracking for potential future debugging
    const currentTargetsKey = Array.from(targets).sort().join(',');
    const originKey = baseOrigins.slice().sort().join(',');
    const stateChanged = _lastLoggedFilterState.originId !== originKey ||
        _lastLoggedFilterState.targets !== currentTargetsKey ||
        _lastLoggedFilterState.isHover !== isHover;

    if (stateChanged) {
        _lastLoggedFilterState = { originId: originKey, targets: currentTargetsKey, isHover };
    }

    const features = [];
    const allActiveSignatures = new Set();
    const labelPoints = [];
    const labeledSignatures = new Set();
    const MIN_LABEL_DISTANCE_M = 120;

    // Reset colors if this is a "real" update (active filter), not just a hover preview
    // Actually, we want to maintain consistent colors during a session.
    // If isHover only (not applied), maybe ephemeral? 
    // But typically this called by applyFilter -> permanent.
    // Let's assume the manager handles persistence.

    // Deduplicate targets by equivalence group to avoid drawing duplicate/reversed lines
    // When multiple targets are equivalent (same physical stop from different datasets),
    // we only need to draw one line for the group
    const processedEquivalenceGroups = new Set();
    const deduplicatedTargets = [];

    targets.forEach(targetId => {
        // Get equivalents for this target
        const equivalents = getEquivalentStops(targetId);
        // Create a sorted key to identify the equivalence group
        const groupKey = equivalents.slice().sort().join(',');

        if (!processedEquivalenceGroups.has(groupKey)) {
            processedEquivalenceGroups.add(groupKey);
            // Pick the best representative: prefer one with valid coordinates in allStops
            const representative = equivalents.find(id => {
                const stop = allStops.find(s => s.id === id);
                return stop && stop.lat && stop.lon && !(stop.lat === 0 && stop.lon === 0);
            }) || targetId; // Fallback to original if no valid coords found
            deduplicatedTargets.push(representative);
        }
    });

    // Process only deduplicated targets
    deduplicatedTargets.forEach(targetId => {
        const targetStop = allStops.find(s => s.id === targetId);
        if (!targetStop) return;

        // Skip stops with invalid coordinates (e.g., Rustavi equivalents with [0,0])
        // These would cause polyline slicing to find wrong points
        if (!targetStop.lat || !targetStop.lon || (targetStop.lat === 0 && targetStop.lon === 0)) {
            // Skip - stop has invalid coordinates (e.g., Rustavi equivalents with [0,0])
            return;
        }

        const targetFeatures = []; // Temporary collection for this target for quality filtering

        // Find connecting routes - only from selected origin, not all hub members
        // Hub equivalents should only be used for excluding destinations, not for route lookup
        const originIdsForRoutes = new Set();
        baseOrigins.forEach((baseId) => {
            if (!baseId) return;
            const base = String(baseId);
            originIdsForRoutes.add(base);
            // Include redirect target if this is a redirected stop
            if (redirectMap.has(base)) {
                originIdsForRoutes.add(redirectMap.get(base));
            }
            // Include merge sources if this is a parent stop
            if (mergeSourcesMap.has(base)) {
                mergeSourcesMap.get(base).forEach(s => originIdsForRoutes.add(s));
            }
        });

        const originRoutesSet = new Set();
        originIdsForRoutes.forEach(oid => {
            const routes = stopToRoutesMap.get(oid) || [];
            routes.forEach(r => originRoutesSet.add(r));
        });
        const originRoutes = Array.from(originRoutesSet);



        // Group Routes by Path Signature
        const pathGroups = new Map(); // signature -> { routes: [], patternStops: [], pattern: patternObj, originStop: stopObj }

        originRoutes.forEach(r => {
            // Strict Check Logic (Duplicates applyFilter logic but per target)
            // We need to EXTRACT the specific path segment for this route to generate signature
            let segmentStops = null;
            let matchedPattern = null;
            let originStopForGroup = null;

            const targetEq = new Set(getEquivalentStops(targetId));

            if (r._details && r._details.patterns) {
                r._details.patterns.some(p => {
                    if (!p.stops) return false;


                    // For loop routes, we need to check both O→T and T→O directions
                    // and pick the shorter segment
                    let foundO = -1;
                    let foundT = -1;
                    let foundT_beforeO = -1; // T that comes before O (for loop routes)

                    for (let i = 0; i < p.stops.length; i++) {
                        const sId = p.stops[i].id;
                        const normId = redirectMap.get(sId) || sId;

                        if (foundO === -1 && originIdsForRoutes.has(normId)) {
                            foundO = i;
                        } else if (foundO !== -1 && targetEq.has(normId)) {
                            foundT = i;
                            break; // Found first T after O, stop.
                        }
                        // Track if we found T before O (for loop detection)
                        if (foundO === -1 && targetEq.has(normId)) {
                            foundT_beforeO = i;
                        }
                    }

                    // For loop routes: if we found T before O AND T after O,
                    // compare segment lengths and pick shorter one
                    // NOTE: This logic was causing issues with bidirectional routes (e.g., 532)
                    // where finding T before O simply means we're looking at the wrong pattern
                    // (the return direction). We should only take O→T (forward) segments.
                    // The special circular route handling for 387/397 below handles actual loops.



                    if (foundO !== -1 && foundT !== -1) {
                        // For loop routes: target must be before the terminus
                        // Otherwise the stop is only reachable via the return leg, which is "unlooped"
                        const isLoopRoute = r._overrides?.isLoop === true ||
                            r._overrides?.isLoop === 'true' ||
                            (p.patternSuffix && p.patternSuffix.includes('_PART'));

                        // Fix: If it's a virtual pattern (_PART), it's already sliced linearly. Treat as standard.
                        if (isLoopRoute && !p.patternSuffix.includes('_PART')) {
                            let terminusIdx = -1;
                            const terminusStopId = r._overrides?.terminusStopIdOverride || r._overrides?.terminusStopId;
                            if (terminusStopId) {
                                terminusIdx = p.stops.findIndex(s => {
                                    const normId = redirectMap.get(s.id) || s.id;
                                    return normId === terminusStopId || s.id === terminusStopId;
                                });
                            }
                            if (terminusIdx === -1) {
                                terminusIdx = Math.ceil(p.stops.length * 0.5) - 1;
                            }
                            if (foundO <= terminusIdx && foundT > terminusIdx + 1) {
                                // Target is past terminus - skip this route for line drawing
                                return false;
                            }
                        }

                        segmentStops = p.stops.slice(foundO, foundT + 1).map(s => {
                            const normId = redirectMap.get(s.id) || s.id;
                            // Hydrate with overridden coordinates from allStops if available
                            const refStop = allStops.find(as => as.id === normId);
                            // Ensure we use the stop object ID but potentially override coords
                            return refStop ? { ...s, id: normId, lat: refStop.lat, lon: refStop.lon } : { ...s, id: normId };
                        });

                        originStopForGroup = segmentStops[0] || null;
                        matchedPattern = p;
                        return true;
                    }

                    // Wrapped route case: T only exists before O (at index 0)
                    // Special case for circular routes 387/397: bus continues from last to first stop
                    const CIRCULAR_ROUTES = ['387', '397'];
                    if (CIRCULAR_ROUTES.includes(String(r.shortName)) && foundO !== -1 && foundT === -1 && foundT_beforeO !== -1 && foundT_beforeO === 0) {
                        const firstStop = p.stops[0];
                        // Create wrapped segment: origin → end of pattern + first stop
                        const afterOrigin = p.stops.slice(foundO).map(s => {
                            const normId = redirectMap.get(s.id) || s.id;
                            const refStop = allStops.find(as => as.id === normId);
                            return refStop ? { ...s, id: normId, lat: refStop.lat, lon: refStop.lon } : { ...s, id: normId };
                        });
                        // Add the first stop (target) at the end of the segment
                        const firstStopHydrated = (() => {
                            const normId = redirectMap.get(firstStop.id) || firstStop.id;
                            const refStop = allStops.find(as => as.id === normId);
                            return refStop ? { ...firstStop, id: normId, lat: refStop.lat, lon: refStop.lon } : { ...firstStop, id: normId };
                        })();
                        segmentStops = [...afterOrigin, firstStopHydrated];
                        originStopForGroup = segmentStops[0] || null;
                        matchedPattern = p;
                        return true;
                    }

                    return false;
                });
            } else if (r.stops) {
                // Fallback
                const stops = r.stops;
                let foundO = -1;
                let foundT = -1;

                for (let i = 0; i < stops.length; i++) {
                    const sId = stops[i];
                    const normId = redirectMap.get(sId) || sId;
                    if (foundO === -1 && originIdsForRoutes.has(normId)) {
                        foundO = i;
                    } else if (foundO !== -1 && targetEq.has(normId)) {
                        foundT = i;
                        break;
                    }
                }

                if (foundO !== -1 && foundT !== -1) {
                    segmentStops = stops.slice(foundO, foundT + 1).map(sid => {
                        const normId = redirectMap.get(sid) || sid;
                        return allStops.find(s => s.id === normId);
                    }).filter(Boolean);
                    originStopForGroup = segmentStops[0] || null;
                }
            }

            if (segmentStops && segmentStops.length >= 2) {
                // Generate Signature
                // HUB COLOR LOGIC: Use HUB PARENT IDs for generating color signature
                // This ensures all routes going to the same "Hub" get the same color.
                const ids = generatePathSignature(segmentStops, null, hubMap);

                if (ids && !pathGroups.has(ids)) {
                    pathGroups.set(ids, {
                        routes: [],
                        stops: segmentStops,
                        pattern: matchedPattern,
                        originStop: originStopForGroup
                    });
                }
                if (ids) {
                    const group = pathGroups.get(ids);
                    if (group && !group.originStop && originStopForGroup) group.originStop = originStopForGroup;
                    group.routes.push(r);
                }
            }
        });

        if (pathGroups.size === 0) return; // Skip unconnected

        if (stateChanged && pathGroups.size > 0) {
            // Debug logging available if needed
        }


        // Track Active Signatures for Global GC
        for (const sig of pathGroups.keys()) {
            allActiveSignatures.add(sig);
        }

        // Process Groups
        pathGroups.forEach((group, signature) => {
            const routeIds = group.routes.map(r => r.id);

            // If the route is destined for one of our selected targets, 
            // ensure it gets the color WE assigned to it (if any).
            // But assignNextColor handles logic: if exists, return it. If not, assign and advance.
            // Wait, we need to know if this specific GROUP is heading to a *newly selected* target.
            // Actually, we can just call assignNextColor for ALL valid paths.
            // If they were already assigned (e.g. from previous select), they keep color.
            // If they are new (just selected), they get the current peek color AND queue advances.
            // But wait, if we have multiple routes to the SAME target, they share a signature?
            // Yes, grouped by signature (usually origin+dest+stops).

            // Check if this path goes to a target we care about
            if (group.pattern && group.pattern.stops) {
                const destStop = group.pattern.stops[group.pattern.stops.length - 1];
                // Check if this path eventually hits a selected target
                // Actually relying on "signature" is safer if we trust the group logic.
                // But simply: if `targetId` passed to applyFilter is in this group?
            }
            // Simplified: Just assign color for this path if it connects origin -> ANY target
            // But applyFilter is dealing with a SPECIFIC targetId addition/removal.

            // Correct approach:
            // 1. Identify if this pathGroup connects Origin -> NormTargetId
            // 2. If so, call assignNextColor(signature, routeIds).

            // We need to know which target this group serves.
            // The signature is usually based on the pattern.
            // Let's look at how we found commonRoutes.
            // commonRoutes was just a list of routes. `pathGroups` is derived from commonRoutes.

            // Determine Color Strategy
            let color;
            const isSelected = filterManager.state.targetIds && filterManager.state.targetIds.has(targetId);
            const isHoverPreview = isHover && String(targetId) === String(hoverId);

            if (isSelected) {
                // Selected: Consume/Lock Color
                color = RouteFilterColorManager.assignNextColor(signature, routeIds);
            } else if (isHoverPreview) {
                // Hover: Peek Next Color (Preview)
                color = RouteFilterColorManager.getNextColor();
                // Do NOT assign to map.
            } else {
                // Fallback (e.g. existing map but not selected? Should be covered by GC)
                const entry = RouteFilterColorManager.pathColors.get(signature);
                color = entry ? entry.color : '#888888';
            }

            const selectedPatternStops = group.stops.map(s => [s.lon, s.lat]);
            const originStopForSlice = group.originStop || originStop;

            // DEBUG: Check if stops have valid coordinates
            if (stateChanged && (originId === '3963' || originId === 3963)) {
                const validCoords = selectedPatternStops.filter(c => c[0] && c[1]);
                // console.log(`[Coords Debug] group.stops=${group.stops.length}, valid=${validCoords.length}, first=${JSON.stringify(group.stops[0])}`);
            }

            // Geometry Logic
            let finalCoordinates = null;

            // "Actual Route" Logic
            // Prioritize fetched polyline from the pattern
            // Fix: Don't downgrade selected lines when hovering. Check if THIS target is selected.
            const isPersistent = filterManager.state.targetIds && filterManager.state.targetIds.has(targetId);

            // Debug: isPersistent, isHover, targetId, patternSuffix, hasPattern, hasDecodedPolyline

            if ((isPersistent || isHover) && group.pattern) {
                const bestPattern = group.pattern;
                const bestRoute = group.routes[0]; // Just need one route ID for fetching

                // Ensure we have a suffix
                if (!bestPattern.suffix && bestPattern.patternSuffix) {
                    bestPattern.suffix = bestPattern.patternSuffix;
                }

                if (bestPattern.suffix) {
                    if (bestPattern._decodedPolyline) {
                        // Using polyline from pattern for accurate route geometry
                        try {
                            const sliced = RouteGeometry.slicePolyline(bestPattern._decodedPolyline, originStopForSlice, targetStop, group.stops);


                            // Sanity check: reject sliced polylines that are too short or don't span enough distance
                            // This prevents garbage 2-point results from replacing good spline data
                            if (sliced && sliced.length >= 5) {
                                const firstPt = sliced[0];
                                const lastPt = sliced[sliced.length - 1];
                                const dLon = lastPt[0] - firstPt[0];
                                const dLat = lastPt[1] - firstPt[1];
                                const distSq = dLon * dLon + dLat * dLat;
                                // Require at least ~100m span (0.001 degrees ≈ 100m)
                                if (distSq > 0.000001) {
                                    finalCoordinates = sliced;
                                }
                            }
                        } catch (e) {
                            console.warn('Polyline slice failed', e);
                        }
                    } else {
                        // Trigger Fetch (Cache-Only for stability during picking)
                        RouteGeometry.fetchAndCacheGeometry(bestRoute, bestPattern, { strategy: 'cache-only' }, { filterManager, updateConnectionLine });
                    }
                }
            }

            // "Simple Line" (Spline) - ALWAYS create this as base or fallback?
            // User request: "so if the stops are a little or very different, we should plot another line (first a simple stop-by stop one, then an accurate from route shape."
            // This implies showing BOTH? 
            // "first a simple stop-by stop one, then an accurate from route shape" might mean loading sequence or layering.
            // "and they should have different colors" -> Wait, user said "if the stops are a little or very different... we should plot another line".
            // This means for DIFFERENT paths, we plot different lines. 
            // "first a simple stop-by stop one, then an accurate from route shape. and they should have different colors."
            // This phrasing is slightly ambiguous. 
            // 1. Path A (Simple) vs Path A (Accurate) have different colors? NO, that's weird.
            // 2. Path A vs Path B have different colors.
            // I'm assuming Interpretation 2.

            // Fallback / Simple Geometry
            let simpleCoordinates = null;
            if (selectedPatternStops.length >= 2) {
                simpleCoordinates = RouteGeometry.getCatmullRomSpline(selectedPatternStops);
            } else if (originStopForSlice && targetStop) {
                simpleCoordinates = [[originStopForSlice.lon, originStopForSlice.lat], [targetStop.lon, targetStop.lat]];
            }

            // If we lack accurate polyline, us simpleCoordinates as the main line.
            // If we have accurate, maybe we just show accurate?
            // "first a simple stop-by stop one, then an accurate from route shape" seems to imply progressive loading.
            // I will add BOTH features if available, or just one.

            // Add Simple Feature (always, or only if no accurate?)
            // If I add both, they overlap.
            // Maybe add simple as a "halo" or base? 
            // Let's just add the best available geometry. 
            // If awaiting fetch, simple. If fetched, accurate.

            // Only show high-quality polylines (actual route geometry)
            // Skip low-quality spline fallbacks - no line is better than a wrong straight line
            if (!finalCoordinates) {
                // DEBUG: Check why no finalCoordinates
                if (stateChanged) {
                    const hasPattern = !!group.pattern;
                    const hasSuffix = hasPattern && !!group.pattern.suffix;
                    const hasDecoded = hasPattern && !!group.pattern._decodedPolyline;
                    const isFetching = hasPattern && !!group.pattern._fetchingPolyline;
                    // console.log(`[Polyline Debug] No finalCoords. hasPattern=${hasPattern}, hasSuffix=${hasSuffix}, hasDecoded=${hasDecoded}, isFetching=${isFetching}, isPersistent=${isPersistent}`);
                }

                // Trigger geometry fetch if not available
                // Use network fetch for persistent selections (skip fetching check), cache-only for hover
                if (group.pattern && group.pattern.suffix && !group.pattern._decodedPolyline) {
                    // For persistent selections, allow refetch even if already fetching
                    if (isPersistent || !group.pattern._fetchingPolyline) {
                        const bestRoute = group.routes[0];
                        const fetchOptions = isPersistent ? {} : { strategy: 'cache-only' };
                        // console.log(`[Polyline Debug] Fetching geometry for route ${bestRoute.id}/${bestRoute.shortName}, suffix=${group.pattern.suffix}`);
                        RouteGeometry.fetchAndCacheGeometry(bestRoute, group.pattern, fetchOptions, { filterManager, updateConnectionLine });
                    }
                }
                return; // Skip this path group - wait for high quality data
            }

            const activeCoords = finalCoordinates;

            // Safety: Ensure color is never null
            if (!color) {
                console.warn('[Debug] Color was null/undefined for signature:', signature, 'Using fallback.');
                color = '#888888';
            }

            const stopCount = group.stops ? Math.max(group.stops.length - 1, 0) : null;
            let travelMinutes = null;
            if (isSelected && group.routes.length > 0 && stopCount !== null) {
                const bestRoute = group.routes[0];
                const suffix = group.pattern?.patternSuffix || group.pattern?.suffix || null;
                const travelOriginId = originStopForSlice?.id || originId;
                travelMinutes = filterTravelTimeHelper.requestScheduledTravelMinutes({
                    signature,
                    routeId: bestRoute.id,
                    patternSuffix: suffix,
                    originId: travelOriginId,
                    targetId
                });
            }
            let travelLabel = null;
            if (travelMinutes && typeof travelMinutes === 'object') {
                const min = travelMinutes.min;
                const max = travelMinutes.max;
                if (min !== null && max !== null) {
                    travelLabel = (min === max)
                        ? t('filteredPlaqueMinutes', String(min))
                        : t('filteredPlaqueMinutesRange', String(min), String(max));
                }
            }
            const stopCountLabel = formatFilteredStopCount(stopCount);
            const label = (isSelected && travelLabel !== null && stopCount !== null)
                ? `${stopCountLabel}\n${travelLabel}`
                : null;
            const subLabel = (isSelected && travelLabel !== null && stopCount !== null)
                ? t('filteredPlaqueWithoutTraffic')
                : null;

            // Quality Indicator
            const quality = 'high'; // We only reach here with finalCoordinates

            // DEBUG: Check coordinates validity
            if (stateChanged && activeCoords && activeCoords.length > 0) {
                const first = activeCoords[0];
                const last = activeCoords[activeCoords.length - 1];
                // console.log(`[Polyline Debug] quality=${quality}, color=${color}, coords: first=[${first}], last=[${last}], total=${activeCoords.length}`);
            }

            targetFeatures.push({
                type: 'Feature',
                geometry: {
                    type: 'LineString',
                    coordinates: activeCoords
                },
                properties: {
                    color: color,
                    lineWidth: 4,
                    opacity: 0.8,
                    quality: quality, // Used for local dedup
                    label: label,
                    subLabel: subLabel
                }
            });

            if (label && Array.isArray(activeCoords) && activeCoords.length > 0) {
                if (labeledSignatures.has(signature)) return;
                const labelKey = `${signature}|${targetId}`;
                const candidates = getLabelCandidateFactors(labelKey)
                    .map(f => Math.max(0, Math.min(activeCoords.length - 1, Math.floor(activeCoords.length * f))))
                    .map(idx => activeCoords[idx]);
                const fallbackFactor = getLabelMidpointFactor(labelKey);
                candidates.push(activeCoords[Math.max(0, Math.min(activeCoords.length - 1, Math.floor(activeCoords.length * fallbackFactor)))]);

                let midCoord = candidates[0];
                for (const candidate of candidates) {
                    if (!candidate || candidate.length !== 2) continue;
                    const tooClose = labelPoints.some(p => distanceMeters(candidate, p) < MIN_LABEL_DISTANCE_M);
                    if (!tooClose) {
                        midCoord = candidate;
                        break;
                    }
                }
                if (midCoord && midCoord.length === 2) {
                    const offset = getLabelOffset(labelKey);
                    const labelOffset = [offset[0], 0];
                    targetFeatures.push({
                        type: 'Feature',
                        geometry: {
                            type: 'Point',
                            coordinates: midCoord
                        },
                        properties: {
                            color: color,
                            label: label,
                            subLabel: subLabel,
                            labelOffset: labelOffset,
                            subLabelOffset: [labelOffset[0], 2.4],
                            quality: quality
                        }
                    });
                    labelPoints.push(midCoord);
                    labeledSignatures.add(signature);
                }
            }
        });

        // Dedup/Filter Logic per Target
        // All features are now high quality (we skip low quality above)
        const finalFeatures = targetFeatures;

        // Quality filter: prefer high-quality polylines over splines

        features.push(...finalFeatures);
    });

    // Garbage Collect Unused Colors (Global)
    RouteFilterColorManager.gc(allActiveSignatures);

    // Update Source
    const source = map.getSource('filter-connection');
    if (source) {
        if (features.length > 0 && stateChanged) {
            // console.log(`[Polyline Debug] Setting ${features.length} features to filter-connection source`);
        }
        source.setData({ type: 'FeatureCollection', features: features });
    } else {
        console.warn('[Polyline Debug] filter-connection source NOT FOUND!');
    }

    // Switch to Data-Driven Styling if needed
    if (map.getLayer('filter-connection-line')) {
        map.setPaintProperty('filter-connection-line', 'line-color', ['get', 'color']);
        map.setPaintProperty('filter-connection-line', 'line-width', 4); // Fixed width or data driven
        map.setPaintProperty('filter-connection-line', 'line-opacity', 0.8);
    } else {
        console.warn('[Polyline Debug] filter-connection-line layer NOT FOUND!');
    }
}


// --- Edit Tools Integration ---

// --- Route Overrides Logic ---
let routesConfig = { routeOverrides: {} };
window.routesConfig = routesConfig;

async function loadRoutesConfig() {
    try {
        let csvText = await getOtaDataFileText('routes_overrides.csv');
        let foundConfig = !!csvText;

        if (!csvText) {
            const basePath = import.meta.env.BASE_URL.endsWith('/') ? import.meta.env.BASE_URL : `${import.meta.env.BASE_URL}/`;
            // Add cache buster to ensure fresh config on reload
            const response = await fetch(`${basePath}data/routes_overrides.csv?v=${Date.now()}`);
            if (response.ok) {
                csvText = await response.text();
                foundConfig = true;
            } else if (response.status === 404) {
                foundConfig = false;
            } else {
                throw new Error(`Failed to load routes_overrides.csv: ${response.status}`);
            }
        }

        if (foundConfig && csvText) {
            // Parse CSV and extract overrides
            const { parseCSV, extractOverrides } = await import('./csv-parser.js');
            const rows = parseCSV(csvText);
            const overrides = extractOverrides(rows, 'id');

            routesConfig = { routeOverrides: overrides };
            window.routesConfig = routesConfig;

            // Also store overrides with stripped keys for easier matching
            // (e.g., "1:R12237" -> also store as "R12237")
            Object.keys(overrides).forEach(key => {
                if (key.includes(':')) {
                    const stripped = key.split(':')[1];
                    if (!overrides[stripped]) {
                        overrides[stripped] = overrides[key];
                    }
                    // Also store with r-prefix for Rustavi routes (e.g., R12237 -> rR12237)
                    if (stripped.startsWith('R') && !stripped.startsWith('Ru')) {
                        const rPrefixed = 'r' + stripped;
                        if (!overrides[rPrefixed]) {
                            overrides[rPrefixed] = overrides[key];
                        }
                    }
                }
            });

            console.log('[Config] Loaded routes config from CSV', Object.keys(overrides).length, 'overrides');
            if (allRoutes && allRoutes.length > 0) applyRouteOverrides();
        } else {
            routesConfig = { routeOverrides: {} };
            window.routesConfig = routesConfig;
        }
    } catch (e) {
        console.warn('Failed to load routes_overrides.csv', e);
        routesConfig = { routeOverrides: {} };
        window.routesConfig = routesConfig;
    }
}

function applyRouteOverrides() {
    if (!window.routesConfig?.routeOverrides) {
        // console.log('[Config] No local route overrides found.');
        return;
    }
    console.log('[Config] Applying Route Overrides...', Object.keys(window.routesConfig.routeOverrides).length);

    // --- LEGACY CODE (ENABLED) ---

    // Detect locale loosely or assume EN/KA based on something? 
    // Ideally we want to patch the object with the *correct* locale string.
    // BUT `allRoutes` is usually monolingual based on what was fetched.
    // If we loaded EN routes, `longName` is EN.
    // If we have an override, we should check if we have an override for that locale.

    // We can infer locale from document.documentElement.lang or URL? 
    // Or just look at what's in `allRoutes`? 
    // Actually, `api.js` loads specific locale files.
    // Let's assume we patch `longName` if a matching locale override exists.
    // AND we attach `_overrides` object for components that support dual-lang or dynamic reuse.

    const locale = getCurrentStopNamesLanguage();

    let updateCount = 0;

    allRoutes.forEach(route => {
        // Robust ID Matching: Check raw, stripped, and multiple prefixes
        let override = window.routesConfig.routeOverrides[route.id];

        // Try stripping prefix (e.g., "2:R12237" -> "R12237")
        if (!override && route.id.includes(':')) {
            const stripped = route.id.split(':')[1];
            override = window.routesConfig.routeOverrides[stripped];

            // Try with 1: prefix (CSV uses 1: for all routes including Rustavi)
            if (!override) {
                override = window.routesConfig.routeOverrides[`1:${stripped}`];
            }
        }

        // Try adding prefix if no colon
        if (!override && !route.id.includes(':')) {
            override = window.routesConfig.routeOverrides[`1:${route.id}`];
            if (!override) {
                override = window.routesConfig.routeOverrides[`2:${route.id}`];
            }
        }

        // Handle Rustavi r-prefix (e.g., "rR12237" -> try "R12237" and "1:R12237")
        if (!override && route.id.startsWith('r')) {
            const withoutR = route.id.substring(1); // "rR12237" -> "R12237"
            override = window.routesConfig.routeOverrides[withoutR];
            if (!override) {
                override = window.routesConfig.routeOverrides[`1:${withoutR}`];
            }
        }

        // Debug specific route
        if (route.id === '1:minibusR1265' || route.id === 'minibusR1265') {
            // console.log(`[Config Debug] Route 466 ID: ${route.id}`);
            // console.log(`[Config Debug] Direct lookup:`, window.routesConfig.routeOverrides[route.id]);
            // console.log(`[Config Debug] Found override:`, !!override, override);
        }

        // Rustavi route debug disabled - CSV needs Rustavi entries

        // DEBUG: Log first 3 routes to check ID format
        /*
        if (updateCount < 3) {
             // console.log(`[Config] Checking route ID: '${route.id}'. Override exists? ${!!override}`);
        }
        */

        if (override) {
            updateCount++;
            if (override.terminusStopIdOverride && !override.terminusStopId_override) {
                override.terminusStopId_override = override.terminusStopIdOverride;
            }
            route._overrides = override; // Attach for reference
            if (override.shortName) route.customShortName = override.shortName; // Display Alias
            // Do NOT overwrite route.shortName to preserve URLs and linking logic
            if (override.color) route.color = override.color;
            if (override.textColor) route.textColor = override.textColor;

            // Complex overrides (destinations, longName) are handled during render/details

            if (override.longName && override.longName[locale]) {
                route.longName = override.longName[locale];
            }
        }
    });

    console.log(`[Config] Applied overrides to ${updateCount} routes.`);
}



// --- Initialize Edit Tools ---
setupEditTools(map, {
    getAllStops: () => allStops,
    getAllRoutes: () => allRoutes,
    getMergeSourcesMap: () => mergeSourcesMap,
    getHubMap: () => hubMap,
    getHubSourcesMap: () => hubSourcesMap,
    getStopToRoutesMap: () => stopToRoutesMap,
    getEditState: getEditState
}, {
    refreshStopsLayer,
    updateMapFilterState,
    setSheetState,
    renderAllRoutes,
    checkDirtyState: () => { } // handled internally or not needed
});

// --- Keyboard Listeners ---
window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        // 1. All Routes Editor (High priority Modal)
        const allRoutesEditor = document.getElementById('all-routes-editor');
        if (allRoutesEditor && !allRoutesEditor.classList.contains('hidden')) {
            document.getElementById('close-all-routes-editor')?.click();
            return;
        }

        // 2. Search Suggestions
        const searchInput = document.getElementById('search-input');
        const suggestions = document.getElementById('search-suggestions');
        if (document.activeElement === searchInput || (suggestions && !suggestions.classList.contains('hidden'))) {
            dismissSearch();
            return;
        }

        // 3. Settings Menu
        const settingsMenu = document.getElementById('map-menu-popup');
        if (settingsMenu && !settingsMenu.classList.contains('hidden')) {
            settingsMenu.classList.add('hidden');
            return;
        }

        // 4. Sheets (Step-by-step: Route Info then Info Panel)
        const routeInfo = document.getElementById('route-info');
        if (routeInfo && !routeInfo.classList.contains('hidden')) {
            document.getElementById('close-route-info')?.click();
            return;
        }

        const infoPanel = document.getElementById('info-panel');
        if (infoPanel && !infoPanel.classList.contains('hidden')) {
            document.getElementById('close-panel')?.click();
            return;
        }
    }
});

loadRoutesConfig();

/* Map Menu & Simplify Logic */
