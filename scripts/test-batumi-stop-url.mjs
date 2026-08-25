import assert from 'node:assert/strict';
import { getBatumiStopUrlId, resolveBatumiStopUrlId } from '../src/data/batumi-stop-url.js';

const stops = [
    { id: 'b628251a85af67b0612cc234d', code: '1152', _source: 'batumi' },
    { id: '801', code: '801', _source: 'tbilisi' }
];

assert.equal(getBatumiStopUrlId(stops[0]), 'b1152');
assert.equal(getBatumiStopUrlId(stops[1]), null);
assert.equal(resolveBatumiStopUrlId('b1152', stops), 'b628251a85af67b0612cc234d');
assert.equal(resolveBatumiStopUrlId('1:b1152', stops), 'b628251a85af67b0612cc234d');
assert.equal(resolveBatumiStopUrlId('b628251a85af67b0612cc234d', stops), null);

console.log('Batumi stop URL tests passed.');
