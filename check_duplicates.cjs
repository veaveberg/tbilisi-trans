const fs = require('fs');

const data = JSON.parse(fs.readFileSync('public/data/long_segments.geojson', 'utf8'));

const geoMap = new Map();

data.features.forEach(f => {
    const key = JSON.stringify(f.geometry.coordinates);
    if (!geoMap.has(key)) {
        geoMap.set(key, 0);
    }
    geoMap.set(key, geoMap.get(key) + 1);
});

console.log(`Total features: ${data.features.length}`);
console.log(`Unique geometries: ${geoMap.size}`);

let duplicates = 0;
geoMap.forEach(v => {
    if (v > 1) duplicates += (v - 1);
});
console.log(`Redundant duplicates: ${duplicates}`);
