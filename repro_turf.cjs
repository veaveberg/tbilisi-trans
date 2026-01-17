
const turf = require('@turf/turf');

try {
    const start = [44.815908, 41.792064];
    const cp1 = [44.815908, 41.793];
    const cp2 = [44.815908, 41.794];
    const end = [44.815908, 41.795];

    const input = {
        type: 'Feature',
        geometry: {
            type: 'LineString',
            coordinates: [start, cp1, cp2, end]
        }
    };

    console.log('Testing bezierSpline with Feature input...');
    const res = turf.bezierSpline(input);
    console.log('Success!', res);

} catch (e) {
    console.error('Error:', e);
}
