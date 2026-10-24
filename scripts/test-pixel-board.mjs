import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {BoardRasterizer} from '../src/pixel-board/rasterizer.js';
import {DEFAULTS,SCHEME_COLORS,normalizeLabel,layoutBoard,boardDimensions} from '../src/pixel-board/layout.js';
import {retention} from '../src/pixel-board/motion.js';

const fonts=JSON.parse(readFileSync(new URL('../src/assets/fonts/board-pixels.json',import.meta.url)));
for(const face of Object.values(fonts)) {
    const source=readFileSync(new URL(`../${face.source}`,import.meta.url));
    assert.equal(createHash('sha256').update(source).digest('hex'),face.sha256);
}
const arrivals=Array.from({length:9},(_,i)=>({
    routeId:`route-${i}`,routeNumber:String(301+i),directionIndex:0,
    destinationEn:'Liberty Square',destinationKa:'თავისუფლების მოედანი',minutes:i+2,isScheduled:false,
}));
const clock=new Date('2026-10-24T08:00:00Z');
const board=new BoardRasterizer(fonts);
const lit=(frame,left,top,right,bottom)=>{
    let count=0;
    for(let y=top;y<bottom;y++)for(let x=left;x<right;x++)count+=frame[(y*152+x)*4]>0;
    return count;
};
board.setState({loading:false,stopId:'810',source:'tbilisi',arrivals,language:'ka'});
assert.ok(board.accessibleText().includes(normalizeLabel('თავისუფლების მოედანი')));
let bitmap=board.render(0,clock,true);
assert.ok(lit(bitmap.pixels,0,0,152,7)>0);
assert.ok(lit(bitmap.pixels,0,56,152,63)>0,'overflow ticker');
for(let i=0;i<6;i++)assert.ok(lit(bitmap.pixels,20,i*9,138,i*9+7)>0);
board.setState({arrivals:arrivals.slice(0,7)});
bitmap=board.render(0,clock,true);
assert.ok(lit(bitmap.pixels,0,54,18,61)>0,'seventh static route');
assert.equal(lit(bitmap.pixels,0,63,152,65),0,'gap before footer');
board.setState({arrivals:arrivals.slice(0,6),language:'en'});
const before=board.render(1,clock,true).pixels.slice();
board.setState({arrivals:arrivals.slice(0,6).map(row=>({...row,minutes:row.minutes-1}))});
const after=board.render(1,clock,true).pixels.slice();
assert.notDeepEqual(after,before,'actual minute changes reach pixels');
for(let y=0;y<54;y++)for(let x=0;x<138;x++)assert.equal(after[(y*152+x)*4],before[(y*152+x)*4],'minute update preserves names and routes');
board.setState({scheme:'wgy'});
bitmap=board.render(1,clock,true);
let green=0,yellow=0;
for(let i=0;i<bitmap.colors.length;i+=4) {
    if(!bitmap.pixels[i])continue;
    const color=Array.from(bitmap.colors.slice(i,i+3));
    if(color.join(',')==='125,255,133')green++;
    if(color.join(',')==='255,229,125')yellow++;
}
assert.ok(green>0,'urgent minutes receive green tint');
assert.ok(yellow>0,'status receives yellow tint');
board.setState({scheme:'blue',stopId:'b1152',source:'batumi',arrivals:[]});
assert.equal(board.numbers.size,0,'stop switch clears number history');
bitmap=board.render(2,clock,true);
assert.ok(lit(bitmap.pixels,40,28,112,42)>0,'empty clock');
assert.equal(lit(bitmap.pixels,0,65,100,72),0,'empty footer does not retain previous stop ID');
board.resize(108);board.setState({arrivals,fillHeight:true});
bitmap=board.render(3,clock,true);
assert.equal(bitmap.pixels.length,152*108*4);
assert.equal(layoutBoard(arrivals,108,true).main.length,9);
for(const scheme of Object.keys(SCHEME_COLORS)) {
    board.setState({scheme});bitmap=board.render(4,clock,true);
    assert.ok(bitmap.colors.every(Number.isFinite));
}
for(const rate of [30,60,120]) {
    let brightness=1;
    for(let i=0;i<rate;i++)brightness*=retention(1/rate,50);
    assert.ok(Math.abs(brightness-2**-20)<1e-12);
}
assert.deepEqual(DEFAULTS,{diameter:.9,glow:.15,attack:5,trail:5,speed:14,unlit:.08,color:'#ff6633'});
console.log('PASS: production bitmap fonts, live minute updates, 6/7/overflow layouts, WGY tints, stop switches, empty clock, fill height, palettes and fade timing');

for(const width of [320,375,713,1422,1920,2560]) {
    for(const dpr of [1,1.25,1.8,2,3]) {
        for(const fillHeight of [false,true]) {
            const size=boardDimensions({width,height:800,dpr,fillHeight});
            assert.equal(size.cssWidth,width,'no horizontal margins from integer scaling');
            assert.equal(size.pixelWidth,Math.round(width*dpr));
            assert.ok(Math.abs(size.pixelHeight/size.logicalHeight-size.pitch)<=.5/size.logicalHeight);
            assert.ok(size.cssHeight<=800+1/dpr);
        }
    }
}
assert.ok(boardDimensions({width:2560,height:800,dpr:2,fillHeight:false}).logicalHeight<72);
console.log('PASS: full-width sizing across window widths, device pixel ratios and fit modes');
