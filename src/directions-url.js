const DEFAULT_OPTIMIZE = 'quick';
const OPTIMIZE_SEGMENT = 'lesswalking';
const OPTIMIZE_SEGMENT_TRANSFERS = 'lesstransfers';
const MODE_ORDER = ['subway', 'bus', 'gondola'];
const POINT_PATTERN = '-?\\d+(?:\\.\\d+)?';
const DIRECTIONS_PATH_RE = new RegExp(
    `^directions/(${POINT_PATTERN})-(${POINT_PATTERN})-to-(${POINT_PATTERN})-(${POINT_PATTERN})(?:/(.*))?$`,
    'i'
);
const SCHEDULE_RE = /^(at|by)(\d{2})(\d{2})-(\d{2})-(\d{2})$/i;

function stripDecorations(path = '') {
    return String(path || '')
        .trim()
        .replace(/^[#?]+/, '')
        .replace(/[?#].*$/, '')
        .replace(/^\/+/, '')
        .replace(/\/+$/, '');
}

function formatCoordinate(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return null;
    return num.toFixed(5);
}

function normalizePoint(point) {
    if (!point) return null;
    const lat = Number(point.lat);
    const lng = Number(point.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { lat, lng };
}

function parseDateFromSegment(segment) {
    const match = String(segment || '').match(SCHEDULE_RE);
    if (!match) return null;

    const hours = Number(match[2]);
    const minutes = Number(match[3]);
    const day = Number(match[4]);
    const month = Number(match[5]);

    if (!Number.isInteger(hours) || !Number.isInteger(minutes) || !Number.isInteger(day) || !Number.isInteger(month)) {
        return null;
    }
    if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
    if (day < 1 || day > 31 || month < 1 || month > 12) return null;

    const year = new Date().getFullYear();
    const date = new Date(year, month - 1, day, hours, minutes, 0, 0);

    if (
        date.getFullYear() !== year ||
        date.getMonth() !== month - 1 ||
        date.getDate() !== day ||
        date.getHours() !== hours ||
        date.getMinutes() !== minutes
    ) {
        return null;
    }

    return date;
}

function formatScheduleSegment(date, timeMode = 'departAt') {
    if (!date) return null;
    const next = date instanceof Date ? date : new Date(date);
    if (Number.isNaN(next.getTime())) return null;
    const hours = String(next.getHours()).padStart(2, '0');
    const minutes = String(next.getMinutes()).padStart(2, '0');
    const day = String(next.getDate()).padStart(2, '0');
    const month = String(next.getMonth() + 1).padStart(2, '0');
    const prefix = timeMode === 'arriveBy' ? 'by' : 'at';
    return `${prefix}${hours}${minutes}-${day}-${month}`;
}

function normalizeModeSlugs(value) {
    return Array.isArray(value)
        ? value.map((item) => String(item).trim().toLowerCase()).filter(Boolean)
        : [];
}

function modeSlugToValue(slug) {
    switch (String(slug || '').trim().toLowerCase()) {
        case 'bus':
            return 'BUS';
        case 'subway':
            return 'SUBWAY';
        case 'gondola':
            return 'GONDOLA';
        default:
            return null;
    }
}

function valueToModeSlug(value) {
    switch (String(value || '').trim().toUpperCase()) {
        case 'BUS':
            return 'bus';
        case 'SUBWAY':
            return 'subway';
        case 'GONDOLA':
            return 'gondola';
        default:
            return null;
    }
}

function normalizeOptimize(value) {
    const slug = String(value || '').trim().toLowerCase();
    if (slug === 'lesswalking') return 'lessWalking';
    if (slug === 'lesstransfers') return 'lessTransfers';
    return DEFAULT_OPTIMIZE;
}

export function parseDirectionsPath(pathname = '') {
    const path = stripDecorations(pathname);
    const match = path.match(DIRECTIONS_PATH_RE);
    if (!match) return null;

    const from = {
        lat: Number(match[1]),
        lng: Number(match[2])
    };
    const to = {
        lat: Number(match[3]),
        lng: Number(match[4])
    };

    if (!Number.isFinite(from.lat) || !Number.isFinite(from.lng) || !Number.isFinite(to.lat) || !Number.isFinite(to.lng)) {
        return null;
    }

    const state = {
        type: 'directions',
        from,
        to,
        selectedModes: MODE_ORDER.map((slug) => modeSlugToValue(slug)),
        optimize: DEFAULT_OPTIMIZE,
        timeMode: 'leaveNow',
        time: null
    };

    const extras = String(match[5] || '')
        .split('/')
        .map((segment) => segment.trim())
        .filter(Boolean);

    extras.forEach((segment) => {
        const lower = segment.toLowerCase();
        if (SCHEDULE_RE.test(segment)) {
            const date = parseDateFromSegment(segment);
            if (date) {
                const match = segment.match(SCHEDULE_RE);
                const prefix = match ? match[1].toLowerCase() : 'at';
                state.time = date;
                state.timeMode = prefix === 'by' ? 'arriveBy' : 'departAt';
            }
            return;
        }

        if (lower === OPTIMIZE_SEGMENT || lower === OPTIMIZE_SEGMENT_TRANSFERS) {
            state.optimize = lower === OPTIMIZE_SEGMENT_TRANSFERS ? 'lessTransfers' : 'lessWalking';
            return;
        }

        if (lower.startsWith('excl-')) {
            const excluded = new Set(lower.substring(5).split('-').filter(Boolean));
            state.selectedModes = MODE_ORDER
                .filter((slug) => !excluded.has(slug))
                .map((slug) => modeSlugToValue(slug))
                .filter(Boolean);
        }
    });

    return state;
}

export function buildDirectionsPath(state = {}) {
    const from = normalizePoint(state.from);
    const to = normalizePoint(state.to);
    if (!from || !to) return null;

    let path = `directions/${formatCoordinate(from.lat)}-${formatCoordinate(from.lng)}-to-${formatCoordinate(to.lat)}-${formatCoordinate(to.lng)}`;

    const timeSegment = state.time instanceof Date
        ? formatScheduleSegment(state.time, state.timeMode)
        : formatScheduleSegment(state.time ? new Date(state.time) : null, state.timeMode);
    if (timeSegment) {
        path += `/${timeSegment}`;
    }

    const hasExplicitModes = Object.prototype.hasOwnProperty.call(state, 'selectedModes') ||
        Object.prototype.hasOwnProperty.call(state, 'modes');
    const selectedModes = hasExplicitModes
        ? normalizeModeSlugs(state.selectedModes || state.modes || [])
        : MODE_ORDER.slice();
    const excludedModes = MODE_ORDER.filter((slug) => !selectedModes.includes(slug));
    if (excludedModes.length > 0 && excludedModes.length < MODE_ORDER.length) {
        path += `/excl-${excludedModes.join('-')}`;
    }

    const optimize = normalizeOptimize(state.optimize);
    if (optimize === 'lessWalking') {
        path += `/${OPTIMIZE_SEGMENT}`;
    } else if (optimize === 'lessTransfers') {
        path += `/${OPTIMIZE_SEGMENT_TRANSFERS}`;
    }

    return path;
}

export function getDirectionsCanonicalState(state = {}) {
    const from = normalizePoint(state.from);
    const to = normalizePoint(state.to);
    const selectedModes = normalizeModeSlugs(state.selectedModes || state.modes || []);
    const optimize = normalizeOptimize(state.optimize);
    const time = state.time instanceof Date
        ? state.time
        : (state.time ? new Date(state.time) : null);

    return {
        from,
        to,
        selectedModes,
        optimize,
        time: time && !Number.isNaN(time.getTime()) ? time : null,
        timeMode: state.timeMode === 'arriveBy' ? 'arriveBy' : (state.timeMode === 'departAt' ? 'departAt' : 'leaveNow')
    };
}
