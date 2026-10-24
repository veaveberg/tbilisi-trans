import assert from 'node:assert/strict';
import { columnCoverage, retention } from './led-motion.js';

for (const position of [-1.75, -0.01, 0, 0.25, 0.999, 17.5]) {
    const samples = columnCoverage(position);
    assert.equal(samples[0][1] + samples[1][1], 1);
    assert.ok(Math.abs(samples.reduce((sum, [x, weight]) => sum + x * weight, 0) - position) < 1e-12);
}
// Exact one-column handoff, including left-edge clipping.
assert.deepEqual(columnCoverage(-0.25), [[-1, 0.25], [0, 0.75]]);
assert.deepEqual(columnCoverage(0), [[0, 1], [1, 0]]);
for (const rate of [30, 60, 120]) {
    let off = 1, on = 0;
    const coefficient = retention(1 / rate, 50);
    for (let i = 0; i < rate; i++) {
        off *= coefficient;
        on = 1 + (on - 1) * coefficient;
    }
    assert.ok(Math.abs(off - 2 ** -20) < 1e-12);
    assert.ok(Math.abs(on - (1 - 2 ** -20)) < 1e-12);
}
assert.equal(retention(0.016, 0), 0);
console.log('PASS: fractional column coverage and time-based attack/release at 30/60/120 Hz');
