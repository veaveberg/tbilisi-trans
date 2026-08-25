import assert from 'node:assert/strict';

import {
    getDirectionsRegionForPoint,
    resolveDirectionsRegion,
    RUSTAVI_ONLY_DIRECTIONS_WARNING
} from '../src/directions-regions.js';

const points = {
    tbilisi: { lng: 44.8015, lat: 41.7151 },
    rustavi: { lng: 45.0065, lat: 41.5444 },
    kutaisi: { lng: 42.7047, lat: 42.2679 },
    batumi: { lng: 41.6367, lat: 41.6168 },
    chiatura: { lng: 43.2912, lat: 42.2894 }
};

for (const cityId of ['tbilisi', 'rustavi', 'kutaisi', 'batumi']) {
    assert.equal(getDirectionsRegionForPoint(points[cityId])?.id, cityId);
}

assert.equal(getDirectionsRegionForPoint(points.chiatura), null);

for (const cityId of ['tbilisi', 'rustavi', 'kutaisi']) {
    assert.deepEqual(
        resolveDirectionsRegion(points[cityId], points[cityId]),
        {
            status: 'supported',
            sourceId: cityId,
            fromCityId: cityId,
            toCityId: cityId
        }
    );
}

assert.equal(resolveDirectionsRegion(points.batumi, points.batumi).reason, 'unsupported-city');
assert.equal(resolveDirectionsRegion(points.chiatura, points.chiatura).reason, 'outside-service-area');
assert.equal(resolveDirectionsRegion(points.tbilisi, points.kutaisi).reason, 'cross-city');

for (const [fromCityId, toCityId] of [['tbilisi', 'rustavi'], ['rustavi', 'tbilisi']]) {
    const result = resolveDirectionsRegion(points[fromCityId], points[toCityId]);
    assert.equal(result.status, 'supported');
    assert.equal(result.sourceId, 'rustavi');
    assert.equal(result.warningText, RUSTAVI_ONLY_DIRECTIONS_WARNING);
}

// The Tbilisi and Rustavi boxes overlap; the closest city center must win.
assert.equal(getDirectionsRegionForPoint({ lng: 44.99, lat: 41.57 })?.id, 'rustavi');

console.log('Directions region tests passed.');
