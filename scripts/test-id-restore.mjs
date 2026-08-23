import assert from 'node:assert/strict';
import {
    namespaceVehicleId,
    sourceForAppId,
    staticRouteResourceKeys,
    toApiId,
    toAppId
} from '../src/data/source-identity.js';

const sources = [
    {
        id: 'tbilisi',
        stripPrefixes: ['1:'],
    },
    {
        id: 'rustavi',
        prefix: 'r',
        separator: '',
        stripPrefixes: ['1:', '2:'],
    },
    {
        id: 'kutaisi',
        prefix: 'k',
        separator: '',
        stripPrefixes: ['1:'],
    },
    {
        id: 'batumi',
        prefix: 'b',
        separator: '',
        stripPrefixes: [],
    }
];

const rustavi = sources.find(s => s.id === 'rustavi');
const tbilisi = sources.find(s => s.id === 'tbilisi');
const kutaisi = sources.find(s => s.id === 'kutaisi');
const batumi = sources.find(s => s.id === 'batumi');

assert.equal(toApiId('rR826', rustavi, sources), '1:R826');
assert.equal(toApiId('r145', rustavi, sources), '1:145');
assert.equal(toApiId('811', tbilisi, sources), '1:811');
assert.equal(toAppId('1:R826', rustavi), 'rR826');

assert.equal(toAppId('1:R1318', kutaisi), 'kR1318');
assert.equal(toAppId('1:589', kutaisi), 'k589');
assert.equal(toApiId('kR1318', kutaisi, sources), '1:R1318');
assert.equal(toApiId('k589', kutaisi, sources), '1:589');
assert.equal(toApiId('k589', tbilisi, sources), 'k589');
assert.equal(toApiId('r145', kutaisi, sources), 'r145');
assert.equal(namespaceVehicleId('1:19', kutaisi), 'k19');
assert.equal(sourceForAppId('k589', sources, tbilisi), kutaisi);
assert.equal(sourceForAppId('r145', sources, tbilisi), rustavi);
assert.equal(sourceForAppId('811', sources, tbilisi), tbilisi);
assert(staticRouteResourceKeys('kR3241', '1:01', kutaisi, sources).includes('1:R3241_1_01'));
assert(staticRouteResourceKeys('rR826', '1:01', rustavi, sources).includes('1:R826_1_01'));
assert(staticRouteResourceKeys('330', '0:01', tbilisi, sources).includes('1:330_0_01'));

const batumiObjectId = '60acde9ffcc7a224160c587c';
assert.equal(toAppId(batumiObjectId, batumi), `b${batumiObjectId}`);
assert.equal(toApiId(`b${batumiObjectId}`, batumi, sources), batumiObjectId);
assert.equal(toApiId(`b${batumiObjectId}`, tbilisi, sources), `b${batumiObjectId}`);
assert.equal(namespaceVehicleId('PP 436 AA', batumi), 'bPP 436 AA');
assert.equal(sourceForAppId(`b${batumiObjectId}`, sources, tbilisi), batumi);
assert(staticRouteResourceKeys(`b${batumiObjectId}`, '1:01', batumi, sources).includes(`${batumiObjectId}_1_01`));

console.log('Source identity tests passed.');
