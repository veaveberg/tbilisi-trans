const STORAGE_KEY = 'minibusSegmentsEditsV1';
const EDITS_FILENAME = 'minibus_segments_edits.json';

const DEFAULT_EDITS = {
    trims: {},
    statuses: {},
    splits: {}
};

const STATUS_COLORS = {
    ready: '#22c55e',
    check: '#f59e0b',
    future: '#3b82f6',
    hidden: '#6b7280'
};
const USER_MODE_COLOR_LIGHT = '#2563eb';
const USER_MODE_COLOR_DARK = '#80caff';

const SPLIT_ID_OFFSET = 1000000;
function makeSplitId(parentId, sideIndex) {
    return SPLIT_ID_OFFSET + Number(parentId) * 2 + sideIndex;
}

function cloneFeature(feature) {
    return {
        type: 'Feature',
        id: feature.id,
        properties: { ...feature.properties },
        geometry: JSON.parse(JSON.stringify(feature.geometry))
    };
}

function toNumber(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function normalizeRange(start, end) {
    return start <= end ? [start, end] : [end, start];
}

function haversineMeters(a, b) {
    const toRad = (x) => (x * Math.PI) / 180;
    const R = 6371000;
    const lat1 = toRad(a[1]);
    const lat2 = toRad(b[1]);
    const dLat = lat2 - lat1;
    const dLon = toRad(b[0] - a[0]);
    const sinLat = Math.sin(dLat / 2);
    const sinLon = Math.sin(dLon / 2);
    const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon;
    return 2 * R * Math.asin(Math.sqrt(h));
}

function lineLength(coords) {
    let total = 0;
    for (let i = 1; i < coords.length; i += 1) {
        total += haversineMeters(coords[i - 1], coords[i]);
    }
    return total;
}

function interpolatePoint(a, b, t) {
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

function sliceLineByFraction(coords, startFrac, endFrac) {
    const total = lineLength(coords);
    if (!total) return null;

    const [startNorm, endNorm] = normalizeRange(clamp(startFrac, 0, 1), clamp(endFrac, 0, 1));
    const startDist = startNorm * total;
    const endDist = endNorm * total;
    if (endDist <= startDist) return null;

    const result = [];
    let traveled = 0;

    for (let i = 1; i < coords.length; i += 1) {
        const a = coords[i - 1];
        const b = coords[i];
        const segLen = haversineMeters(a, b);
        if (segLen === 0) continue;

        const segStart = traveled;
        const segEnd = traveled + segLen;

        if (segEnd < startDist) {
            traveled = segEnd;
            continue;
        }

        const startT = startDist > segStart ? (startDist - segStart) / segLen : 0;
        const endT = endDist < segEnd ? (endDist - segStart) / segLen : 1;

        if (result.length === 0) {
            result.push(interpolatePoint(a, b, startT));
        }

        if (endT < 1) {
            result.push(interpolatePoint(a, b, endT));
            return result;
        }

        result.push(b);
        traveled = segEnd;

        if (segEnd >= endDist) {
            return result;
        }
    }

    return result.length >= 2 ? result : null;
}

function sliceLineByRange(coords, startFrac, endFrac) {
    const sliced = sliceLineByFraction(coords, startFrac, endFrac);
    return sliced && sliced.length >= 2 ? sliced : null;
}

function normalizeGeometry(geometry) {
    if (!geometry) return { type: 'LineString', coordinates: [] };
    if (geometry.type === 'LineString') return geometry;
    if (geometry.type === 'MultiLineString') {
        const flattened = geometry.coordinates.flat();
        return { type: 'LineString', coordinates: flattened };
    }
    return { type: 'LineString', coordinates: [] };
}

function getEndpointsFromGeometry(geometry) {
    if (!geometry) return null;
    if (geometry.type === 'LineString') {
        const coords = geometry.coordinates || [];
        if (coords.length < 2) return null;
        return { start: coords[0], end: coords[coords.length - 1] };
    }
    if (geometry.type === 'MultiLineString') {
        const lines = geometry.coordinates || [];
        if (lines.length === 0) return null;
        const first = lines[0];
        const last = lines[lines.length - 1];
        if (!first || first.length < 2 || !last || last.length < 2) return null;
        return { start: first[0], end: last[last.length - 1] };
    }
    return null;
}

export function loadMinibusSegmentEdits() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return { ...DEFAULT_EDITS };
        const parsed = JSON.parse(raw);
        return {
            trims: parsed.trims && typeof parsed.trims === 'object' ? parsed.trims : {},
            statuses: parsed.statuses && typeof parsed.statuses === 'object' ? parsed.statuses : {},
            splits: parsed.splits && typeof parsed.splits === 'object' ? parsed.splits : {},
            hiddenIds: Array.isArray(parsed.hiddenIds) ? parsed.hiddenIds : []
        };
    } catch (e) {
        console.warn('[MinibusSegments] Failed to load edits:', e);
        return { ...DEFAULT_EDITS };
    }
}

