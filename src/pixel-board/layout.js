// Coordinates are LED cells, half the original board's CSS coordinates.
export const WIDTH = 152;
export const DEFAULT_HEIGHT = 72;
export const DEFAULTS = Object.freeze({
    diameter: 0.9, glow: 0.15, attack: 5, trail: 5,
    speed: 14, unlit: 0.08, color: '#ff6633',
});

export function normalizeLabel(value) {
    const cleaned = String(value).replace(/✈/g, '').trim();
    return /[\u10a0-\u10ff]/u.test(cleaned) ? cleaned.toLocaleUpperCase('ka-GE') : cleaned;
}

export function glyphFor(fonts, char, style='numeric') {
    // Match formatLedLabelMarkup: Latin runs use 5x7 Matrix in Georgian labels.
    const face = char==='°' || (style === 'ka' && !/[A-Za-z]/.test(char)) ? 'matrix' : 'numeric';
    return fonts[face].glyphs[char] || fonts.matrix.glyphs[char] || fonts.numeric.glyphs['?'];
}

export function textWidth(fonts, value, style='numeric') {
    return [...value].reduce((total, char) => total + glyphFor(fonts,char,style).advance, 0);
}

export function layoutBoard(arrivals, height=DEFAULT_HEIGHT, fill=false) {
    const rows = arrivals.filter(row => row.minutes === null || row.minutes <= 90);
    const capacity = fill ? Math.max(1, Math.floor((height-18)/9)) : 6;
    // Exactly one extra arrival gets its own row instead of a ticker.
    const hideTicker = rows.length === capacity+1;
    const main = rows.slice(0, capacity+(hideTicker?1:0));
    return {
        main, overflow: hideTicker ? [] : rows.slice(capacity),
        tickerY: fill ? main.length*9 : 56,
        footerY: height-7,
    };
}

export function nameScrollOffset(width, viewport, elapsed, speed) {
    const overflow = Math.max(0,width-viewport);
    if (!overflow || speed<=0) return 0;
    // Original pauses for 2s at each end, then resets to the start.
    const duration = Math.max(2.4,overflow/speed);
    const phase = elapsed % (4+duration);
    return Math.min(overflow,Math.max(0,phase-2)/duration*overflow);
}

export function numberSwapOffsets(elapsed) {
    if (elapsed>=0.32) return null;
    // Same eight steps as the source's 320ms number-swap animation.
    const step = Math.max(0,Math.floor(elapsed/0.04));
    return {oldY:-step,newY:8-step};
}

export const SCHEME_COLORS = Object.freeze({
    orange: '#ff6633', yellow: '#ffe57d', red: '#ff6c57', green: '#7dff85',
    blue: '#78cfff', cyan: '#75fff8', magenta: '#ff86ef', white: '#f0f0ea', wgy: '#f0f0ea',
});

export function rgb(hex) {
    return [1,3,5].map(offset=>parseInt(hex.slice(offset,offset+2),16));
}

// Use the entire safe-area width. Render at device resolution rather than
// stretching a smaller bitmap whose width is an integer multiple of 152.
export function boardDimensions({width,height,dpr,fillHeight}) {
    const pixelWidth=Math.max(1,Math.round(width*dpr));
    const pitch=pixelWidth/WIDTH;
    const availableRows=Math.max(27,Math.floor(height*dpr/pitch));
    const logicalHeight=fillHeight?availableRows:Math.min(DEFAULT_HEIGHT,availableRows);
    const pixelHeight=Math.round(logicalHeight*pitch);
    return {logicalHeight,pixelWidth,pixelHeight,pitch,cssWidth:width,cssHeight:pixelHeight/dpr};
}
