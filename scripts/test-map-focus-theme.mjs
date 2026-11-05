import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const readFunction = (file, start, end) => {
    const source = fs.readFileSync(new URL(file, import.meta.url), 'utf8');
    const first = source.indexOf(start);
    const last = source.indexOf(end, first);
    assert.ok(first >= 0 && last > first);
    return source.slice(first, last).replace('export ', '');
};
const paint = new Map();
const layers = new Map(['stops-layer', 'stops-layer-circle', 'stops-highlight'].map(id => [id, {}]));
const sources = new Map();
let dark = false;
const context = vm.createContext({
    console,
    window: { currentStopId: '1:4359' },
    document: { body: { classList: { contains: () => dark } } },
    map: {
        getStyle: () => ({}),
        getLayer: id => layers.get(id),
        getSource: id => sources.get(id),
        addSource: (id, source) => sources.set(id, source),
        addLayer: layer => layers.set(layer.id, layer),
        moveLayer() {},
        setPaintProperty: (id, prop, value) => paint.set(`${id}:${prop}`, value),
        setLayoutProperty() {}
    }
});
vm.runInContext(readFunction('../src/map-interactions.js', 'export function setMapFocus(', 'export function refreshMapFocusDimTheme('), context);
vm.runInContext(readFunction('../src/map-visuals.js', 'export function updateMapTheme()', 'const STOP_STACK_SOURCE_IDS'), context);
const opacityKeys = ['stops-layer:icon-opacity', 'stops-layer-circle:circle-opacity', 'stops-layer-circle:circle-stroke-opacity'];
for (const isDark of [false, true]) {
    dark = isDark;
    // Nested route startup: stop/route focus first, delayed theme initialization next.
    context.setMapFocus(true);
    const expected = opacityKeys.map(key => paint.get(key));
    context.updateMapTheme();
    opacityKeys.forEach((key, index) => assert.deepEqual(paint.get(key), expected[index], key));
    const expression = paint.get(opacityKeys[0]);
    assert.equal(expression[1][2], '1:4359');
    assert.equal(expression.at(-1), isDark ? 0.3 : 0.4);
    assert.equal(paint.get('stops-layer-circle:circle-stroke-width'), 1.5, 'Theme styling still runs');
    // Leaving the route must restore full opacity, also after another theme refresh.
    context.setMapFocus(false);
    context.updateMapTheme();
    opacityKeys.forEach(key => assert.equal(paint.get(key), 1, key));
}
// Filter mode also owns its dimming expressions.
for (const key of opacityKeys) paint.set(key, 0.12);
context.updateMapTheme();
opacityKeys.forEach(key => assert.equal(paint.get(key), 0.12, key));
console.log('Map focus survives delayed theme updates in light/dark modes; clearing focus and filter opacity also passed.');
