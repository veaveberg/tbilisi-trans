import assert from 'node:assert/strict';

import {
    findLocalSearchResults,
    getSearchContext,
    rankPlaces
} from '../src/search-ranking.js';

function createMap({ zoom, center, visibleCityCenters = [] }) {
    return {
        getZoom: () => zoom,
        getCenter: () => center,
        getBounds: () => ({
            contains: ([lng, lat]) => visibleCityCenters.some(candidate =>
                candidate.lng === lng && candidate.lat === lat
            )
        })
    };
}

const batumiCenter = { lng: 41.6367, lat: 41.6168 };
const tbilisiCenter = { lng: 44.8015, lat: 41.7151 };

{
    const context = getSearchContext(
        createMap({ zoom: 12, center: batumiCenter, visibleCityCenters: [batumiCenter] }),
        tbilisiCenter
    );
    assert.equal(context.preferredCityId, 'batumi');
    assert.equal(context.preferenceSource, 'map');
}

{
    const context = getSearchContext(
        createMap({ zoom: 6, center: { lng: 43.4, lat: 42.3 } }),
        batumiCenter
    );
    assert.equal(context.preferredCityId, 'batumi');
    assert.equal(context.preferenceSource, 'location');
}

{
    const context = getSearchContext(
        createMap({ zoom: 6, center: { lng: 43.4, lat: 42.3 } }),
        null
    );
    assert.equal(context.preferredCityId, null);
}

{
    const routes = [
        { shortName: '106', longName: 'University', _source: 'tbilisi' },
        { shortName: '10', longName: 'Batumi centre', _source: 'batumi' },
        { shortName: '10', longName: 'Tbilisi centre', _source: 'tbilisi' },
        { shortName: '210', longName: 'Station', _source: 'tbilisi' }
    ];
    const { routes: results } = findLocalSearchResults([], routes, '10', 'tbilisi');
    assert.deepEqual(
        results.map(route => `${route._source}:${route.shortName}`),
        ['tbilisi:10', 'batumi:10', 'tbilisi:106', 'tbilisi:210']
    );
}

{
    const stops = [
        { name: 'Stop 1010', code: '1010', _source: 'tbilisi' },
        { name: 'Central Station', code: '10', _source: 'batumi' }
    ];
    const { stops: results } = findLocalSearchResults(stops, [], '10', 'tbilisi');
    assert.equal(results[0].code, '10');
}

{
    const places = [
        { text: 'Central Avenue', center: [44.8015, 41.7151] },
        { text: 'Central', center: [43.2912, 42.2894] }
    ];
    const results = rankPlaces(places, 'central', 'tbilisi');
    assert.equal(results[0]._cityId, 'tbilisi');
    assert.equal(results[0].text, 'Central Avenue');
}

console.log('Search ranking tests passed.');
