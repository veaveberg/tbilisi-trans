import { decodePolyline } from '../src/polyline.js';
import { changedPathSections } from './route-geometry-diff.js';
const valid = coordinates => coordinates.length >= 2 && coordinates.every(point => Array.isArray(point) && point.length >= 2 && Number.isFinite(point[0]) && Number.isFinite(point[1]) && Math.abs(point[0]) <= 180 && Math.abs(point[1]) <= 90);
const decoded = paths => Object.entries(paths || {}).map(([pattern, path]) => ({ pattern, coordinates: decodePolyline(Array.isArray(path) ? path : path?.encodedValue) })).filter(path => valid(path.coordinates));
export function routeChangeFeatures(changes, savedPaths, locale = 'en') {
    const features = [], highlights = [], stops = [], routeStops = [], moves = [], unavailable = [];
    for (const change of changes) {
        const data = savedPaths[change.id];
        const before = decoded(data?.before), after = decoded(data?.after);
        const different = JSON.stringify(before) !== JSON.stringify(after);
        const sides = change.status === 'removed' ? [['before', before]] : change.status === 'added' ? [['after', after]] : different ? [['before', before], ['after', after]] : [['after', after]];
        const start = features.length;
        const rawColor = change.context?.route?.color || '2563eb';
        const routeColor = rawColor.startsWith('#') ? rawColor : `#${rawColor}`;
        const properties = { id: change.id, name: change.label, status: change.status, routeColor };
        for (const stop of data?.routeStops?.[locale] || []) routeStops.push({ type: 'Feature', properties, geometry: { type: 'Point', coordinates: stop.coordinates } });
        for (const [side, paths] of sides) for (const { pattern, coordinates } of paths) {
            features.push({ type: 'Feature', properties: { ...properties, previous: side === 'before' && change.status !== 'removed', pattern }, geometry: { type: 'LineString', coordinates } });
        }
        if (change.status === 'modified' && data?.before !== null && data?.after !== null) {
            const diff = changedPathSections(before.map(path => path.coordinates), after.map(path => path.coordinates));
            for (const status of ['added', 'removed']) for (const coordinates of diff[status]) highlights.push({ type: 'Feature', properties: { ...properties, status, previous: status === 'removed', pattern: 'Changed geometry' }, geometry: { type: 'LineString', coordinates } });
        }
        for (const status of ['added', 'removed']) for (const stop of data?.stops?.[locale]?.[status] || []) {
            if (!Array.isArray(stop.coordinates) || stop.coordinates.length !== 2 || !stop.coordinates.every(Number.isFinite) || Math.abs(stop.coordinates[0]) > 180 || Math.abs(stop.coordinates[1]) > 90) continue;
            stops.push({ type: 'Feature', properties: { ...properties, status, stopId: stop.id, stopName: stop.name }, geometry: { type: 'Point', coordinates: stop.coordinates } });
        }
        for (const stop of data?.stops?.[locale]?.moved || []) {
            const before = stop.before.coordinates, after = stop.after.coordinates;
            if (![before, after].every(point => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite) && Math.abs(point[0]) <= 180 && Math.abs(point[1]) <= 90) || JSON.stringify(before) === JSON.stringify(after)) continue;
            const moved = { ...properties, status: 'modified', stopId: stop.id, stopName: stop.after.name };
            for (const [previous, coordinates] of [[true, before], [false, after]]) stops.push({ type: 'Feature', properties: { ...moved, previous }, geometry: { type: 'Point', coordinates } });
            moves.push({ type: 'Feature', properties: moved, geometry: { type: 'LineString', coordinates: [before, after] } });
        }
        if (features.length === start) unavailable.push(change.id);
    }
    return { type: 'FeatureCollection', features, highlights: { type: 'FeatureCollection', features: highlights }, stops: { type: 'FeatureCollection', features: stops }, routeStops: { type: 'FeatureCollection', features: routeStops }, moves: { type: 'FeatureCollection', features: moves }, unavailable };
}
