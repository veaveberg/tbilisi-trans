const fs = require('fs');

const INPUT_FILE = 'public/data/long_segments_original.geojson';
const OUTPUT_FILE = 'public/data/long_segments_snapped.geojson';
const MAPBOX_TOKEN = 'pk.eyJ1IjoidHRjYXpyeSIsImEiOiJjam5sZWU2NHgxNmVnM3F0ZGN2N2lwaGF2In0.00TvUGr9Qu4Q4fc_Jb9wjw';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const data = JSON.parse(fs.readFileSync(INPUT_FILE, 'utf8'));

console.log(`Processing ${data.features.length} features (Mapbox Matching v9)...`);

let successCount = 0;

const processFeature = async (feature, index) => {
    // skip if done with v9
    if (feature.properties.snapped_v9) return;

    const originalPoints = feature.geometry.coordinates;

    // Mapbox Matching allows up to 100 coordinates.
    // We must chunk. But unlike OSRM Match, Mapbox might handle broken traces better?
    // Actually, if we chunk, we might get disconnected segments.
    // Ideally we want to pass the whole thing.
    // If > 100 points, we HAVE to chunk.
    // But we should overlap to ensure continuity.

    const CHUNK_SIZE = 90;
    const OVERLAP = 5;

    let chunks = [];
    if (originalPoints.length <= 100) {
        chunks.push(originalPoints);
    } else {
        for (let i = 0; i < originalPoints.length; i += (CHUNK_SIZE - OVERLAP)) {
            let slice = originalPoints.slice(i, i + CHUNK_SIZE);
            if (slice.length < 2) {
                if (i > 0) slice.unshift(originalPoints[i - 1]);
                else continue;
            }
            chunks.push(slice);
            if (i + CHUNK_SIZE >= originalPoints.length) break;
        }
    }

    let combinedCoordinates = [];
    let totalDistance = 0;

    for (const chunk of chunks) {
        const coords = chunk.map(c =>
            `${Number(c[0]).toFixed(5)},${Number(c[1]).toFixed(5)}`
        ).join(';');

        const url = `https://api.mapbox.com/matching/v5/mapbox/driving/${coords}?access_token=${MAPBOX_TOKEN}&geometries=geojson&tidy=true&overview=full`;

        try {
            const res = await fetch(url);
            if (res.ok) {
                const response = await res.json();
                if (response.code === 'Ok') {
                    // response.matchings array
                    for (const m of response.matchings) {
                        // If we are stitching, we might have duplicate points at the join.
                        // Ideally we check distance.
                        // Simple concat for now.
                        combinedCoordinates.push(...m.geometry.coordinates);
                        totalDistance += m.distance;
                    }
                } else {
                    console.log(`\nFeature ${index} Chunk Fail: ${response.code}`);
                    combinedCoordinates.push(...chunk);
                }
            } else {
                console.log(`\nFeature ${index} HTTP Fail: ${res.status}`);
                // Fallback to raw
                combinedCoordinates.push(...chunk);
            }
        } catch (e) {
            console.log(`\nFeature ${index} Net Fail: ${e.message}`);
            combinedCoordinates.push(...chunk);
        }
        await sleep(250); // Rate limit protection
    }

    if (combinedCoordinates.length > 0) {
        feature.geometry.coordinates = combinedCoordinates;
        feature.properties.gapLength = Math.round(totalDistance);
        feature.properties.snapped_v9 = true;
        successCount++;
        process.stdout.write('.');
    }
};

(async () => {
    for (let i = 0; i < data.features.length; i++) {
        await processFeature(data.features[i], i);
        if (i % 5 === 0) {
            fs.writeFileSync(OUTPUT_FILE, JSON.stringify(data, null, 2));
        }
    }
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(data, null, 2));
    console.log(`\nDone. Snapped: ${successCount}`);
})();
