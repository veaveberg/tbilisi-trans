const BATUMI_STOP_CODE_URL = /^b(\d{3,4})$/i;

export function getBatumiStopUrlId(stop) {
    if (!stop || stop._source !== 'batumi') return null;
    const code = String(stop.code || '').trim();
    return /^\d{3,4}$/.test(code) ? `b${code}` : null;
}

export function resolveBatumiStopUrlId(urlId, stops = []) {
    const match = String(urlId || '').replace(/^1:/, '').match(BATUMI_STOP_CODE_URL);
    if (!match) return null;

    const code = match[1];
    return stops.find(stop =>
        stop?._source === 'batumi' && String(stop.code || '').trim() === code
    )?.id || null;
}
