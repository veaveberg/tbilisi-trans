import mapboxgl from 'mapbox-gl';
import * as turf from '@turf/turf';
import { getSegmentForStop, generateSegmentGeometry, generateConnectionGeometry, getConnectionKey, SEGMENT_LENGTH_M, LINE_1_IDS, LINE_2_IDS } from './metro-utils';
import metroWaysData from './metro_ways.json';

let _map = null;
let _allStops = null;
let _segments = {};
let _midpoints = {}; // Store midpoints between stations: { "idA__idB": [{ position, angle, handleIn, handleOut }] }
let _isEditorActive = false;

// State for Interaction
let _selectedStopId = null;
let _dragState = null; // { type: 'center'|'rotate'|'midpoint', startLngLat, startVal, stopId, midpointKey, midpointIndex }

const LAYER_ID_LINES = 'metro-editor-lines';
const LAYER_ID_HANDLES = 'metro-editor-handles';
const SOURCE_ID = 'metro-editor-source';
const OSM_SOURCE_ID = 'osm-metro-lines-source';
const OSM_LAYER_ID = 'osm-metro-lines-layer';

export async function initMetroEditor(map, allStops) {
    if (_map) {
        // Already initialized, toggle visibility
        toggleMetroEditor();
        return;
    }

    _map = map;
    _allStops = allStops;

    console.log('[MetroEditor] Initializing...');
    await loadSegments();
    await loadMidpoints();

    // Add Source
    if (!map.getSource(SOURCE_ID)) {
        map.addSource(SOURCE_ID, {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: [] }
        });
    }

    // Add OSM Reference Source
    setupOSMReferenceLayer();

    // Add Token/Global
    window.toggleMetroEditor = toggleMetroEditor;
    window.saveMetroSegments = saveMetroSegments;
    window.addMidpoint = addMidpointToConnection;
    window.removeMidpoint = removeMidpointFromConnection;

    // Auto-enable for first time use
    toggleMetroEditor(true);
}

function setupOSMReferenceLayer() {
    if (_map.getSource(OSM_SOURCE_ID)) return;

    // Convert OSM ways data to GeoJSON
    const features = metroWaysData.elements
        .filter(el => el.type === 'way' && el.geometry)
        .map(way => ({
            type: 'Feature',
            properties: {
                id: way.id,
                name: way.tags?.name || way.tags?.['name:en'] || 'Metro Line',
                ref: way.tags?.ref || '',
                isMainLine: !way.tags?.service // Main lines don't have service tag
            },
            geometry: {
                type: 'LineString',
                coordinates: way.geometry.map(pt => [pt.lon, pt.lat])
            }
        }));

    _map.addSource(OSM_SOURCE_ID, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features }
    });

    // Add layer (initially hidden)
    _map.addLayer({
        id: OSM_LAYER_ID,
        type: 'line',
        source: OSM_SOURCE_ID,
        layout: {
            'line-join': 'round',
            'line-cap': 'round',
            'visibility': 'none'
        },
        paint: {
            'line-color': [
                'case',
                ['get', 'isMainLine'], '#ff6600',
                '#996633'
            ],
            'line-width': [
                'case',
                ['get', 'isMainLine'], 3,
                2
            ],
            'line-opacity': 0.7,
            'line-dasharray': [2, 2]
        }
    });

    console.log(`[MetroEditor] Loaded ${features.length} OSM metro way segments as reference`);
}

function toggleMetroEditor(forceState) {
    _isEditorActive = forceState !== undefined ? forceState : !_isEditorActive;
    console.log('[MetroEditor] Active:', _isEditorActive);

    if (_isEditorActive) {
        // Show OSM reference layer
        if (_map.getLayer(OSM_LAYER_ID)) {
            _map.setLayoutProperty(OSM_LAYER_ID, 'visibility', 'visible');
        }
        // Add Layers
        addEditorLayers();
        renderSegments();
        setupInteractions();
    } else {
        // Hide OSM reference layer
        if (_map.getLayer(OSM_LAYER_ID)) {
            _map.setLayoutProperty(OSM_LAYER_ID, 'visibility', 'none');
        }
        // Remove Layers/Handlers
        removeEditorLayers();
        removeInteractions();
    }
}

