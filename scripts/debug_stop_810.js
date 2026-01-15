
import fs from 'fs';
import path from 'path';

const routesPath = path.resolve('public/data/tbilisi_routes_details_en.json');
const routesData = JSON.parse(fs.readFileSync(routesPath, 'utf8'));

const targetShortNames = ['305', '306', '311', '378', '541'];
const targetStopId = '810'; // We'll search for 810 or 1:810

console.log('--- Analyzing Stop 810 ---');

Object.values(routesData).forEach(route => {
    if (!targetShortNames.includes(route.shortName)) return;

    console.log(`\nRoute ${route.shortName} (${route.id}):`);

    if (!route._stopsOfPatterns) {
        console.log('  No _stopsOfPatterns found.');
        return;
    }

    const stopEntry = route._stopsOfPatterns.find(s => {
        const id = String(s.stop.id || s.stop).replace(/^1:/, '');
        return id === targetStopId;
    });

    if (stopEntry) {
        console.log(`  Stop 810 Found.`);
        console.log(`  Pattern Suffixes: ${JSON.stringify(stopEntry.patternSuffixes)}`);
        if (stopEntry.patternSuffixes.length === 1) {
            const suffix = stopEntry.patternSuffixes[0];
            const dir = parseInt(suffix.split(':')[0]);
            console.log(`  -> FIX APPLIES. Forced Index: ${dir}`);
        } else {
            console.log(`  -> FIX DOES NOT APPLY (Multiple Suffixes).`);
        }

        // Also checks patterns to see what directions map to these suffixes
        if (route.patterns) {
            route.patterns.forEach(p => {
                if (stopEntry.patternSuffixes.includes(p.patternSuffix)) {
                    console.log(`  - Pattern ${p.patternSuffix}: Headsign "${p.headsign}", DirId: ${p.directionId}`);
                }
            });
        }

    } else {
        console.log('  Stop 810 NOT found in route definition.');
    }
});
