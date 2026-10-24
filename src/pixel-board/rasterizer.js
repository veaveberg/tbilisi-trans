import {
    WIDTH, DEFAULT_HEIGHT, DEFAULTS, SCHEME_COLORS, rgb, normalizeLabel,
    glyphFor, textWidth, layoutBoard, nameScrollOffset, numberSwapOffsets,
} from './layout.js';

const clocks = [false,true].map(seconds=>new Intl.DateTimeFormat('en-GB', {
    timeZone:'Asia/Tbilisi',hour:'2-digit',minute:'2-digit',...(seconds?{second:'2-digit'}:{}),hour12:false,
}));
const minutesText = minutes=>minutes===null?'--':String(Math.max(0,Math.round(minutes))).padStart(2,'0');

// Converts board state into LED brightness and tint, without DOM or font APIs.
export class BoardRasterizer {
    constructor(fonts) {
        this.fonts=fonts;
        this.elapsed=0;
        this.nameStarted=0;
        this.tickerStarted=0;
        this.numbers=new Map();
        this.state={arrivals:[],stopId:'',source:'',temperature:22,language:'en',statusMode:'temp',scheme:'orange',loading:true,fillHeight:false};
        this.resize(DEFAULT_HEIGHT);
    }

    resize(height) {
        this.width=WIDTH;
        this.height=height;
        this.lit=new Uint8Array(WIDTH*height);
        this.pixels=new Uint8Array(WIDTH*height*4);
        this.colors=new Uint8Array(WIDTH*height*4);
    }

    setState(next) {
        const old=this.state;
        const changedStop=next.stopId!==undefined && next.stopId!==old.stopId;
        const changedNames=next.language!==undefined && next.language!==old.language;
        const oldRows=old.arrivals.map(row=>`${row.routeId||row.routeNumber}/${row.directionIndex}/${row.destinationEn}/${row.destinationKa}`).join('|');
        const rows=next.arrivals || old.arrivals;
        const newRows=rows.map(row=>`${row.routeId||row.routeNumber}/${row.directionIndex}/${row.destinationEn}/${row.destinationKa}`).join('|');
        if(changedStop || changedNames || oldRows!==newRows) {
            this.nameStarted=this.elapsed;
            this.tickerStarted=this.elapsed;
        }
        if(changedStop) this.numbers.clear();
        this.state={...old,...next};
        return changedStop;
    }

    measure(value,style='numeric') { return textWidth(this.fonts,value,style); }

    drawText(value,x,y,clip=this.clip,style='numeric',tint=this.baseColor) {
        // Position controls when an LED switches, never its target brightness.
        // WebGL/CanvasDisplay alone own the time-based fade between 0 and 1.
        x=Math.round(x);
        y=Math.round(y);
        for(const char of value) {
            const glyph=glyphFor(this.fonts,char,style);
            // Most ticker glyphs are off-screen. Skip their pixel work entirely.
            if(x+glyph.x+glyph.width<clip.left-1 || x+glyph.x>clip.right) {
                x+=glyph.advance;
                continue;
            }
            for(let row=0;row<glyph.rows.length;row++) {
                for(let col=0;col<glyph.width;col++) {
                    if(!(glyph.rows[row] & (1<<(glyph.width-1-col)))) continue;
                    const px=x+glyph.x+col,py=y+glyph.y+row;
                    if(px<clip.left || px>=clip.right || py<clip.top || py>=clip.bottom || px<0 || px>=WIDTH || py<0 || py>=this.height)continue;
                    const index=py*WIDTH+px;
                    this.lit[index]=1;
                    this.colors.set(tint,index*4);
                }
            }
            x+=glyph.advance;
        }
    }

    drawNumber(key,value,x,y,clip,tint=this.baseColor) {
        let state=this.numbers.get(key);
        if(!state){state={value,old:value,at:-Infinity};this.numbers.set(key,state);}
        if(state.value!==value){state.old=state.value;state.value=value;state.at=this.elapsed;}
        this.seenNumbers.add(key);
        const offsets=this.reducedMotion?null:numberSwapOffsets(this.elapsed-state.at);
        if(offsets) {
            this.drawText(state.old,x,y+offsets.oldY,clip,'numeric',tint);
            this.drawText(value,x,y+offsets.newY,clip,'numeric',tint);
        } else this.drawText(value,x,y,clip,'numeric',tint);
    }

    label(row) {
        return normalizeLabel((this.state.language==='ka'?row.destinationKa:row.destinationEn)||row.destination||'');
    }

    drawTime(time,x,y,period=2,tint=this.baseColor) {
        time.split(':').forEach((part,index,parts)=>{
            this.drawText(part,x,y,this.clip,'numeric',tint);
            x+=this.measure(part);
            if(index<parts.length-1) {
                if(this.reducedMotion || this.elapsed%period<period/2)this.drawText(':',x,y,this.clip,'numeric',tint);
                x+=this.measure(':');
            }
        });
    }

