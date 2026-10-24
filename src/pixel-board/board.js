import fonts from '../assets/fonts/board-pixels.json';
import {WIDTH,DEFAULT_HEIGHT,boardDimensions} from './layout.js';
import {BoardRasterizer} from './rasterizer.js';
import {WebGLDisplay} from './webgl.js';
import {CanvasDisplay} from './canvas-display.js';

export class PixelBoard {
    constructor(container) {
        this.container=container;
        this.rasterizer=new BoardRasterizer(fonts);
        this.height=DEFAULT_HEIGHT;
        this.pitch=1;
        this.elapsed=0;
        this.active=false;
        this.frame=0;
        this.lastFrame=0;
        this.motion=window.matchMedia('(prefers-reduced-motion: reduce)');
        this.createDisplay();
        this.motion.addEventListener('change',()=>{this.lastFrame=performance.now();this.requestFrame();});
    }

    createCanvas() {
        const canvas=document.createElement('canvas');
        canvas.className='street-screen-surface';
        canvas.setAttribute('role','img');
        return canvas;
    }

    createDisplay() {
        this.canvas=this.createCanvas();
        try {this.display=new WebGLDisplay(this.canvas);}
        catch {
            // A failed context cannot become a 2D context on the same canvas.
            this.canvas=this.createCanvas();
            this.display=new CanvasDisplay(this.canvas);
        }
        this.container.replaceChildren(this.canvas);
        this.display.resize(WIDTH,this.height);
        this.canvas.addEventListener('webglcontextlost',event=>{
            event.preventDefault();
            this.display.dispose();
            const previous=this.canvas;
            this.canvas=this.createCanvas();
            this.canvas.style.cssText=previous.style.cssText;
            this.canvas.width=previous.width;this.canvas.height=previous.height;
            this.display=new CanvasDisplay(this.canvas);
            this.display.resize(WIDTH,this.height);
            this.container.replaceChildren(this.canvas);
            this.canvas.setAttribute('aria-label',this.rasterizer.accessibleText());
            this.requestFrame();
        });
    }

    setState(state) {
        if(this.rasterizer.setState(state))this.display.reset=true;
        this.canvas.setAttribute('aria-label',this.rasterizer.accessibleText());
        this.requestFrame();
    }

    resize(rect,fillHeight) {
        const dpr=window.devicePixelRatio||1;
        const dimensions=boardDimensions({...rect,dpr,fillHeight});
        const {logicalHeight:height,pitch,pixelWidth,pixelHeight}=dimensions;
        if(height!==this.height) {
            this.height=height;this.rasterizer.resize(height);this.display.resize(WIDTH,height);
        }
        this.pitch=pitch;
        if(this.canvas.width!==pixelWidth || this.canvas.height!==pixelHeight) {
            this.canvas.width=pixelWidth;this.canvas.height=pixelHeight;
            this.display.reset=true;
        }
        const {cssWidth:widthCSS,cssHeight:heightCSS}=dimensions;
        this.container.style.width=`${widthCSS}px`;this.container.style.height=`${heightCSS}px`;
        this.container.style.left='0px';
        this.container.style.top=`${(Math.round((rect.top+(rect.height-heightCSS)/2)*dpr)/dpr)-(rect.top+(rect.height-heightCSS)/2)}px`;
        this.canvas.style.width=`${widthCSS}px`;this.canvas.style.height=`${heightCSS}px`;
        this.rasterizer.setState({fillHeight:fillHeight || height<DEFAULT_HEIGHT});
        this.requestFrame();
    }

    start() {
        this.active=true;this.lastFrame=performance.now();
        this.display.reset=true;this.requestFrame();
    }

    stop() {
        this.active=false;cancelAnimationFrame(this.frame);this.frame=0;
    }

    requestFrame() {
        if(!this.active || document.hidden || this.frame)return;
        this.frame=requestAnimationFrame(now=>{
            this.frame=0;
            const delta=Math.max(0,(now-this.lastFrame)/1000);
            this.lastFrame=now;
            this.elapsed+=delta;
            const bitmap=this.rasterizer.render(this.elapsed,new Date(),this.motion.matches);
            this.display.draw(bitmap,delta,this.pitch,this.rasterizer.state.scheme,this.motion.matches);
            if(!this.motion.matches)this.requestFrame();
        });
    }
}