async function loadSegments() {
    try {
        const basePath = import.meta.env.BASE_URL.endsWith('/') ? import.meta.env.BASE_URL : `${import.meta.env.BASE_URL}/`;
        // Add cache-busting timestamp to ensure we get the latest file
        const url = `${basePath}data/metro_segments.json?t=${Date.now()}`;
        console.log('[MetroEditor] Loading segments from:', url);

        const res = await fetch(url, { cache: 'no-store' });
        if (res.ok) {
            _segments = await res.json();
            console.log(`[MetroEditor] Loaded ${_segments ? Object.keys(_segments).length : 0} segments.`);
        } else {
            console.warn('[MetroEditor] No existing segments found, starting fresh.');
        }
    } catch (e) {
        console.warn('[MetroEditor] Failed to load segments:', e);
    }
}

async function loadMidpoints() {
    try {
        const basePath = import.meta.env.BASE_URL.endsWith('/') ? import.meta.env.BASE_URL : `${import.meta.env.BASE_URL}/`;
        // Add cache-busting timestamp to ensure we get the latest file
        const url = `${basePath}data/metro_midpoints.json?t=${Date.now()}`;

        console.log('[MetroEditor] Loading midpoints from:', url);

        const res = await fetch(url, { cache: 'no-store' });
        if (res.ok) {
            const data = await res.json();
            _midpoints = data;
            const keys = Object.keys(_midpoints);
            console.log(`[MetroEditor] Loaded ${keys.length} midpoint connections:`, keys);
        } else {
            console.log('[MetroEditor] No existing midpoints found (status:', res.status, '), starting fresh.');
            _midpoints = {};
        }
    } catch (e) {
        console.error('[MetroEditor] Failed to load midpoints file:', e);
        _midpoints = {};
    }
}

function addEditorLayers() {
    if (!_map.getLayer(LAYER_ID_LINES)) {
        _map.addLayer({
            id: LAYER_ID_LINES,
            type: 'line',
            source: SOURCE_ID,
            layout: {
                'line-cap': 'round',
                'line-join': 'round'
            },
            paint: {
                'line-width': 6,
                'line-color': ['get', 'color'],
                'line-opacity': 0.8
            }
        });
    }

    // Handles (Circles)
    if (!_map.getLayer(LAYER_ID_HANDLES)) {
        _map.addLayer({
            id: LAYER_ID_HANDLES,
            type: 'circle',
            source: SOURCE_ID,
            filter: ['==', '$type', 'Point'],
            paint: {
                'circle-radius': ['get', 'radius'],
                'circle-color': ['get', 'color'],
                'circle-stroke-width': 2,
                'circle-stroke-color': '#fff'
            }
        });
    }
}

function removeEditorLayers() {
    if (_map.getLayer(LAYER_ID_LINES)) _map.removeLayer(LAYER_ID_LINES);
    if (_map.getLayer(LAYER_ID_HANDLES)) _map.removeLayer(LAYER_ID_HANDLES);
}

function getMetroStops() {
    return _allStops.filter(s => (s.vehicleMode === 'SUBWAY' || s.mode === 'SUBWAY' || s.transportType === 'SUBWAY') && s.lon && s.lat);
}

