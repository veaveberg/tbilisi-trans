// Coverage of a moving bitmap column on the fixed LED grid.
export function columnCoverage(x) {
    const left = Math.floor(x);
    const fraction = x - left;
    return [[left, 1 - fraction], [left + 1, fraction]];
}

export function retention(deltaSeconds, halfLifeMs) {
    return halfLifeMs <= 0 ? 0 : Math.pow(0.5, deltaSeconds * 1000 / halfLifeMs);
}
