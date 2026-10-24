import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {BoardRasterizer} from '../src/pixel-board/rasterizer.js';
import {nameScrollOffset,DEFAULTS} from '../src/pixel-board/layout.js';
import {retention} from '../src/pixel-board/motion.js';

const fonts=JSON.parse(readFileSync(new URL('../src/assets/fonts/board-pixels.json',import.meta.url)));
const now=new Date('2026-10-24T08:00:00Z');
const curves=[];
for(const characters of [20,40]) {
    const board=new BoardRasterizer(fonts);
    const name='A'.repeat(characters);
    board.setState({loading:false,language:'en',arrivals:[{
        routeNumber:'301',routeId:'301',destinationEn:name,destinationKa:name,
        minutes:8,isScheduled:false,
    }]});
    const width=board.measure(name,'en');
    const speed=Math.min(DEFAULTS.speed,(width-118)/2.4);
    const transition=2+0.5/speed;
    assert.ok(Math.abs(nameScrollOffset(width,118,transition,DEFAULTS.speed)-.5)<1e-10);
    const before=board.render(transition-1e-6,now).pixels.slice();
    const after=board.render(transition+1e-6,now).pixels.slice();
    assert.ok(before.every(value=>value===0||value===255),'scroll targets must be fully on/off, including slow overflow');
    assert.ok(after.every(value=>value===0||value===255),'fractional positions must not dim the target');
    const rising=after.findIndex((value,index)=>index%4===0 && value===255 && before[index]===0);
    const falling=after.findIndex((value,index)=>index%4===0 && value===0 && before[index]===255);
    assert.ok(rising>=0 && falling>=0,'moving text switches LEDs on and off');
    let on=0,off=1;
    const curve=[];
    for(let ms=1;ms<=25;ms++) {
        const pixels=board.render(transition+ms/1000,now).pixels;
        const keep=retention(.001,DEFAULTS.attack);
        on=pixels[rising]/255+(on-pixels[rising]/255)*keep;
        off=pixels[falling]/255+(off-pixels[falling]/255)*retention(.001,DEFAULTS.trail);
        if(ms===5||ms===15||ms===25)curve.push([on,off]);
    }
    curves.push(curve);
}
assert.deepEqual(curves[0],curves[1],'fade curves must match for 0.83 and 14 cells/s');
for(const [index,halfLives] of [1,3,5].entries()) {
    assert.ok(Math.abs(curves[0][index][0]-(1-2**-halfLives))<1e-12);
    assert.ok(Math.abs(curves[0][index][1]-2**-halfLives)<1e-12);
}
console.log('PASS: slightly overflowing and long names retain identical 5ms LED fade curves');
