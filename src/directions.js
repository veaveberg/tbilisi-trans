import mapboxgl from 'mapbox-gl';
import { Router } from './router.js';
import { map, getMapHash } from './map-setup.js';
import { setPanelState, setSheetState } from './panel-manager.js';
import { buildDirectionsPath, getDirectionsCanonicalState } from './directions-url.js';
import { fetchDirections } from './directions-api.js';
import { getRoutesForStopStatic, getStaticRouteDetails, MAPBOX_TOKEN } from './api.js';
import { getCurrentUiLanguage, getCurrentStopNamesLanguage, getCurrentMapLanguage, onLanguageChange, t } from './i18n.ts';
import { getSegmentForStop, generateSegmentGeometry, generateConnectionGeometry, getConnectionKey } from './metro-utils.js';
import { setMapFocus } from './map-interactions.js';
import { getLastUserCoords, stopTracking } from './geolocation.js';
import { fetchArrivals, getArrivalMinutesValue, formatArrivalDisplayValue, formatScheduledTime, shouldShowLateDepotWarning, getV3Schedule, isArrivalsLiveDataStale } from './arrivals.js';
import { getBandPadding } from './map-camera.js';

let metroSegments = null;
let metroMidpoints = null;

async function ensureMetroSchematicData() {
    if (metroSegments) return;
    try {
        const basePath = import.meta.env.BASE_URL.endsWith('/') ? import.meta.env.BASE_URL : `${import.meta.env.BASE_URL}/`;
        const segmentsUrl = `${basePath}data/metro_segments.json`;
        const midpointsUrl = `${basePath}data/metro_midpoints.json`;
        
        const [segments, midpoints] = await Promise.all([
            fetch(segmentsUrl).then(res => res.json()),
            fetch(midpointsUrl).then(res => res.ok ? res.json() : {}).catch(() => ({}))
        ]);
        metroSegments = segments;
        metroMidpoints = midpoints;
    } catch (e) {
        console.error('[Directions] Failed to load metro schematic data', e);
    }
}

const METRO_STATIONS_MAP = {
    'varketili': 'metro_1_16',
    'samgori': 'metro_1_15',
    'isani': 'metro_1_14',
    '300 aragveli': 'metro_1_13',
    'avlabari': 'metro_1_12',
    'liberty square': 'metro_1_11',
    'freedom square': 'metro_1_11',
    'rustaveli': 'metro_1_10',
    'marjanishvili': 'metro_1_9',
    'station square': 'metro_1_8',
    'station square 1': 'metro_1_8',
    'station square 2': 'metro_2_1',
    'nadzaladevi': 'metro_1_7',
    'gotsiridze': 'metro_1_6',
    'didube': 'metro_1_5',
    'ghrmaghele': 'metro_1_4',
    'grmaghele': 'metro_1_4',
    'guramishvili': 'metro_1_3',
    'sarajishvili': 'metro_1_2',
    'akhmeteli theatre': 'metro_1_1',
    'tsereteli': 'metro_2_2',
    'technical university': 'metro_2_3',
    'technical univercity': 'metro_2_3',
    'technacal university': 'metro_2_3',
    'techinacal university': 'metro_2_3',
    'medical university': 'metro_2_4',
    'delisi': 'metro_2_5',
    'vazha-pshavela': 'metro_2_6',
    'vazha pshavela': 'metro_2_6',
    'state university': 'metro_2_7'
};

function resolveMetroSegmentId(name, lineNum) {
    if (!name) return null;
    const clean = name.replace(/^m\/s\s+/i, '')
                      .replace(/metro station/gi, '')
                      .trim()
                      .toLowerCase();
    if (clean === 'station square') {
        return lineNum === 2 ? 'metro_2_1' : 'metro_1_8';
    }
    return METRO_STATIONS_MAP[clean] || null;
}

const METRO_CLEAN_NAMES = {
    'metro_1_16': { en: 'Varketili', ka: 'ვარკეთილი' },
    'metro_1_15': { en: 'Samgori', ka: 'სამგორი' },
    'metro_1_14': { en: 'Isani', ka: 'ისანი' },
    'metro_1_13': { en: '300 Aragveli', ka: '300 არაგველი' },
    'metro_1_12': { en: 'Avlabari', ka: 'ავლაბარი' },
    'metro_1_11': { en: 'Liberty Square', ka: 'თავისუფლების მოედანი' },
    'metro_1_10': { en: 'Rustaveli', ka: 'რუსთაველი' },
    'metro_1_9': { en: 'Marjanishvili', ka: 'მარჯანიშვილი' },
    'metro_1_8': { en: 'Station Square', ka: 'სადგურის მოედანი' },
    'metro_1_7': { en: 'Nadzaladevi', ka: 'ნაძალადევი' },
    'metro_1_6': { en: 'Gotsiridze', ka: 'გოცირიძე' },
    'metro_1_5': { en: 'Didube', ka: 'დიდუბე' },
    'metro_1_4': { en: 'Ghrmaghele', ka: 'ღრმაღელე' },
    'metro_1_3': { en: 'Guramishvili', ka: 'გურამიშვილი' },
    'metro_1_2': { en: 'Sarajishvili', ka: 'სარაჯიშვილი' },
    'metro_1_1': { en: 'Akhmeteli Theatre', ka: 'ახმეტელის თეატრი' },
    'metro_2_1': { en: 'Station Square', ka: 'სადგურის მოედანი' },
    'metro_2_2': { en: 'Tsereteli', ka: 'წერეთელი' },
    'metro_2_3': { en: 'Technical University', ka: 'ტექნიკური უნივერსიტეტი' },
    'metro_2_4': { en: 'Medical University', ka: 'სამედიცინო უნივერსიტეტი' },
    'metro_2_5': { en: 'Delisi', ka: 'დელისი' },
    'metro_2_6': { en: 'Vazha-Pshavela', ka: 'ვაჟა-ფშაველა' },
    'metro_2_7': { en: 'State University', ka: 'სახელმწიფო უნივერსიტეტი' }
};

function getCleanMetroName(rawName, lineNum) {
    if (!rawName) return rawName;
    const segmentId = resolveMetroSegmentId(rawName, lineNum);
    if (!segmentId) return rawName;

    const names = METRO_CLEAN_NAMES[segmentId];
    if (!names) return rawName;

    const locale = getCurrentStopNamesLanguage ? getCurrentStopNamesLanguage() : 'en';
    return locale === 'ka' ? (names.ka || names.en) : (names.en || names.ka);
}

const LINE_1_SEQUENCE = Array.from({ length: 16 }, (_, i) => `metro_1_${i + 1}`);
const LINE_2_SEQUENCE = Array.from({ length: 7 }, (_, i) => `metro_2_${i + 1}`);

function getSubwayLegCoordinates(fromName, toName, shortName) {
    if (!metroSegments) return null;

    const lineNum = Number(shortName) === 2 ? 2 : 1;
    const fromId = resolveMetroSegmentId(fromName, lineNum);
    const toId = resolveMetroSegmentId(toName, lineNum);

    if (!fromId || !toId || fromId === toId) return null;

    const seq = lineNum === 2 ? LINE_2_SEQUENCE : LINE_1_SEQUENCE;
    const idxA = seq.indexOf(fromId);
    const idxB = seq.indexOf(toId);

    if (idxA === -1 || idxB === -1) return null;

    const isForward = idxA < idxB;
    const subSeq = isForward
        ? seq.slice(idxA, idxB + 1)
        : seq.slice(idxB, idxA + 1).reverse();

    const coords = [];

    for (let i = 0; i < subSeq.length; i++) {
        const id = subSeq[i];
        const seg = getSegmentForStop({ id }, metroSegments);
        if (!seg) continue;

        const geom = generateSegmentGeometry(seg);
        if (isForward) {
            coords.push(geom.leftPt, geom.rightPt);
        } else {
            coords.push(geom.rightPt, geom.leftPt);
        }

        if (i < subSeq.length - 1) {
            const nextId = subSeq[i + 1];
            
            // Always generate connection from topologically lower station to higher station
            const idAIndex = seq.indexOf(id);
            const nextIdIndex = seq.indexOf(nextId);
            const firstId = idAIndex < nextIdIndex ? id : nextId;
            const secondId = idAIndex < nextIdIndex ? nextId : id;

            const firstSeg = getSegmentForStop({ id: firstId }, metroSegments);
            const secondSeg = getSegmentForStop({ id: secondId }, metroSegments);

            const connKey = getConnectionKey(firstId, secondId);
            const connMidpoints = metroMidpoints ? (metroMidpoints[connKey] || []) : [];
            const connGeom = generateConnectionGeometry(firstSeg, secondSeg, connMidpoints);

            if (connGeom && connGeom.coordinates) {
                if (isForward) {
                    coords.push(...connGeom.coordinates);
                } else {
                    coords.push(...[...connGeom.coordinates].reverse());
                }
            }
        }
    }

    return coords;
}

const state = {
    from: null,
    to: null,
    contextPoint: null,
    isSuspended: false,
    hasCompletedFirstUseDefault: false,
    loadingGeocode: {
        from: false,
        to: false
    },
    geocodingInProgress: {
        from: false,
        to: false
    },
    markers: {
        from: null,
        to: null
    },
    routing: {
        requestId: 0,
        abortController: null,
        debounceTimer: null,
        result: null,
        selectedRouteIndex: 0,
        status: 'idle',
        message: '',
        transferMarkers: []
    },
    time: {
        mode: 'leaveNow',
        value: new Date(),
        calendarMonth: new Date(),
        calendarOpen: false,
        tempValue: null,
        tempMode: null
    }
};

const POINT_LAYERS_ALLOWLIST = [
    'stops',
    'metro',
    'gondola'
];

const DIRECTIONS_MODE_ORDER = ['BUS', 'SUBWAY', 'GONDOLA'];
const DIRECTIONS_ROUTE_SOURCE_ID = 'directions-route';
const DIRECTIONS_ROUTE_CASING_LAYER_ID = 'directions-route-casing';
const DIRECTIONS_ROUTE_LAYER_ID = 'directions-route-line';
const DIRECTIONS_ROUTE_WALK_LAYER_ID = 'directions-route-walk-line';
const DIRECTIONS_ROUTE_STOPS_SOURCE_ID = 'directions-route-stops';
const DIRECTIONS_ROUTE_STOPS_LAYER_ID = 'directions-route-stops-layer';
const EMPTY_FEATURE_COLLECTION = { type: 'FeatureCollection', features: [] };

function formatCoordinate(lngLat) {
    return `${lngLat.lat.toFixed(5)}, ${lngLat.lng.toFixed(5)}`;
}

function normalizeLngLat(value) {
    if (!value) return null;
    if (typeof value.lng === 'number' && typeof value.lat === 'number') {
        return { lng: value.lng, lat: value.lat };
    }
    if (Array.isArray(value) && value.length >= 2) {
        return { lng: Number(value[0]), lat: Number(value[1]) };
    }
    return null;
}

function getSelectedModeValues() {
    return DIRECTIONS_MODE_ORDER
        .map((id) => document.getElementById(`directions-mode-${id.toLowerCase()}`))
        .filter((input) => input?.checked)
        .map((input) => input.value);
}

function setSelectedModeValues(selectedModes = []) {
    const selected = new Set((selectedModes || []).map((value) => String(value || '').trim().toUpperCase()));
    DIRECTIONS_MODE_ORDER.forEach((mode) => {
        const input = document.getElementById(`directions-mode-${mode.toLowerCase()}`);
        if (!input) return;
        input.checked = selected.has(mode);
    });
}

function getSelectedOptimizeValue() {
    return document.querySelector('input[name="directions-optimize"]:checked')?.value || 'quick';
}

function setSelectedOptimizeValue(value = 'quick') {
    const next = String(value || 'quick');
    document.querySelectorAll('input[name="directions-optimize"]').forEach((input) => {
        input.checked = input.value === next;
    });
    syncSegmentedActiveState('directions-optimize');
}

const STORAGE_KEY = 'directions_draft_state';

