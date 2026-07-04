import assert from 'node:assert/strict';
import { buildDirectionsPath, parseDirectionsPath } from '../src/directions-url.js';

const baseState = {
    from: { lat: 41.73922, lng: 44.77709 },
    to: { lat: 41.73452, lng: 44.83053 }
};

function assertRoundTrip(input, expectedPath, message) {
    const path = buildDirectionsPath(input);
    assert.equal(path, expectedPath, `${message}: encoded path mismatch`);

    const parsed = parseDirectionsPath(`/${path}`);
    assert.ok(parsed, `${message}: parsed state missing`);
    assert.equal(parsed.type, 'directions', `${message}: parsed type mismatch`);
    assert.deepEqual(parsed.from, input.from, `${message}: from mismatch`);
    assert.deepEqual(parsed.to, input.to, `${message}: to mismatch`);
    return parsed;
}

const plainPath = 'directions/41.73922-44.77709-to-41.73452-44.83053';
const plainParsed = assertRoundTrip(baseState, plainPath, 'plain directions URL');
assert.deepEqual(plainParsed.selectedModes, ['SUBWAY', 'BUS', 'GONDOLA'], 'plain directions URL: default modes');
assert.equal(plainParsed.optimize, 'quick', 'plain directions URL: default optimize');
assert.equal(plainParsed.timeMode, 'leaveNow', 'plain directions URL: default time mode');
assert.equal(plainParsed.time, null, 'plain directions URL: default time');

const scheduledTime = new Date();
scheduledTime.setFullYear(new Date().getFullYear(), 10, 7);
scheduledTime.setHours(9, 5, 0, 0);
const scheduledPath = 'directions/41.73922-44.77709-to-41.73452-44.83053/at0905-07-11';
const scheduledParsed = assertRoundTrip({ ...baseState, time: scheduledTime }, scheduledPath, 'scheduled directions URL');
assert.equal(scheduledParsed.timeMode, 'departAt', 'scheduled directions URL: time mode');
assert.equal(scheduledParsed.time.getHours(), 9, 'scheduled directions URL: hours');
assert.equal(scheduledParsed.time.getMinutes(), 5, 'scheduled directions URL: minutes');
assert.equal(scheduledParsed.time.getDate(), 7, 'scheduled directions URL: day');
assert.equal(scheduledParsed.time.getMonth(), 10, 'scheduled directions URL: month');

const excludedPath = 'directions/41.73922-44.77709-to-41.73452-44.83053/excl-subway-bus';
const excludedParsed = parseDirectionsPath(`/${excludedPath}`);
assert.ok(excludedParsed, 'excluded modes URL: parsed state missing');
assert.deepEqual(excludedParsed.selectedModes, ['GONDOLA'], 'excluded modes URL: selected modes');
assert.equal(buildDirectionsPath({ ...baseState, selectedModes: ['GONDOLA'] }), excludedPath, 'excluded modes URL: encoded path');

const liveSyncInitial = buildDirectionsPath({ ...baseState, selectedModes: ['BUS', 'SUBWAY', 'GONDOLA'], optimize: 'quick' });
const liveSyncUpdated = buildDirectionsPath({
    ...baseState,
    selectedModes: ['BUS'],
    optimize: 'lessTransfers',
    time: scheduledTime
});
assert.equal(liveSyncInitial, plainPath, 'live URL sync: default state');
assert.equal(liveSyncUpdated, 'directions/41.73922-44.77709-to-41.73452-44.83053/at0905-07-11/excl-subway-gondola/lesstransfers', 'live URL sync: updated state');

const hashParsed = parseDirectionsPath('/directions/41.73922-44.77709-to-41.73452-44.83053/at0905-07-11#12.00/41.73922/44.77709');
assert.ok(hashParsed, 'map-hash coexistence: parsed state missing');
assert.equal(hashParsed.timeMode, 'departAt', 'map-hash coexistence: preserved scheduled time');
assert.equal(buildDirectionsPath(baseState).includes('#'), false, 'map-hash coexistence: encoded path should not contain hash');

console.log('Directions URL verification passed.');
