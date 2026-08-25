const DIRECTIONS_REGIONS = Object.freeze([
    {
        id: 'tbilisi',
        supportsDirections: true,
        center: { lng: 44.8015, lat: 41.7151 },
        bounds: { west: 44.55, south: 41.58, east: 45.00, north: 41.88 }
    },
    {
        id: 'rustavi',
        supportsDirections: true,
        center: { lng: 45.0065, lat: 41.5444 },
        bounds: { west: 44.88, south: 41.48, east: 45.12, north: 41.66 }
    },
    {
        id: 'kutaisi',
        supportsDirections: true,
        center: { lng: 42.7047, lat: 42.2679 },
        bounds: { west: 42.55, south: 42.15, east: 42.82, north: 42.38 }
    },
    {
        id: 'batumi',
        supportsDirections: false,
        center: { lng: 41.6367, lat: 41.6168 },
        bounds: { west: 41.50, south: 41.50, east: 41.80, north: 41.78 }
    }
]);

export const RUSTAVI_ONLY_DIRECTIONS_WARNING = '[warning about Tbilisi Rustavi intercity directions]';

function normalizePoint(point) {
    const lng = Number(point?.lng ?? point?.lon ?? point?.[0]);
    const lat = Number(point?.lat ?? point?.[1]);
    return Number.isFinite(lng) && Number.isFinite(lat) ? { lng, lat } : null;
}

function containsPoint(region, point) {
    const { west, south, east, north } = region.bounds;
    return point.lng >= west && point.lng <= east && point.lat >= south && point.lat <= north;
}

function distanceSquared(point, center) {
    const lngScale = Math.cos(point.lat * Math.PI / 180);
    const dx = (point.lng - center.lng) * lngScale;
    const dy = point.lat - center.lat;
    return dx * dx + dy * dy;
}

export function getDirectionsRegionForPoint(rawPoint) {
    const point = normalizePoint(rawPoint);
    if (!point) return null;

    return DIRECTIONS_REGIONS
        .filter(region => containsPoint(region, point))
        .sort((a, b) => distanceSquared(point, a.center) - distanceSquared(point, b.center))[0] || null;
}

export function resolveDirectionsRegion(from, to) {
    const fromRegion = getDirectionsRegionForPoint(from);
    const toRegion = getDirectionsRegionForPoint(to);

    if (!fromRegion || !toRegion || !fromRegion.supportsDirections || !toRegion.supportsDirections) {
        return {
            status: 'unsupported',
            reason: !fromRegion || !toRegion ? 'outside-service-area' : 'unsupported-city',
            fromCityId: fromRegion?.id || null,
            toCityId: toRegion?.id || null,
            messageKey: 'directionsUnsupportedArea'
        };
    }

    if (fromRegion.id !== toRegion.id) {
        const cityPair = new Set([fromRegion.id, toRegion.id]);
        if (cityPair.has('tbilisi') && cityPair.has('rustavi')) {
            return {
                status: 'supported',
                sourceId: 'rustavi',
                fromCityId: fromRegion.id,
                toCityId: toRegion.id,
                warningText: RUSTAVI_ONLY_DIRECTIONS_WARNING
            };
        }

        return {
            status: 'unsupported',
            reason: 'cross-city',
            fromCityId: fromRegion.id,
            toCityId: toRegion.id,
            messageKey: 'directionsCrossCity'
        };
    }

    return {
        status: 'supported',
        sourceId: fromRegion.id,
        fromCityId: fromRegion.id,
        toCityId: toRegion.id
    };
}

export { DIRECTIONS_REGIONS };