export function saveMinibusSegmentEdits(edits) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(edits));
    } catch (e) {
        console.warn('[MinibusSegments] Failed to save edits:', e);
    }
}

export async function loadMinibusSegmentEditsFromFile(basePath) {
    try {
        const path = basePath?.endsWith('/') ? basePath : `${basePath || ''}/`;
        const res = await fetch(`${path}data/${EDITS_FILENAME}`, { cache: 'no-store' });
        if (!res.ok) return null;
        const parsed = await res.json();
        return {
            trims: parsed.trims && typeof parsed.trims === 'object' ? parsed.trims : {},
            statuses: parsed.statuses && typeof parsed.statuses === 'object' ? parsed.statuses : {},
            splits: parsed.splits && typeof parsed.splits === 'object' ? parsed.splits : {},
            hiddenIds: Array.isArray(parsed.hiddenIds) ? parsed.hiddenIds : []
        };
    } catch (e) {
        console.warn('[MinibusSegments] Failed to load edits file:', e);
        return null;
    }
}

export function applyMinibusSegmentEdits(baseData, edits, options = {}) {
    if (!baseData || !Array.isArray(baseData.features)) return baseData;
    const statuses = edits?.statuses || {};
    const hidden = new Set(edits?.hiddenIds || []);
    const splits = edits?.splits || {};
    const visibleStatuses = Array.isArray(options.visibleStatuses)
        ? new Set(options.visibleStatuses)
        : null;
    const trims = edits?.trims || {};

    const expanded = baseData.features.flatMap((feature) => {
        const id = feature.id;
        const splitAt = splits[id];
        if (Number.isFinite(splitAt) && feature.geometry) {
            const geometry = normalizeGeometry(feature.geometry);
            const left = sliceLineByFraction(geometry.coordinates, 0, splitAt);
            const right = sliceLineByFraction(geometry.coordinates, splitAt, 1);
            const leftId = makeSplitId(id, 0);
            const rightId = makeSplitId(id, 1);
            const baseProps = feature.properties || {};
            return [
                left && left.length >= 2
                ? {
                    type: 'Feature',
                    id: leftId,
                    properties: { ...baseProps, id: leftId, _splitParent: id, _splitSide: 'a' },
                    geometry: { type: 'LineString', coordinates: left }
                }
                : null,
                right && right.length >= 2
                ? {
                    type: 'Feature',
                    id: rightId,
                    properties: { ...baseProps, id: rightId, _splitParent: id, _splitSide: 'b' },
                    geometry: { type: 'LineString', coordinates: right }
                }
                : null
            ].filter(Boolean);
        }
        return [feature];
    });

    const features = expanded.reduce((acc, feature) => {
        let id = feature.id;
        if (id === undefined || id === null) {
            id = feature.properties?.id;
            if (id !== undefined && id !== null) {
                feature = { ...feature, id };
            }
        }
        if (id === undefined || id === null) return acc;
        const parentId = feature.properties?._splitParent;
        const status = statuses[id] || (parentId && statuses[parentId]) || (hidden.has(id) ? 'hidden' : 'future');
        if (visibleStatuses && !visibleStatuses.has(status)) return acc;
        if (visibleStatuses === null && status === 'hidden') return acc;

        const trim = trims[id];
        if (trim && feature.geometry) {
            const mode = trim.mode === 'cut' ? 'cut' : 'trim';
            const { start = 0, end = 1 } = trim;
            if (start <= 0 && end >= 1) {
                const next = {
                    ...feature,
                    properties: { ...(feature.properties || {}), id, _status: status, _trimApplied: false }
                };
                acc.push(next);
                return acc;
            }
            const geometry = normalizeGeometry(feature.geometry);
            if (mode === 'cut') {
                const left = sliceLineByRange(geometry.coordinates, 0, start);
                const right = sliceLineByRange(geometry.coordinates, end, 1);
                const parts = [];
                if (left) parts.push(left);
                if (right) parts.push(right);
                if (parts.length === 0) return acc;
                const copy = cloneFeature(feature);
                copy.geometry = parts.length === 1
                    ? { type: 'LineString', coordinates: parts[0] }
                    : { type: 'MultiLineString', coordinates: parts };
                copy.properties = { ...(copy.properties || {}), id, _status: status, _trimApplied: true };
                acc.push(copy);
                return acc;
            }
            const sliced = sliceLineByFraction(geometry.coordinates, start, end);
            if (!sliced || sliced.length < 2) return acc;
            const copy = cloneFeature(feature);
            copy.geometry = { type: 'LineString', coordinates: sliced };
            copy.properties = { ...(copy.properties || {}), id, _status: status, _trimApplied: true };
            acc.push(copy);
            return acc;
        }

        const next = {
            ...feature,
            properties: { ...(feature.properties || {}), id, _status: status, _trimApplied: false }
        };
        acc.push(next);
        return acc;
    }, []);

    return {
        type: 'FeatureCollection',
        features
    };
}