function saveDirectionsStateToStorage() {
    try {
        const data = {
            from: state.from,
            to: state.to,
            timeMode: state.time.mode,
            timeValue: state.time.mode === 'leaveNow' ? null : (state.time.value instanceof Date ? state.time.value.getTime() : new Date(state.time.value).getTime()),
            selectedModes: getSelectedModeValues(),
            optimize: getSelectedOptimizeValue(),
            hasCompletedFirstUseDefault: state.hasCompletedFirstUseDefault
        };
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (err) {
        console.error('Failed to save directions state to sessionStorage', err);
    }
}

function loadDirectionsStateFromStorage() {
    try {
        const raw = sessionStorage.getItem(STORAGE_KEY);
        if (!raw) return false;
        const data = JSON.parse(raw);
        if (!data) return false;

        state.from = data.from;
        state.to = data.to;
        state.hasCompletedFirstUseDefault = !!data.hasCompletedFirstUseDefault;

        if (data.from) renderMarker('from');
        if (data.to) renderMarker('to');

        if (data.timeMode) {
            state.time.mode = data.timeMode;
        }
        if (data.timeValue) {
            state.time.value = new Date(data.timeValue);
        } else {
            state.time.value = new Date();
        }

        if (data.selectedModes) {
            setSelectedModeValues(data.selectedModes);
        }
        if (data.optimize) {
            setSelectedOptimizeValue(data.optimize);
        }
        return !!(state.from || state.to);
    } catch (err) {
        console.error('Failed to load directions state from sessionStorage', err);
        return false;
    }
}

function syncDirectionsUrl() {
    const canonical = getDirectionsCanonicalState({
        from: state.from,
        to: state.to,
        selectedModes: getSelectedModeValues(),
        optimize: getSelectedOptimizeValue(),
        timeMode: state.time.mode,
        time: state.time.mode === 'leaveNow' ? null : state.time.value
    });

    saveDirectionsStateToStorage();

    const path = buildDirectionsPath(canonical);

    if (path) {
        Router.updateDirections(canonical);
        return;
    }

    if (Router.isDirectionsPath()) {
        history.replaceState(null, '', `${Router.base}${getMapHash()}`);
    }
}

function restoreMapUrl() {
    history.replaceState(null, '', `${Router.base}${getMapHash()}`);
}

function getModeColor(mode, fallbackColor) {
    if (fallbackColor) return fallbackColor;
    switch (String(mode || '').toUpperCase()) {
        case 'BUS':
            return '#2563eb';
        case 'SUBWAY':
        case 'METRO':
            return '#e11d48';
        case 'GONDOLA':
        case 'CABLE_CAR':
            return document.body.classList.contains('dark-mode') ? '#2DD4BF' : '#0D9488';
        case 'WALK':
            return '#64748b';
        default:
            return '#0a84ff';
    }
}

function ensureDirectionsRouteLayers() {
    if (!map) {
        console.warn('[DirectionsPlot] ensureDirectionsRouteLayers called, but map is null');
        return false;
    }
    const hasStyle = !!map.getStyle();
    console.log(`[DirectionsPlot] ensureDirectionsRouteLayers called. hasStyle=${hasStyle}, isStyleLoaded=${map.isStyleLoaded()}`);
    if (!hasStyle) return false;

    if (!map.getSource(DIRECTIONS_ROUTE_SOURCE_ID)) {
        console.log(`[DirectionsPlot] Creating source: ${DIRECTIONS_ROUTE_SOURCE_ID}`);
        map.addSource(DIRECTIONS_ROUTE_SOURCE_ID, {
            type: 'geojson',
            data: EMPTY_FEATURE_COLLECTION
        });
    }

    const beforeLayer = map.getLayer('stops-layer') ? 'stops-layer' : undefined;
    console.log(`[DirectionsPlot] beforeLayer for placement: ${beforeLayer}`);

    if (!map.getLayer(DIRECTIONS_ROUTE_LAYER_ID)) {
        console.log(`[DirectionsPlot] Creating layer: ${DIRECTIONS_ROUTE_LAYER_ID}`);
        map.addLayer({
            id: DIRECTIONS_ROUTE_LAYER_ID,
            type: 'line',
            source: DIRECTIONS_ROUTE_SOURCE_ID,
            slot: 'top',
            filter: ['!=', ['get', 'mode'], 'WALK'],
            layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: {
                'line-color': ['coalesce', ['get', 'color'], '#0a84ff'],
                'line-width': [
                    'match',
                    ['get', 'mode'],
                    'SUBWAY', 7,
                    'METRO', 7,
                    12 // default (bus/minibus/etc.)
                ],
                'line-opacity': [
                    'match',
                    ['get', 'mode'],
                    'SUBWAY', 0.92,
                    'METRO', 0.92,
                    0.8 // default (bus/minibus/etc.)
                ],
                'line-emissive-strength': 1
            }
        }, beforeLayer);
    }

    if (!map.getLayer(DIRECTIONS_ROUTE_WALK_LAYER_ID)) {
        console.log(`[DirectionsPlot] Creating layer: ${DIRECTIONS_ROUTE_WALK_LAYER_ID}`);
        const isDark = document.body.classList.contains('dark-mode');
        map.addLayer({
            id: DIRECTIONS_ROUTE_WALK_LAYER_ID,
            type: 'line',
            source: DIRECTIONS_ROUTE_SOURCE_ID,
            slot: 'top',
            filter: ['==', ['get', 'mode'], 'WALK'],
            layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: {
                'line-color': isDark ? '#ffffff' : '#000000',
                'line-width': 4,
                'line-opacity': 0.8,
                'line-dasharray': [2, 2],
                'line-emissive-strength': 1
            }
        }, beforeLayer);
    }

    if (!map.getSource(DIRECTIONS_ROUTE_STOPS_SOURCE_ID)) {
        console.log(`[DirectionsPlot] Creating source: ${DIRECTIONS_ROUTE_STOPS_SOURCE_ID}`);
        map.addSource(DIRECTIONS_ROUTE_STOPS_SOURCE_ID, {
            type: 'geojson',
            data: EMPTY_FEATURE_COLLECTION
        });
    }

    if (!map.getLayer(DIRECTIONS_ROUTE_STOPS_LAYER_ID)) {
        console.log(`[DirectionsPlot] Creating layer: ${DIRECTIONS_ROUTE_STOPS_LAYER_ID}`);
        map.addLayer({
            id: DIRECTIONS_ROUTE_STOPS_LAYER_ID,
            type: 'circle',
            source: DIRECTIONS_ROUTE_STOPS_SOURCE_ID,
            slot: 'top',
            paint: {
                'circle-color': '#ffffff',
                'circle-radius': 3,
                'circle-stroke-width': 0,
                'circle-opacity': 1,
                'circle-emissive-strength': 1
            }
        }, beforeLayer);
    }

    return true;
}

function clearDirectionsRoute() {
    clearTransferMarkers();
    stopDirectionsRefreshTimer();
    state.routing.requestId += 1;
    if (state.routing.abortController) {
        state.routing.abortController.abort();
        state.routing.abortController = null;
    }
    if (state.routing.debounceTimer) {
        clearTimeout(state.routing.debounceTimer);
        state.routing.debounceTimer = null;
    }
    const source = map?.getSource?.(DIRECTIONS_ROUTE_SOURCE_ID);
    if (source) source.setData(EMPTY_FEATURE_COLLECTION);

    const stopsSource = map?.getSource?.(DIRECTIONS_ROUTE_STOPS_SOURCE_ID);
    if (stopsSource) stopsSource.setData(EMPTY_FEATURE_COLLECTION);

    state.routing.result = null;
    state.routing.selectedRouteIndex = 0;

    if (typeof setMapFocus === 'function') {
        setMapFocus(false);
    }
}

function buildRouteFeatures(result, routeIndex = 0) {
    const route = result?.routes?.[routeIndex];
    if (!route?.segments?.length) return EMPTY_FEATURE_COLLECTION;

    return {
        type: 'FeatureCollection',
        features: route.segments
            .filter((segment) => Array.isArray(segment.coordinates) && segment.coordinates.length > 1)
            .map((segment, index) => {
                let coords = segment.coordinates;
                const modeUpper = String(segment.mode || 'ROUTE').toUpperCase();
                if (modeUpper === 'SUBWAY' || modeUpper === 'METRO') {
                    const customCoords = getSubwayLegCoordinates(segment.from?.name, segment.to?.name, segment.routeShortName);
                    if (customCoords && customCoords.length > 0) {
                        coords = customCoords;
                    }
                }

                return {
                    type: 'Feature',
                    geometry: {
                        type: 'LineString',
                        coordinates: coords
                    },
                    properties: {
                        id: segment.id || String(index),
                        mode: modeUpper,
                        color: getRouteColorByShortName(segment.routeShortName, segment.from, segment.to, segment.mode) || getModeColor(segment.mode, segment.color),
                        text: segment.text || ''
                    }
                };
            })
    };
}

function buildRouteStopsFeatures(result, routeIndex = 0) {
    const route = result?.routes?.[routeIndex];
    if (!route?.segments?.length) return EMPTY_FEATURE_COLLECTION;

    const features = [];
    const redirectMap = window.dataProvider?.getRedirectMap?.() || new Map();
    const allStops = window.allStops || [];
    const seenIds = new Set();

    // Helper to get merged coordinates for a stop/point
    function getMergedCoords(stop) {
        if (!stop) return null;
        const rawId = stop.stopId || stop.id;
        if (rawId) {
            const cleanId = String(rawId).split(':').pop();
            const normId = redirectMap.get(cleanId) || cleanId;
            const existingStop = allStops.find(s => String(s.id) === String(normId));
            if (existingStop) {
                return {
                    coordinates: [existingStop.lon, existingStop.lat],
                    canonicalId: normId
                };
            }
        }
        const lon = stop.lon != null ? stop.lon : stop.lng;
        if (stop.lat != null && lon != null) {
            return {
                coordinates: [lon, stop.lat],
                canonicalId: rawId ? String(rawId).split(':').pop() : `${lon.toFixed(5)},${stop.lat.toFixed(5)}`
            };
        }
        return null;
    }

    function addStopFeature(stop) {
        if (!stop) return;
        const info = getMergedCoords(stop);
        if (!info) return;

        if (seenIds.has(info.canonicalId)) return;
        seenIds.add(info.canonicalId);

        features.push({
            type: 'Feature',
            geometry: {
                type: 'Point',
                coordinates: info.coordinates
            },
            properties: { name: stop.name || '' }
        });
    }

    route.segments.forEach(segment => {
        const mode = String(segment.mode || '').toUpperCase();
        if (mode === 'WALK' || mode === 'SUBWAY' || mode === 'METRO') return; // Do not show stops on walk/metro segments

        // 1. Add start stop
        addStopFeature(segment.from);

        // 2. Add intermediate stops
        if (Array.isArray(segment.intermediateStops)) {
            segment.intermediateStops.forEach(addStopFeature);
        }

        // 3. Add end stop
        addStopFeature(segment.to);
    });

    return {
        type: 'FeatureCollection',
        features
    };
}

function fitDirectionsRoute(featureCollection) {
    const coords = featureCollection.features.flatMap((feature) => feature.geometry.coordinates || []);
    console.log(`[DirectionsPlot] fitDirectionsRoute called. Coordinates count: ${coords.length}`);
    if (!coords.length) {
        console.warn('[DirectionsPlot] fitDirectionsRoute: No coordinates to fit bounds to.');
        return;
    }

    const bounds = new mapboxgl.LngLatBounds();
    coords.forEach((coord) => bounds.extend(coord));
    if (bounds.isEmpty()) {
        console.warn('[DirectionsPlot] fitDirectionsRoute: Computed bounds are empty.');
        return;
    }

    const searchWrapper = document.querySelector('.search-wrapper');
    let topPadding = 80;
    if (searchWrapper) {
        const rect = searchWrapper.getBoundingClientRect();
        if (rect.height > 0 && rect.bottom > 0) {
            topPadding = Math.max(80, rect.bottom + 20);
        }
    }

    const panelPadding = getBandPadding({
        topAnchorSelector: '.search-wrapper',
        bottomAnchorSelector: '#directions-panel',
        topMargin: 20,
        topFallback: topPadding,
        bottomMargin: 16
    });

    map.fitBounds(bounds, {
        padding: panelPadding,
        maxZoom: 15,
        duration: 900,
        retainPadding: false
    });
}

function getStopLngLat(stop) {
    if (!stop) return null;
    const lon = stop.lon != null ? stop.lon : stop.lng;
    if (stop.lat != null && lon != null) {
        return [Number(lon), Number(stop.lat)];
    }
    return null;
}

function getDistanceInMeters(lat1, lon1, lat2, lon2) {
    const R = 6371e3; // meters
    const phi1 = lat1 * Math.PI / 180;
    const phi2 = lat2 * Math.PI / 180;
    const deltaPhi = (lat2 - lat1) * Math.PI / 180;
    const deltaLambda = (lon2 - lon1) * Math.PI / 180;

    const a = Math.sin(deltaPhi / 2) * Math.sin(deltaPhi / 2) +
              Math.cos(phi1) * Math.cos(phi2) *
              Math.sin(deltaLambda / 2) * Math.sin(deltaLambda / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c;
}

function buildTransferPoints(result, routeIndex = 0) {
    const route = result?.routes?.[routeIndex];
    if (!route?.segments?.length) return [];

    const transitSegments = route.segments.filter(s => s.mode && s.mode !== 'WALK');
    if (transitSegments.length === 0) return [];

    const points = [];

    function getResolvedStopId(stop) {
        if (!stop) return null;
        const lon = stop.lon != null ? stop.lon : stop.lng;
        return resolveStopId(stop.name, stop.lat, lon) || stop.stopId || stop.id;
    }

    function isSameStop(stopA, stopB) {
        if (!stopA || !stopB) return false;
        if (stopA.name && stopB.name && stopA.name === stopB.name) return true;
        const coordsA = getStopLngLat(stopA);
        const coordsB = getStopLngLat(stopB);
        if (coordsA && coordsB) {
            const dist = getDistanceInMeters(coordsA[1], coordsA[0], coordsB[1], coordsB[0]);
            return dist < 50; // within 50 meters
        }
        return false;
    }

    // 1. First Boarding Point
    const firstLeg = transitSegments[0];
    const firstLngLat = getStopLngLat(firstLeg.from);
    if (firstLngLat) {
        points.push({
            lngLat: firstLngLat,
            stopName: firstLeg.from.name || '',
            stopId: getResolvedStopId(firstLeg.from),
            type: 'board',
            filterRouteShortName: firstLeg.routeShortName,
            filterRouteMode: firstLeg.mode
        });
    }

    // 2. Intermediate Transfer Points
    for (let i = 0; i < transitSegments.length - 1; i++) {
        const currentLeg = transitSegments[i];
        const nextLeg = transitSegments[i + 1];

        const alightStop = currentLeg.to;
        const boardStop = nextLeg.from;

        const alightLngLat = getStopLngLat(alightStop);
        const boardLngLat = getStopLngLat(boardStop);

        if (isSameStop(alightStop, boardStop)) {
            // Same stop transfer
            if (boardLngLat) {
                points.push({
                    lngLat: boardLngLat,
                    stopName: boardStop.name || '',
                    stopId: getResolvedStopId(boardStop),
                    type: 'transfer',
                    nextRouteShortName: nextLeg.routeShortName,
                    nextRouteColor: nextLeg.color,
                    nextRouteMode: nextLeg.mode,
                    filterRouteShortName: nextLeg.routeShortName,
                    filterRouteMode: nextLeg.mode
                });
            }
        } else {
            // Different stops transfer (walk in between)
            if (alightLngLat) {
                points.push({
                    lngLat: alightLngLat,
                    stopName: alightStop.name || '',
                    stopId: getResolvedStopId(alightStop),
                    type: 'alight'
                });
            }
            if (boardLngLat) {
                points.push({
                    lngLat: boardLngLat,
                    stopName: boardStop.name || '',
                    stopId: getResolvedStopId(boardStop),
                    type: 'transfer',
                    nextRouteShortName: nextLeg.routeShortName,
                    nextRouteColor: nextLeg.color,
                    nextRouteMode: nextLeg.mode,
                    filterRouteShortName: nextLeg.routeShortName,
                    filterRouteMode: nextLeg.mode
                });
            }
        }
    }

    // 3. Final Alighting Point
    const lastLeg = transitSegments[transitSegments.length - 1];
    const lastLngLat = getStopLngLat(lastLeg.to);
    if (lastLngLat) {
        const isAlreadyAdded = points.some(p => {
            const dist = getDistanceInMeters(p.lngLat[1], p.lngLat[0], lastLngLat[1], lastLngLat[0]);
            return dist < 10;
        });
        if (!isAlreadyAdded) {
            points.push({
                lngLat: lastLngLat,
                stopName: lastLeg.to.name || '',
                stopId: getResolvedStopId(lastLeg.to),
                type: 'alight'
            });
        }
    }

    return points;
}

function getClosestPointOnSegment(p, a, b) {
    const atob = { x: b.x - a.x, y: b.y - a.y };
    const atop = { x: p.x - a.x, y: p.y - a.y };
    const lenSq = atob.x * atob.x + atob.y * atob.y;
    
    let t = 0;
    if (lenSq > 0) {
        t = (atop.x * atob.x + atop.y * atob.y) / lenSq;
        t = Math.max(0, Math.min(1, t));
    }
    
    return {
        x: a.x + t * atob.x,
        y: a.y + t * atob.y
    };
}

function determineTextAnchor(lngLat, route, pt = {}, points = []) {
    if (!map) {
        return 'right';
    }

    try {
        const stopPt = map.project(lngLat);
        const labelWidth = 150; // Estimate typical label width
        const labelHeight = 35; // Estimate typical label height

        // Define bounding boxes for 'left' and 'right' alignment relative to stopPt
        // Alignment 'right': label is placed right of stop. Offset is [12, -14], anchor top-left.
        // Box is [Sx + 12, Sx + 12 + labelWidth] horizontally, [Sy - 14, Sy - 14 + labelHeight] vertically.
        const boxRight = {
            xMin: stopPt.x + 12,
            xMax: stopPt.x + 12 + labelWidth,
            yMin: stopPt.y - 14,
            yMax: stopPt.y - 14 + labelHeight
        };

        // Alignment 'left': label is placed left of stop. Offset is [-12, -14], anchor top-right.
        // Box is [Sx - 12 - labelWidth, Sx - 12] horizontally, [Sy - 14, Sy - 14 + labelHeight] vertically.
        const boxLeft = {
            xMin: stopPt.x - 12 - labelWidth,
            xMax: stopPt.x - 12,
            yMin: stopPt.y - 14,
            yMax: stopPt.y - 14 + labelHeight
        };

        let costLeft = 0;
        let costRight = 0;

        // 1. A and B Marker overlap costs
        const markers = [];
        if (state.from) markers.push({ lngLat: [state.from.lng, state.from.lat], weight: 1000 });
        if (state.to) markers.push({ lngLat: [state.to.lng, state.to.lat], weight: 1000 });

        markers.forEach(m => {
            try {
                const mPt = map.project(m.lngLat);
                // Marker size is roughly 30px width, 45px height anchored bottom-center.
                // Let's treat it as a box of [mx - 18, mx + 18], [my - 45, my + 10]
                const mBox = {
                    xMin: mPt.x - 18,
                    xMax: mPt.x + 18,
                    yMin: mPt.y - 45,
                    yMax: mPt.y + 10
                };

                // Check intersection with boxLeft
                if (!(boxLeft.xMax < mBox.xMin || boxLeft.xMin > mBox.xMax || boxLeft.yMax < mBox.yMin || boxLeft.yMin > mBox.yMax)) {
                    costLeft += m.weight;
                }
                // Check intersection with boxRight
                if (!(boxRight.xMax < mBox.xMin || boxRight.xMin > mBox.xMax || boxRight.yMax < mBox.yMin || boxRight.yMin > mBox.yMax)) {
                    costRight += m.weight;
                }
            } catch (err) {}
        });

        // 2. Route overlap costs (sample points on route segments)
        if (route?.segments?.length) {
            route.segments.forEach(segment => {
                if (!Array.isArray(segment.coordinates)) return;
                
                segment.coordinates.forEach(coord => {
                    try {
                        const rPt = map.project(coord);
                        
                        // Calculate distance from stopPt to rPt in pixels
                        const distToStop = Math.hypot(stopPt.x - rPt.x, stopPt.y - rPt.y);
                        
                        // Ignore points extremely close to the stop (since the route passes through the stop)
                        if (distToStop < 15) return;
                        
                        // Only consider points within 120 pixels of the stop for local overlap
                        if (distToStop > 120) return;

                        // Check if rPt is inside boxLeft (with 5px padding)
                        if (rPt.x >= boxLeft.xMin - 5 && rPt.x <= boxLeft.xMax + 5 && rPt.y >= boxLeft.yMin - 5 && rPt.y <= boxLeft.yMax + 5) {
                            costLeft += (120 - distToStop) * 2;
                        }

                        // Check if rPt is inside boxRight (with 5px padding)
                        if (rPt.x >= boxRight.xMin - 5 && rPt.x <= boxRight.xMax + 5 && rPt.y >= boxRight.yMin - 5 && rPt.y <= boxRight.yMax + 5) {
                            costRight += (120 - distToStop) * 2;
                        }
                    } catch (err) {}
                });
            });
        }

        // 3. Other stops overlap costs
        if (Array.isArray(points)) {
            points.forEach(other => {
                if (other === pt) return;
                try {
                    const oPt = map.project(other.lngLat);
                    const distToStop = Math.hypot(stopPt.x - oPt.x, stopPt.y - oPt.y);
                    if (distToStop > 150) return;

                    // If other stop is to the left, add cost to placing label on left
                    if (oPt.x < stopPt.x) {
                        costLeft += (150 - distToStop) * 1.5;
                    } else {
                        costRight += (150 - distToStop) * 1.5;
                    }
                } catch (err) {}
            });
        }

        if (costLeft !== costRight) {
            return costLeft < costRight ? 'left' : 'right';
        }

        // Fallback to screen half
        const container = map.getContainer();
        const width = container ? container.clientWidth : 800;
        return stopPt.x < width / 2 ? 'right' : 'left';
    } catch (e) {
        console.error('[DirectionsPlot] Error in determineTextAnchor:', e);
        return 'right';
    }
}

function getWrappedTextWidth(text, maxAllowedWidth, fontStyle) {
    if (typeof document === 'undefined') return 0;
    try {
        const canvas = getWrappedTextWidth.canvas || (getWrappedTextWidth.canvas = document.createElement('canvas'));
        const context = canvas.getContext('2d');
        context.font = fontStyle;

        const words = String(text || '').split(' ');
        let maxLineWidth = 0;
        let currentLine = '';

        for (const word of words) {
            const testLine = currentLine ? currentLine + ' ' + word : word;
            const testWidth = context.measureText(testLine).width;
            if (testWidth > maxAllowedWidth && currentLine) {
                maxLineWidth = Math.max(maxLineWidth, context.measureText(currentLine).width);
                currentLine = word;
            } else {
                currentLine = testLine;
            }
        }
        if (currentLine) {
            maxLineWidth = Math.max(maxLineWidth, context.measureText(currentLine).width);
        }
        return maxLineWidth;
    } catch (e) {
        console.warn('[DirectionsPlot] getWrappedTextWidth error:', e);
        return maxAllowedWidth;
    }
}

function renderTransferMarkers(result, routeIndex = 0) {
    clearTransferMarkers();

    if (!map || !result) return;
    const route = result.routes?.[routeIndex];
    if (!route) return;

    const points = buildTransferPoints(result, routeIndex);
    console.log(`[DirectionsPlot] Found ${points.length} transfer/boarding/alighting points`);

    points.forEach(pt => {
        const alignment = determineTextAnchor(pt.lngLat, route);
        
        const el = document.createElement('div');
        el.className = `directions-transfer-marker align-${alignment}`;
        
        const label = document.createElement('div');
        label.className = 'directions-transfer-label';
        label.textContent = pt.stopName;
        
        // Calculate and set precise width to avoid extra right-margin space when wrapping
        const fontStyle = '600 16px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
        const paddingOffset = 18; // 9px left + 9px right padding
        const maxTextWidth = 180 - paddingOffset;
        const textWidth = getWrappedTextWidth(pt.stopName, maxTextWidth, fontStyle);
        if (textWidth > 0) {
            label.style.width = Math.ceil(textWidth + paddingOffset + 2) + 'px';
        }
        
        el.appendChild(label);

        if (pt.stopId) {
            label.addEventListener('click', (e) => {
                e.stopPropagation();
                const allStops = window.allStops || [];
                const matchedStop = allStops.find(s => String(s.id) === String(pt.stopId));
                const stopObj = matchedStop || { id: pt.stopId, name: pt.stopName };
                if (typeof window.showStopInfo === 'function') {
                    window.showStopInfo(stopObj, true, true);
                }
            });
        }

        if (pt.type === 'transfer' && pt.nextRouteShortName) {
            const chip = document.createElement('div');
            chip.className = 'directions-transfer-chip';
            chip.textContent = pt.nextRouteShortName;
            
            const color = getRouteColorByShortName(pt.nextRouteShortName, null, null, pt.nextRouteMode || 'BUS') 
                          || getModeColor(pt.nextRouteMode || 'BUS', pt.nextRouteColor);
            chip.style.setProperty('--chip-color', color);
            el.appendChild(chip);

            if (pt.stopId) {
                chip.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const allStops = window.allStops || [];
                    const matchedStop = allStops.find(s => String(s.id) === String(pt.stopId));
                    const stopObj = matchedStop || { id: pt.stopId, name: pt.stopName };
                    if (typeof window.showStopInfo === 'function') {
                        window.showStopInfo(stopObj, true, true);
                    }
                });
            }
        }

        const anchor = alignment === 'left' ? 'top-right' : 'top-left';
        const offset = alignment === 'left' ? [-12, -14] : [12, -14];

        const marker = new mapboxgl.Marker({
            element: el,
            anchor: anchor,
            offset: offset
        })
        .setLngLat(pt.lngLat)
        .addTo(map);

        state.routing.transferMarkers.push(marker);
    });
}

