import { API_KEY, decodePolyline } from './api.js';
import { sources } from './data/sources.js';
import { getTransitDataLocale } from './i18n.ts';

const DIRECTIONS_TEXT_LIMIT = 5000;

/**
 * Map local optimize values to TTC API optimize values.
 * The app UI uses 'lessTransfers' but the TTC API expects 'fewerTransfers'.
 */
const OPTIMIZE_MAP = {
    quick: 'quick',
    lessWalking: 'lessWalking',
    lessTransfers: 'fewerTransfers',
    fewerTransfers: 'fewerTransfers'
};

function getApiOptimizeValue(value) {
    return OPTIMIZE_MAP[value] || 'quick';
}

/**
 * Build query parameters for the TTC plan endpoint.
 *
 * TTC API contract (GET /pis-gateway/api/v2/plan):
 *   fromPlace     — "lat,lng"
 *   toPlace       — "lat,lng"
 *   departMode    — "leaveNow" | "departAt" | "arriveBy"
 *   date          — "yyyy-MM-DD" (only when departMode !== "leaveNow")
 *   time          — "HH:mm" (only when departMode !== "leaveNow")
 *   modes         — comma-separated: "WALK,BUS,SUBWAY,GONDOLA"
 *   optimize      — "quick" | "lessWalking" | "fewerTransfers"
 *   locale        — "en" | "ka" | "ru" (ru mapped to en by TTC)
 */
export function buildPlanQueryParams(draft = {}) {
    const params = new URLSearchParams();

    if (draft.from) {
        params.set('fromPlace', `${draft.from.lat},${draft.from.lng}`);
    }
    if (draft.to) {
        params.set('toPlace', `${draft.to.lat},${draft.to.lng}`);
    }

    const departMode = draft.timeMode || 'leaveNow';
    params.set('departMode', departMode);

    if (departMode !== 'leaveNow' && draft.time) {
        const date = draft.time instanceof Date ? draft.time : new Date(draft.time);
        if (!Number.isNaN(date.getTime())) {
            const yyyy = date.getFullYear();
            const mm = String(date.getMonth() + 1).padStart(2, '0');
            const dd = String(date.getDate()).padStart(2, '0');
            const hh = String(date.getHours()).padStart(2, '0');
            const min = String(date.getMinutes()).padStart(2, '0');
            params.set('date', `${yyyy}-${mm}-${dd}`);
            params.set('time', `${hh}:${min}`);
        }
    }

    const modes = Array.isArray(draft.modes) && draft.modes.length
        ? draft.modes.join(',')
        : 'WALK';
    params.set('modes', modes);

    params.set('optimize', getApiOptimizeValue(draft.optimize));
    params.set('locale', getTransitDataLocale());

    return params;
}

function getModeColor(mode, routeColor) {
    if (routeColor) return `#${routeColor.replace(/^#/, '')}`;
    switch (String(mode || '').toUpperCase()) {
        case 'BUS':
            return '#2563eb';
        case 'SUBWAY':
        case 'METRO':
            return '#e11d48';
        case 'GONDOLA':
        case 'CABLE_CAR':
            return '#0891b2';
        case 'WALK':
            return '#64748b';
        default:
            return '#0a84ff';
    }
}

function decodeLegCoordinates(leg) {
    const candidates = [
        leg?.legPolyline,
        leg?.polyline,
        leg?.geometry,
        leg?.points
    ];

    for (const candidate of candidates) {
        if (!candidate) continue;

        if (Array.isArray(candidate)) {
            return candidate;
        }

        if (typeof candidate === 'string') {
            return decodePolyline(candidate);
        }

        if (Array.isArray(candidate.coordinates)) {
            return candidate.coordinates;
        }

        const encoded = candidate.encodedValue || candidate.points || candidate.geometry;
        if (Array.isArray(encoded)) {
            return encoded;
        }
        if (typeof encoded === 'string') {
            return decodePolyline(encoded);
        }
    }

    const from = leg?.from;
    const to = leg?.to;
    if (from?.lat != null && from?.lon != null && to?.lat != null && to?.lon != null) {
        return [
            [Number(from.lon), Number(from.lat)],
            [Number(to.lon), Number(to.lat)]
        ];
    }

    return [];
}