function renderSegments() {
    const stops = getMetroStops();
    console.log(`[MetroEditor] Rendering segments for ${stops.length} stops`);
    if (stops.length === 0) {
        console.warn('[MetroEditor] No metro stops found! Check _allStops content:', _allStops.slice(0, 5));
    }

    const features = [];

    stops.forEach(stop => {
        // Helper to get/init segment with ID logic
        const seg = getSegmentForStop(stop, _segments);
        // Ensure we store it back in runtime state if it was defaulted
        // Note: getSegmentForStop returns a COPY, does not mutate _segments.
        // But for editor we need stateful object.
        if (!_segments[stop.id] && !_segments[stop.id.replace(/^1:/, '')]) {
            _segments[stop.id] = seg;
        }

        // We use the reference from _segments for rendering so dragging works
        // But for the initial pass, we might have newly created defaults.
        // Let's rely on _segments lookup again.
        let liveSeg = _segments[stop.id] || _segments[stop.id.replace(/^1:/, '')];
        // If still missing (shouldn't happen due to logic above), use the copy
        if (!liveSeg) {
            _segments[stop.id] = seg;
            liveSeg = seg;
        }

        const { center, rotation, handleL, handleR } = liveSeg;
        const geom = generateSegmentGeometry(liveSeg);
        const { leftPt, rightPt } = geom;

        // Start/End Points (re-calculated here for handle generation using Turf destination)
        // Actually generateSegmentGeometry returned raw coordinates.
        // We need turf points for further destination calcs for handles.
        const centerPt = turf.point(center);
        const halfLen = SEGMENT_LENGTH_M / 2 / 1000;

        // Re-calculate for handles (or update utility to return these)
        // For editor simplicity, re-calc is fine.
        const leftTurf = turf.destination(centerPt, halfLen, rotation - 90);
        const rightTurf = turf.destination(centerPt, halfLen, rotation + 90);

        const leftHandleTip = turf.destination(leftTurf, handleL, rotation - 90);
        const rightHandleTip = turf.destination(rightTurf, handleR, rotation + 90);

        // Line Feature (The Station)
        features.push({
            type: 'Feature',
            geometry: {
                type: 'LineString',
                coordinates: [leftPt, rightPt]
            },
            properties: {
                type: 'segment',
                stopId: stop.id,
                color: '#ff00ff'
            }
        });

        // Center Handle
        features.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: center },
            properties: {
                type: 'handle_center',
                stopId: stop.id,
                radius: 6,
                color: '#ffff00'
            }
        });

        // Rotation Handle (near Right end)
        features.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: rightPt },
            properties: {
                type: 'handle_rotate',
                stopId: stop.id,
                radius: 5,
                color: '#00ffff'
            }
        });

        // Left Bezier Handle (Green)
        features.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: leftHandleTip.geometry.coordinates },
            properties: {
                type: 'handle_bezier_l',
                stopId: stop.id,
                radius: 4,
                color: '#00ff00'
            }
        });

        // Right Bezier Handle (Green)
        features.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: rightHandleTip.geometry.coordinates },
            properties: {
                type: 'handle_bezier_r',
                stopId: stop.id,
                radius: 4,
                color: '#00ff00'
            }
        });

        // Lines connecting Station Ends to Bezier Handles
        features.push({
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: [leftPt, leftHandleTip.geometry.coordinates] },
            properties: { type: 'guideline', color: '#00ff00', width: 1 }
        });
        features.push({
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: [rightPt, rightHandleTip.geometry.coordinates] },
            properties: { type: 'guideline', color: '#00ff00', width: 1 }
        });
    });

    const source = _map.getSource(SOURCE_ID);
    if (source) source.setData({ type: 'FeatureCollection', features });

    renderConnections();
}

