import mapboxgl from 'mapbox-gl';
import * as turf from '@turf/turf';
import { getSegmentForStop, generateSegmentGeometry, generateConnectionGeometry, SEGMENT_LENGTH_M, LINE_1_IDS, LINE_2_IDS } from './metro-utils';

let _map = null;
let _allStops = null;
let _segments = {};
let _isEditorActive = false;

// State for Interaction
let _selectedStopId = null;
let _dragState = null; // { type: 'center'|'rotate', startLngLat, startVal, stopId }

const LAYER_ID_LINES = 'metro-editor-lines';
const LAYER_ID_HANDLES = 'metro-editor-handles';
const SOURCE_ID = 'metro-editor-source';

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

    // Add Source
    if (!map.getSource(SOURCE_ID)) {
        map.addSource(SOURCE_ID, {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: [] }
        });
    }

    // Add Token/Global
    window.toggleMetroEditor = toggleMetroEditor;
    window.saveMetroSegments = saveMetroSegments;

    // Auto-enable for first time use
    toggleMetroEditor(true);
}

function toggleMetroEditor(forceState) {
    _isEditorActive = forceState !== undefined ? forceState : !_isEditorActive;
    console.log('[MetroEditor] Active:', _isEditorActive);

    if (_isEditorActive) {
        // Add Layers
        addEditorLayers();
        renderSegments();
        setupInteractions();
    } else {
        // Remove Layers/Handlers
        removeEditorLayers();
        removeInteractions();
    }
}

async function loadSegments() {
    try {
        const basePath = import.meta.env.BASE_URL.endsWith('/') ? import.meta.env.BASE_URL : `${import.meta.env.BASE_URL}/`;
        const url = `${basePath}data/metro_segments.json`;
        console.log('[MetroEditor] Loading segments from:', url);

        const res = await fetch(url);
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

            const conn = generateConnectionGeometry(segA, segB);
            if (conn) {
                connectionFeatures.push({
                    type: 'Feature',
                    geometry: conn,
                    properties: { type: 'connection', color: '#0099ff' } // Blue for connections
                });
            }
        }
    });

    const source = _map.getSource('metro-editor-connections-source');
    if (source) source.setData({ type: 'FeatureCollection', features: connectionFeatures });
    else {
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
}

// --- Interactions ---

function onMouseDown(e) {
    if (!_isEditorActive) return;

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
            const features = _map.queryRenderedFeatures(e.point, { layers: [LAYER_ID_HANDLES] });
            _map.getCanvas().style.cursor = features.length ? 'grab' : '';
        }
        return;
    }

    const { type, stopId } = _dragState;
    // Resolve segment again
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
    _map.on('mousemove', onMouseMove);
    _map.on('mouseup', onMouseUp);
    // Prevent map drag when clicking handles
    _map.on('mousedown', LAYER_ID_HANDLES, (e) => e.preventDefault());
}

function removeInteractions() {
    _map.off('mousedown', LAYER_ID_HANDLES, onMouseDown);
    _map.off('mousemove', onMouseMove);
    _map.off('mouseup', onMouseUp);
}

async function saveMetroSegments() {
    try {
        await fetch('/api/save-metro-segments', {
            method: 'POST',
            body: JSON.stringify(_segments)
        });
        console.log('[MetroEditor] Saved.');
    } catch (e) {
        console.error('[MetroEditor] Save failed:', e);
    }
}