function normalizeLeg(leg, index, sourceId) {
    const coordinates = decodeLegCoordinates(leg);

    const route = leg.route || {};
    const mode = String(leg.mode || 'WALK').toUpperCase();
    const color = getModeColor(mode, route.color || leg.legPolyline?.color || leg.polyline?.color || leg.geometry?.color);

    // Build a readable instruction text from the leg
    const textParts = [];
    if (mode !== 'WALK' && route.shortName) {
        textParts.push(`${mode} ${route.shortName}`);
    } else if (mode === 'WALK') {
        textParts.push('Walk');
    }
    if (leg.from?.name && leg.from.name !== 'Origin') {
        textParts.push(`from ${leg.from.name}`);
    }
    if (leg.to?.name && leg.to.name !== 'Destination') {
        textParts.push(`to ${leg.to.name}`);
    }
    if (leg.duration != null) {
        const mins = Math.round(leg.duration / 60);
        textParts.push(`(${mins} min)`);
    }

    return {
        id: route.shortName || String(index),
        sourceId,
        mode,
        color,
        text: textParts.join(' '),
        routeShortName: route.shortName || null,
        routeLongName: route.longName || null,
        from: leg.from || null,
        to: leg.to || null,
        startTime: leg.startTime || null,
        endTime: leg.endTime || null,
        duration: leg.duration || 0,
        distance: leg.distance || 0,
        intermediateStops: leg.intermediateStops || [],
        steps: leg.steps || [],
        realTime: leg.realTime || false,
        coordinates
    };
}

function formatDuration(seconds) {
    const mins = Math.round(seconds / 60);
    if (mins < 60) return `${mins} min`;
    const hours = Math.floor(mins / 60);
    const remainder = mins % 60;
    return remainder > 0 ? `${hours}h ${remainder}min` : `${hours}h`;
}

function summarizeItinerary(itinerary, index) {
    const parts = [];

    if (itinerary.duration != null) {
        parts.push(formatDuration(itinerary.duration));
    }

    // List the transit modes used
    const transitLegs = (itinerary.legs || []).filter(l => l.mode !== 'WALK');
    if (transitLegs.length) {
        const routeNames = transitLegs.map(l => {
            const name = l.route?.shortName || l.mode;
            return name;
        });
        parts.push(routeNames.join(' → '));
    }

    if (itinerary.walkTime != null) {
        parts.push(`${Math.round(itinerary.walkTime / 60)} min walk`);
    }

    return parts.length ? parts.join(' · ') : `Route option ${index + 1}`;
}

export function normalizeDirectionsResponse(raw, options = {}) {
    const sourceId = options.sourceId || 'tbilisi';
    const itineraries = Array.isArray(raw?.itineraries) ? raw.itineraries : [];

    const routes = itineraries.map((itinerary, index) => {
        const segments = (itinerary.legs || [])
            .map((leg, legIndex) => normalizeLeg(leg, legIndex, sourceId))
            .filter(segment => segment.coordinates.length > 1);

        return {
            id: String(index),
            sourceId,
            summaryText: summarizeItinerary(itinerary, index),
            duration: itinerary.duration || 0,
            walkTime: itinerary.walkTime || 0,
            walkDistance: itinerary.walkDistance || 0,
            startTime: itinerary.startTime || null,
            endTime: itinerary.endTime || null,
            segments,
            raw: itinerary
        };
    });

    return {
        raw,
        sourceId,
        routes,
        technicalText: formatDirectionsTechnicalText(raw, routes)
    };
}

export function formatDirectionsTechnicalText(raw, routes = []) {
    const routeLine = routes.length ? `${routes.length} route option(s)` : 'No route options returned';
    let body = '';
    try {
        body = JSON.stringify(raw, null, 2);
    } catch (err) {
        body = String(raw);
    }
    if (body.length > DIRECTIONS_TEXT_LIMIT) {
        body = `${body.slice(0, DIRECTIONS_TEXT_LIMIT)}\n... truncated`;
    }
    return `${routeLine}\n${body}`;
}

/**
 * Fetch directions from the selected city's plan API.
 *
 * Uses GET /plan on the configured Tbilisi, Rustavi, or Kutaisi V2 source.
 */
export async function fetchDirections(draft = {}, options = {}) {
    const sourceId = options.sourceId || 'tbilisi';
    const source = sources.find(candidate => candidate.id === sourceId && candidate.supportsDirections);
    if (!source) {
        throw new Error(`Directions are not configured for source: ${sourceId}`);
    }

    const params = buildPlanQueryParams(draft);
    const url = `${source.apiBase}/plan?${params.toString()}`;

    const response = await fetch(url, {
        method: 'GET',
        headers: {
            'accept': 'application/json, text/plain, */*',
            'x-api-key': API_KEY
        },
        credentials: 'omit',
        mode: 'cors',
        signal: options.signal
    });

    const contentType = response.headers.get('content-type') || '';
    const raw = contentType.includes('application/json')
        ? await response.json()
        : await response.text();

    if (!response.ok) {
        const message = typeof raw === 'string' ? raw : JSON.stringify(raw);
        throw new Error(`Directions API ${response.status}: ${message || response.statusText}`);
    }

    return normalizeDirectionsResponse(raw, { sourceId });
}
