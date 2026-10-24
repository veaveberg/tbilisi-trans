import { columnCoverage, retention } from './led-motion.js';
import {
 WIDTH as W, DEFAULT_HEIGHT, DEFAULTS, DEMO_ARRIVALS,
 normalizeLabel, glyphFor, textWidth, layoutBoard, nameScrollOffset, numberSwapOffsets,
} from './board-content.js';
let H = DEFAULT_HEIGHT;
for (const [name,value] of Object.entries(DEFAULTS)) {
 document.getElementById(name).value = value;
}
const $ = id => document.getElementById(id);
const canvas = $('board');
const vertex = `attribute vec2 position; varying vec2 uv; void main(){ uv=position*.5+.5; gl_Position=vec4(position,0.,1.); }`;
// Evolved from Three.js r180 AfterimageShader (MIT; assets/THREE-LICENSE.txt).
// Smooth both attack and release. Pack history into 16 bits to prevent dim LEDs
// getting stuck at an 8-bit rounding floor during slow decay/high refresh rates.
const unpack = `float unpack(vec4 value) { return dot(value.rg,vec2(256.,1.))/257.; }`;
const persistence = `precision highp float;
varying vec2 uv; uniform sampler2D currentFrame, oldFrame;
uniform float attack, decay;
${unpack}
void main(){
 float old=unpack(texture2D(oldFrame,uv));
 float fresh=texture2D(currentFrame,uv).r;
 float value=mix(fresh,old,fresh>old ? attack : decay);
 float encoded=floor(clamp(value,0.,1.)*65535.+.5);
 gl_FragColor=vec4(floor(encoded/256.)/255.,mod(encoded,256.)/255.,0.,1.);
}`;
// Blur at LED resolution, independently of the aperture mask. Two small passes
// produce light between diodes without 25+ texture reads per screen pixel.
const bloom = `precision highp float;
varying vec2 uv; uniform sampler2D pixels; uniform vec2 direction;
uniform float packedInput;
${unpack}
void main(){
 float total=0.;
 for(int i=-4;i<=4;i++){
  vec2 position=uv+direction*float(i);
  float weight=exp(-float(i*i)/4.5);
  if(position.x>=0. && position.x<=1. && position.y>=0. && position.y<=1.) {
   vec4 sampleValue=texture2D(pixels,position);
   total+=mix(sampleValue.r,unpack(sampleValue),packedInput)*weight;
  }
 }
 gl_FragColor=vec4(vec3(total/3.7515),1.);
}`;
const display = `precision highp float;
varying vec2 uv; uniform sampler2D pixels, halo; uniform vec2 grid; uniform vec3 color;
uniform float diameter, glow, unlit, square, pitch;
${unpack}
void main(){
 vec2 gridUv=vec2(uv.x,1.-uv.y);
 vec2 p=gridUv*grid; vec2 cell=floor(p); vec2 local=fract(p)-.5;
 float distanceToCenter=mix(length(local),max(abs(local.x),abs(local.y)),square);
 float edge=.6/pitch;
 float mask=1.-smoothstep(diameter*.5-edge,diameter*.5+edge,distanceToCenter);
 float core=unpack(texture2D(pixels,(cell+.5)/grid));
 float softLight=texture2D(halo,gridUv).r*glow*1.8;
 // Screen-composite broad bloom so bright cores retain their color.
 vec3 sharp=color*clamp(mask*(core+unlit),0.,1.);
 vec3 light=1.-(1.-sharp)*exp(-color*softLight);
 gl_FragColor=vec4(light,1.);
}`;