function clearTransferMarkers() {
    if (Array.isArray(state.routing.transferMarkers)) {
        state.routing.transferMarkers.forEach(marker => marker.remove());
    }
    state.routing.transferMarkers = [];
}


function renderDirectionsResult(result, { fit = true } = {}) {
    console.log('[DirectionsPlot] renderDirectionsResult called:', { fit, hasResult: !!result, routesCount: result?.routes?.length });
    state.routing.result = result;
    if (!ensureDirectionsRouteLayers()) {
        console.log('[DirectionsPlot] Style not fully loaded or layers not created. Delaying rendering until style.load.');
        map.once('style.load', () => renderDirectionsResult(result, { fit }));
        return;
    }

    setRouteLayersVisibility(true);

    const featureCollection = buildRouteFeatures(result, state.routing.selectedRouteIndex);
    console.log(`[DirectionsPlot] Generated route features (selected index: ${state.routing.selectedRouteIndex}):`, featureCollection.features.length, 'features');
    const routeSource = map.getSource(DIRECTIONS_ROUTE_SOURCE_ID);
    if (routeSource) {
        routeSource.setData(featureCollection);
        console.log(`[DirectionsPlot] Set data on source "${DIRECTIONS_ROUTE_SOURCE_ID}"`);
    } else {
        console.warn(`[DirectionsPlot] Source "${DIRECTIONS_ROUTE_SOURCE_ID}" not found on map!`);
    }

    const stopsCollection = buildRouteStopsFeatures(result, state.routing.selectedRouteIndex);
    console.log(`[DirectionsPlot] Generated route stops features:`, stopsCollection.features.length, 'features');
    const stopsSource = map.getSource(DIRECTIONS_ROUTE_STOPS_SOURCE_ID);
    if (stopsSource) {
        stopsSource.setData(stopsCollection);
        console.log(`[DirectionsPlot] Set data on source "${DIRECTIONS_ROUTE_STOPS_SOURCE_ID}"`);
    } else {
        console.warn(`[DirectionsPlot] Source "${DIRECTIONS_ROUTE_STOPS_SOURCE_ID}" not found on map!`);
    }

    if (typeof setMapFocus === 'function') {
        setMapFocus(true);
    }

    if (isDirectionsPanelVisible() && result?.routes?.length > 0) {
        stopTracking();
    }

    if (fit && featureCollection.features.length) {
        fitDirectionsRoute(featureCollection);
    } else {
        console.log('[DirectionsPlot] Skipping fitBounds:', { fit, featuresCount: featureCollection.features.length });
    }

    renderTransferMarkers(result, state.routing.selectedRouteIndex);
}

function selectDirectionsRoute(index) {
    if (!state.routing.result?.routes?.[index]) return;
    state.routing.selectedRouteIndex = index;
    const panel = document.getElementById('directions-panel');
    if (panel) {
        setSheetState(panel, 'half');
    }
    renderDirectionsResult(state.routing.result, { fit: true });
    renderDirectionsStatus();
}

function formatDurationShort(seconds) {
    if (seconds == null) return '';
    const mins = Math.round(seconds / 60);
    if (mins < 60) return t('durationMin', mins);
    const hours = Math.floor(mins / 60);
    const remainder = mins % 60;
    return remainder > 0 ? t('durationHourMin', hours, remainder) : t('durationHour', hours);
}

