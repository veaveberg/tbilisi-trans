const fs = require('fs');
const path = '/Volumes/stuff/Documents/Projects/ttc app/public/data/tbilisi_routes_details_en.json';
const data = JSON.parse(fs.readFileSync(path, 'utf8'));
const stopIds = ['1:1241', '1:4332', '1:4356', '1:4357', '1:4358', '1:809'];

const results = [];
for (const [id, route] of Object.entries(data)) {
    if (!route._stopsOfPatterns) continue;

    // Find ALL entries for ANY of the stopIds
    const entries = route._stopsOfPatterns.filter(s => {
        const sId = String(s.stop.id || s.stop);
        return stopIds.includes(sId);
    });

    if (entries.length > 0) {
        const allSuffixes = new Set();
        entries.forEach(e => e.patternSuffixes.forEach(s => allSuffixes.add(s)));

        results.push({
            shortName: route.shortName,
            id: id,
            suffixes: Array.from(allSuffixes),
            isLoop: route._overrides?.isLoop,
            count: allSuffixes.size,
            stopsFound: entries.map(e => (e.stop.id || e.stop))
        });
    }
}

// Filter and sort for clarity
results.sort((a, b) => b.count - a.count);
console.log(JSON.stringify(results, null, 2));
