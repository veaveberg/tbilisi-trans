import assert from 'node:assert/strict';
import { forEachConcurrent, routeConcurrency, orderedRecords } from './prefetch-concurrency.js';
let active = 0, peak = 0;
const completed = [];
await forEachConcurrent([1, 2, 3, 4, 5, 6], async value => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, (7 - value) * 3));
    completed.push(value); active--;
}, 3);
assert.equal(peak, 3);
assert.equal(active, 0);
assert.deepEqual(completed.sort(), [1, 2, 3, 4, 5, 6]);
await assert.rejects(forEachConcurrent([1, 2, 3], async value => { if (value === 1) throw new Error('failure'); await new Promise(resolve => setTimeout(resolve, 5)); }, 2), AggregateError);
assert.equal(routeConcurrency('1'), 1);
assert.throws(() => routeConcurrency('0'));
assert.throws(() => routeConcurrency('99'));
assert.deepEqual(Object.keys(orderedRecords({ r10: 1, r2: 2 })), ['r2', 'r10']);
console.log('Route workers respect their limit, drain on failure, and serialize aggregate keys consistently.');