function formatTimeShort(isoString) {
    if (!isoString) return '';
    const d = new Date(isoString);
    if (Number.isNaN(d.getTime())) return '';
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const BASE_PATH = import.meta.env.BASE_URL.endsWith('/')
    ? import.meta.env.BASE_URL
    : `${import.meta.env.BASE_URL}/`;

function resolveStopId(name, lat, lon) {
    const stopsSource = (window.dataProvider && window.dataProvider.getRawStops)
        ? window.dataProvider.getRawStops()
        : (window.allStops || []);

    if (!stopsSource || stopsSource.length === 0) return null;

    // 1. Try exact coordinate match first (within 5 meters) since API returns exact stop coords
    let closest = null;
    let minDistance = Infinity;

    for (const stop of stopsSource) {
        if (stop.lat == null || stop.lon == null) continue;
        const dLat = stop.lat - lat;
        const dLon = stop.lon - lon;
        const dist = dLat * dLat + dLon * dLon;
        if (dist < minDistance) {
            minDistance = dist;
            closest = stop;
        }
    }

    // 5 meters in degrees is roughly 0.00005 degrees
    if (closest && minDistance < 0.00005 * 0.00005) {
        return closest.id;
    }

    // 2. If not found by exact coord, search by name + closest distance
    if (!name) return null;
    const normInputName = name.trim().toLowerCase();
    
    closest = null;
    minDistance = Infinity;

    for (const stop of stopsSource) {
        if (stop.name && stop.name.trim().toLowerCase() === normInputName) {
            if (stop.lat == null || stop.lon == null) continue;
            const dLat = stop.lat - lat;
            const dLon = stop.lon - lon;
            const dist = dLat * dLat + dLon * dLon;
            if (dist < minDistance) {
                minDistance = dist;
                closest = stop;
            }
        }
    }

    // 150m limit in degrees is roughly 0.0013 degrees
    if (closest && minDistance < 0.0013 * 0.0013) {
        return closest.id;
    }

    return null;
}

function getEquivalentStopIds(stopId, includeHubs = true) {
    if (!stopId) return [];
    if (!window.dataProvider) return [stopId];

    const hubMap = window.dataProvider.getHubMap();
    const hubSourcesMap = window.dataProvider.getHubSourcesMap();
    const redirectMap = window.dataProvider.getRedirectMap();
    const mergeSourcesMap = window.dataProvider.getMergeSourcesMap();

    const equivalents = new Set();
    equivalents.add(stopId);

    // 1. Check merges/redirects
    const target = redirectMap.get(stopId) || stopId;
    equivalents.add(target);

    const mergedSources = mergeSourcesMap.get(target);
    if (mergedSources) {
        mergedSources.forEach(s => equivalents.add(s));
    }

    // 2. Check hubs for all collected IDs if requested
    if (includeHubs) {
        const checkedIds = Array.from(equivalents);
        checkedIds.forEach(id => {
            const parentHub = hubMap.get(id) || id;
            equivalents.add(parentHub);
            
            const children = hubSourcesMap.get(parentHub);
            if (children) {
                children.forEach(c => equivalents.add(c));
            }
        });
    }

    return Array.from(equivalents);
}

function inferRouteType(shortName, mode) {
    const name = String(shortName || '').trim();
    if (!name || mode !== 'BUS') return 'regular';

    if (name.length === 3) {
        if (name.startsWith('4') || name.startsWith('5')) {
            return 'minibus';
        }
        return 'regular';
    }
    if (name.length === 1 || name.length === 2) {
        return 'rustavi';
    }
    return 'regular';
}

function getRouteColorByShortName(shortName, fromStop, toStop, mode = 'BUS') {
    if (mode === 'WALK') return null;

    if (mode === 'GONDOLA' || mode === 'CABLE_CAR') {
        const isDark = document.body.classList.contains('dark-mode');
        return isDark ? '#2DD4BF' : '#0D9488';
    }

    if (!shortName) return null;

    if (mode === 'SUBWAY' || mode === 'METRO') {
        if (String(shortName) === '2') {
            return '#22c55e'; // Green Line
        }
        return '#ef4444'; // Red Line
    }

    const type = inferRouteType(shortName, mode);
    const isDark = document.body.classList.contains('dark-mode');

    if (type === 'rustavi') {
        return isDark ? '#818cf8' : '#4f46e5';
    }
    if (type === 'minibus') {
        return isDark ? '#0a84ff' : '#0033B4';
    }

    // Try to resolve Tbilisi regular bus custom color if available in allRoutes
    if (window.allRoutes) {
        const match = window.allRoutes.find(r => String(r.shortName) === String(shortName));
        if (match && window.dataProvider && window.dataProvider.getRouteDisplayColor) {
            return window.dataProvider.getRouteDisplayColor(match);
        }
    }

    return '#00B38B';
}

function makeRoutePlaque(shortName, color, mode) {
    const wrap = document.createElement('span');
    if (mode === 'BUS') {
        wrap.className = 'directions-leg-bus-wrap directions-alternative-plaque';
        wrap.style.setProperty('--leg-color', color);
    } else {
        wrap.className = 'directions-leg-badge directions-alternative-plaque';
        wrap.style.setProperty('--leg-color', color);
    }

    if (mode === 'GONDOLA' || mode === 'CABLE_CAR') {
        const innerIcon = document.createElement('span');
        innerIcon.className = 'directions-leg-icon-mask';
        innerIcon.style.setProperty('--icon-url', `url("${BASE_PATH}cablecar.custom.fill.svg")`);
        innerIcon.style.backgroundColor = 'currentColor';
        innerIcon.style.width = '12px';
        innerIcon.style.height = '12px';
        innerIcon.style.display = 'inline-block';
        innerIcon.style.verticalAlign = 'middle';
        wrap.appendChild(innerIcon);
    } else {
        const num = document.createElement('span');
        num.className = 'directions-leg-route-num';
        num.textContent = shortName;
        wrap.appendChild(num);
    }
    return wrap;
}

function getPathStopsSequence(route, fromEquivalents, toEquivalents, redirectMap) {
    let segmentStops = null;

    const details = getStaticRouteDetails(route.id || route);
    const targetRoute = details || route;

    if (targetRoute.patterns) {
        targetRoute.patterns.some(p => {
            if (!p.stops) return false;
            let foundO = -1;
            let foundT = -1;

            for (let i = 0; i < p.stops.length; i++) {
                const sId = p.stops[i].id || p.stops[i];
                const normId = redirectMap ? (redirectMap.get(sId) || sId) : sId;
                if (foundO === -1 && fromEquivalents.includes(normId)) {
                    foundO = i;
                } else if (foundO !== -1 && toEquivalents.includes(normId)) {
                    foundT = i;
                    break;
                }
            }

            if (foundO !== -1 && foundT !== -1) {
                segmentStops = p.stops.slice(foundO, foundT + 1);
                return true;
            }
            return false;
        });
    }

    if (!segmentStops && targetRoute.stops) {
        let foundO = -1;
        let foundT = -1;

        for (let i = 0; i < targetRoute.stops.length; i++) {
            const sId = targetRoute.stops[i];
            const normId = redirectMap ? (redirectMap.get(sId) || sId) : sId;
            if (foundO === -1 && fromEquivalents.includes(normId)) {
                foundO = i;
            } else if (foundO !== -1 && toEquivalents.includes(normId)) {
                foundT = i;
                break;
            }
        }
        if (foundO !== -1 && foundT !== -1) {
            segmentStops = targetRoute.stops.slice(foundO, foundT + 1);
        }
    }

    return segmentStops;
}

function getRouteSignature(route, fromEquivalents, toEquivalents, redirectMap, hubMap) {
    const stops = getPathStopsSequence(route, fromEquivalents, toEquivalents, redirectMap);
    if (!stops || stops.length < 2) return null;

    return stops
        .map(s => {
            let id = s.id || s;
            if (redirectMap) id = redirectMap.get(id) || id;
            if (hubMap) return hubMap.get(id) || id;
            return id;
        })
        .filter((id, i, arr) => i === 0 || id !== arr[i - 1])
        .join('|');
}

function getAlternativeRoutes(fromStop, toStop, currentRouteShortName, mode) {
    if (!fromStop || !toStop) return [];

    const fromId = resolveStopId(fromStop.name, fromStop.lat, fromStop.lon);
    const toId = resolveStopId(toStop.name, toStop.lat, toStop.lon);

    if (!fromId || !toId || fromId === toId) return [];

    const fromEquivalents = getEquivalentStopIds(fromId, false);
    const toEquivalents = getEquivalentStopIds(toId, true);

    const candidateRouteIds = new Set();
    for (const fid of fromEquivalents) {
        getRoutesForStopStatic(fid).forEach(rid => candidateRouteIds.add(rid));
    }

    const redirectMap = window.dataProvider ? window.dataProvider.getRedirectMap() : null;
    const hubMap = window.dataProvider ? window.dataProvider.getHubMap() : null;

    // Resolve the primary route object to extract its path signature
    const primaryRoute = window.dataProvider && window.dataProvider.resolveRouteByShortName
        ? window.dataProvider.resolveRouteByShortName(currentRouteShortName, {
            preferredStopId: fromId || toId,
            preferBus: mode === 'BUS'
        })
        : (window.allRoutes ? window.allRoutes.find(r => String(r.shortName) === String(currentRouteShortName)) : null);

    const primarySig = primaryRoute ? getRouteSignature(primaryRoute, fromEquivalents, toEquivalents, redirectMap, hubMap) : null;
    const alts = [];

    for (const routeId of candidateRouteIds) {
        const details = getStaticRouteDetails(routeId);
        if (!details) continue;

        // Skip the current route shown by the API
        if (String(details.shortName) === String(currentRouteShortName)) continue;

        // Verify connecting stops
        const connects = details.patterns && details.patterns.some(p => {
            if (!p.stops) return false;

            const idxA = p.stops.findIndex(s => {
                const sid = s.id || s;
                const normId = redirectMap ? (redirectMap.get(sid) || sid) : sid;
                return fromEquivalents.includes(sid) || fromEquivalents.includes(normId);
            });
            if (idxA === -1) return false;

            const idxB = p.stops.findIndex((s, idx) => {
                if (idx <= idxA) return false;
                const sid = s.id || s;
                const normId = redirectMap ? (redirectMap.get(sid) || sid) : sid;
                return toEquivalents.includes(sid) || toEquivalents.includes(normId);
            });

            return idxB !== -1;
        });

        if (connects && details.shortName) {
            // Only include alternative route if it runs along the same corridor/signature group
            if (primarySig) {
                const candSig = getRouteSignature(details, fromEquivalents, toEquivalents, redirectMap, hubMap);
                if (candSig && candSig === primarySig) {
                    alts.push(details.shortName);
                }
            } else {
                // Fallback to basic connection if primary signature is not resolvable
                alts.push(details.shortName);
            }
        }
    }

    const isRustavi = (shortName) => inferRouteType(shortName, 'BUS') === 'rustavi';

    return Array.from(new Set(alts)).sort((a, b) => {
        const isA = isRustavi(a);
        const isB = isRustavi(b);
        if (isA !== isB) {
            return isA ? 1 : -1; // Rustavi goes to the end
        }
        return a.localeCompare(b, undefined, { numeric: true });
    });
}

function makeLegIcon(segment) {
    const mode = segment.mode;
    const resolvedColor = getRouteColorByShortName(segment.routeShortName, segment.from, segment.to, segment.mode) || segment.color || '#64748b';

    if (mode === 'WALK') {
        const icon = document.createElement('span');
        icon.className = 'directions-leg-icon-mask directions-leg-icon-walk';
        icon.style.setProperty('--icon-url', `url("${BASE_PATH}figure.walk.svg")`);
        icon.setAttribute('aria-label', t('walkMode'));
        return icon;
    }

    if (mode === 'BUS') {
        const wrap = document.createElement('span');
        wrap.className = 'directions-leg-bus-wrap';
        wrap.style.setProperty('--leg-color', resolvedColor);

        const container = document.createElement('span');
        container.className = 'directions-leg-bus-container';

        const primaryGroup = document.createElement('span');
        primaryGroup.className = 'directions-leg-bus-primary-group';

        const icon = document.createElement('span');
        icon.className = 'directions-leg-icon-mask directions-leg-icon-bus';
        icon.style.setProperty('--icon-url', `url("${BASE_PATH}bus.fill.svg")`);
        icon.setAttribute('aria-label', t('bus'));
        primaryGroup.appendChild(icon);

        if (segment.routeShortName) {
            const num = document.createElement('span');
            num.className = 'directions-leg-route-num';
            num.textContent = segment.routeShortName;
            wrap.appendChild(num);
        }
        primaryGroup.appendChild(wrap);
        container.appendChild(primaryGroup);

        // Find alternative routes
        const alts = getAlternativeRoutes(segment.from, segment.to, segment.routeShortName, 'BUS');
        for (const altShortName of alts) {
            const altColor = getRouteColorByShortName(altShortName, segment.from, segment.to, 'BUS') || resolvedColor;
            const altPlaque = makeRoutePlaque(altShortName, altColor, 'BUS');
            container.appendChild(altPlaque);
        }

        return container;
    }

    if (mode === 'SUBWAY' || mode === 'METRO') {
        const wrap = document.createElement('span');
        wrap.className = 'directions-leg-badge';
        wrap.style.setProperty('--leg-color', resolvedColor);

        const container = document.createElement('span');
        container.className = 'directions-leg-bus-container';

        const primaryGroup = document.createElement('span');
        primaryGroup.className = 'directions-leg-bus-primary-group';

        const icon = document.createElement('span');
        icon.className = 'directions-leg-icon-mask directions-leg-icon-subway';
        icon.style.setProperty('--icon-url', `url("${BASE_PATH}tram.fill.tunnel.svg")`);
        icon.setAttribute('aria-label', t('metro'));
        primaryGroup.appendChild(icon);

        if (segment.routeShortName) {
            const num = document.createElement('span');
            num.className = 'directions-leg-route-num';
            num.textContent = segment.routeShortName;
            wrap.appendChild(num);
        }
        primaryGroup.appendChild(wrap);
        container.appendChild(primaryGroup);

        // Find alternative routes
        const alts = getAlternativeRoutes(segment.from, segment.to, segment.routeShortName, mode);
        for (const altShortName of alts) {
            const altColor = getRouteColorByShortName(altShortName, segment.from, segment.to, mode) || resolvedColor;
            const altPlaque = makeRoutePlaque(altShortName, altColor, mode);
            container.appendChild(altPlaque);
        }

        return container;
    }

    if (mode === 'GONDOLA' || mode === 'CABLE_CAR') {
        const wrap = document.createElement('span');
        wrap.className = 'directions-leg-bus-wrap';
        wrap.style.setProperty('--leg-color', resolvedColor);

        const container = document.createElement('span');
        container.className = 'directions-leg-bus-container';

        const primaryGroup = document.createElement('span');
        primaryGroup.className = 'directions-leg-bus-primary-group';

        const innerIcon = document.createElement('span');
        innerIcon.className = 'directions-leg-icon-mask';
        innerIcon.style.setProperty('--icon-url', `url("${BASE_PATH}cablecar.custom.fill.svg")`);
        innerIcon.style.backgroundColor = 'currentColor';
        innerIcon.style.width = '13px';
        innerIcon.style.height = '13px';
        innerIcon.style.display = 'inline-block';
        innerIcon.style.verticalAlign = 'middle';
        wrap.appendChild(innerIcon);

        primaryGroup.appendChild(wrap);
        container.appendChild(primaryGroup);

        // Find alternative routes
        const alts = getAlternativeRoutes(segment.from, segment.to, segment.routeShortName, mode);
        for (const altShortName of alts) {
            const altColor = getRouteColorByShortName(altShortName, segment.from, segment.to, mode) || resolvedColor;
            const altPlaque = makeRoutePlaque(altShortName, altColor, mode);
            container.appendChild(altPlaque);
        }

        return container;
    }

    // fallback for other modes
    const badge = document.createElement('span');
    badge.className = 'directions-leg-badge';
    badge.style.setProperty('--leg-color', resolvedColor);
    badge.textContent = segment.routeShortName || mode.slice(0, 1);

    const container = document.createElement('span');
    container.className = 'directions-leg-subway-container';
    container.appendChild(badge);

    const alts = getAlternativeRoutes(segment.from, segment.to, segment.routeShortName, mode);
    for (const altShortName of alts) {
        const altColor = getRouteColorByShortName(altShortName, segment.from, segment.to, mode) || resolvedColor;
        const altPlaque = makeRoutePlaque(altShortName, altColor, mode);
        container.appendChild(altPlaque);
    }

    return container;
}

let directionsRefreshTimer = null;
let directionsLastFetchTime = 0;
let directionsEarliestArrival = 999;

function startDirectionsRefreshTimer() {
    stopDirectionsRefreshTimer();

    directionsRefreshTimer = setInterval(() => {
        if (state.routing.status !== 'success' || !state.routing.result?.routes) return;
        if (document.hidden) return;

        const age = (Date.now() - directionsLastFetchTime) / 1000;
        
        let threshold = 60;
        if (directionsEarliestArrival < 10) threshold = 15;
        else if (directionsEarliestArrival < 90) threshold = 60;
        else threshold = 600;

        if (age > threshold) {
            refreshDirectionsArrivals();
        }
    }, 5000);
}

function stopDirectionsRefreshTimer() {
    if (directionsRefreshTimer) {
        clearInterval(directionsRefreshTimer);
        directionsRefreshTimer = null;
    }
}

async function refreshDirectionsArrivals() {
    stopArrivalsCache.clear();
    directionsEarliestArrival = 999;
    directionsLastFetchTime = Date.now();

    const routes = state.routing.result?.routes || [];
    const resultsContainer = document.getElementById('directions-results');
    if (!resultsContainer) return;

    for (let i = 0; i < routes.length; i++) {
        const route = routes[i];
        const card = resultsContainer.querySelector(`.directions-route-option[data-route-index="${i}"]`);
        if (!card) continue;

        const legItems = Array.from(card.querySelectorAll('.directions-leg-item'));
        let busSegmentCount = 0;

        for (let sIdx = 0; sIdx < route.segments.length; sIdx++) {
            const seg = route.segments[sIdx];
            if (seg.mode === 'BUS') {
                busSegmentCount++;
                if (busSegmentCount <= 3 && seg.from) {
                    const boardingStopId = resolveStopId(seg.from.name, seg.from.lat, seg.from.lon);
                    const legItem = legItems[sIdx];
                    if (boardingStopId && legItem) {
                        legItem.setAttribute('data-stop-id', boardingStopId);
                        loadArrivalsForLeg(boardingStopId, legItem);
                    }
                }
            }
        }
    }
}

const stopArrivalsCache = new Map();

async function getStopArrivalsCached(stopId) {
    if (!stopId) return [];
    const key = String(stopId);
    if (stopArrivalsCache.has(key)) {
        return stopArrivalsCache.get(key);
    }
    const promise = fetchArrivals(stopId).catch(err => {
        console.warn(`[Directions] Failed to fetch arrivals for stop ${stopId}:`, err);
        return [];
    });
    stopArrivalsCache.set(key, promise);
    return promise;
}

async function loadArrivalsForLeg(stopId, legItemElement, cardElement = null) {
    if (!stopId || !legItemElement) return;

    const routeSpans = legItemElement.querySelectorAll('.directions-leg-route-num');
    const card = cardElement || legItemElement.closest('.directions-route-option');
    const isStale = isArrivalsLiveDataStale();

    try {
        const arrivals = await getStopArrivalsCached(stopId);
        
        if (!arrivals || arrivals.length === 0 || isStale) {
            // Clear arrival times and warnings on stale/failed load
            routeSpans.forEach(span => {
                const routeShortName = span.dataset.routeShortName || (span.firstChild ? span.firstChild.textContent.trim() : span.textContent.trim()).split(' ')[0];
                const badgeArrival = span.querySelector('.directions-leg-badge-arrival');
                if (badgeArrival) {
                    span.innerHTML = '';
                    span.textContent = routeShortName;
                }
            });
            legItemElement.dataset.isLate = 'false';
            if (card) {
                const anyLegLate = Array.from(card.querySelectorAll('.directions-leg-item'))
                    .some(el => el.dataset.isLate === 'true');
                const existingWarning = card.querySelector('.arrival-warning');
                if (!anyLegLate && existingWarning) {
                    existingWarning.remove();
                }
            }
            return;
        }

        let anyLate = false;
        const checkPromises = Array.from(routeSpans).map(async span => {
            const routeShortName = span.dataset.routeShortName || span.textContent.trim().split(' ')[0];
            if (!routeShortName) return;
            span.dataset.routeShortName = routeShortName;

            // Find the next arrival for this route
            const routeArrivals = arrivals.filter(a => 
                String(a.shortName).trim() === String(routeShortName)
            );

            if (routeArrivals.length > 0) {
                const nextArrival = routeArrivals[0];
                const minutes = getArrivalMinutesValue(nextArrival);
                if (minutes < directionsEarliestArrival) {
                    directionsEarliestArrival = minutes;
                }
                const isScheduled = !nextArrival.realtime;
                const formattedTime = formatArrivalDisplayValue(minutes, isScheduled);

                // Update the span to show routeShortName and formattedTime inline, no brackets
                span.innerHTML = '';
                span.appendChild(document.createTextNode(routeShortName));

                const timeSpan = document.createElement('span');
                const classes = ['directions-leg-badge-arrival', 'led-text', 'led-text-secondary'];
                if (isScheduled) {
                    classes.push('scheduled-time');
                }
                timeSpan.className = classes.join(' ');
                timeSpan.textContent = formattedTime;
                span.appendChild(timeSpan);

                // Check for late warnings if it's a live arrival
                if (!isScheduled) {
                    try {
                        const sched = await getV3Schedule(routeShortName, stopId, nextArrival.id, nextArrival.patternSuffix);
                        if (sched) {
                            const isLate = shouldShowLateDepotWarning(minutes, sched.lastScheduledMinutes, sched.firstScheduledMinutes);
                            if (isLate) {
                                timeSpan.classList.add('late-depot-time');
                                anyLate = true;
                            }
                        }
                    } catch (err) {
                        console.warn('[Directions] Failed to fetch schedule boundaries for late check:', routeShortName, stopId, err);
                    }
                }
            } else {
                // No arrivals found for this specific route (clear any old time badge)
                const badgeArrival = span.querySelector('.directions-leg-badge-arrival');
                if (badgeArrival) {
                    span.innerHTML = '';
                    span.textContent = routeShortName;
                }
            }
        });

        await Promise.all(checkPromises);

        // Find the bus container to sort/filter route badges
        const busContainer = legItemElement.querySelector('.directions-leg-bus-container');
        if (busContainer) {
            const primaryGroup = busContainer.querySelector('.directions-leg-bus-primary-group');
            const altPlaques = Array.from(busContainer.querySelectorAll('.directions-alternative-plaque'));

            // Find arrival minutes for primary route
            let primaryMinutes = 999;
            if (primaryGroup) {
                const primarySpan = primaryGroup.querySelector('.directions-leg-route-num');
                if (primarySpan) {
                    const badgeArrival = primarySpan.querySelector('.directions-leg-badge-arrival');
                    if (badgeArrival) {
                        const routeShortName = primarySpan.dataset.routeShortName;
                        const routeArrivals = arrivals.filter(a => 
                            String(a.shortName).trim() === String(routeShortName)
                        );
                        if (routeArrivals.length > 0) {
                            primaryMinutes = getArrivalMinutesValue(routeArrivals[0]);
                        }
                    }
                }
            }

            // Filter alternative plaques: hide those arriving too early (altTime < primaryTime - 1)
            const visibleAlts = [];
            const hiddenAlts = [];

            altPlaques.forEach(plaque => {
                const span = plaque.querySelector('.directions-leg-route-num');
                let isTooClose = false;
                if (span) {
                    const badgeArrival = span.querySelector('.directions-leg-badge-arrival');
                    if (badgeArrival) {
                        const routeShortName = span.dataset.routeShortName;
                        const routeArrivals = arrivals.filter(a => 
                            String(a.shortName).trim() === String(routeShortName)
                        );
                        if (routeArrivals.length > 0) {
                            const altMinutes = getArrivalMinutesValue(routeArrivals[0]);
                            if (primaryMinutes !== 999 && altMinutes < primaryMinutes - 1) {
                                isTooClose = true;
                            }
                        }
                    }
                }

                if (isTooClose) {
                    plaque.style.display = 'none';
                    hiddenAlts.push(plaque);
                } else {
                    plaque.style.display = '';
                    visibleAlts.push(plaque);
                }
            });

            // Map visible elements to their minutes for sorting
            const childrenWithMinutes = [];
            if (primaryGroup) {
                childrenWithMinutes.push({ element: primaryGroup, minutes: primaryMinutes });
            }
            visibleAlts.forEach(plaque => {
                let minutes = 999;
                const span = plaque.querySelector('.directions-leg-route-num');
                if (span) {
                    const routeShortName = span.dataset.routeShortName;
                    const routeArrivals = arrivals.filter(a => 
                        String(a.shortName).trim() === String(routeShortName)
                    );
                    if (routeArrivals.length > 0) {
                        minutes = getArrivalMinutesValue(routeArrivals[0]);
                    }
                }
                childrenWithMinutes.push({ element: plaque, minutes: minutes });
            });

            // Sort visible badges by minutes ascending
            childrenWithMinutes.sort((a, b) => a.minutes - b.minutes);

            // Re-append in sorted order (visible ones first, then hidden ones)
            childrenWithMinutes.forEach(item => {
                busContainer.appendChild(item.element);
            });
            hiddenAlts.forEach(plaque => {
                busContainer.appendChild(plaque);
            });
        }

        // Update the card-level warning based on all legs
        legItemElement.dataset.isLate = anyLate ? 'true' : 'false';
        if (card) {
            const anyLegLate = Array.from(card.querySelectorAll('.directions-leg-item'))
                .some(el => el.dataset.isLate === 'true');
            const existingWarning = card.querySelector('.arrival-warning');
            if (anyLegLate) {
                if (!existingWarning) {
                    const warningDiv = document.createElement('div');
                    warningDiv.className = 'arrival-warning';
                    warningDiv.textContent = t('lateArrivalWarning');
                    card.appendChild(warningDiv);
                }
            } else {
                if (existingWarning) {
                    existingWarning.remove();
                }
            }
        }

    } catch (e) {
        console.warn('[Directions] Failed to load/render arrivals for stop', stopId, e);
        // Clear times/warnings on error
        routeSpans.forEach(span => {
            const routeShortName = span.dataset.routeShortName || (span.firstChild ? span.firstChild.textContent.trim() : span.textContent.trim()).split(' ')[0];
            const badgeArrival = span.querySelector('.directions-leg-badge-arrival');
            if (badgeArrival) {
                span.innerHTML = '';
                span.textContent = routeShortName;
            }
        });
        legItemElement.dataset.isLate = 'false';
        if (card) {
            const anyLegLate = Array.from(card.querySelectorAll('.directions-leg-item'))
                .some(el => el.dataset.isLate === 'true');
            const existingWarning = card.querySelector('.arrival-warning');
            if (!anyLegLate && existingWarning) {
                existingWarning.remove();
            }
        }
    }
}

function buildRouteOptionElement(route, index, isSelected) {
    const section = document.createElement('div');
    section.className = `directions-route-option${isSelected ? ' selected' : ''}`;
    section.dataset.routeIndex = String(index);

    // Find the first transit segment
    const firstTransitIndex = route.segments?.findIndex(s => s.mode !== 'WALK');

    // Top row: total duration (left) + arrival time (right)
    const header = document.createElement('div');
    header.className = 'directions-route-header';

    const duration = document.createElement('span');
    duration.className = 'directions-route-duration';
    duration.textContent = formatDurationShort(route.duration);
    header.appendChild(duration);

    if (route.endTime) {
        const arrive = document.createElement('span');
        arrive.className = 'directions-route-arrive';
        arrive.textContent = t('arriveAt', formatTimeShort(route.endTime));
        header.appendChild(arrive);
    }

    section.appendChild(header);

    // Leg strip: icon/badge per segment, separated by ›
    if (route.segments?.length) {
        const strip = document.createElement('div');
        strip.className = 'directions-leg-strip';

        if (state.time.mode === 'arriveBy' && route.startTime) {
            const leaveItem = document.createElement('span');
            leaveItem.className = 'directions-leg-item';
            
            const leaveLabel = document.createElement('span');
            leaveLabel.className = 'directions-leg-label';
            leaveLabel.textContent = `${t('leaveAt')} ${formatTimeShort(route.startTime)}`;
            leaveItem.appendChild(leaveLabel);
            strip.appendChild(leaveItem);

            strip.appendChild(document.createTextNode(' '));
            const sep = document.createElement('span');
            sep.className = 'directions-leg-sep';
            sep.textContent = '›';
            strip.appendChild(sep);
            strip.appendChild(document.createTextNode(' '));
        }

        let busSegmentCount = 0;
        for (let i = 0; i < route.segments.length; i++) {
            const seg = route.segments[i];

            const item = document.createElement('span');
            item.className = `directions-leg-item${seg.mode === 'WALK' ? ' directions-walk-leg' : ''}`;
            if (seg.mode === 'WALK') {
                item.appendChild(makeLegIcon(seg));
                const label = document.createElement('span');
                label.className = 'directions-leg-label';
                label.textContent = formatDurationShort(seg.duration);
                item.appendChild(label);
            } else {
                let fromName = seg.from?.name || '';
                let toName = seg.to?.name || '';
                
                if (seg.mode === 'SUBWAY' || seg.mode === 'METRO') {
                    const lineNum = Number(seg.routeShortName) === 2 ? 2 : 1;
                    fromName = getCleanMetroName(fromName, lineNum);
                    toName = getCleanMetroName(toName, lineNum);
                }

                // 1. Origin Stop Name
                const fromSpan = document.createElement('span');
                fromSpan.className = 'directions-leg-label';
                fromSpan.textContent = fromName || t('startingPoint');
                item.appendChild(fromSpan);

                // 2. Space (no comma)
                item.appendChild(document.createTextNode(' '));

                // 3. Bus/Metro Badge(s)
                const legIcon = makeLegIcon(seg);
                item.appendChild(legIcon);

                // 4. Arrow Separator (in directions-leg-label span to keep color)
                const arrowSpan = document.createElement('span');
                arrowSpan.className = 'directions-leg-label';
                arrowSpan.textContent = ' → ';
                item.appendChild(arrowSpan);

                // 5. Destination Stop Name
                const toSpan = document.createElement('span');
                toSpan.className = 'directions-leg-label';
                toSpan.textContent = toName || t('destinationPoint');
                item.appendChild(toSpan);
            }

            if (seg.mode === 'BUS') {
                busSegmentCount++;
                if (busSegmentCount <= 3 && seg.from) {
                    const boardingStopId = resolveStopId(seg.from.name, seg.from.lat, seg.from.lon);
                    if (boardingStopId) {
                        item.setAttribute('data-stop-id', boardingStopId);
                        loadArrivalsForLeg(boardingStopId, item, section);
                    }
                }
            }

            strip.appendChild(item);

            if (i < route.segments.length - 1) {
                strip.appendChild(document.createTextNode(' '));
                const sep = document.createElement('span');
                sep.className = 'directions-leg-sep';
                sep.textContent = '›';
                strip.appendChild(sep);
                strip.appendChild(document.createTextNode(' '));
            }
        }

        section.appendChild(strip);
    }

    section.addEventListener('click', () => selectDirectionsRoute(index));
    return section;
}

function renderDirectionsStatus() {
    const placeholder = document.getElementById('directions-placeholder');
    const resultsContainer = document.getElementById('directions-results');
    if (!placeholder) return;

    stopArrivalsCache.clear();

    // Clear previous results
    if (resultsContainer) resultsContainer.innerHTML = '';

    placeholder.classList.toggle('directions-placeholder-error', state.routing.status === 'error');
    placeholder.classList.toggle('directions-placeholder-loading', state.routing.status === 'loading');

    if (!state.from || !state.to) {
        placeholder.textContent = t('routeOptionsEmpty');
        placeholder.classList.remove('hidden');
        if (resultsContainer) resultsContainer.classList.add('hidden');
        stopDirectionsRefreshTimer();
        return;
    }

    if (state.routing.status === 'loading') {
        placeholder.textContent = t('loadingRoute');
        placeholder.classList.remove('hidden');
        if (resultsContainer) resultsContainer.classList.add('hidden');
        stopDirectionsRefreshTimer();
        return;
    }

    if (state.routing.status === 'error') {
        placeholder.textContent = t('cantGetRoutes');
        placeholder.classList.remove('hidden');
        if (resultsContainer) resultsContainer.classList.add('hidden');
        stopDirectionsRefreshTimer();
        return;
    }

    if (state.routing.status === 'success' && state.routing.result) {
        let routes = state.routing.result.routes || [];

        if (!routes.length) {
            placeholder.textContent = t('cantGetRoutes');
            placeholder.classList.remove('hidden');
            if (resultsContainer) resultsContainer.classList.add('hidden');
            return;
        }

        const isRustaviOption = (opt) => {
            if (!opt || !opt.segments) return false;
            return opt.segments.some(seg => inferRouteType(seg.routeShortName, seg.mode) === 'rustavi');
        };

        // Sort routes in-place: Tbilisi routes first, Rustavi routes at the end
        if (state.routing.result.routes) {
            state.routing.result.routes.sort((a, b) => {
                const isA = isRustaviOption(a);
                const isB = isRustaviOption(b);
                if (isA !== isB) {
                    return isA ? 1 : -1;
                }
                return 0; // Maintain original duration sorting as fallback
            });
        }

        routes = state.routing.result.routes || [];

        // Hide placeholder, show results
        placeholder.classList.add('hidden');
        if (resultsContainer) {
            resultsContainer.innerHTML = ''; // Clear old results
            resultsContainer.classList.remove('hidden');
            for (let i = 0; i < routes.length; i++) {
                const isSelected = i === state.routing.selectedRouteIndex;
                resultsContainer.appendChild(buildRouteOptionElement(routes[i], i, isSelected));
            }
        }

        directionsLastFetchTime = Date.now();
        directionsEarliestArrival = 999;
        startDirectionsRefreshTimer();

        return;
    }

    placeholder.textContent = t('cantGetRoutes');
    placeholder.classList.remove('hidden');
    if (resultsContainer) resultsContainer.classList.add('hidden');
}

async function runDirectionsFetch({ fit = true } = {}) {
    if (!state.from || !state.to) {
        state.routing.status = 'idle';
        state.routing.message = '';
        clearDirectionsRoute();
        renderDirectionsStatus();
        return;
    }

    const requestId = state.routing.requestId + 1;
    state.routing.requestId = requestId;

    if (state.routing.abortController) {
        state.routing.abortController.abort();
    }
    const abortController = new AbortController();
    state.routing.abortController = abortController;
    state.routing.status = 'loading';
    state.routing.message = '';
    state.routing.selectedRouteIndex = 0;
    renderDirectionsStatus();

    try {
        const result = await fetchDirections(getDirectionsRequestDraft(), { signal: abortController.signal });
        if (requestId !== state.routing.requestId) return;
        state.routing.status = 'success';
        state.routing.message = result.routes?.[0]?.summaryText || '';
        renderDirectionsResult(result, { fit });
        renderDirectionsStatus();
    } catch (err) {
        if (err?.name === 'AbortError' || requestId !== state.routing.requestId) return;
        state.routing.status = 'error';
        state.routing.message = err?.message || String(err);
        clearDirectionsRoute();
        renderDirectionsStatus();
    } finally {
        if (state.routing.abortController === abortController) {
            state.routing.abortController = null;
        }
    }
}

function scheduleDirectionsFetch({ delay = 300, fit = true } = {}) {
    if (state.routing.debounceTimer) {
        clearTimeout(state.routing.debounceTimer);
        state.routing.debounceTimer = null;
    }

    if (!state.from || !state.to) {
        state.routing.status = 'idle';
        state.routing.message = '';
        clearDirectionsRoute();
        renderDirectionsStatus();
        return;
    }

    state.routing.debounceTimer = setTimeout(() => {
        state.routing.debounceTimer = null;
        runDirectionsFetch({ fit });
    }, delay);
}

export function applyDirectionsUrlState(nextState = {}, options = {}) {
    state.from = normalizeDirectionPoint(nextState.from);
    state.to = normalizeDirectionPoint(nextState.to);
    state.contextPoint = null;
    state.time.calendarOpen = false;

    if (state.from || state.to) {
        state.hasCompletedFirstUseDefault = true;
    }

    renderMarker('from');
    renderMarker('to');

    const selectedModes = Array.isArray(nextState.selectedModes)
        ? nextState.selectedModes
        : Array.isArray(nextState.modes)
            ? nextState.modes
            : null;
    if (selectedModes) {
        setSelectedModeValues(selectedModes);
    }

    if (nextState.optimize) {
        setSelectedOptimizeValue(nextState.optimize);
    }

    const nextTimeMode = nextState.timeMode === 'arriveBy'
        ? 'arriveBy'
        : (nextState.timeMode === 'departAt' ? 'departAt' : 'leaveNow');
    if (nextTimeMode === 'leaveNow') {
        setTimeMode('leaveNow', { syncUrl: false });
    } else if (nextState.time instanceof Date || typeof nextState.time === 'string' || typeof nextState.time === 'number') {
        setScheduledTime(new Date(nextState.time), nextTimeMode, { syncUrl: false });
    } else {
        setTimeMode(nextTimeMode, { syncUrl: false });
    }

    updateFields();

    if (options.openSheet !== false) {
        openDirectionsSheet();
    }

    if (options.syncUrl !== false) {
        syncDirectionsUrl();
    }

    scheduleDirectionsFetch({ delay: 0, fit: options.fit !== false });
}

export function isDirectionsContextActive() {
    return isDirectionsPanelVisible() && !!(state.from || state.to);
}

function getFeatureLabel(feature, fallbackLngLat) {
    const props = feature?.properties || {};
    return props.name || props.name_en || props.stationName || props.title || props.id || formatCoordinate(fallbackLngLat);
}

function pickContextFeature(point) {
    let features = [];
    try {
        features = map.queryRenderedFeatures(point);
    } catch (err) {
        return null;
    }

    return features.find((feature) => {
        const layerId = feature.layer?.id || '';
        const props = feature.properties || {};
        const hasUsefulName = props.name || props.name_en || props.stationName || props.id;
        return hasUsefulName && POINT_LAYERS_ALLOWLIST.some((needle) => layerId.includes(needle));
    }) || null;
}

function buildPoint(event) {
    const fallbackLngLat = normalizeLngLat(event.lngLat);
    const feature = pickContextFeature(event.point);
    const lngLat = fallbackLngLat;

    return {
        lng: lngLat.lng,
        lat: lngLat.lat,
        label: feature ? getFeatureLabel(feature, lngLat) : formatCoordinate(lngLat),
        featureId: feature?.properties?.id || null,
        featureType: feature?.layer?.id || null
    };
}

function normalizeDirectionPoint(point) {
    const lngLat = normalizeLngLat(point);
    if (!lngLat) return null;
    return {
        lng: lngLat.lng,
        lat: lngLat.lat,
        label: point?.label || formatCoordinate(lngLat),
        featureId: point?.featureId || null,
        featureType: point?.featureType || null
    };
}

function createMarkerElement(type) {
    const letter = type === 'from' ? 'A' : 'B';
    const el = document.createElement('div');
    el.className = `directions-pin directions-pin-${type}`;
    el.setAttribute('aria-label', type === 'from' ? t('startingPoint') : t('destinationPoint'));
    el.innerHTML = `
        <div class="directions-pin-visual">
            <svg class="directions-pin-svg" width="34" height="44" viewBox="0 0 34 44" aria-hidden="true">
                <path class="directions-pin-shadow" d="M17 42C17 42 31 27.4 31 16.8C31 8.6 24.7 2 17 2C9.3 2 3 8.6 3 16.8C3 27.4 17 42 17 42Z" />
                <path class="directions-pin-body" d="M17 42C17 42 31 27.4 31 16.8C31 8.6 24.7 2 17 2C9.3 2 3 8.6 3 16.8C3 27.4 17 42 17 42Z" />
            </svg>
            <span>${letter}</span>
        </div>
    `;
    return el;
}

function syncMarkerLabels() {
    ['from', 'to'].forEach((type) => {
        const marker = state.markers[type];
        const element = marker?.getElement?.();
        if (!element) return;
        element.setAttribute('aria-label', type === 'from' ? t('startingPoint') : t('destinationPoint'));
    });
}


function setupDraggableWithDelay(marker, map, delayMs = 300) {
    const el = marker.getElement();
    let pressTimer = null;
    let startX, startY;
    let isHoldActive = false;
    let activePointerId = null;

    // Prevent map's context menu from triggering on the marker
    el.addEventListener('contextmenu', (e) => {
        e.stopPropagation();
        e.preventDefault();
    });

    // Marker is ALWAYS draggable: true so Mapbox binds its listeners at start of gesture
    marker.setDraggable(true);

    const onPointerDown = (e) => {
        // DO NOT call e.stopPropagation() here to let Mapbox's map-level down event handler run!
        // To prevent map panning during the 300ms hold window, we disable map controls immediately.

        // Only left click for mouse/pointer
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        if (e.type === 'mousedown' && e.button !== 0) return;

        // Reset state
        isHoldActive = false;
        activePointerId = e.pointerId !== undefined ? e.pointerId : null;

        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;
        startX = clientX;
        startY = clientY;

        // Disable map controls immediately to freeze map panning/zooming during the hold timer
        map.dragPan.disable();
        map.scrollZoom.disable();
        map.doubleClickZoom.disable();

        clearTimeout(pressTimer);
        pressTimer = setTimeout(() => {
            isHoldActive = true;
            el.classList.add('grabbing-ready');
            
            if (navigator.vibrate) {
                navigator.vibrate(40);
            }
        }, delayMs);

        // Intercept movements at window level before hold is complete
        const onPointerMove = (moveEvt) => {
            if (activePointerId !== null && moveEvt.pointerId !== undefined && moveEvt.pointerId !== activePointerId) return;

            const moveX = moveEvt.touches ? moveEvt.touches[0].clientX : moveEvt.clientX;
            const moveY = moveEvt.touches ? moveEvt.touches[0].clientY : moveEvt.clientY;
            
            const dx = moveX - startX;
            const dy = moveY - startY;
            const distance = Math.sqrt(dx * dx + dy * dy);

            if (!isHoldActive) {
                if (distance > 6) {
                    cancelDragHold();
                } else {
                    // Suppress event from reaching Mapbox window drag listeners
                    moveEvt.stopImmediatePropagation();
                    if (moveEvt.cancelable) {
                        moveEvt.preventDefault();
                    }
                }
            } else {
                // Prevent mobile scroll bounce when dragging the marker
                if (moveEvt.type === 'touchmove' && moveEvt.cancelable) {
                    moveEvt.preventDefault();
                }
            }
        };

        const onPointerUp = (upEvt) => {
            if (activePointerId !== null && upEvt.pointerId !== undefined && upEvt.pointerId !== activePointerId) return;
            cleanup();
        };

        function cancelDragHold() {
            clearTimeout(pressTimer);
            
            // Force Mapbox to release its active map-level drag listeners
            marker._state = 'inactive';
            map.off('mousemove', marker._onMove);
            map.off('touchmove', marker._onMove);
            map.off('mouseup', marker._onUp);
            map.off('touchend', marker._onUp);

            cleanup();
        }

        function cleanup() {
            clearTimeout(pressTimer);
            el.classList.remove('grabbing-ready');
            
            // Re-enable map controls
            map.dragPan.enable();
            map.scrollZoom.enable();
            map.doubleClickZoom.enable();

            window.removeEventListener('pointermove', onPointerMove, { capture: true });
            window.removeEventListener('pointerup', onPointerUp, { capture: true });
            window.removeEventListener('mousemove', onPointerMove, { capture: true });
            window.removeEventListener('mouseup', onPointerUp, { capture: true });
            window.removeEventListener('touchmove', onPointerMove, { capture: true });
            window.removeEventListener('touchend', onPointerUp, { capture: true });
            window.removeEventListener('touchcancel', onPointerUp, { capture: true });
        }

        // Always listen to all movement/release events to support both pointer and touch fallbacks on iOS
        window.addEventListener('pointermove', onPointerMove, { capture: true });
        window.addEventListener('pointerup', onPointerUp, { capture: true });
        window.addEventListener('mousemove', onPointerMove, { capture: true });
        window.addEventListener('mouseup', onPointerUp, { capture: true });
        window.addEventListener('touchmove', onPointerMove, { capture: true, passive: false });
        window.addEventListener('touchend', onPointerUp, { capture: true });
        window.addEventListener('touchcancel', onPointerUp, { capture: true });
    };

    // Always listen to all down event types in capture phase to intercept regardless of engine preference
    el.addEventListener('pointerdown', onPointerDown, { capture: true });
    el.addEventListener('mousedown', onPointerDown, { capture: true });
    el.addEventListener('touchstart', onPointerDown, { capture: true, passive: true });
}

function renderMarker(type) {
    const point = state[type];
    if (state.markers[type]) {
        state.markers[type].remove();
        state.markers[type] = null;
    }
    if (!point) return;

    state.markers[type] = new mapboxgl.Marker({
        element: createMarkerElement(type),
        anchor: 'center',
        offset: [0, 0],
        draggable: true
    })
        .setLngLat([point.lng, point.lat])
        .addTo(map);

    setupDraggableWithDelay(state.markers[type], map, 300);

    state.markers[type].on('dragend', () => {
        const lngLat = state.markers[type]?.getLngLat();
        if (!lngLat) return;

        state[type] = {
            ...state[type],
            lng: lngLat.lng,
            lat: lngLat.lat,
            label: formatCoordinate(lngLat),
            featureId: null,
            featureType: null
        };
        updateFields();
        syncDirectionsUrl();
        scheduleDirectionsFetch();
    });

    syncMarkerVisibility(type);
}

function getPanel() {
    return document.getElementById('directions-panel');
}

function isDirectionsPanelVisible() {
    const panel = getPanel();
    return !!panel && !panel.classList.contains('hidden');
}

function syncMarkerVisibility(type) {
    const marker = state.markers[type];
    if (!marker) return;

    const element = marker.getElement?.();
    if (!element) return;

    element.style.visibility = isDirectionsPanelVisible() ? '' : 'hidden';
    element.style.pointerEvents = isDirectionsPanelVisible() ? '' : 'none';
}

function syncAllMarkerVisibility() {
    syncMarkerVisibility('from');
    syncMarkerVisibility('to');
}

function syncMarkerPosition(type) {
    const marker = state.markers[type];
    const point = state[type];
    if (!marker || !point) return;

    marker.setLngLat([point.lng, point.lat]);
}

function syncAllMarkerPositions() {
    syncMarkerPosition('from');
    syncMarkerPosition('to');
}

function updateFields() {
    const fromInput = document.getElementById('directions-from-input');
    const toInput = document.getElementById('directions-to-input');
    const fromClearBtn = document.getElementById('directions-clear-from');
    const toClearBtn = document.getElementById('directions-clear-to');
    const placeholder = document.getElementById('directions-placeholder');

    const rawCoordsRegex = /^-?\d+\.\d+\s*,\s*-?\d+\.\d+$/;
    const hasToken = !!(MAPBOX_TOKEN || window.mapboxgl?.accessToken);

    // Pre-check if geocoding will be needed so we can set loadingGeocode = true synchronously
    // before the fields are populated, preventing coordinate flashes.
    ['from', 'to'].forEach((type) => {
        const point = state[type];
        if (point && rawCoordsRegex.test(point.label || '') && hasToken) {
            const cacheKey = `${point.lng.toFixed(5)},${point.lat.toFixed(5)}`;
            if (!geocodeCache.has(cacheKey)) {
                state.loadingGeocode[type] = true;
            }
        }
    });

    if (fromInput) {
        const label = state.from?.label || '';
        const isRaw = rawCoordsRegex.test(label);
        if (!(state.loadingGeocode?.from && isRaw)) {
            fromInput.value = label;
        }
        fromInput.style.opacity = state.loadingGeocode?.from ? '0.4' : '';
    }
    if (toInput) {
        const label = state.to?.label || '';
        const isRaw = rawCoordsRegex.test(label);
        if (!(state.loadingGeocode?.to && isRaw)) {
            toInput.value = label;
        }
        toInput.style.opacity = state.loadingGeocode?.to ? '0.4' : '';
    }
    if (fromInput) fromInput.placeholder = t('chooseStartingPoint');
    if (toInput) toInput.placeholder = t('chooseDestination');
    fromClearBtn?.setAttribute('aria-label', t('clearStartingPoint'));
    toClearBtn?.setAttribute('aria-label', t('clearDestination'));
    fromClearBtn?.classList.toggle('hidden', !state.from);
    toClearBtn?.classList.toggle('hidden', !state.to);
    syncAllMarkerVisibility();

    if (placeholder) renderDirectionsStatus();

    triggerReverseGeocode('from');
    triggerReverseGeocode('to');
}

const geocodeCache = new Map();

async function triggerReverseGeocode(type) {
    const point = state[type];
    if (!point || !point.lat || !point.lng) return;
    if (state.geocodingInProgress[type]) return;

    const rawCoordsRegex = /^-?\d+\.\d+\s*,\s*-?\d+\.\d+$/;
    const isRawCoords = !point.label || rawCoordsRegex.test(point.label);
    if (!isRawCoords) return;

    const cacheKey = `${point.lng.toFixed(5)},${point.lat.toFixed(5)}`;
    if (geocodeCache.has(cacheKey)) {
        point.label = geocodeCache.get(cacheKey);
        state.loadingGeocode[type] = false;
        updateFields();
        return;
    }

    const token = MAPBOX_TOKEN || window.mapboxgl?.accessToken;
    if (!token) return;

    state.geocodingInProgress[type] = true;
    state.loadingGeocode[type] = true;
    updateFields();

    const mapLang = getCurrentMapLanguage ? getCurrentMapLanguage() : 'en';
    const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${point.lng},${point.lat}.json?access_token=${token}&limit=1&language=${mapLang}&types=address,poi,neighborhood,place`;

    try {
        const response = await fetch(url);
        if (!response.ok) throw new Error('Geocoding fail');
        const data = await response.json();
        const feature = data.features?.[0];
        if (feature) {
            let address = feature.place_name || feature.text || '';
            address = address
                .replace(/, Tbilisi, Georgia$/i, '')
                .replace(/, Georgia$/i, '')
                .replace(/, Tbilisi$/i, '')
                .trim();
            if (address) {
                point.label = address;
                geocodeCache.set(cacheKey, address);
            }
        }
    } catch (err) {
        console.error('Reverse geocoding error:', err);
    } finally {
        state.loadingGeocode[type] = false;
        state.geocodingInProgress[type] = false;
        updateFields();
    }
}

function openDirectionsSheet() {
    const panel = getPanel();
    if (!panel) return;

    const infoPanel = document.getElementById('info-panel');
    const routePanel = document.getElementById('route-info');
    if (infoPanel) setSheetState(infoPanel, 'hidden');
    if (routePanel) setSheetState(routePanel, 'hidden');

    setSheetState(panel, 'half');
    setPanelState(true);
    syncAllMarkerVisibility();
    requestAnimationFrame(syncAllMarkerPositions);
    updateDirectionsIconState(true);

    if (state.routing.result) {
        stopTracking();
    }
}

function setRouteLayersVisibility(visible) {
    if (!map) {
        console.warn('[DirectionsPlot] Cannot set visibility: map is not initialized');
        return;
    }
    const value = visible ? 'visible' : 'none';
    console.log(`[DirectionsPlot] Setting directions layers visibility to "${value}"`);
    const layers = [
        DIRECTIONS_ROUTE_CASING_LAYER_ID,
        DIRECTIONS_ROUTE_LAYER_ID,
        DIRECTIONS_ROUTE_WALK_LAYER_ID,
        DIRECTIONS_ROUTE_STOPS_LAYER_ID
    ];
    layers.forEach((layer) => {
        const exists = !!map.getLayer(layer);
        console.log(`[DirectionsPlot] Layer "${layer}" status: exists=${exists}`);
        if (exists) {
            map.setLayoutProperty(layer, 'visibility', value);
            console.log(`[DirectionsPlot] Set layer "${layer}" visibility to "${value}"`);
        }
    });

    if (Array.isArray(state.routing.transferMarkers)) {
        state.routing.transferMarkers.forEach((marker) => {
            const el = marker.getElement();
            if (el) {
                el.style.display = visible ? '' : 'none';
            }
        });
    }
}

export function updateDirectionsIconState(isActive) {
    const btn = document.getElementById('search-directions');
    if (btn) {
        const wasActive = btn.classList.contains('active');
        btn.classList.toggle('active', isActive);
        if (wasActive && !isActive) {
            btn.classList.remove('bounce-animation');
            void btn.offsetWidth; // trigger reflow
            btn.classList.add('bounce-animation');
            btn.addEventListener('animationend', () => {
                btn.classList.remove('bounce-animation');
            }, { once: true });
        } else if (isActive) {
            btn.classList.remove('bounce-animation');
        }
    }
}

export function redrawActiveDirections() {
    if (state.routing.result) {
        console.log('[DirectionsPlot] Redrawing active directions route');
        renderDirectionsResult(state.routing.result, { fit: false });
    }
}

export function openDirections() {
    state.isSuspended = false;
    if (!state.from && !state.to) {
        const restored = loadDirectionsStateFromStorage();
        if (!restored) {
            const userCoords = getLastUserCoords();
            if (userCoords) {
                state.from = {
                    lng: userCoords.lng,
                    lat: userCoords.lat,
                    label: t('myLocation')
                };
                renderMarker('from');
            }
        }
    }
    if (state.from && state.to) {
        if (state.routing.result) {
            renderDirectionsResult(state.routing.result, { fit: true });
        } else {
            scheduleDirectionsFetch({ delay: 0 });
        }
    }
    updateFields();
    openDirectionsSheet();
    syncDirectionsUrl();
    updateDirectionsIconState(true);
}

export function toggleDirections() {
    const isVisible = isDirectionsPanelVisible();
    if (isVisible) {
        state.isSuspended = true;
        const panel = getPanel();
        if (panel) setSheetState(panel, 'hidden');
        setPanelState(false);
        restoreMapUrl();
        setRouteLayersVisibility(false);
        syncAllMarkerVisibility();
        updateDirectionsIconState(false);
    } else {
        state.isSuspended = false;
        openDirectionsSheet();
        
        // Restore route layers visibility if we have a result
        if (state.routing.result) {
            renderDirectionsResult(state.routing.result, { fit: true });
        } else {
            // No result, check if we need to initialize default starting point
            if (!state.from && !state.to) {
                const restored = loadDirectionsStateFromStorage();
                if (!restored) {
                    const userCoords = getLastUserCoords();
                    if (userCoords) {
                        state.from = {
                            lng: userCoords.lng,
                            lat: userCoords.lat,
                            label: t('myLocation')
                        };
                        renderMarker('from');
                    }
                }
            } else if (state.from && state.to) {
                // If both points are set but we don't have a result, build the route!
                scheduleDirectionsFetch({ delay: 0 });
            }
        }
        
        updateFields();
        syncDirectionsUrl();
    }
}

function hideContextMenu() {
    const menu = document.getElementById('directions-context-menu');
    if (!menu) return;
    menu.classList.add('hidden');
    state.contextPoint = null;
}

function showContextMenu(event) {
    const menu = document.getElementById('directions-context-menu');
    if (!menu) return;

    state.contextPoint = buildPoint(event);

    const canvasRect = map.getCanvas().getBoundingClientRect();
    const left = canvasRect.left + event.point.x;
    const top = canvasRect.top + event.point.y;
    const width = 210;
    const height = 92;
    const pad = 10;

    menu.style.left = `${Math.min(left, window.innerWidth - width - pad)}px`;
    menu.style.top = `${Math.min(top, window.innerHeight - height - pad)}px`;
    menu.classList.remove('hidden');
}

export function setPoint(type, point, { syncUrl = true, openSheet = true } = {}) {
    state[type] = point;
    renderMarker(type);

    if (!state.hasCompletedFirstUseDefault) {
        if (type === 'to') {
            const otherType = 'from';
            if (!state[otherType]) {
                const userCoords = getLastUserCoords();
                if (userCoords) {
                    state.hasCompletedFirstUseDefault = true;
                    const defaultPoint = {
                        lng: userCoords.lng,
                        lat: userCoords.lat,
                        label: t('myLocation')
                    };
                    state[otherType] = defaultPoint;
                    renderMarker(otherType);
                }
            }
        } else if (type === 'from') {
            state.hasCompletedFirstUseDefault = true;
        }
    }

    updateFields();
    if (openSheet) {
        openDirectionsSheet();
    }
    if (syncUrl) {
        syncDirectionsUrl();
    }
    scheduleDirectionsFetch();
}

export function clearPoint(type, { syncUrl = true } = {}) {
    state[type] = null;
    if (state.markers[type]) {
        state.markers[type].remove();
        state.markers[type] = null;
    }
    updateFields();
    if (syncUrl) {
        syncDirectionsUrl();
    }
    scheduleDirectionsFetch();
}

function reversePoints({ syncUrl = true } = {}) {
    const previousFrom = state.from;
    state.from = state.to;
    state.to = previousFrom;
    renderMarker('from');
    renderMarker('to');
    updateFields();
    if (syncUrl) {
        syncDirectionsUrl();
    }
    scheduleDirectionsFetch();
}

function padNumber(value) {
    return String(value).padStart(2, '0');
}

function startOfDay(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function getMinSelectableDate() {
    return addDays(startOfDay(new Date()), -1);
}

function getMaxSelectableDate() {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

function isSameDay(first, second) {
    return startOfDay(first).getTime() === startOfDay(second).getTime();
}

function addMinutes(date, minutes) {
    const next = new Date(date);
    next.setMinutes(next.getMinutes() + minutes);
    return next;
}

function snapTimeToFiveMinuteSlot(date, direction) {
    const snapped = new Date(date);
    const minute = snapped.getMinutes();
    const remainder = minute % 5;
    const slotMinute = direction > 0
        ? minute + (remainder === 0 ? 5 : 5 - remainder)
        : minute - (remainder === 0 ? 5 : remainder);

    snapped.setMinutes(slotMinute);
    return snapped;
}

function addDays(date, days) {
    const next = new Date(date);
    next.setDate(next.getDate() + days);
    return next;
}

function clampScheduledDate(date) {
    const minDate = getMinSelectableDate();
    const maxDate = getMaxSelectableDate();
    const clamped = new Date(date);
    const day = startOfDay(clamped);

    if (day < minDate) {
        clamped.setFullYear(minDate.getFullYear(), minDate.getMonth(), minDate.getDate());
        return clamped;
    }

    if (day > maxDate) {
        clamped.setFullYear(maxDate.getFullYear(), maxDate.getMonth(), maxDate.getDate());
        return clamped;
    }

    return clamped;
}

function isBeforeMin(date) {
    return startOfDay(date) < getMinSelectableDate();
}

function isAfterMax(date) {
    return startOfDay(date) > getMaxSelectableDate();
}

function formatLocalInputValue(date) {
    return `${date.getFullYear()}-${padNumber(date.getMonth() + 1)}-${padNumber(date.getDate())}T${padNumber(date.getHours())}:${padNumber(date.getMinutes())}`;
}

function formatTimeLabel(date) {
    return `${padNumber(date.getHours())}:${padNumber(date.getMinutes())}`;
}

function parseTimeInputValue(value, fallbackDate) {
    const match = String(value).trim().match(/^(\d{1,2}):(\d{2})$/);
    if (!match) return null;

    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
    if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;

    const next = new Date(fallbackDate);
    next.setHours(hours, minutes, 0, 0);
    return next;
}

function formatDateLabel(date) {
    const today = startOfDay(new Date());
    const selected = startOfDay(date);
    const tomorrow = addDays(today, 1);
    const locale = getCurrentUiLanguage();

    if (selected.getTime() === today.getTime()) return t('today');
    if (selected.getTime() === tomorrow.getTime()) return t('tomorrow');

    return new Intl.DateTimeFormat(locale, {
        month: 'short',
        day: 'numeric'
    }).format(date);
}

function setTimeMode(mode, { syncUrl = true } = {}) {
    state.time.mode = mode;
    document.querySelectorAll('input[name="directions-time-mode"]').forEach((input) => {
        input.checked = input.value === mode;
    });
    renderTimePicker();
    if (syncUrl) {
        syncDirectionsUrl();
        scheduleDirectionsFetch();
    }
}

function setScheduledTime(date, mode = state.time.mode === 'arriveBy' ? 'arriveBy' : 'departAt', { syncUrl = true } = {}) {
    state.time.value = clampScheduledDate(date);
    state.time.calendarMonth = new Date(state.time.value.getFullYear(), state.time.value.getMonth(), 1);
    setTimeMode(mode, { syncUrl: false });
    if (syncUrl) {
        syncDirectionsUrl();
        scheduleDirectionsFetch();
    }
}

function setCalendarOpen(isOpen) {
    state.time.calendarOpen = isOpen;
    renderTimePicker();
}

function renderCalendar() {
    const monthLabel = document.getElementById('directions-calendar-month');
    const grid = document.getElementById('directions-calendar-grid');
    if (!monthLabel || !grid) return;

    const monthDate = state.time.calendarMonth;
    const locale = getCurrentUiLanguage();
    const monthName = new Intl.DateTimeFormat(locale, { month: 'long' }).format(monthDate);
    monthLabel.textContent = monthName.charAt(0).toUpperCase() + monthName.slice(1);
    grid.innerHTML = '';

    const firstOfMonth = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1);
    const mondayOffset = (firstOfMonth.getDay() + 6) % 7;
    const firstCellDate = addDays(firstOfMonth, -mondayOffset);
    const today = new Date();
    const minDate = getMinSelectableDate();
    const maxDate = getMaxSelectableDate();

    for (let index = 0; index < 42; index += 1) {
        const cellDate = addDays(firstCellDate, index);
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = String(cellDate.getDate());
        button.className = 'directions-calendar-day';
        button.dataset.date = formatLocalInputValue(cellDate);

        button.classList.toggle('outside-month', cellDate.getMonth() !== monthDate.getMonth());
        button.classList.toggle('selected', isSameDay(cellDate, state.time.tempValue || state.time.value));
        button.classList.toggle('today', isSameDay(cellDate, today));
        button.classList.toggle('weekend', cellDate.getDay() === 0 || cellDate.getDay() === 6);
        button.classList.toggle('disabled', startOfDay(cellDate) < minDate || startOfDay(cellDate) > maxDate);
        button.disabled = startOfDay(cellDate) < minDate || startOfDay(cellDate) > maxDate;
        button.setAttribute('aria-label', new Intl.DateTimeFormat(locale, {
            weekday: 'long',
            month: 'long',
            day: 'numeric'
        }).format(cellDate));

        button.addEventListener('click', () => {
            const baseDate = state.time.tempValue || state.time.value;
            const next = new Date(baseDate);
            next.setFullYear(cellDate.getFullYear(), cellDate.getMonth(), cellDate.getDate());
            state.time.calendarOpen = false;
            if (state.time.tempValue) {
                state.time.tempValue = clampScheduledDate(next);
                renderTimePicker();
            } else {
                setScheduledTime(next);
            }
        });

        grid.appendChild(button);
    }
}

function commitTimeSelection() {
    if (!state.time.tempValue) return;

    const next = state.time.tempValue;
    const mode = state.time.tempMode || (state.time.mode === 'leaveNow' ? 'departAt' : state.time.mode);

    state.time.tempValue = null;
    state.time.tempMode = null;

    setScheduledTime(next, mode);
}

function renderTimePicker() {
    const dateDisplay = document.getElementById('directions-date-display');
    const modeSelect = document.getElementById('directions-time-mode-select');
    const resetBtn = document.getElementById('directions-reset-btn');
    const timePrevBtn = document.getElementById('directions-time-prev');
    const timeNextBtn = document.getElementById('directions-time-next');
    const datePrevBtn = document.getElementById('directions-date-prev');
    const dateNextBtn = document.getElementById('directions-date-next');
    const datePill = document.getElementById('directions-date-pill');
    const calendar = document.getElementById('directions-calendar-popover');
    const calendarPrevBtn = document.getElementById('directions-calendar-prev');
    const calendarNextBtn = document.getElementById('directions-calendar-next');
    const timeInput = document.getElementById('directions-time-input');
    const timeAndDateLabel = document.getElementById('directions-time-and-date-label');
    const minDate = getMinSelectableDate();
    const maxDate = getMaxSelectableDate();
    const minMonth = new Date(minDate.getFullYear(), minDate.getMonth(), 1);
    const maxMonth = new Date(maxDate.getFullYear(), maxDate.getMonth(), 1);

    const isLeaveNow = state.time.mode === 'leaveNow' && !state.time.tempValue;
    const activeDate = state.time.tempValue || (isLeaveNow ? new Date() : state.time.value);
    if (isLeaveNow) {
        state.time.value = activeDate;
        state.time.calendarMonth = new Date(activeDate.getFullYear(), activeDate.getMonth(), 1);
    }

    if (dateDisplay) dateDisplay.textContent = formatDateLabel(activeDate);
    
    const displayMode = state.time.tempMode || state.time.mode;
    if (modeSelect) modeSelect.value = displayMode === 'arriveBy' ? 'arriveBy' : 'departAt';
    
    if (timeAndDateLabel) timeAndDateLabel.textContent = t('timeAndDate');
    
    if (resetBtn) resetBtn.classList.toggle('hidden', isLeaveNow);

    if (datePill) {
        datePill.classList.toggle('is-open', state.time.calendarOpen);
        datePill.setAttribute('aria-expanded', String(state.time.calendarOpen));
    }
    if (calendar) calendar.classList.toggle('hidden', !state.time.calendarOpen);
    if (timeInput) {
        if (isLeaveNow) {
            if (timeInput.type !== 'text') {
                timeInput.type = 'text';
            }
            timeInput.value = t('now');
        } else {
            if (timeInput.type !== 'time') {
                timeInput.type = 'time';
            }
            timeInput.value = formatTimeLabel(activeDate);
        }
        timeInput.readOnly = false;
    }

    if (timePrevBtn) timePrevBtn.disabled = isBeforeMin(snapTimeToFiveMinuteSlot(activeDate, -1));
    if (timeNextBtn) timeNextBtn.disabled = isAfterMax(snapTimeToFiveMinuteSlot(activeDate, 1));
    if (datePrevBtn) datePrevBtn.disabled = isBeforeMin(addDays(activeDate, -1));
    if (dateNextBtn) dateNextBtn.disabled = isAfterMax(addDays(activeDate, 1));
    if (calendarPrevBtn) calendarPrevBtn.disabled = state.time.calendarMonth <= minMonth;
    if (calendarNextBtn) calendarNextBtn.disabled = state.time.calendarMonth >= maxMonth;

    renderCalendar();
    updateDirectionsOptionsSummary();
}

function updateDirectionsOptionsSummary() {
    const labelEl = document.getElementById('directions-options-summary-label');
    if (!labelEl) return;

    const overrides = [];

    const selectedModes = getSelectedModeValues() || [];
    const hasBus = selectedModes.includes('BUS');
    const hasMetro = selectedModes.includes('SUBWAY') || selectedModes.includes('METRO');
    const hasCableCar = selectedModes.includes('GONDOLA');

    if (!hasBus) {
        overrides.push(t('noBus'));
    }
    if (!hasMetro) {
        overrides.push(t('noMetro'));
    }
    if (!hasCableCar) {
        overrides.push(t('noCableCar'));
    }

    const optimize = getSelectedOptimizeValue();
    if (optimize === 'lessWalking') {
        overrides.push(t('lessWalking'));
    } else if (optimize === 'lessTransfers') {
        overrides.push(t('lessTransfers'));
    }

    if (state.time.mode !== 'leaveNow') {
        const isLeaveNow = state.time.mode === 'leaveNow';
        const activeDate = isLeaveNow ? new Date() : state.time.value;
        const timeStr = formatTimeLabel(activeDate);
        const dateLabel = formatDateLabel(activeDate);
        
        let timeLabel = '';
        if (dateLabel === t('today')) {
            timeLabel = `${t(state.time.mode)} ${timeStr}`;
        } else {
            timeLabel = `${t(state.time.mode)} ${dateLabel} ${timeStr}`;
        }
        overrides.push(timeLabel);
    }

    const summaryEl = labelEl.closest('.directions-options-summary');
    if (overrides.length > 0) {
        labelEl.textContent = overrides.join(', ');
        labelEl.classList.add('directions-options-overridden');
        summaryEl?.classList.add('directions-options-overridden');
    } else {
        labelEl.textContent = t('options');
        labelEl.classList.remove('directions-options-overridden');
        summaryEl?.classList.remove('directions-options-overridden');
    }
}

function syncTimeFromRadio() {
    const selected = document.querySelector('input[name="directions-time-mode"]:checked')?.value || 'leaveNow';
    setTimeMode(selected);
}

function syncSegmentedActiveState(groupName) {
    document.querySelectorAll(`input[name="${groupName}"]`).forEach((input) => {
        input.closest('.theme-option')?.classList.toggle('active', input.checked);
    });
}

function syncDirectionsLanguage() {
    syncMarkerLabels();
    updateFields();
    renderTimePicker();
}

export function getDirectionsRequestDraft() {
    const modes = ['bus', 'subway', 'gondola']
        .map((id) => document.getElementById(`directions-mode-${id}`))
        .filter((input) => input?.checked)
        .map((input) => input.value);

    return {
        from: state.from,
        to: state.to,
        modes: ['WALK', ...modes],
        optimize: document.querySelector('input[name="directions-optimize"]:checked')?.value || 'quick',
        timeMode: document.querySelector('input[name="directions-time-mode"]:checked')?.value || 'leaveNow',
        time: state.time.mode === 'leaveNow' ? '' : formatLocalInputValue(state.time.value)
    };
}

export function initDirectionsUI() {
    ensureMetroSchematicData();

    const contextMenu = document.getElementById('directions-context-menu');
    const fromBtn = document.getElementById('directions-context-from');
    const toBtn = document.getElementById('directions-context-to');
    const closeBtn = document.getElementById('close-directions');
    const reverseBtn = document.getElementById('directions-reverse');
    const clearFromBtn = document.getElementById('directions-clear-from');
    const clearToBtn = document.getElementById('directions-clear-to');
    const timeModeSelect = document.getElementById('directions-time-mode-select');
    const resetBtn = document.getElementById('directions-reset-btn');
    const timePrevBtn = document.getElementById('directions-time-prev');
    const timeNextBtn = document.getElementById('directions-time-next');
    const datePrevBtn = document.getElementById('directions-date-prev');
    const dateNextBtn = document.getElementById('directions-date-next');
    const datePill = document.getElementById('directions-date-pill');
    const calendarPrevBtn = document.getElementById('directions-calendar-prev');
    const calendarNextBtn = document.getElementById('directions-calendar-next');
    const timeInput = document.getElementById('directions-time-input');
    document.querySelectorAll('.directions-menu-row').forEach((row) => {
        const checkbox = row.querySelector('input[type="checkbox"]');
        if (!checkbox) return;

        row.addEventListener('click', (event) => {
            if (event.target.closest('.toggle-switch')) return;
            if (event.target.matches('input, button, label, a')) return;
            checkbox.checked = !checkbox.checked;
            checkbox.dispatchEvent(new Event('change', { bubbles: true }));
        });
    });

    let longPressTimeout = null;
    let startPoint = null;

    function startLongPressTimer(event) {
        cancelLongPressTimer();
        // Don't trigger context menu if we tap on route marker elements
        if (event.originalEvent?.target?.closest('.directions-pin')) return;
        
        startPoint = event.point;
        longPressTimeout = setTimeout(() => {
            showContextMenu(event);
        }, 600);
    }

    function cancelLongPressTimer() {
        if (longPressTimeout) {
            clearTimeout(longPressTimeout);
            longPressTimeout = null;
        }
        startPoint = null;
    }

    function handleLongPressMove(event) {
        if (!longPressTimeout || !startPoint || !event.point) return;
        const dx = event.point.x - startPoint.x;
        const dy = event.point.y - startPoint.y;
        if (dx * dx + dy * dy > 64) {
            cancelLongPressTimer();
        }
    }

    map.on('mousedown', startLongPressTimer);
    map.on('touchstart', startLongPressTimer);
    map.on('mousemove', handleLongPressMove);
    map.on('touchmove', handleLongPressMove);
    map.on('mouseup', cancelLongPressTimer);
    map.on('touchend', cancelLongPressTimer);
    map.on('dragstart', cancelLongPressTimer);
    map.on('zoomstart', cancelLongPressTimer);
    map.on('movestart', cancelLongPressTimer);

    map.on('contextmenu', (event) => {
        event.preventDefault?.();
        event.originalEvent?.preventDefault?.();
        cancelLongPressTimer();
        showContextMenu(event);
    });

    fromBtn?.addEventListener('click', () => {
        if (state.contextPoint) setPoint('from', state.contextPoint);
        hideContextMenu();
    });

    toBtn?.addEventListener('click', () => {
        if (state.contextPoint) setPoint('to', state.contextPoint);
        hideContextMenu();
    });

    closeBtn?.addEventListener('click', () => {
        state.isSuspended = true;
        const panel = getPanel();
        if (panel) setSheetState(panel, 'hidden');
        setPanelState(false);
        restoreMapUrl();
        setRouteLayersVisibility(false);
        syncAllMarkerVisibility();
        updateDirectionsIconState(false);
    });

    reverseBtn?.addEventListener('click', reversePoints);
    clearFromBtn?.addEventListener('click', () => clearPoint('from'));
    clearToBtn?.addEventListener('click', () => clearPoint('to'));

    timeModeSelect?.addEventListener('change', (event) => {
        const nextMode = event.target.value === 'arriveBy' ? 'arriveBy' : 'departAt';
        if (state.time.tempValue) {
            state.time.tempMode = nextMode;
            renderTimePicker();
        } else {
            setTimeMode(nextMode);
        }
    });

    const initTimeInputTempState = () => {
        if (!state.time.tempValue) {
            state.time.tempValue = new Date(state.time.value);
            state.time.tempMode = state.time.mode === 'leaveNow' ? 'departAt' : state.time.mode;
            renderTimePicker();
        }
    };

    timeInput?.addEventListener('focus', () => {
        initTimeInputTempState();
        if (timeInput.type === 'time' && typeof timeInput.showPicker === 'function') {
            try {
                timeInput.showPicker();
            } catch (e) {
                console.error('showPicker failed', e);
            }
        }
    });

    timeInput?.addEventListener('click', () => {
        initTimeInputTempState();
        if (timeInput.type === 'time' && typeof timeInput.showPicker === 'function') {
            try {
                timeInput.showPicker();
            } catch (e) {
                console.error('showPicker failed', e);
            }
        }
    });

    const handleTimeInputChange = () => {
        if (!state.time.tempValue) return;
        const parsed = parseTimeInputValue(timeInput.value, state.time.tempValue);
        if (parsed) {
            state.time.tempValue = parsed;
        }
    };

    timeInput?.addEventListener('change', handleTimeInputChange);
    timeInput?.addEventListener('input', handleTimeInputChange);

    timeInput?.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            commitTimeSelection();
            timeInput.blur();
        }
    });

    timeInput?.addEventListener('blur', () => {
        setTimeout(() => {
            if (state.time.tempValue) {
                commitTimeSelection();
            }
        }, 150);
    });

    resetBtn?.addEventListener('mousedown', (event) => {
        event.preventDefault();
    });

    resetBtn?.addEventListener('click', () => {
        state.time.value = new Date();
        state.time.calendarOpen = false;
        state.time.tempValue = null;
        state.time.tempMode = null;
        setTimeMode('leaveNow');
    });

    const adjustTime = (direction) => {
        const baseDate = state.time.tempValue || state.time.value;
        const next = snapTimeToFiveMinuteSlot(baseDate, direction);
        if (state.time.tempValue) {
            state.time.tempValue = clampScheduledDate(next);
            renderTimePicker();
        } else {
            setScheduledTime(next);
        }
    };

    const adjustDate = (days) => {
        const baseDate = state.time.tempValue || state.time.value;
        const next = addDays(baseDate, days);
        if (state.time.tempValue) {
            state.time.tempValue = clampScheduledDate(next);
            renderTimePicker();
        } else {
            setScheduledTime(next);
        }
    };

    timePrevBtn?.addEventListener('click', () => adjustTime(-1));
    timeNextBtn?.addEventListener('click', () => adjustTime(1));
    datePrevBtn?.addEventListener('click', () => adjustDate(-1));
    dateNextBtn?.addEventListener('click', () => adjustDate(1));
    datePill?.addEventListener('click', () => setCalendarOpen(!state.time.calendarOpen));
    calendarPrevBtn?.addEventListener('click', () => {
        state.time.calendarMonth = new Date(
            state.time.calendarMonth.getFullYear(),
            state.time.calendarMonth.getMonth() - 1,
            1
        );
        renderTimePicker();
    });
    calendarNextBtn?.addEventListener('click', () => {
        state.time.calendarMonth = new Date(
            state.time.calendarMonth.getFullYear(),
            state.time.calendarMonth.getMonth() + 1,
            1
        );
        renderTimePicker();
    });

    document.querySelectorAll('input[name="directions-time-mode"]').forEach((input) => {
        input.addEventListener('change', () => {
            syncSegmentedActiveState('directions-time-mode');
            syncTimeFromRadio();
        });
    });

    document.querySelectorAll('input[name="directions-optimize"]').forEach((input) => {
        input.addEventListener('change', () => {
            syncSegmentedActiveState('directions-optimize');
            syncDirectionsUrl();
            scheduleDirectionsFetch();
            updateDirectionsOptionsSummary();
        });
    });

    document.querySelectorAll('input[id^="directions-mode-"]').forEach((input) => {
        input.addEventListener('change', () => {
            syncDirectionsUrl();
            scheduleDirectionsFetch();
            updateDirectionsOptionsSummary();
        });
    });

    document.addEventListener('click', (event) => {
        if (!contextMenu || contextMenu.classList.contains('hidden')) return;
        if (contextMenu.contains(event.target)) return;
        hideContextMenu();
    });

    document.addEventListener('click', (event) => {
        const calendar = document.getElementById('directions-calendar-popover');
        const dateGroup = document.querySelector('.directions-date-group');
        if (!calendar || calendar.classList.contains('hidden')) return;
        if (dateGroup?.contains(event.target)) return;
        setCalendarOpen(false);
    });

    map.on('movestart', hideContextMenu);
    map.on('zoomstart', hideContextMenu);
    map.on('style.load', () => {
        if (state.routing.result && isDirectionsPanelVisible()) {
            renderDirectionsResult(state.routing.result, { fit: false });
        }
    });
    document.addEventListener('sheet:closed', (event) => {
        if (event.detail?.panelId === 'directions-panel') {
            restoreMapUrl();
            if (!state.isSuspended) {
                clearDirectionsRoute();
                state.from = null;
                state.to = null;
                updateFields();
                saveDirectionsStateToStorage();
            }
            setRouteLayersVisibility(false);
            syncAllMarkerVisibility();
            renderDirectionsStatus();
            updateDirectionsIconState(false);
        }
    });

    onLanguageChange((change) => {
        if (change.target === 'ui') {
            syncDirectionsLanguage();
        }
        if (change.target === 'map') {
            geocodeCache.clear();
            if (state.from && !state.from.featureId) {
                state.from.label = formatCoordinate(state.from);
            }
            if (state.to && !state.to.featureId) {
                state.to.label = formatCoordinate(state.to);
            }
            updateFields();
        }
    });

    window.addEventListener('map-data-initialized', () => {
        if (state.routing.result && isDirectionsPanelVisible()) {
            renderDirectionsStatus();
        }
    });

    window.addEventListener('static-routes-loaded', () => {
        if (state.routing.result && isDirectionsPanelVisible()) {
            renderDirectionsStatus();
        }
    });

    renderTimePicker();
    syncAllMarkerVisibility();
    syncMarkerLabels();
    updateFields();
}

export function getActiveDirectionsMetroDetails() {
    const route = state.routing.result?.routes?.[state.routing.selectedRouteIndex];
    if (!route || !route.segments) {
        return null;
    }

    const metroSegmentsIds = new Set();
    const metroTerminalIds = new Set();

    route.segments.forEach(seg => {
        const mode = String(seg.mode || '').toUpperCase();
        if (mode === 'SUBWAY' || mode === 'METRO') {
            const lineNum = Number(seg.routeShortName) === 2 ? 2 : 1;
            const fromId = resolveMetroSegmentId(seg.from?.name, lineNum);
            const toId = resolveMetroSegmentId(seg.to?.name, lineNum);
            
            if (fromId && toId) {
                metroTerminalIds.add(fromId);
                metroTerminalIds.add(toId);

                const seq = lineNum === 2 ? LINE_2_SEQUENCE : LINE_1_SEQUENCE;
                const idxA = seq.indexOf(fromId);
                const idxB = seq.indexOf(toId);
                if (idxA !== -1 && idxB !== -1) {
                    const min = Math.min(idxA, idxB);
                    const max = Math.max(idxA, idxB);
                    for (let i = min; i <= max; i++) {
                        metroSegmentsIds.add(seq[i]);
                    }
                }
            }
        }
    });

    if (metroSegmentsIds.size === 0) {
        return null;
    }

    // Deduplicate Station Square labels: if both platforms are in the route, only keep the Red Line (metro_1_8) label
    if (metroTerminalIds.has('metro_1_8') && metroTerminalIds.has('metro_2_1')) {
        metroTerminalIds.delete('metro_2_1');
    }

    return {
        stationIds: Array.from(metroSegmentsIds),
        terminalIds: Array.from(metroTerminalIds)
    };
}

export function getActiveDirectionsTransferPoints() {
    if (!state.routing.result || state.routing.status !== 'success') {
        return [];
    }
    return buildTransferPoints(state.routing.result, state.routing.selectedRouteIndex);
}

window.getActiveDirectionsMetroDetails = getActiveDirectionsMetroDetails;
window.getActiveDirectionsTransferPoints = getActiveDirectionsTransferPoints;
window.isDirectionsContextActive = isDirectionsContextActive;
