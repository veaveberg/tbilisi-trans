import { getSegmentForStop, generateSegmentGeometry, generateConnectionGeometry, getConnectionKey, LINE_1_IDS, LINE_2_IDS } from '../src/metro-utils.js';

// Use the app's station segments and connection geometry, including its
// manually edited midpoints, rather than the provider's metro polylines.
export function metroRoutePaths(change, segments, midpoints) {
    const second = String(change.context.route.shortName) === '2';
    const ids = second ? LINE_2_IDS : LINE_1_IDS;
    const properties = { id: change.id, name: change.label, status: change.status, previous: false, routeColor: second ? '#22c55e' : '#ef4444', pattern: 'Metro line' };
    const features = [], stops = [];
    for (let i = 0; i < ids.length; i++) {
        const segment = getSegmentForStop({ id: ids[i] }, segments);
        if (!segment) continue;
        const geometry = generateSegmentGeometry(segment);
        features.push({ type: 'Feature', properties, geometry: { type: 'LineString', coordinates: [geometry.leftPt, geometry.rightPt] } });
        stops.push({ type: 'Feature', properties, geometry: { type: 'Point', coordinates: segment.center } });
        if (i === ids.length - 1) continue;
        const next = getSegmentForStop({ id: ids[i + 1] }, segments);
        if (!next) continue;
        const connection = generateConnectionGeometry(segment, next, midpoints[getConnectionKey(ids[i], ids[i + 1])] || []);
        if (connection) features.push({ type: 'Feature', properties, geometry: connection });
    }
    return { features, stops };
}