function renderConnections() {
    // Detect ID format from _segments keys
    const keys = Object.keys(_segments);
    const hasPrefix = keys.some(k => k.startsWith('1:'));
    const prefix = hasPrefix ? '1:' : '';


    // Station Sequences
    const line1 = LINE_1_IDS.map(id => `${prefix}${id}`);
    const line2 = LINE_2_IDS.map(id => `${prefix}${id}`);

    const connectionFeatures = [];
    const midpointFeatures = [];
    const lines = [line1, line2];

    lines.forEach(lineIds => {
        for (let i = 0; i < lineIds.length - 1; i++) {
            const idA = lineIds[i];
            const idB = lineIds[i + 1];

            // Resolve segments using the live _segments map
            // Note: getSegmentForStop expects a Stop object with .id, but we have IDs.
            // We can look up in _segments directly.
            const segA = _segments[idA];
            const segB = _segments[idB];

            if (!segA || !segB) continue;

            // Get midpoints for this connection
            const connKey = getConnectionKey(idA, idB);
            const midpoints = _midpoints[connKey] || [];

            const conn = generateConnectionGeometry(segA, segB, midpoints);
            if (conn) {
                connectionFeatures.push({
                    type: 'Feature',
                    geometry: conn,
                    properties: { type: 'connection', color: '#0099ff' } // Blue for connections
                });
            }

            // Render midpoint handles
            midpoints.forEach((mp, idx) => {
                // Main midpoint handle (orange - position)
                midpointFeatures.push({
                    type: 'Feature',
                    geometry: { type: 'Point', coordinates: mp.position },
                    properties: {
                        type: 'handle_midpoint',
                        connectionKey: connKey,
                        midpointIndex: idx,
                        radius: 7,
                        color: '#ff8800'
                    }
                });

                // Bezier handle tips for the midpoint
                const mpCenter = turf.point(mp.position);
                const angle = mp.angle || 0;

                // Handle In (purple)
                const handleInTip = turf.destination(mpCenter, mp.handleIn || 0.1, angle + 180);
                midpointFeatures.push({
                    type: 'Feature',
                    geometry: { type: 'Point', coordinates: handleInTip.geometry.coordinates },
                    properties: {
                        type: 'handle_midpoint_in',
                        connectionKey: connKey,
                        midpointIndex: idx,
                        radius: 4,
                        color: '#aa00ff'
                    }
                });

                // Handle Out (purple)
                const handleOutTip = turf.destination(mpCenter, mp.handleOut || 0.1, angle);
                midpointFeatures.push({
                    type: 'Feature',
                    geometry: { type: 'Point', coordinates: handleOutTip.geometry.coordinates },
                    properties: {
                        type: 'handle_midpoint_out',
                        connectionKey: connKey,
                        midpointIndex: idx,
                        radius: 4,
                        color: '#aa00ff'
                    }
                });

                // Guideline from midpoint to handles
                midpointFeatures.push({
                    type: 'Feature',
                    geometry: { type: 'LineString', coordinates: [handleInTip.geometry.coordinates, mp.position, handleOutTip.geometry.coordinates] },
                    properties: { type: 'guideline', color: '#aa00ff', width: 1 }
                });
            });
        }
    });

    // Update connections source
    let connSource = _map.getSource('metro-editor-connections-source');
    if (connSource) {
        connSource.setData({ type: 'FeatureCollection', features: connectionFeatures });
    } else {
        // Setup layer if not exists (lazy init)
        if (!_map.getSource('metro-editor-connections-source')) {
            _map.addSource('metro-editor-connections-source', {
                type: 'geojson',
                data: { type: 'FeatureCollection', features: connectionFeatures }
            });
            _map.addLayer({
                id: 'metro-editor-connections-layer',
                type: 'line',
                source: 'metro-editor-connections-source',
                layout: { 'line-join': 'round', 'line-cap': 'round' },
                paint: {
                    'line-width': 4,
                    'line-color': '#0099ff',
                    'line-dasharray': [2, 2],
                    'line-opacity': 0.6
                }
            }, LAYER_ID_LINES); // Place below segments
        }
    }

    // Update midpoints source
    let mpSource = _map.getSource('metro-editor-midpoints-source');
    if (mpSource) {
        mpSource.setData({ type: 'FeatureCollection', features: midpointFeatures });
    } else {
        if (!_map.getSource('metro-editor-midpoints-source')) {
            _map.addSource('metro-editor-midpoints-source', {
                type: 'geojson',
                data: { type: 'FeatureCollection', features: midpointFeatures }
            });
            // Midpoint lines (guidelines)
            _map.addLayer({
                id: 'metro-editor-midpoints-lines-layer',
                type: 'line',
                source: 'metro-editor-midpoints-source',
                filter: ['==', ['get', 'type'], 'guideline'],
                paint: {
                    'line-width': 1,
                    'line-color': '#aa00ff',
                    'line-opacity': 0.8
                }
            });
            // Midpoint handles (circles)
            _map.addLayer({
                id: 'metro-editor-midpoints-layer',
                type: 'circle',
                source: 'metro-editor-midpoints-source',
                filter: ['==', '$type', 'Point'],
                paint: {
                    'circle-radius': ['get', 'radius'],
                    'circle-color': ['get', 'color'],
                    'circle-stroke-width': 2,
                    'circle-stroke-color': '#fff'
                }
            });
        }
    }
}

// --- Interactions ---

function onMouseDown(e) {
    if (!_isEditorActive) return;

    // Check midpoint handles first
    const midpointFeatures = _map.queryRenderedFeatures(e.point, { layers: ['metro-editor-midpoints-layer'] });
    if (midpointFeatures.length > 0) {
        const f = midpointFeatures[0];
        const props = f.properties;

        _dragState = {
            type: props.type,
            connectionKey: props.connectionKey,
            midpointIndex: props.midpointIndex,
            startLngLat: e.lngLat
        };
        _map.dragPan.disable();
        _map.getCanvas().style.cursor = 'grabbing';
        e.preventDefault();
        return;
    }

    // Then check station handles
    const features = _map.queryRenderedFeatures(e.point, { layers: [LAYER_ID_HANDLES] });
    if (features.length > 0) {
        const f = features[0];
        const props = f.properties;
        // Need to find segment by stopId carefully (prefix/no prefix)
        const stopId = props.stopId;
        const segment = _segments[stopId] || _segments[stopId.replace(/^1:/, '')];

        if (segment) {
            _dragState = {
                type: props.type,
                stopId: stopId, // Keep original ID for reverse lookup if needed
                startLngLat: e.lngLat,
                // store reference to the segment object we are mutating
                // wait, mutating _segments directly is fine for drag
            };
            _map.dragPan.disable();
            _map.getCanvas().style.cursor = 'grabbing';
            e.preventDefault();
        }
    }
}

