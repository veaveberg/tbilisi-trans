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

export const DEMO_ARRIVALS = [
    ['387','Vake - Saburtalo via University','ვაკე - საბურთალო',2],
    ['311','Station Square','სადგურის მოედანი',7],
    ['541','Vake Park','ვაკის პარკი',7],
    ['305','State University','სახელმწიფო უნივერსიტეტი',9],
    ['331','Tsereteli Avenue','წერეთლის გამზირი',14],
    ['388','Didube Bus Station','დიდუბის სადგური',15],
    ['309','Rustaveli Avenue','რუსთაველის გამზირი',19],
    ['301','Liberty Square','თავისუფლების მოედანი',22],
    ['337','Airport','აეროპორტი',25],
].map(([routeNumber,destinationEn,destinationKa,minutes])=>({
    routeNumber,destinationEn,destinationKa,minutes,isScheduled:false,
}));
