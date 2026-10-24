import { DEFAULTS, rgb, SCHEME_COLORS } from './layout.js';
import { retention } from './motion.js';

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
varying vec2 uv; uniform sampler2D pixels, colors; uniform vec2 direction;
uniform float packedInput;
${unpack}
void main(){
 vec3 total=vec3(0.);
 for(int i=-4;i<=4;i++){
  vec2 position=uv+direction*float(i);
  float weight=exp(-float(i*i)/4.5);
  if(position.x>=0. && position.x<=1. && position.y>=0. && position.y<=1.) {
   vec4 sampleValue=texture2D(pixels,position);
   total+=mix(sampleValue.rgb,vec3(unpack(sampleValue))*texture2D(colors,position).rgb,packedInput)*weight;
  }
 }
 gl_FragColor=vec4(total/3.7515,1.);
}`;
const display = `precision highp float;
varying vec2 uv; uniform sampler2D pixels, halo, colors; uniform vec2 grid, frameSize; uniform vec3 color;
uniform float diameter, glow, unlit, square, pitch;
${unpack}
void main(){
 vec2 gridUv=vec2(uv.x,1.-uv.y);
 vec2 cell=floor(gridUv*grid);
 // Keep LED centers on physical pixel centers even at a fractional grid pitch.
 vec2 center=floor((cell+.5)*frameSize/grid)+.5;
 vec2 local=(gridUv*frameSize-center)/pitch;
 float distanceToCenter=mix(length(local),max(abs(local.x),abs(local.y)),square);
 float edge=.6/pitch;
 float mask=1.-smoothstep(diameter*.5-edge,diameter*.5+edge,distanceToCenter);
 float core=unpack(texture2D(pixels,(cell+.5)/grid));
 vec3 softLight=texture2D(halo,gridUv).rgb*glow*1.8;
 vec3 tint=texture2D(colors,(cell+.5)/grid).rgb;
 // Screen-composite broad bloom so bright cores retain their color.
 vec3 sharp=clamp(tint*mask*core+color*mask*unlit,0.,1.);
 vec3 light=1.-(1.-sharp)*exp(-softLight);
 gl_FragColor=vec4(light,1.);
}`;

// Owns GPU resources only. Layout and arrival state live in BoardRasterizer.
export class WebGLDisplay {
    constructor(canvas) {
        this.canvas=canvas;
        this.gl=canvas.getContext('webgl',{alpha:false,antialias:false,depth:false,stencil:false});
        if(!this.gl)throw new Error('WebGL is unavailable');
        const gl=this.gl;
        gl.disable(gl.DITHER);
        this.history=this.program(persistence);
        this.blur=this.program(bloom);
        this.display=this.program(display);
        this.quad=gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER,this.quad);
        gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]),gl.STATIC_DRAW);
        this.source=this.texture(gl.NEAREST);
        this.colors=this.texture(gl.NEAREST);
        this.previous=this.target(gl.NEAREST);
        this.next=this.target(gl.NEAREST);
        this.horizontal=this.target(gl.LINEAR);
        this.vertical=this.target(gl.LINEAR);
    }

    program(fragment) {
        const gl=this.gl;
        const program=gl.createProgram();
        for(const [type,source] of [[gl.VERTEX_SHADER,vertex],[gl.FRAGMENT_SHADER,fragment]]) {
            const shader=gl.createShader(type);
            gl.shaderSource(shader,source);gl.compileShader(shader);
            if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(shader));
            gl.attachShader(program,shader);gl.deleteShader(shader);
        }
        gl.linkProgram(program);
        if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(program));
        return {program,uniforms:new Map()};
    }

    texture(filter) {
        const gl=this.gl,texture=gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D,texture);
        for(const option of [gl.TEXTURE_MIN_FILTER,gl.TEXTURE_MAG_FILTER])gl.texParameteri(gl.TEXTURE_2D,option,filter);
        for(const option of [gl.TEXTURE_WRAP_S,gl.TEXTURE_WRAP_T])gl.texParameteri(gl.TEXTURE_2D,option,gl.CLAMP_TO_EDGE);
        return texture;
    }

    target(filter) {
        const gl=this.gl,texture=this.texture(filter),framebuffer=gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER,framebuffer);
        gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,texture,0);
        return {texture,framebuffer};
    }

    resize(width,height) {
        const gl=this.gl;
        this.width=width;this.height=height;
        for(const texture of [this.source,this.colors,this.previous.texture,this.next.texture,this.horizontal.texture,this.vertical.texture]) {
            gl.bindTexture(gl.TEXTURE_2D,texture);
            gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,width,height,0,gl.RGBA,gl.UNSIGNED_BYTE,null);
        }
        for(const target of [this.previous,this.next,this.horizontal,this.vertical]) {
            gl.bindFramebuffer(gl.FRAMEBUFFER,target.framebuffer);
            if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)throw new Error('Cannot allocate LED display buffer');
        }
        this.reset=true;
    }

    uniform(program,name) {
        if(!program.uniforms.has(name))program.uniforms.set(name,this.gl.getUniformLocation(program.program,name));
        return program.uniforms.get(name);
    }

    use(program) {
        const gl=this.gl;gl.useProgram(program.program);
        gl.bindBuffer(gl.ARRAY_BUFFER,this.quad);
        const attribute=gl.getAttribLocation(program.program,'position');
        gl.enableVertexAttribArray(attribute);gl.vertexAttribPointer(attribute,2,gl.FLOAT,false,0,0);
    }

    bind(program,name,texture,unit) {
        const gl=this.gl;
        gl.activeTexture(gl.TEXTURE0+unit);gl.bindTexture(gl.TEXTURE_2D,texture);
        gl.uniform1i(this.uniform(program,name),unit);
    }

    draw({pixels,colors},delta,pitch,scheme,reducedMotion) {
        const gl=this.gl;
        for(const [texture,data] of [[this.source,pixels],[this.colors,colors]]) {
            gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,texture);
            gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,this.width,this.height,gl.RGBA,gl.UNSIGNED_BYTE,data);
        }
        gl.viewport(0,0,this.width,this.height);
        gl.bindFramebuffer(gl.FRAMEBUFFER,this.next.framebuffer);
        this.use(this.history);
        this.bind(this.history,'currentFrame',this.source,0);
        this.bind(this.history,'oldFrame',this.previous.texture,1);
        gl.uniform1f(this.uniform(this.history,'attack'),this.reset||reducedMotion?0:retention(delta,DEFAULTS.attack));
        gl.uniform1f(this.uniform(this.history,'decay'),this.reset||reducedMotion?0:retention(delta,DEFAULTS.trail));
        gl.drawArrays(gl.TRIANGLES,0,6);
        [this.previous,this.next]=[this.next,this.previous];
        this.reset=false;
        this.use(this.blur);
        this.bind(this.blur,'colors',this.colors,1);
        for(const [target,input,x,y,packed] of [
            [this.horizontal,this.previous.texture,1/this.width,0,1],
            [this.vertical,this.horizontal.texture,0,1/this.height,0],
        ]) {
            gl.bindFramebuffer(gl.FRAMEBUFFER,target.framebuffer);
            this.bind(this.blur,'pixels',input,0);
            gl.uniform2f(this.uniform(this.blur,'direction'),x,y);
            gl.uniform1f(this.uniform(this.blur,'packedInput'),packed);
            gl.drawArrays(gl.TRIANGLES,0,6);
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER,null);
        gl.viewport(0,0,this.canvas.width,this.canvas.height);
        this.use(this.display);
        this.bind(this.display,'pixels',this.previous.texture,0);
        this.bind(this.display,'halo',this.vertical.texture,1);
        this.bind(this.display,'colors',this.colors,2);
        gl.uniform2f(this.uniform(this.display,'grid'),this.width,this.height);
        gl.uniform2f(this.uniform(this.display,'frameSize'),this.canvas.width,this.canvas.height);
        gl.uniform3f(this.uniform(this.display,'color'),...rgb(SCHEME_COLORS[scheme]).map(value=>value/255));
        for(const name of ['diameter','glow','unlit'])gl.uniform1f(this.uniform(this.display,name),DEFAULTS[name]);
        gl.uniform1f(this.uniform(this.display,'square'),0);
        gl.uniform1f(this.uniform(this.display,'pitch'),pitch);
        gl.drawArrays(gl.TRIANGLES,0,6);
    }

    dispose() {
        const gl=this.gl;
        for(const {texture,framebuffer} of [this.previous,this.next,this.horizontal,this.vertical]) {
            gl.deleteFramebuffer(framebuffer);gl.deleteTexture(texture);
        }
        gl.deleteTexture(this.source);gl.deleteTexture(this.colors);gl.deleteBuffer(this.quad);
        for(const item of [this.history,this.blur,this.display])gl.deleteProgram(item.program);
    }
}