function ensureEditorStyles() {
    if (document.getElementById('minibus-segments-editor-style')) return;
    const style = document.createElement('style');
    style.id = 'minibus-segments-editor-style';
    style.textContent = `
        .minibus-editor {
            position: fixed;
            right: 16px;
            top: 86px;
            z-index: 9999;
            width: 280px;
            background: rgba(20, 24, 28, 0.95);
            color: #e5e7eb;
            border: 1px solid rgba(255,255,255,0.12);
            border-radius: 10px;
            padding: 12px;
            font-family: "Space Mono", "SFMono-Regular", Menlo, monospace;
            font-size: 12px;
            display: none;
        }
        .minibus-editor h3 {
            margin: 0 0 6px 0;
            font-size: 13px;
            font-weight: 600;
        }
        .minibus-editor .row { margin-top: 8px; display: flex; gap: 6px; flex-wrap: wrap; }
        .minibus-editor .row.vertical { flex-direction: column; align-items: stretch; }
        .minibus-editor .status-row { display: flex; align-items: center; gap: 8px; }
        .minibus-editor .row.tight { margin-top: 4px; }
        .minibus-editor button {
            background: #111827;
            color: #e5e7eb;
            border: 1px solid rgba(255,255,255,0.2);
            border-radius: 6px;
            padding: 4px 8px;
            cursor: pointer;
        }
        .minibus-editor button.primary { background: #2563eb; border-color: #2563eb; }
        .minibus-editor button.danger { background: #b91c1c; border-color: #b91c1c; }
        .minibus-editor button.active { outline: 2px solid #f59e0b; }
        .minibus-editor button.eye { padding: 2px 6px; }
        .minibus-editor input {
            width: 60px;
            background: #0f172a;
            color: #e5e7eb;
            border: 1px solid rgba(255,255,255,0.2);
            border-radius: 6px;
            padding: 4px 6px;
        }
        .minibus-editor .muted { color: #9ca3af; }
        .minibus-editor .divider { height: 1px; background: rgba(255,255,255,0.12); margin: 8px 0; }
    `;
    document.head.appendChild(style);
}

