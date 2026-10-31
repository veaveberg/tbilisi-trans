export const CHANGE_COLORS = Object.freeze({ added: '#176b46', modified: '#175d9e', removed: '#a72d3d' });
const valid = point => Array.isArray(point?.coordinates) && point.coordinates.length === 2 && point.coordinates.every(Number.isFinite) && Math.abs(point.coordinates[0]) <= 180 && Math.abs(point.coordinates[1]) <= 90;
export function stopChangeFeatures(changes) {
    const points = [], moves = [];
    let unavailable = 0;
    for (const change of changes) {
        const before = change.context?.locationBefore, after = change.context?.locationAfter;
        const location = change.status === 'removed' ? before : after;
        if (!valid(location)) { unavailable++; continue; }
        const properties = { id: change.id, name: location.name || change.label, status: change.status, previous: false };
        points.push({ type: 'Feature', properties, geometry: { type: 'Point', coordinates: location.coordinates } });
        if (change.status === 'modified' && valid(before) && before.coordinates.some((value, i) => value !== location.coordinates[i])) {
            points.push({ type: 'Feature', properties: { ...properties, name: before.name || change.label, previous: true }, geometry: { type: 'Point', coordinates: before.coordinates } });
            moves.push({ type: 'Feature', properties, geometry: { type: 'LineString', coordinates: [before.coordinates, location.coordinates] } });
        }
    }
    return { points: { type: 'FeatureCollection', features: points }, moves: { type: 'FeatureCollection', features: moves }, unavailable };
}