    render(elapsed,now=new Date(),reducedMotion=false) {
        this.elapsed=elapsed;
        this.reducedMotion=reducedMotion;
        this.lit.fill(0);
        this.baseColor=rgb(SCHEME_COLORS[this.state.scheme]);
        this.clip={left:0,right:WIDTH,top:0,bottom:this.height};
        this.seenNumbers=new Set();
        for(let i=0;i<this.colors.length;i+=4){this.colors.set(this.baseColor,i);this.colors[i+3]=255;}
        const {main,overflow,tickerY,footerY}=layoutBoard(this.state.arrivals,this.height,this.state.fillHeight);
        const {loading,language,statusMode,stopId,source,temperature,scheme}=this.state;
        const statusTint=scheme==='wgy'?rgb(SCHEME_COLORS.yellow):this.baseColor;
        if(loading) {
            this.drawText('Loading...',0,Math.floor((this.height-7)/2));
        } else if(main.length===0) {
            const time=clocks[1].format(now);
            this.drawTime(time,Math.floor((WIDTH-this.measure(time))/2),Math.floor((this.height-7)/2),1);
            const temp=`${Math.round(temperature)}°C`;
            this.drawText(temp,WIDTH-this.measure(temp),footerY,this.clip,'numeric',statusTint);
        } else {
            main.forEach((row,index)=>{
                const y=index*9,clip={left:0,right:WIDTH,top:y,bottom:y+7};
                const key=`${row.routeId||row.routeNumber}/${row.directionIndex??0}/${index}`;
                this.drawNumber(`route-${key}`,row.routeNumber,0,y,{...clip,right:18});
                const name=this.label(row);
                const offset=this.reducedMotion?0:nameScrollOffset(this.measure(name,language),118,elapsed-this.nameStarted,DEFAULTS.speed);
                this.drawText(name,20-offset,y,{...clip,left:20,right:138},language);
                const minutes=minutesText(row.minutes);
                const urgent=row.minutes!==null && row.minutes<=1 && !row.isScheduled;
                this.seenNumbers.add(`minutes-${key}`);
                if(!urgent || reducedMotion || elapsed%.4<.2) {
                    const tint=scheme==='wgy' && urgent?rgb(SCHEME_COLORS.green):this.baseColor;
                    this.drawNumber(`minutes-${key}`,minutes,WIDTH-this.measure(minutes),y,{...clip,left:140},tint);
                }
            });
            if(overflow.length) {
                const segments=overflow.flatMap(row=>[
                    {text:row.routeNumber,style:'numeric',gap:5},
                    {text:this.label(row),style:language,gap:5},
                    {text:minutesText(row.minutes),style:'numeric',gap:row.minutes===null?5:0},
                    ...(row.minutes===null?[]:[{text:language==='ka'?'ᲬᲗ':'min',style:language,gap:5}]),
                    {text:'*',style:'ka',gap:5},
                ]);
                const length=segments.reduce((n,part)=>n+this.measure(part.text,part.style)+part.gap,0);
                const offset=reducedMotion?0:((elapsed-this.tickerStarted)*Math.min(30,length/12))%length;
                const clip={left:0,right:WIDTH,top:tickerY,bottom:tickerY+7};
                for(const start of [-offset,length-offset]) {
                    let x=start;
                    for(const part of segments){this.drawText(part.text,x,tickerY,clip,part.style);x+=this.measure(part.text,part.style)+part.gap;}
                }
            }
            this.drawText(`ID:${stopId}${source==='tbilisi'?' SMS:93344':''}`,0,footerY);
            if(statusMode==='temp') {
                const temp=`${Math.round(temperature)}°C`;
                this.drawNumber('temperature',temp,WIDTH-this.measure(temp),footerY,{...this.clip,top:footerY},statusTint);
            } else {
                const time=clocks[0].format(now);
                this.drawTime(time,WIDTH-this.measure(time),footerY,2,statusTint);
            }
        }
        for(const key of this.numbers.keys())if(!this.seenNumbers.has(key))this.numbers.delete(key);
        for(let i=0;i<this.lit.length;i++) {
            const value=this.lit[i]*255;
            this.pixels.fill(value,i*4,i*4+4);
        }
        return {pixels:this.pixels,colors:this.colors};
    }

    accessibleText() {
        if(this.state.loading)return 'Loading arrivals';
        if(!this.state.arrivals.length)return 'No arrivals. Tbilisi clock.';
        return `Stop ${this.state.stopId}. `+this.state.arrivals.map(row=>`${row.routeNumber}, ${this.label(row)}, ${row.minutes??'unknown'} minutes`).join('. ');
    }
}