function buildEditorPanel() {
    ensureEditorStyles();
    let panel = document.getElementById('minibus-segments-editor');
    if (panel) return panel;

    panel = document.createElement('div');
    panel.id = 'minibus-segments-editor';
    panel.className = 'minibus-editor';
    panel.innerHTML = `
        <h3>Minibus Segment Editor</h3>
        <div id="minibus-editor-status" class="muted">Select a segment to edit.</div>
        <div class="divider"></div>
        <div id="minibus-editor-selection" class="muted">No selection</div>
        <div class="row vertical">
            <div class="status-row">
                <button id="minibus-editor-status-ready-eye" class="eye">👁️</button>
                <button id="minibus-editor-status-ready">Ready</button>
            </div>
            <div class="status-row">
                <button id="minibus-editor-status-check-eye" class="eye">👁️</button>
                <button id="minibus-editor-status-check">Need Check</button>
            </div>
            <div class="status-row">
                <button id="minibus-editor-status-future-eye" class="eye">👁️</button>
                <button id="minibus-editor-status-future">For Future</button>
            </div>
            <div class="status-row">
                <button id="minibus-editor-status-hidden-eye" class="eye">👁️</button>
                <button id="minibus-editor-status-hidden">Hidden</button>
            </div>
        </div>
        <div class="row">
            <input id="minibus-editor-start" type="number" min="0" max="100" value="0" />
            <input id="minibus-editor-end" type="number" min="0" max="100" value="100" />
            <button id="minibus-editor-trim" class="primary">Trim</button>
            <button id="minibus-editor-split" class="primary">Split</button>
            <button id="minibus-editor-clear">Clear</button>
        </div>
        <div class="row tight">
            <button id="minibus-editor-pick-start">Pick Start</button>
            <button id="minibus-editor-pick-end">Pick End</button>
        </div>
        <div class="divider"></div>
        <div class="row">
            <button id="minibus-editor-save" class="primary">Save</button>
            <button id="minibus-editor-export">Export</button>
            <button id="minibus-editor-reset">Reset</button>
            <button id="minibus-editor-close">Close</button>
        </div>
    `;
    document.body.appendChild(panel);
    return panel;
}