function onMouseMove(e) {
    if (!_dragState) {
        // Cursor hover logic
        if (_isEditorActive) {
            const midpointFeatures = _map.queryRenderedFeatures(e.point, { layers: ['metro-editor-midpoints-layer'] });
            const stationFeatures = _map.queryRenderedFeatures(e.point, { layers: [LAYER_ID_HANDLES] });
            _map.getCanvas().style.cursor = (midpointFeatures.length || stationFeatures.length) ? 'grab' : '';
        }
        return;
    }

    const { type, stopId, connectionKey, midpointIndex } = _dragState;

    // Handle midpoint dragging
    if (type === 'handle_midpoint' || type === 'handle_midpoint_in' || type === 'handle_midpoint_out') {
        const midpoints = _midpoints[connectionKey];
        if (!midpoints || midpointIndex >= midpoints.length) return;

        const mp = midpoints[midpointIndex];

        if (type === 'handle_midpoint') {
            // Move the midpoint position
            mp.position = [e.lngLat.lng, e.lngLat.lat];
        } else if (type === 'handle_midpoint_in') {
            // Adjust handleIn length and angle
            const center = turf.point(mp.position);
            const mouse = turf.point([e.lngLat.lng, e.lngLat.lat]);
            const dist = turf.distance(center, mouse);
            const bearing = turf.bearing(center, mouse);
            mp.handleIn = dist;
            // Angle is the outgoing direction, so in-handle is opposite
            mp.angle = (bearing + 180 + 360) % 360;
        } else if (type === 'handle_midpoint_out') {
            // Adjust handleOut length and angle
            const center = turf.point(mp.position);
            const mouse = turf.point([e.lngLat.lng, e.lngLat.lat]);
            const dist = turf.distance(center, mouse);
            const bearing = turf.bearing(center, mouse);
            mp.handleOut = dist;
            mp.angle = bearing;
        }

        renderSegments();
        return;
    }

    // Handle station segment dragging
    const current = _segments[stopId] || _segments[stopId.replace(/^1:/, '')];
    if (!current) return;

    if (type === 'handle_center') {
        // Move center
        current.center = [e.lngLat.lng, e.lngLat.lat];
    } else if (type === 'handle_rotate') {
        // Calculate Angle
        const center = turf.point(current.center);
        const mouse = turf.point([e.lngLat.lng, e.lngLat.lat]);
        const bearing = turf.bearing(center, mouse);

        // Bearing is -180 to 180.
        // Our 'right' handle is at +90 relative to rotation.
        // So Rotation = Bearing - 90
        current.rotation = bearing - 90;
    } else if (type === 'handle_bezier_l') {
        const center = turf.point(current.center);
        const halfLen = SEGMENT_LENGTH_M / 2 / 1000;
        const leftPt = turf.destination(center, halfLen, current.rotation - 90);
        const mouse = turf.point([e.lngLat.lng, e.lngLat.lat]);
        const dist = turf.distance(leftPt, mouse); // km
        current.handleL = dist;
    } else if (type === 'handle_bezier_r') {
        const center = turf.point(current.center);
        const halfLen = SEGMENT_LENGTH_M / 2 / 1000;
        const rightPt = turf.destination(center, halfLen, current.rotation + 90);
        const mouse = turf.point([e.lngLat.lng, e.lngLat.lat]);
        const dist = turf.distance(rightPt, mouse); // km
        current.handleR = dist;
    }

    renderSegments();
}

function onMouseUp(e) {
    if (!_dragState) return;

    _map.dragPan.enable();
    _map.getCanvas().style.cursor = '';

    // Save on release
    saveMetroSegments();

    _dragState = null;
}

function setupInteractions() {
    _map.on('mousedown', LAYER_ID_HANDLES, onMouseDown);
    _map.on('mousedown', 'metro-editor-midpoints-layer', onMouseDown);
    _map.on('mousemove', onMouseMove);
    _map.on('mouseup', onMouseUp);
    // Prevent map drag when clicking handles
    _map.on('mousedown', LAYER_ID_HANDLES, (e) => e.preventDefault());
    _map.on('mousedown', 'metro-editor-midpoints-layer', (e) => e.preventDefault());

    // Double-click on connection line to add midpoint
    _map.on('dblclick', 'metro-editor-connections-layer', onConnectionDoubleClick);
}

