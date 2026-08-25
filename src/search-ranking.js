const MIN_CITY_FOCUS_ZOOM = 8;

export const GEORGIA_SEARCH_BBOX = '40.0,41.0,46.8,43.6';

export const SEARCH_CITIES = Object.freeze([
    {
        id: 'tbilisi',
        center: { lng: 44.8015, lat: 41.7151 },
        searchBbox: '44.55,41.58,45.00,41.88',
        maxDistanceKm: 35,
        names: { en: 'Tbilisi', ka: 'თბილისი', ru: 'Тбилиси' }
    },
    {
        id: 'rustavi',
        center: { lng: 45.0065, lat: 41.5444 },
        searchBbox: '44.88,41.48,45.12,41.66',
        maxDistanceKm: 18,
        names: { en: 'Rustavi', ka: 'რუსთავი', ru: 'Рустави' }
    },
    {
        id: 'kutaisi',
        center: { lng: 42.7047, lat: 42.2679 },
        searchBbox: '42.55,42.15,42.82,42.38',
        maxDistanceKm: 25,
        names: { en: 'Kutaisi', ka: 'ქუთაისი', ru: 'Кутаиси' }
    },
    {
        id: 'batumi',
        center: { lng: 41.6367, lat: 41.6168 },
        searchBbox: '41.50,41.50,41.80,41.78',
        maxDistanceKm: 30,
        names: { en: 'Batumi', ka: 'ბათუმი', ru: 'Батуми' }
    }
]);

function normalize(value) {
    return String(value ?? '').trim().toLocaleLowerCase();
}