async function start(){
 const response=await fetch('./assets/original-board-fonts.json');
 if(!response.ok)throw new Error('Unable to load bitmap font');
 const fonts=await response.json();
 const gl=canvas.getContext('webgl',{alpha:false,antialias:false,depth:false,stencil:false,preserveDrawingBuffer:true});
 if(!gl)throw new Error('This prototype requires WebGL.');
 gl.disable(gl.DITHER);
 function program(fragment){
  function shader(type,source){const s=gl.createShader(type);gl.shaderSource(s,source);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(s));return s;}
  const p=gl.createProgram(); const shaders=[shader(gl.VERTEX_SHADER,vertex),shader(gl.FRAGMENT_SHADER,fragment)];
  shaders.forEach(s=>gl.attachShader(p,s));gl.linkProgram(p);shaders.forEach(s=>gl.deleteShader(s));
  if(!gl.getProgramParameter(p,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(p));
  return {p,locations:new Map()};
 }
 const historyProgram=program(persistence), bloomProgram=program(bloom), displayProgram=program(display);
 const quad=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,quad);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]),gl.STATIC_DRAW);
 function use(program){gl.useProgram(program.p);const pos=gl.getAttribLocation(program.p,'position');gl.enableVertexAttribArray(pos);gl.vertexAttribPointer(pos,2,gl.FLOAT,false,0,0);}
 function uniform(program,name){if(!program.locations.has(name))program.locations.set(name,gl.getUniformLocation(program.p,name));return program.locations.get(name);}
 function texture(filter=gl.NEAREST){const t=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,t);for(const option of [gl.TEXTURE_MIN_FILTER,gl.TEXTURE_MAG_FILTER])gl.texParameteri(gl.TEXTURE_2D,option,filter);for(const option of [gl.TEXTURE_WRAP_S,gl.TEXTURE_WRAP_T])gl.texParameteri(gl.TEXTURE_2D,option,gl.CLAMP_TO_EDGE);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,W,H,0,gl.RGBA,gl.UNSIGNED_BYTE,null);return t;}
 function target(filter){const t=texture(filter),f=gl.createFramebuffer();gl.bindFramebuffer(gl.FRAMEBUFFER,f);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,t,0);if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)throw new Error('Cannot allocate LED history buffer');return {t,f};}
 const source=texture();let previous=target(),next=target();
 const bloomHorizontal=target(gl.LINEAR), bloomVertical=target(gl.LINEAR);
 let resetHistory=true;
 function bind(program,name,t,unit){gl.activeTexture(gl.TEXTURE0+unit);gl.bindTexture(gl.TEXTURE_2D,t);gl.uniform1i(uniform(program,name),unit);}
 function clearHistory(){resetHistory=true;for(const t of [previous,next]){gl.bindFramebuffer(gl.FRAMEBUFFER,t.f);gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);}}
 clearHistory();
 let data=new Uint8Array(W*H*4);
 let coverage=new Float32Array(W*H);
 let elapsed=0, languageEpoch=0, tickerTravel=0, last=performance.now();
 let paused=matchMedia('(prefers-reduced-motion: reduce)').matches, frame=0, pitch=1, custom='';
 let model={stopId:'810',source:'tbilisi',temperature:22,arrivals:DEMO_ARRIVALS.map(row=>({...row}))};
 let missing=new Set();
 const numberStates=new Map();
 let activeLanguage='ka', lastLanguage='ka', languageStarted=0;
 let frozenWallTime=new Date();

 function drawText(value,x,y,clip={left:0,right:W,top:0,bottom:H},style='numeric') {
  for (const char of value) {
   const glyph=glyphFor(fonts,char,style);
   if (!fonts.numeric.glyphs[char] && !fonts.matrix.glyphs[char]) missing.add(char);
   for (let row=0;row<glyph.rows.length;row++) {
    const py=y+glyph.y+row;
    for (let col=0;col<glyph.width;col++) {
     if (!(glyph.rows[row] & (1<<(glyph.width-1-col)))) continue;
     for (const [px,xAmount] of columnCoverage(x+glyph.x+col)) {
      for (const [dy,yAmount] of columnCoverage(py)) {
       if(px<clip.left || px>=clip.right || dy<clip.top || dy>=clip.bottom || px<0 || px>=W || dy<0 || dy>=H)continue;
       coverage[dy*W+px]+=xAmount*yAmount;
      }
     }
    }
   }
   x+=glyph.advance;
  }
 }
 function drawNumber(key,value,x,y,clip) {
  let state=numberStates.get(key);
  if (!state) {state={value,old:value,at:-Infinity};numberStates.set(key,state);}
  if (state.value!==value) {state.old=state.value;state.value=value;state.at=elapsed;}
  const offsets=paused?null:numberSwapOffsets(elapsed-state.at);
  if(offsets) {
   drawText(state.old,x,y+offsets.oldY,clip);
   drawText(value,x,y+offsets.newY,clip);
  } else drawText(value,x,y,clip);
 }
 function labelFor(row) {
  return normalizeLabel(activeLanguage==='ka' ? row.destinationKa : row.destinationEn);
 }
 function wallTime(seconds=false) {
  return new Intl.DateTimeFormat('en-GB',{
   timeZone:'Asia/Tbilisi',hour:'2-digit',minute:'2-digit',...(seconds?{second:'2-digit'}:{}),hour12:false,
  }).format(paused?frozenWallTime:new Date());
 }
 function statusTime(value,x,y,period=2) {
  const pieces=value.split(':');
  pieces.forEach((piece,i)=>{
   drawText(piece,x,y);
   x+=textWidth(fonts,piece);
   if(i<pieces.length-1){if(elapsed%period<period/2)drawText(':',x,y);x+=textWidth(fonts,':');}
  });
 }
 function drawGrid() {
  coverage.fill(0);missing=new Set();
  const selected=$('language').value;
  const phase=Math.floor((elapsed-languageEpoch)/10);
  activeLanguage=selected==='auto' ? (phase%2===0?'ka':'en') : selected;
  if(activeLanguage!==lastLanguage){languageStarted=elapsed;lastLanguage=activeLanguage;}
  const fill=$('fit').value==='fill';
  const {main,overflow,tickerY,footerY}=layoutBoard(model.arrivals,H,fill);
  if(main.length===0) {
   const time=wallTime(true);
   statusTime(time,Math.floor((W-textWidth(fonts,time))/2),Math.floor((H-7)/2),1);
   const temperature=`${Math.round(model.temperature)}°C`;
   drawText(temperature,W-textWidth(fonts,temperature),footerY);
  } else {
   main.forEach((row,index)=>{
    const y=index*9, clip={left:0,right:W,top:y,bottom:y+7};
    drawNumber(`route-${index}`,row.routeNumber,0,y,{...clip,right:18});
    const label=index===0&&custom?normalizeLabel(custom):labelFor(row);
    const width=textWidth(fonts,label,activeLanguage);
    const offset=nameScrollOffset(width,118,elapsed-languageStarted,Number($('speed').value));
    drawText(label,20-offset,y,{...clip,left:20,right:138},activeLanguage);
    const minutes=row.minutes===null?'--':String(Math.max(0,Math.round(row.minutes))).padStart(2,'0');
    const urgent=row.minutes!==null && row.minutes<=1 && !row.isScheduled;
    if(!urgent || elapsed%.4<.2)drawNumber(`minutes-${index}`,minutes,W-textWidth(fonts,minutes),y,{...clip,left:140});
   });
   if(overflow.length){
    const segments=overflow.flatMap(row=>[
     {text:row.routeNumber,style:'numeric',gap:5},
     {text:labelFor(row),style:activeLanguage,gap:5},
     {text:row.minutes===null?'--':String(row.minutes).padStart(2,'0'),style:'numeric',gap:row.minutes===null?5:0},
     ...(row.minutes===null?[]:[{text:activeLanguage==='ka'?'ᲬᲗ':'min',style:activeLanguage,gap:5}]),
     {text:'*',style:'ka',gap:5},
    ]);
    const length=segments.reduce((n,segment)=>n+textWidth(fonts,segment.text,segment.style)+segment.gap,0);
    const travel=length;const speed=Math.min(30,travel/12);
    // Control is relative to the approved 14px/s default; ticker retains source pacing.
    const offset=(tickerTravel*speed)%travel;
    for(const start of [-offset,travel-offset]){
     let x=start;
     for(const segment of segments){drawText(segment.text,x,tickerY,{left:0,right:W,top:tickerY,bottom:tickerY+7},segment.style);x+=textWidth(fonts,segment.text,segment.style)+segment.gap;}
    }
   }
   const id=`ID:${model.stopId}${model.source==='tbilisi'?' SMS:93344':''}`;
   drawText(id,0,footerY);
   if(phase%2===0){
    const temp=`${Math.round(model.temperature)}°C`;
    drawNumber('temperature',temp,W-textWidth(fonts,temp),footerY,{left:0,right:W,top:footerY,bottom:H});
   } else {
    const time=wallTime();statusTime(time,W-textWidth(fonts,time),footerY);
   }
  }
  $('fontWarning').textContent=missing.size?`Unsupported characters shown as ?: ${[...missing].join(' ')}`:'';
  canvas.setAttribute('aria-label',main.length ? `Stop ${model.stopId}. ${main.map(row=>`${row.routeNumber}, ${labelFor(row)}, ${row.minutes??'unknown'} minutes`).join('. ')}` : 'No arrivals. Tbilisi clock.');
  for(let i=0;i<coverage.length;i++){const value=Math.round(Math.min(1,coverage[i])*255);data.fill(value,i*4,i*4+4);}
  gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,source);
  gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,W,H,gl.RGBA,gl.UNSIGNED_BYTE,data);
 }
 function allocateGrid(height) {
  if(height===H)return;
  H=height;data=new Uint8Array(W*H*4);coverage=new Float32Array(W*H);
  for(const t of [source,previous.t,next.t,bloomHorizontal.t,bloomVertical.t]) {
   gl.bindTexture(gl.TEXTURE_2D,t);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,W,H,0,gl.RGBA,gl.UNSIGNED_BYTE,null);
  }
  clearHistory();
 }
 function resize() {
  const dpr=devicePixelRatio||1;
  pitch=Math.max(1,Math.floor(($('stage').clientWidth-16)*dpr/W));
  const fill=$('fit').value==='fill';
  const top=$('stage').getBoundingClientRect().top+window.scrollY;
  const available=Math.max(240,window.innerHeight-top-32);
  const height=fill?Math.max(27,Math.floor((available-48)*dpr/pitch)):DEFAULT_HEIGHT;
  allocateGrid(height);
  canvas.width=W*pitch;canvas.height=H*pitch;
  canvas.style.width=`${canvas.width/dpr}px`;canvas.style.height=`${canvas.height/dpr}px`;
  canvas.style.transform='';
  const rect=canvas.getBoundingClientRect();
  canvas.style.transform=`translate(${(Math.round(rect.left*dpr)-rect.left*dpr)/dpr}px,${(Math.round(rect.top*dpr)-rect.top*dpr)/dpr}px)`;
  $('status').textContent=`${W} × ${H} LEDs · original bitmap fonts`;
 }
 function paint(){gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.viewport(0,0,canvas.width,canvas.height);use(displayProgram);bind(displayProgram,'pixels',previous.t,0);bind(displayProgram,'halo',bloomVertical.t,1);gl.uniform2f(uniform(displayProgram,'grid'),W,H);
  const color=$('color').value;gl.uniform3f(uniform(displayProgram,'color'),... [1,3,5].map(i=>parseInt(color.slice(i,i+2),16)/255));
  for(const name of ['diameter','glow','unlit'])gl.uniform1f(uniform(displayProgram,name),Number($(name).value));
  gl.uniform1f(uniform(displayProgram,'square'),Number($('shape').value));gl.uniform1f(uniform(displayProgram,'pitch'),pitch);gl.drawArrays(gl.TRIANGLES,0,6);
 }
 function step(dt) {
  drawGrid();
  gl.bindFramebuffer(gl.FRAMEBUFFER,next.f);
  gl.viewport(0,0,W,H);
  use(historyProgram);
  bind(historyProgram,'currentFrame',source,0);
  bind(historyProgram,'oldFrame',previous.t,1);
  gl.uniform1f(uniform(historyProgram,'attack'),resetHistory?0:retention(dt,Number($('attack').value)));
  gl.uniform1f(uniform(historyProgram,'decay'),resetHistory?0:retention(dt,Number($('trail').value)));
  gl.drawArrays(gl.TRIANGLES,0,6);
  resetHistory=false;
  [previous,next]=[next,previous];
  use(bloomProgram);
  for (const [target,input,dx,dy,packed] of [
   [bloomHorizontal,previous.t,1/W,0,1],
   [bloomVertical,bloomHorizontal.t,0,1/H,0]
  ]) {
   gl.bindFramebuffer(gl.FRAMEBUFFER,target.f);
   bind(bloomProgram,'pixels',input,0);
   gl.uniform2f(uniform(bloomProgram,'direction'),dx,dy);
   gl.uniform1f(uniform(bloomProgram,'packedInput'),packed);
   gl.drawArrays(gl.TRIANGLES,0,6);
  }
  paint();
 }
 function loop(now) {
  frame=0;
  const dt=Math.max(0,(now-last)/1000);
  last=now;
  if(!paused){elapsed+=dt;tickerTravel+=dt*Number($('speed').value)/14;}
  step(paused?0:dt);
  if(!paused&&!document.hidden)frame=requestAnimationFrame(loop);
 }
 function request(){if(!frame&&!document.hidden){last=performance.now();frame=requestAnimationFrame(loop);}}
 function labels(){for(const name of ['diameter','glow','attack','trail','speed','unlit'])$(name+'Value').textContent=$(name).value+({attack:' ms',trail:' ms',speed:' px/s'}[name]||'');$('pause').textContent=paused?'Play':'Pause';}
 document.querySelectorAll('input,select').forEach(el=>el.addEventListener('input',()=>{labels();request();}));
 $('apply').addEventListener('click',()=>{custom=$('destination').value.normalize('NFC');languageStarted=elapsed;clearHistory();request();});
 $('pause').addEventListener('click',()=>{paused=!paused;frozenWallTime=new Date();labels();request();});
 const presets={clean:[0,0,0],soft:[.15,5,5],trails:[.15,5,5]};
 document.querySelectorAll('[data-preset]').forEach(button=>button.addEventListener('click',()=>{[$('glow').value,$('attack').value,$('trail').value]=presets[button.dataset.preset];clearHistory();labels();request();}));
 $('language').addEventListener('change',()=>{languageEpoch=elapsed;languageStarted=elapsed;clearHistory();request();});
 $('fit').addEventListener('change',()=>{resize();request();});
 $('scenario').addEventListener('change',()=>{
  model.arrivals=DEMO_ARRIVALS.slice(0,Number($('scenario').value)).map(row=>({...row}));
  numberStates.clear();languageStarted=elapsed;tickerTravel=0;clearHistory();request();
 });
 $('update-minutes').addEventListener('click',()=>{
  model.arrivals=model.arrivals.map(row=>({...row,minutes:row.minutes===null?null:Math.max(0,row.minutes-1)}));
  if(paused)clearHistory();
  request();
 });
 $('reset').addEventListener('click',()=>{
  for(const [name,value] of Object.entries(DEFAULTS))$(name).value=value;
  clearHistory();labels();request();
 });
 new ResizeObserver(()=>{resize();request();}).observe($('stage'));window.addEventListener('resize',()=>{resize();request();});
 document.addEventListener('visibilitychange',()=>{if(document.hidden){cancelAnimationFrame(frame);frame=0;}else{clearHistory();request();}});
 canvas.addEventListener('webglcontextlost',event=>{event.preventDefault();cancelAnimationFrame(frame);$('status').textContent='Graphics context lost. Reload to restart the prototype.';});
 resize();labels();request();
}
start().catch(error=>{$('status').textContent=error.message;$('status').classList.add('error');console.error(error);});
