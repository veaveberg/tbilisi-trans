import assert from 'node:assert/strict';
import { normalizeBatumiArrivalMinutes } from '../src/data/batumi-live.js';

assert.equal(normalizeBatumiArrivalMinutes(null), null);
assert.equal(normalizeBatumiArrivalMinutes(undefined), null);
assert.equal(normalizeBatumiArrivalMinutes(''), null);
assert.equal(normalizeBatumiArrivalMinutes(0), null);
assert.equal(normalizeBatumiArrivalMinutes('0'), null);
assert.equal(normalizeBatumiArrivalMinutes(-1), null);
assert.equal(normalizeBatumiArrivalMinutes('not-a-number'), null);
assert.equal(normalizeBatumiArrivalMinutes(1), 0);
assert.equal(normalizeBatumiArrivalMinutes('13'), 12);

console.log('Batumi live-arrival normalization tests passed.');
