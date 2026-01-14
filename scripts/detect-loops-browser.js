// Run this in the browser console after the app has loaded
// It will detect loop routes and output CSV-ready data

async function detectLoopRoutes() {
    const EXCLUDED_ROUTES = ['387', '397'];

    function isLoop(stops, routeIdent) {
        if (!stops || stops.length < 5) return false;
        if (routeIdent && EXCLUDED_ROUTES.includes(String(routeIdent))) return false;

        const first = stops[0];
        const last = stops[stops.length - 1];

        const fId = String(first.id || first.stopId).split(':')[1] || String(first.id || first.stopId);
        const lId = String(last.id || last.stopId).split(':')[1] || String(last.id || last.stopId);

        return fId === lId || first.name === last.name;
    }

    function findTerminusStop(stops, headsign) {
        if (!stops || stops.length < 5) return null;

        const midpoint = Math.ceil(stops.length * 0.5);

        // Try to find terminus by headsign match first
        if (headsign) {
            const searchStart = Math.floor(stops.length * 0.2);
            const searchEnd = Math.floor(stops.length * 0.8);

            for (let i = searchStart; i < searchEnd; i++) {
                if (stops[i].name === headsign || stops[i].name?.includes(headsign)) {
                    return { stopId: stops[i].id, index: i, name: stops[i].name };
                }
            }
        }

        // Fallback to midpoint
        const terminusStop = stops[midpoint - 1];
        return terminusStop ? { stopId: terminusStop.id, index: midpoint - 1, name: terminusStop.name } : null;
    }

    const routes = window.allRoutes || [];
    const loopData = [];

    console.log(`Checking ${routes.length} routes...`);

    for (const route of routes) {
        // Skip if already has isLoop set
        if (route._overrides?.isLoop) continue;

        // Need to fetch details if not loaded
        if (!route._details || !route._details.patterns) {
            try {
                // Try to hydrate
                await window.hydrateRouteDetails([route]);
            } catch (e) {
                console.log(`  ${route.shortName}: Could not fetch details`);
                continue;
            }
        }

        if (!route._details || !route._details.patterns) continue;

        for (const pattern of route._details.patterns) {
            if (!pattern.stops || pattern.stops.length < 5) continue;

            if (isLoop(pattern.stops, route.shortName)) {
                const terminus = findTerminusStop(pattern.stops, pattern.headsign);
                if (terminus) {
                    loopData.push({
                        id: route.id,
                        shortName: route.shortName,
                        terminusStopId: terminus.stopId,
                        terminusStopName: terminus.name,
                        terminusIndex: terminus.index,
                        stopsCount: pattern.stops.length
                    });
                    console.log(`${route.shortName}: Loop! Terminus: ${terminus.name} at ${terminus.index}/${pattern.stops.length}`);
                }
                break;
            }
        }
    }

    console.log(`\n\nFound ${loopData.length} new loop routes\n`);
    console.log('Copy the following to update routes_overrides.csv:\n');
    console.log('ID | shortName | terminusStopId | terminusStopName');
    console.log('--------------------------------------------------');
    loopData.forEach(d => {
        console.log(`${d.id} | ${d.shortName} | ${d.terminusStopId} | ${d.terminusStopName}`);
    });

    // Also output as array for easy processing
    console.log('\n\nAs JSON:');
    console.log(JSON.stringify(loopData, null, 2));

    return loopData;
}

// Run it
detectLoopRoutes();
