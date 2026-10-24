import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {
 DEFAULTS, DEMO_ARRIVALS, layoutBoard, normalizeLabel, glyphFor,
 textWidth, nameScrollOffset, numberSwapOffsets,
} from './board-content.js';
const fonts=JSON.parse(readFileSync(new URL('./assets/original-board-fonts.json',import.meta.url)));
for(const face of Object.values(fonts)) {
 const source=readFileSync(new URL(`../../${face.source}`,import.meta.url));
 assert.equal(createHash('sha256').update(source).digest('hex'),face.sha256);
 for(const glyph of Object.values(face.glyphs)) {
  assert.ok(Number.isInteger(glyph.advance));
  assert.ok(glyph.rows.every(row=>Number.isInteger(row)&&row>=0&&row<2**glyph.width));
 }
}
assert.equal(DEFAULTS.color,'#ff6633');
assert.equal(DEFAULTS.attack,5);assert.equal(DEFAULTS.trail,5);
assert.equal(DEFAULTS.glow,.15);assert.equal(DEFAULTS.unlit,.08);
for(const char of '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz') {
 const glyph=fonts.numeric.glyphs[char];assert.ok(glyph, char);
 assert.equal(glyph.advance,6);assert.ok(glyph.width<=5);
}
for(const row of DEMO_ARRIVALS) {
 for(const char of normalizeLabel(row.destinationKa))assert.ok(fonts.matrix.glyphs[char],char);
}
assert.equal(normalizeLabel(' თავისუფლების ✈ '),'ᲗᲐᲕᲘᲡᲣᲤᲚᲔᲑᲘᲡ');
assert.equal(normalizeLabel('Vake - Saburtalo'),'Vake - Saburtalo');
assert.equal(glyphFor(fonts,'A','ka'),fonts.numeric.glyphs.A);
assert.equal(glyphFor(fonts,'Ა','ka'),fonts.matrix.glyphs['Ა']);
assert.equal(textWidth(fonts,'387'),18);
assert.equal(textWidth(fonts,'07'),12);
assert.equal(glyphFor(fonts,'°'),fonts.matrix.glyphs['°']);
for(const count of [0,6,7,9]) {
 const layout=layoutBoard(DEMO_ARRIVALS.slice(0,count));
 assert.equal(layout.main.length,count===7?7:Math.min(6,count));
 assert.equal(layout.overflow.length,count===9?3:0);
 assert.equal(layout.footerY,65);assert.equal(layout.tickerY,56);
}
assert.equal(layoutBoard([...DEMO_ARRIVALS,{minutes:91}]).overflow.length,3);
const fill=layoutBoard(DEMO_ARRIVALS,108,true);
assert.equal(fill.main.length,9);assert.equal(fill.footerY,101);
assert.equal(nameScrollOffset(180,118,1,14),0);
assert.equal(nameScrollOffset(180,118,3,14),14);
assert.equal(nameScrollOffset(180,118,7,14),62);
assert.equal(nameScrollOffset(180,118,8.5,14),0);
assert.equal(nameScrollOffset(50,118,3,14),0);
assert.deepEqual(numberSwapOffsets(.16),{oldY:-4,newY:4});
assert.equal(numberSwapOffsets(.32),null);
console.log('PASS: source font fingerprints, Latin/Georgian coverage, layout capacity, name pauses, number transitions, defaults');
