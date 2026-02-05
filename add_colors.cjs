const fs = require('fs');

const INPUT_FILE = 'public/data/long_segments_snapped.geojson';
const OUTPUT_FILE = 'public/data/long_segments_colored.geojson';

const data = JSON.parse(fs.readFileSync(INPUT_FILE, 'utf8'));

// Generate consistent colors for routes
const routeColors = new Map();

function stringToColor(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = str.charCodeAt(i) + ((hash << 5) - hash);
    }
    let color = '#';
    for (let i = 0; i < 3; i++) {
        let value = (hash >> (i * 8)) & 0xFF;
        color += ('00' + value.toString(16)).substr(-2);
    }
    return color;
}

// Pre-define some nice distinct colors for common routes if we wanted, 
// but hasing is fine for debugging.

data.features.forEach(f => {
    const route = f.properties.routeNumber;
    if (!routeColors.has(route)) {
        // Use a simple hash generator
        routeColors.set(route, stringToColor(route + "salt"));
    }
    f.properties.color = routeColors.get(route);
});

console.log(`Assigned colors to ${routeColors.size} unique routes.`);

fs.writeFileSync(OUTPUT_FILE, JSON.stringify(data, null, 2));
console.log(`Saved colored features to ${OUTPUT_FILE}`);