function removeInteractions() {
    _map.off('mousedown', LAYER_ID_HANDLES, onMouseDown);
    _map.off('mousedown', 'metro-editor-midpoints-layer', onMouseDown);
    _map.off('mousemove', onMouseMove);
    _map.off('mouseup', onMouseUp);
    _map.off('dblclick', 'metro-editor-connections-layer', onConnectionDoubleClick);
}

function onConnectionDoubleClick(e) {
    // Find which connection was clicked by checking proximity to each connection
    const clickPoint = [e.lngLat.lng, e.lngLat.lat];

    // Get all connections and find the closest one
    const keys = Object.keys(_segments);
    const hasPrefix = keys.some(k => k.startsWith('1:'));
    const prefix = hasPrefix ? '1:' : '';

    const line1 = LINE_1_IDS.map(id => `${prefix}${id}`);
    const line2 = LINE_2_IDS.map(id => `${prefix}${id}`);
    const lines = [line1, line2];

    let bestConnection = null;
    let bestDistance = Infinity;

    lines.forEach(lineIds => {
        for (let i = 0; i < lineIds.length - 1; i++) {
            const idA = lineIds[i];
            const idB = lineIds[i + 1];
            const segA = _segments[idA];
            const segB = _segments[idB];
            if (!segA || !segB) continue;

            // Check distance from click to line between centers
            const line = turf.lineString([segA.center, segB.center]);
            const pt = turf.point(clickPoint);
            const dist = turf.pointToLineDistance(pt, line);

            if (dist < bestDistance) {
                bestDistance = dist;
                bestConnection = { idA, idB, clickPoint };
            }
        }
    });

    if (bestConnection && bestDistance < 0.5) { // Within 500m
        const { idA, idB } = bestConnection;
        addMidpointToConnection(idA, idB, clickPoint);
        e.preventDefault();
    }
}

function addMidpointToConnection(idA, idB, position) {
    const connKey = getConnectionKey(idA, idB);
    if (!_midpoints[connKey]) {
        _midpoints[connKey] = [];
    }

    // Calculate initial angle based on direction between segments
    const segA = _segments[idA];
    const segB = _segments[idB];
    let angle = 0;
    if (segA && segB) {
        angle = turf.bearing(turf.point(segA.center), turf.point(segB.center));
    }

    _midpoints[connKey].push({
        position: position,
        angle: angle,
        handleIn: 0.15,
        handleOut: 0.15
    });

    console.log(`[MetroEditor] Added midpoint to connection ${connKey}`);
    renderSegments();
    saveMetroSegments();
}

function removeMidpointFromConnection(connectionKey, index) {
    if (_midpoints[connectionKey] && _midpoints[connectionKey].length > index) {
        _midpoints[connectionKey].splice(index, 1);
        if (_midpoints[connectionKey].length === 0) {
            delete _midpoints[connectionKey];
        }
        console.log(`[MetroEditor] Removed midpoint ${index} from ${connectionKey}`);
        renderSegments();
        saveMetroSegments();
    }
}

async function saveMetroSegments() {
    console.log('[MetroEditor] Saving...', {
        segments: Object.keys(_segments).length,
        midpoints: Object.keys(_midpoints).length
    });

    try {
        // Save segments
        const segRes = await fetch('/api/save-metro-segments', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(_segments)
        });
        if (segRes.ok) {
            console.log('[MetroEditor] ✓ Saved segments.');
        } else {
            console.error('[MetroEditor] ✗ Failed to save segments:', segRes.status, await segRes.text());
        }

        // Save midpoints
        console.log('[MetroEditor] Saving midpoints:', JSON.stringify(_midpoints, null, 2));
        const mpRes = await fetch('/api/save-metro-midpoints', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(_midpoints)
        });
        if (mpRes.ok) {
            console.log('[MetroEditor] ✓ Saved midpoints.');
        } else {
            console.error('[MetroEditor] ✗ Failed to save midpoints:', mpRes.status, await mpRes.text());
        }
    } catch (e) {
        console.error('[MetroEditor] Save failed:', e);
    }
}