function distanceKm(a, b) {
    const toRadians = (degrees) => degrees * Math.PI / 180;
    const dLat = toRadians(b.lat - a.lat);
    const dLng = toRadians(b.lng - a.lng);
    const lat1 = toRadians(a.lat);
    const lat2 = toRadians(b.lat);
    const h = Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

function toCoords(value) {
    if (!value) return null;
    const lng = Number(value.lng ?? value.lon ?? value[0]);
    const lat = Number(value.lat ?? value[1]);
    return Number.isFinite(lng) && Number.isFinite(lat) ? { lng, lat } : null;
}

export function getCityForCoords(value) {
    const coords = toCoords(value);
    if (!coords) return null;

    const candidates = SEARCH_CITIES
        .map(city => ({ city, distance: distanceKm(coords, city.center) }))
        .filter(({ city, distance }) => distance <= city.maxDistanceKm)
        .sort((a, b) => a.distance - b.distance);
    return candidates[0]?.city || null;
}

function mapContainsCity(mapInstance, city) {
    try {
        const bounds = mapInstance.getBounds?.();
        if (!bounds) return false;
        if (typeof bounds.contains === 'function') {
            return bounds.contains([city.center.lng, city.center.lat]);
        }
        return city.center.lng >= bounds.getWest() && city.center.lng <= bounds.getEast() &&
            city.center.lat >= bounds.getSouth() && city.center.lat <= bounds.getNorth();
    } catch (error) {
        return false;
    }
}

function getMapFocusedCity(mapInstance) {
    const zoom = Number(mapInstance?.getZoom?.());
    if (!Number.isFinite(zoom) || zoom < MIN_CITY_FOCUS_ZOOM) return null;

    const center = toCoords(mapInstance?.getCenter?.());
    if (!center) return null;

    const visibleCities = SEARCH_CITIES.filter(city => mapContainsCity(mapInstance, city));
    if (visibleCities.length > 0) {
        return visibleCities.sort((a, b) => distanceKm(center, a.center) - distanceKm(center, b.center))[0];
    }

    return getCityForCoords(center);
}

export function getSearchContext(mapInstance, userCoords = null) {
    const mapCity = getMapFocusedCity(mapInstance);
    if (mapCity) {
        return {
            preferredCityId: mapCity.id,
            preferenceSource: 'map',
            bias: toCoords(mapInstance?.getCenter?.()) || { ...mapCity.center },
            searchBbox: mapCity.searchBbox
        };
    }

    const userCity = getCityForCoords(userCoords);
    if (userCity) {
        return {
            preferredCityId: userCity.id,
            preferenceSource: 'location',
            bias: toCoords(userCoords) || { ...userCity.center },
            searchBbox: userCity.searchBbox
        };
    }

    const mapCenter = toCoords(mapInstance?.getCenter?.());
    return {
        preferredCityId: null,
        preferenceSource: null,
        bias: mapCenter || { ...SEARCH_CITIES[0].center },
        searchBbox: GEORGIA_SEARCH_BBOX
    };
}

export function getCityName(cityId, language = 'en') {
    const city = SEARCH_CITIES.find(candidate => candidate.id === cityId);
    return city?.names?.[language] || city?.names?.en || '';
}

function cityTier(item, preferredCityId) {
    if (!preferredCityId) return 0;
    const itemCityId = item?._source || item?._cityId;
    return itemCityId === preferredCityId ? 0 : 1;
}

function routeMatchTier(route, query) {
    const shortName = normalize(route.shortName);
    const longName = normalize(route.longName);
    if (shortName === query) return 0;
    if (shortName.startsWith(query)) return 1;
    if (shortName.includes(query)) return 2;
    if (longName === query) return 3;
    if (longName.startsWith(query)) return 4;
    return 5;
}

function stopMatchTier(stop, query) {
    const code = normalize(stop.code);
    const name = normalize(stop.name);
    if (code === query) return 0;
    if (name === query) return 1;
    if (code.startsWith(query)) return 2;
    if (name.startsWith(query)) return 3;
    if (name.includes(query)) return 4;
    return 5;
}

function placeMatchTier(place, query) {
    const text = normalize(place.text);
    if (text === query) return 0;
    if (text.startsWith(query)) return 1;
    return 2;
}

function compareRanked(a, b, matchTier, preferredCityId, label) {
    return matchTier(a) - matchTier(b) ||
        cityTier(a, preferredCityId) - cityTier(b, preferredCityId) ||
        normalize(label(a)).localeCompare(normalize(label(b)), undefined, { numeric: true });
}

export function findLocalSearchResults(stops, routes, rawQuery, preferredCityId, limits = {}) {
    const query = normalize(rawQuery);
    const stopLimit = limits.stops ?? 5;
    const routeLimit = limits.routes ?? 5;

    const matchedStops = (stops || [])
        .filter(stop => normalize(stop.name).includes(query) || normalize(stop.code).includes(query))
        .sort((a, b) => compareRanked(a, b, item => stopMatchTier(item, query), preferredCityId, item => item.name || item.code))
        .slice(0, stopLimit);

    const matchedRoutes = (routes || [])
        .filter(route => normalize(route.shortName).includes(query) || normalize(route.longName).includes(query))
        .sort((a, b) => compareRanked(a, b, item => routeMatchTier(item, query), preferredCityId, item => item.shortName || item.longName))
        .slice(0, routeLimit);

    return { stops: matchedStops, routes: matchedRoutes };
}

export function rankPlaces(places, rawQuery, preferredCityId, limit = 7) {
    const query = normalize(rawQuery);
    return (places || [])
        .map(place => ({
            ...place,
            _cityId: place._cityId || getCityForCoords(place.center)?.id || null
        }))
        .sort((a, b) =>
            cityTier(a, preferredCityId) - cityTier(b, preferredCityId) ||
            placeMatchTier(a, query) - placeMatchTier(b, query) ||
            normalize(a.text).localeCompare(normalize(b.text), undefined, { numeric: true })
        )
        .slice(0, limit);
}

export function isSearchableQuery(rawQuery) {
    const query = normalize(rawQuery);
    return query.length >= 2 || /^\d$/.test(query);
}
