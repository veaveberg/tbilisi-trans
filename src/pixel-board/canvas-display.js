import {DEFAULTS,SCHEME_COLORS,rgb} from './layout.js';
import {retention} from './motion.js';

// Same bitmap grid and timing when a browser cannot create/retain WebGL.
export class CanvasDisplay {
    constructor(canvas) {
        this.canvas=canvas;
        this.context=canvas.getContext('2d',{alpha:false});
        this.sprites=new Map();
    }

    resize(width,height) {
        this.width=width;this.height=height;
        this.brightness=new Float32Array(width*height);
        this.reset=true;
        this.background=null;
        this.sprites.clear();
    }

    sprite(color,pitch,glow) {
        const key=`${color}/${pitch}/${glow}`;
        if(this.sprites.has(key))return this.sprites.get(key);
        const canvas=document.createElement('canvas');canvas.width=canvas.height=Math.ceil(pitch*5);
        const ctx=canvas.getContext('2d');
        ctx.fillStyle=`rgb(${color})`;
        if(glow){ctx.shadowColor=`rgba(${color},${DEFAULTS.glow})`;ctx.shadowBlur=pitch*1.8;}
        ctx.beginPath();ctx.arc(canvas.width/2,canvas.height/2,pitch*DEFAULTS.diameter/2,0,Math.PI*2);ctx.fill();
        this.sprites.set(key,canvas);
        return canvas;
    }

    draw({pixels,colors},delta,pitch,scheme,reducedMotion) {
        const ctx=this.context,base=rgb(SCHEME_COLORS[scheme]);
        const key=`${scheme}/${pitch}/${this.canvas.width}/${this.canvas.height}`;
        if(this.backgroundKey!==key || !this.background) {
            this.sprites.clear();
            this.background=document.createElement('canvas');
            this.background.width=this.canvas.width;this.background.height=this.canvas.height;
            const bg=this.background.getContext('2d');bg.fillStyle='#000';bg.fillRect(0,0,this.canvas.width,this.canvas.height);
            bg.globalAlpha=DEFAULTS.unlit;
            const sprite=this.sprite(base.join(','),pitch,false);
            for(let y=0;y<this.height;y++)for(let x=0;x<this.width;x++)bg.drawImage(sprite,Math.floor((x+.5)*this.canvas.width/this.width)+.5-sprite.width/2,Math.floor((y+.5)*this.canvas.height/this.height)+.5-sprite.height/2);
            this.backgroundKey=key;
        }
        ctx.globalAlpha=1;ctx.drawImage(this.background,0,0);
        const attack=this.reset||reducedMotion?0:retention(delta,DEFAULTS.attack);
        const decay=this.reset||reducedMotion?0:retention(delta,DEFAULTS.trail);
        for(let i=0;i<this.brightness.length;i++) {
            const fresh=pixels[i*4]/255,old=this.brightness[i];
            const value=fresh+(old-fresh)*(fresh>old?attack:decay);
            this.brightness[i]=value;
            if(value<.001)continue;
            ctx.globalAlpha=value;
            const color=Array.from(colors.subarray(i*4,i*4+3)).join(',');
            const sprite=this.sprite(color,pitch,true);
            ctx.drawImage(sprite,Math.floor((i%this.width+.5)*this.canvas.width/this.width)+.5-sprite.width/2,Math.floor((Math.floor(i/this.width)+.5)*this.canvas.height/this.height)+.5-sprite.height/2);
        }
        ctx.globalAlpha=1;this.reset=false;
    }

    dispose(){this.sprites.clear();this.background=null;}
}
