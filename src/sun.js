export function getSunPosition(date, lat, lng) {
    const PI = Math.PI;
    const rad = PI / 180;
    const deg = 180 / PI;

    function toJulian(date) { return date.valueOf() / 86400000 - 0.5 + 2440588; }
    function toDays(date) { return toJulian(date) - 2451545; }

    const d = toDays(date);
    const lw = rad * -lng;
    const phi = rad * lat;

    const M = rad * (357.5291 + 0.98560028 * d);
    const C = rad * (1.9148 * Math.sin(M) + 0.0200 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
    const L = rad * (280.4665 + 0.98564736 * d) + C;
    const epsilon = rad * 23.4397;

    const sinDec = Math.sin(epsilon) * Math.sin(L);
    const cosDec = Math.sqrt(1 - sinDec * sinDec);
    const dec = Math.asin(sinDec);

    const RA = Math.atan2(Math.cos(epsilon) * Math.sin(L), Math.cos(L));
    const H = rad * (280.46061837 + 360.98564736629 * d) - lw - RA;

    const sinAlt = Math.sin(phi) * sinDec + Math.cos(phi) * cosDec * Math.cos(H);
    const altitude = Math.asin(sinAlt);

    const cosAz = (Math.sin(dec) - Math.sin(phi) * sinAlt) / (Math.cos(phi) * Math.cos(altitude));
    const azimuth = Math.atan2(Math.sin(H), cosAz);

    return {
        altitude: altitude * deg,
        azimuth: azimuth * deg
    };
}

export function getLightPreset(date, lat, lng) {
    const { altitude } = getSunPosition(date, lat, lng);

    if (altitude < -6) return 'night';
    if (altitude < 6) return 'dusk'; // or dawn, Standard style treats them similarly or just uses 'dusk'/'dawn'
    return 'day';
}