export function createMinibusSegmentsEditor(map, options) {
    const sourceId = options?.sourceId || 'minibus-segments';
    const layerId = options?.layerId || 'minibus-segments-layer';

    let baseData = options?.baseData || null;
    let edits = loadMinibusSegmentEdits();
    let active = false;
    let selectedId = null;
    let pickMode = null;
    let endpointsSourceAdded = false;
    const statusVisibility = { ready: true, check: true, future: true, hidden: true };
    let lastRenderedData = null;
    let lastSelectedId = null;
    let showMinibusMode = false;
    let fileHandle = null;

    const panel = buildEditorPanel();
    const statusEl = panel.querySelector('#minibus-editor-status');
    const selectionEl = panel.querySelector('#minibus-editor-selection');
    const startInput = panel.querySelector('#minibus-editor-start');
    const endInput = panel.querySelector('#minibus-editor-end');
    const pickStartBtn = panel.querySelector('#minibus-editor-pick-start');
    const pickEndBtn = panel.querySelector('#minibus-editor-pick-end');
    const splitBtn = panel.querySelector('#minibus-editor-split');
    const statusButtons = {
        ready: panel.querySelector('#minibus-editor-status-ready'),
        check: panel.querySelector('#minibus-editor-status-check'),
        future: panel.querySelector('#minibus-editor-status-future'),
        hidden: panel.querySelector('#minibus-editor-status-hidden')
    };
    const statusEyeButtons = {
        ready: panel.querySelector('#minibus-editor-status-ready-eye'),
        check: panel.querySelector('#minibus-editor-status-check-eye'),
        future: panel.querySelector('#minibus-editor-status-future-eye'),
        hidden: panel.querySelector('#minibus-editor-status-hidden-eye')
    };

    function getBaseData() {
        return baseData || options?.getBaseData?.() || null;
    }

    function findFeatureById(data, id) {
        if (!data || !Array.isArray(data.features)) return null;
        return data.features.find((f) => f.id === id) || null;
    }

    function setCursor(cursor) {
        map.getCanvas().style.cursor = cursor || '';
    }

    function updateStatus() {
        const trimsCount = Object.keys(edits.trims).length;
        const statusCounts = { ready: 0, check: 0, future: 0, hidden: 0 };
        Object.values(edits.statuses || {}).forEach((status) => {
            if (statusCounts[status] !== undefined) statusCounts[status] += 1;
        });
        statusEl.textContent = `Ready: ${statusCounts.ready}, Check: ${statusCounts.check}, Future: ${statusCounts.future}, Hidden: ${statusCounts.hidden}, Trimmed: ${trimsCount}`;
    }

    function updateSelectionInfo() {
        const data = getBaseData();
        if (!selectedId || !data) {
            selectionEl.textContent = 'No selection';
            return;
        }
        const feature = findFeatureById(data, selectedId) || findFeatureById(lastRenderedData, selectedId);
        if (!feature) {
            selectionEl.textContent = `Selected: ${selectedId}`;
            return;
        }
        const props = feature.properties || {};
        const status = edits.statuses?.[selectedId] || 'future';
        selectionEl.textContent = `Selected ${selectedId}: ${props.routeNumber || '-'} ${props.from || ''} → ${props.to || ''} (${status})`;
        Object.entries(statusButtons).forEach(([key, btn]) => {
            if (!btn) return;
            btn.classList.toggle('active', key === status);
        });
    }

    function updateVisibilityButtons() {
        Object.entries(statusEyeButtons).forEach(([status, btn]) => {
            if (!btn) return;
            btn.classList.toggle('active', statusVisibility[status]);
        });
    }

    function updateSelectionState() {
        if (lastSelectedId !== null && lastSelectedId !== undefined) {
            map.setFeatureState({ source: sourceId, id: lastSelectedId }, { selected: false });
        }
        if (selectedId !== null && selectedId !== undefined) {
            map.setFeatureState({ source: sourceId, id: selectedId }, { selected: true });
        }
        lastSelectedId = selectedId;
    }

    function ensureEndpointsLayer() {
        if (endpointsSourceAdded) return;
        if (!map.getSource('minibus-segments-endpoints')) {
            map.addSource('minibus-segments-endpoints', {
                type: 'geojson',
                data: { type: 'FeatureCollection', features: [] }
            });
        }
        if (!map.getLayer('minibus-segments-endpoints-layer')) {
            map.addLayer({
                id: 'minibus-segments-endpoints-layer',
                type: 'symbol',
                source: 'minibus-segments-endpoints',
                layout: {
                    'text-field': ['get', 'label'],
                    'text-size': 14,
                    'text-offset': [0, -0.8],
                    'text-allow-overlap': true
                },
                paint: {
                    'text-color': '#f59e0b',
                    'text-halo-color': '#0f172a',
                    'text-halo-width': 2
                }
            });
        }
        endpointsSourceAdded = true;
    }

    function updateEndpointsLayer() {
        ensureEndpointsLayer();
        const data = getBaseData();
        const source = map.getSource('minibus-segments-endpoints');
        if (!source || !data || !selectedId) {
            if (source) source.setData({ type: 'FeatureCollection', features: [] });
            return;
        }
        const feature = findFeatureById(lastRenderedData, selectedId) || findFeatureById(data, selectedId);
        if (!feature) {
            source.setData({ type: 'FeatureCollection', features: [] });
            return;
        }
        if (feature.properties?._trimApplied) {
            const endpoints = getEndpointsFromGeometry(feature.geometry);
            if (!endpoints) {
                source.setData({ type: 'FeatureCollection', features: [] });
                return;
            }
            source.setData({
                type: 'FeatureCollection',
                features: [
                    {
                        type: 'Feature',
                        geometry: { type: 'Point', coordinates: endpoints.start },
                        properties: { label: 'A' }
                    },
                    {
                        type: 'Feature',
                        geometry: { type: 'Point', coordinates: endpoints.end },
                        properties: { label: 'B' }
                    }
                ]
            });
            return;
        }
        const geometry = normalizeGeometry(feature.geometry);
        const coords = geometry.coordinates;
        if (!coords || coords.length < 2) {
            source.setData({ type: 'FeatureCollection', features: [] });
            return;
        }
        const trim = edits.trims[selectedId] || { start: 0, end: 1, mode: 'trim' };
        const sliced = sliceLineByFraction(coords, trim.start ?? 0, trim.end ?? 1);
        if (!sliced || sliced.length < 2) {
            source.setData({ type: 'FeatureCollection', features: [] });
            return;
        }
        source.setData({
            type: 'FeatureCollection',
            features: [
                {
                    type: 'Feature',
                    geometry: { type: 'Point', coordinates: sliced[0] },
                    properties: { label: 'A' }
                },
                {
                    type: 'Feature',
                    geometry: { type: 'Point', coordinates: sliced[sliced.length - 1] },
                    properties: { label: 'B' }
                }
            ]
        });
    }

    function applyToMap() {
        const data = getBaseData();
        if (!data) return;
        const visibleStatuses = showMinibusMode
            ? ['ready', 'check']
            : Object.keys(statusVisibility).filter((status) => statusVisibility[status]);
        const rendered = applyMinibusSegmentEdits(data, edits, { visibleStatuses });
        lastRenderedData = rendered;
        const source = map.getSource(sourceId);
        if (source) source.setData(rendered);
        if (map.getLayer(layerId)) {
            if (showMinibusMode) {
                const color = document.body.classList.contains('dark-mode') ? USER_MODE_COLOR_DARK : USER_MODE_COLOR_LIGHT;
                map.setPaintProperty(layerId, 'line-color', color);
            } else {
                map.setPaintProperty(layerId, 'line-color', [
                    'match',
                    ['get', '_status'],
                    'ready', STATUS_COLORS.ready,
                    'check', STATUS_COLORS.check,
                    'future', STATUS_COLORS.future,
                    'hidden', STATUS_COLORS.hidden,
                    USER_MODE_COLOR_LIGHT
                ]);
            }
            map.setPaintProperty(layerId, 'line-width', [
                'case',
                ['boolean', ['feature-state', 'selected'], false],
                12,
                ['boolean', ['feature-state', 'hover'], false],
                12,
                8
            ]);
            map.setPaintProperty(layerId, 'line-opacity', [
                'case',
                ['boolean', ['feature-state', 'selected'], false],
                0.9,
                ['boolean', ['feature-state', 'hover'], false],
                0.8,
                0.5
            ]);
        }
        if (!showMinibusMode && selectedId !== null && selectedId !== undefined) {
            updateSelectionState();
        }
    }

    function selectFeature(feature) {
        if (!feature || feature.id === undefined || feature.id === null) return;
        selectedId = feature.id;
        if (!edits.statuses[selectedId]) edits.statuses[selectedId] = 'future';
        updateSelectionInfo();
        updateSelectionState();
        updateEndpointsLayer();
        const trim = edits.trims[selectedId];
        if (trim) {
            startInput.value = Math.round(trim.start * 100);
            endInput.value = Math.round(trim.end * 100);
        } else {
            startInput.value = 0;
            endInput.value = 100;
        }
    }

    function trimSelected() {
        if (selectedId === null) return;
        let start = clamp(toNumber(startInput.value, 0) / 100, 0, 1);
        let end = clamp(toNumber(endInput.value, 100) / 100, 0, 1);
        [start, end] = normalizeRange(start, end);
        startInput.value = Math.round(start * 100);
        endInput.value = Math.round(end * 100);
        if (start <= 0 && end >= 1) {
            delete edits.trims[selectedId];
        } else {
            edits.trims[selectedId] = { start, end, mode: 'trim' };
        }
        applyToMap();
        updateStatus();
        updateEndpointsLayer();
    }

    function clearTrim() {
        if (selectedId === null) return;
        delete edits.trims[selectedId];
        applyToMap();
        updateStatus();
        updateEndpointsLayer();
    }

    function resetAll() {
        edits = { ...DEFAULT_EDITS, trims: {}, statuses: {}, splits: {} };
        ensureStatuses(getBaseData());
        applyToMap();
        updateStatus();
    }

    function exportEdits() {
        const payload = JSON.stringify(edits, null, 2);
        if (navigator.clipboard?.writeText) {
            navigator.clipboard.writeText(payload);
        }
        console.log('[MinibusSegments] Exported edits:', payload);
    }

    async function saveEditsToFile() {
        const payload = JSON.stringify(edits, null, 2);
        try {
            if (window.showSaveFilePicker) {
                if (!fileHandle) {
                    fileHandle = await window.showSaveFilePicker({
                        suggestedName: EDITS_FILENAME,
                        types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }]
                    });
                }
                const writable = await fileHandle.createWritable();
                await writable.write(payload);
                await writable.close();
                console.log(`[MinibusSegments] Saved edits to file handle: ${EDITS_FILENAME}`);
                return;
            }
        } catch (e) {
            console.warn('[MinibusSegments] File save canceled or failed:', e);
        }
        const blob = new Blob([payload], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = EDITS_FILENAME;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        console.log(`[MinibusSegments] Downloaded ${EDITS_FILENAME} - move it into public/data/`);
    }

    function ensureStatuses(data) {
        if (!data || !Array.isArray(data.features)) return;
        edits.statuses = edits.statuses && typeof edits.statuses === 'object' ? edits.statuses : {};
        edits.splits = edits.splits && typeof edits.splits === 'object' ? edits.splits : {};
        const hiddenIds = new Set(edits.hiddenIds || []);
        data.features.forEach((feature) => {
            const id = feature.id;
            if (edits.statuses[id]) return;
            edits.statuses[id] = hiddenIds.has(id) ? 'hidden' : 'future';
        });
        delete edits.hiddenIds;
    }

    function setStatus(status) {
        if (selectedId === null) return;
        edits.statuses[selectedId] = status;
        if (status === 'hidden') delete edits.trims[selectedId];
        applyToMap();
        updateStatus();
        updateSelectionInfo();
    }

    function setPickMode(mode) {
        pickMode = mode;
        pickStartBtn.classList.toggle('active', pickMode === 'start');
        pickEndBtn.classList.toggle('active', pickMode === 'end');
        splitBtn.classList.toggle('active', pickMode === 'split');
        setCursor(pickMode ? 'crosshair' : '');
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

    panel.querySelector('#minibus-editor-trim').addEventListener('click', trimSelected);
    panel.querySelector('#minibus-editor-clear').addEventListener('click', clearTrim);
    startInput.addEventListener('input', () => {
        if (selectedId === null) return;
        trimSelected();
    });
    endInput.addEventListener('input', () => {
        if (selectedId === null) return;
        trimSelected();
    });
    statusButtons.ready.addEventListener('click', () => setStatus('ready'));
    statusButtons.check.addEventListener('click', () => setStatus('check'));
    statusButtons.future.addEventListener('click', () => setStatus('future'));
    statusButtons.hidden.addEventListener('click', () => setStatus('hidden'));
    pickStartBtn.addEventListener('click', () => setPickMode(pickMode === 'start' ? null : 'start'));
    pickEndBtn.addEventListener('click', () => setPickMode(pickMode === 'end' ? null : 'end'));
    panel.querySelector('#minibus-editor-save').addEventListener('click', () => {
        saveMinibusSegmentEdits(edits);
        console.log(`[MinibusSegments] Saved to localStorage key: ${STORAGE_KEY}`);
    });
    panel.querySelector('#minibus-editor-save').addEventListener('contextmenu', async (e) => {
        e.preventDefault();
        await saveEditsToFile();
    });
    panel.querySelector('#minibus-editor-export').addEventListener('click', exportEdits);
    panel.querySelector('#minibus-editor-reset').addEventListener('click', () => {
        resetAll();
        saveMinibusSegmentEdits(edits);
    });
    panel.querySelector('#minibus-editor-close').addEventListener('click', () => close());

    function open() {
        active = true;
        panel.style.display = 'block';
        showMinibusMode = false;
        ensureStatuses(getBaseData());
        updateStatus();
        updateSelectionInfo();
        updateSelectionState();
        updateEndpointsLayer();
        updateVisibilityButtons();
        applyToMap();
        setCursor(pickMode ? 'crosshair' : '');
    }

    function close() {
        active = false;
        panel.style.display = 'none';
        selectedId = null;
        updateSelectionState();
        updateEndpointsLayer();
        setPickMode(null);
        setCursor('');
    }

    function isActive() {
        return active;
    }

    function setBaseData(data) {
        baseData = data;
        ensureStatuses(baseData);
        updateSelectionInfo();
        updateEndpointsLayer();
    }

    function setEdits(nextEdits) {
        edits = nextEdits || { ...DEFAULT_EDITS };
        ensureStatuses(getBaseData());
        updateStatus();
        lastRenderedData = null;
    }

    map.on('click', layerId, (e) => {
        if (!active) return;
        if (!e.features || e.features.length === 0) return;
        const feature = e.features[0];
        selectFeature(feature);
        if (pickMode && selectedId !== null) {
            const base = getBaseData();
            const baseFeature = base?.features?.find((f) => f.id === selectedId);
            const geometry = normalizeGeometry((baseFeature || feature).geometry);
            const fraction = nearestFractionOnLine(geometry.coordinates, e.lngLat);
            if (pickMode === 'start') {
                startInput.value = Math.round(fraction * 100);
            } else if (pickMode === 'end') {
                endInput.value = Math.round(fraction * 100);
            } else if (pickMode === 'split') {
                const parentId = feature.properties?._splitParent || feature.id;
                const parentFeature = base?.features?.find((f) => f.id === parentId);
                const parentGeom = normalizeGeometry((parentFeature || feature).geometry);
                const parentFraction = nearestFractionOnLine(parentGeom.coordinates, e.lngLat);
                edits.splits[parentId] = parentFraction;
                const leftId = makeSplitId(parentId, 0);
                const rightId = makeSplitId(parentId, 1);
                const baseStatus = edits.statuses[parentId] || 'future';
                if (!edits.statuses[leftId]) edits.statuses[leftId] = baseStatus;
                if (!edits.statuses[rightId]) edits.statuses[rightId] = baseStatus;
                delete edits.trims[parentId];
                applyToMap();
                updateStatus();
                updateSelectionState();
                updateEndpointsLayer();
                saveMinibusSegmentEdits(edits);
                console.log(`[MinibusSegments] Saved split to localStorage key: ${STORAGE_KEY}`);
                setPickMode(null);
                return;
            }
            trimSelected();
            setPickMode(null);
        }
    });

    splitBtn.addEventListener('click', () => {
        if (selectedId === null) return;
        setPickMode(pickMode === 'split' ? null : 'split');
    });

    Object.entries(statusEyeButtons).forEach(([status, btn]) => {
        if (!btn) return;
        btn.classList.toggle('active', statusVisibility[status]);
        btn.addEventListener('click', () => {
            statusVisibility[status] = !statusVisibility[status];
            btn.classList.toggle('active', statusVisibility[status]);
            applyToMap();
        });
    });

    return {
        open,
        close,
        isActive,
        setBaseData,
        setEdits,
        setShowMinibusMode: (value) => {
            showMinibusMode = Boolean(value);
            applyToMap();
        },
        saveToFile: saveEditsToFile,
        refresh: applyToMap,
        trimSelected,
        clearTrim,
        resetAll,
        exportEdits
    };
}

export function initMinibusSegmentsEditor(map, baseData, options = {}) {
    const edits = options.edits || loadMinibusSegmentEdits();
    if (!window.minibusSegmentsEditor) {
        window.minibusSegmentsEditor = createMinibusSegmentsEditor(map, {
            sourceId: options.sourceId,
            layerId: options.layerId,
            baseData
        });
    } else {
        window.minibusSegmentsEditor.setBaseData(baseData);
    }
    window.minibusSegmentsEditor.setEdits(edits);
    window.startMinibusSegmentsEditor = () => window.minibusSegmentsEditor.open();
    window.stopMinibusSegmentsEditor = () => window.minibusSegmentsEditor.close();
    return applyMinibusSegmentEdits(baseData, edits);
}
