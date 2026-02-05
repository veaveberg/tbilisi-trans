const fs = require('fs');

const INPUT_FILE = 'public/data/long_segments.geojson';
const OUTPUT_FILE = 'public/data/long_segments_merged.geojson';

const data = JSON.parse(fs.readFileSync(INPUT_FILE, 'utf8'));

const geoGroups = new Map();

data.features.forEach(f => {
    // Round coordinates to ignore tiny float differences? 
    // Mapbox might return identical floats, but let's be safe: 5 decimal places.
    // Actually, simple JSON.stringify is risky if key order differs (not for arrays usually).
    // Let's normalize coords string.

    const coordsKey = f.geometry.coordinates.map(pt =>
        `${Number(pt[0]).toFixed(6)},${Number(pt[1]).toFixed(6)}`
    ).join(';');

    if (!geoGroups.has(coordsKey)) {
        geoGroups.set(coordsKey, []);
    }
    geoGroups.get(coordsKey).push(f);
});

console.log(`Checking ${data.features.length} features -> ${geoGroups.size} unique paths.`);

const mergedFeatures = [];

for (const [key, features] of geoGroups) {
    const baseFeature = features[0]; // Use geometry of first

    const routes = features.map(f => ({
        routeNumber: f.properties.routeNumber,
        routeId: f.properties.routeId,
        from: f.properties.from, // might differ if stops strictly differ?
        to: f.properties.to
    }));

    // Deduplicate routes list based on routeNumber
    const uniqueRoutes = [];
    const seenRoutes = new Set();
    routes.forEach(r => {
        if (!seenRoutes.has(r.routeNumber)) {
            seenRoutes.add(r.routeNumber);
            uniqueRoutes.push(r);
        }
    });

    const routeNumbers = uniqueRoutes.map(r => r.routeNumber).join(', ');

    const newProps = {
        ...baseFeature.properties,
        routeNumber: routeNumbers, // "402, 503"
        routeRoutes: uniqueRoutes, // Full array for detail
        mergedCount: features.length
    };

    mergedFeatures.push({
        type: 'Feature',
        geometry: baseFeature.geometry,
        properties: newProps
    });
}

const outGeoJSON = {
    type: 'FeatureCollection',
    features: mergedFeatures
};

fs.writeFileSync(OUTPUT_FILE, JSON.stringify(outGeoJSON, null, 2));
console.log(`Saved ${mergedFeatures.length} merged features.`);
