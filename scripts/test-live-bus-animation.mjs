import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Exercise the production animation with a deterministic display clock.
const source = fs.readFileSync(new URL('../src/map-visuals.js', import.meta.url), 'utf8');
const section = (start, end) => {
    const first = source.indexOf(start);
    const last = source.indexOf(end, first);
    assert.ok(first >= 0 && last > first);
    return source.slice(first, last);
};
let callback;
let now = 0;
const frames = [];
const layers = new Map();
const moves = [];
const context = vm.createContext({
    console,
    performance: { now: () => now },
    requestAnimationFrame: fn => { callback = fn; return 1; },
    cancelAnimationFrame() { callback = null; },
    setLiveBusData: features => frames.push(features),
    map: {
        getSource: () => ({}),
        getLayer: id => layers.get(id),
        addLayer: layer => layers.set(layer.id, layer),
        moveLayer: id => moves.push(id),
        on() {}
    }
});
vm.runInContext([
    section('function ensureLiveBusLayers()', 'function getFeatureSignaturePart'),
    section('function easeInOutCubic(', 'function buildLiveBusFeature('),
    section('function buildLiveBusFeature(', 'function easeOutCubic('),
    section('export function renderLiveBuses(', 'export function registerLiveBusLine(').replace('export ', '')
].join('\n'), context);
vm.runInContext(`
    ensureLiveBusLayers();
    ensureLiveBusLayers();
    liveBusCurrentFeatures.set('bus', {geometry:{coordinates:[0,0]},properties:{id:'bus',heading:350}});
    renderLiveBuses([{geometry:{coordinates:[1,1]},properties:{id:'bus',heading:10,color:'#0088ff'}}]);
`, context);
assert.equal(moves.length, 4, 'Existing layers must not be reordered on animation frames');
for (let frame = 0; frame <= 72; frame++) {
    now = frame * 1000 / 60;
    const next = callback;
    callback = null;
    assert.ok(next);
    next(now);
}
assert.equal(frames.length, 73, 'Every display frame must update the position');
assert.equal(callback, null, 'Animation must stop at its destination');
assert.equal(frames[0][0].geometry.coordinates[0], 0);
assert.equal(frames.at(-1)[0].geometry.coordinates[0], 1);
for (let i = 1; i < frames.length; i++) {
    const delta = frames[i][0].geometry.coordinates[0] - frames[i - 1][0].geometry.coordinates[0];
    assert.ok(delta > 0 && delta < 0.05, 'Movement must advance in small, monotonic steps');
}
assert.ok(Math.abs(frames[36][0].properties.heading) < 0.001, 'Heading must cross north along the short arc');
vm.runInContext(`renderLiveBuses([{geometry:{coordinates:[2,2]},properties:{id:'bus',heading:30,color:'#0088ff'}}]);`, context);
now += 600;
callback(now);
const interruptedPosition = frames.at(-1)[0].geometry.coordinates[0];
vm.runInContext(`renderLiveBuses([{geometry:{coordinates:[3,3]},properties:{id:'bus',heading:40,color:'#0088ff'}}]);`, context);
callback(now);
assert.equal(frames.at(-1)[0].geometry.coordinates[0], interruptedPosition, 'New updates must continue from the displayed position');
vm.runInContext('renderLiveBuses([]);', context);
assert.equal(callback, null);
assert.equal(frames.at(-1).length, 0);
console.log('Live bus animation: smooth frame cadence, layer ordering, heading, retargeting, and clearing passed.');
