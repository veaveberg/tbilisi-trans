import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchWithRetry(url, options, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            const res = await fetch(url, options);
            if (res.ok) return res;
            if (i < retries - 1) await sleep(500 * (i + 1));
            else return res;
        } catch (e) {
            console.warn(`[Retry ${i + 1}/${retries}] Failed to fetch ${url}: ${e.message}`);
            if (i === retries - 1) throw e;
            await sleep(500 * (i + 1));
        }
    }
}

// Define Sources Configuration (Mirrors src/data/sources.js structure but for Node)
const SOURCES = [
    {
        id: 'tbilisi',
        apiBase: 'https://transit.ttc.com.ge/pis-gateway/api/v2',
        // apiBaseV3: 'https://transit.ttc.com.ge/pis-gateway/api/v3' // Not strictly needed for V2 prefetch unless we use V3 details
        // We use V3 for details/schedules/polylines
    },
    {
        id: 'rustavi',
        prefix: 'rustavi',
        apiBase: 'https://rustavi-transit.azrycloud.com/pis-gateway/api/v2'
    }
];

const API_KEY = 'c0a2f304-551a-4d08-b8df-2c53ecd57f9f';
const OUTPUT_DIR = path.join(__dirname, '../public/data');

// Ensure output directory exists
if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

async function processSource(source) {
    console.log(`\n--- Processing Source: ${source.id.toUpperCase()} ---`);
    const API_BASE_URL = source.apiBase;
    const v3Base = API_BASE_URL.replace('/v2', '/v3');

    const headers = {
        'x-api-key': API_KEY,
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Origin': new URL(API_BASE_URL).origin,
        'Referer': new URL(API_BASE_URL).origin + '/'
    };

    // 1. Fetch Stops
    try {
        console.log(`Fetching Stops from ${API_BASE_URL}/stops...`);
        const sRes = await fetch(`${API_BASE_URL}/stops`, { headers });
        if (!sRes.ok) throw new Error(`Failed to fetch stops: ${sRes.status}`);
        const stopsData = await sRes.json();

        // Tag with correct ID if needed? 
        // Logic in API client sets IDs. Here we should just save raw data 
        // OR mirror the ID logic. Usually fallback data is raw.
        // BUT api.js fetchStops logic: fetches raw, then tags with prefix.
        // So we should save RAW data to match API response.

        fs.writeFileSync(path.join(OUTPUT_DIR, `${source.id}_stops.json`), JSON.stringify(stopsData));
        console.log(`Saved ${source.id}_stops.json (${stopsData.length} stops)`);
    } catch (e) {
        console.error(`Error fetching stops for ${source.id}:`, e.message);
    }

    // 2. Fetch Routes
    let routes = [];
    try {
        console.log(`Fetching Routes from ${API_BASE_URL}/routes...`);
        const rRes = await fetch(`${API_BASE_URL}/routes`, { headers });
        if (!rRes.ok) throw new Error(`Failed to fetch routes: ${rRes.status}`);
        routes = await rRes.json();
    } catch (e) {
        console.error(`Error fetching routes for ${source.id}:`, e.message);
        return; // Cannot proceed without routes
    }

    console.log(`Processing ${routes.length} routes for Details/Schedules...`);

    const routesDetails = {};
    const schedules = {};
    const polylines = {};

    for (const [index, route] of routes.entries()) {
        if (index % 10 === 0) process.stdout.write(`\r[${source.id}] Processing ${index}/${routes.length}...`);

        try {
            // A. Fetch V3 Details
            const detailsUrl = `${v3Base}/routes/${route.id}`;
            const detailsRes = await fetchWithRetry(detailsUrl, { headers });
            if (!detailsRes.ok) continue;
            const details = await detailsRes.json();
            routesDetails[route.id] = details;

            // B. Stops of Patterns & Schedules
            if (details.patterns && details.patterns.length > 0) {
                const uniqueSuffixes = [...new Set(details.patterns.map(p => p.patternSuffix))];

                // Stops of Patterns (Consolidated)
                const suffixesStr = uniqueSuffixes.join(',');
                const patternsUrl = `${v3Base}/routes/${route.id}/stops-of-patterns?patternSuffixes=${suffixesStr}&locale=en`;
                try {
                    const patRes = await fetchWithRetry(patternsUrl, { headers });
                    if (patRes.ok) {
                        const patData = await patRes.json();
                        details._stopsOfPatterns = patData;

                        // Extract Stop IDs for Route fallback
                        const stopIds = new Set();
                        if (Array.isArray(patData)) {
                            patData.forEach(item => {
                                if (item.stop && item.stop.id) stopIds.add(item.stop.id);
                                else if (item.stops) item.stops.forEach(s => stopIds.add(s.id));
                            });
                        } else if (patData.patterns) {
                            patData.patterns.forEach(pattern => {
                                if (pattern.stops) pattern.stops.forEach(s => stopIds.add(s.id));
                            });
                        }
                        route.stops = Array.from(stopIds);
                    }
                } catch (e) { }

                // Schedules & Polylines per suffix
                for (const suffix of uniqueSuffixes) {
                    const safeSuffix = suffix.replace(/:/g, '_').replace(/,/g, '-');
                    const key = `${route.id}_${safeSuffix}`;

                    // Schedule
                    const scheduleUrl = `${v3Base}/routes/${route.id}/schedule?patternSuffix=${suffix}&locale=en`;
                    try {
                        const sRes = await fetchWithRetry(scheduleUrl, { headers });
                        if (sRes.ok) schedules[key] = await sRes.json();
                    } catch (e) { }

                    // Polyline
                    const polylineUrl = `${v3Base}/routes/${route.id}/polylines?patternSuffixes=${suffix}`;
                    try {
                        const pRes = await fetchWithRetry(polylineUrl, { headers });
                        if (pRes.ok) polylines[key] = await pRes.json();
                    } catch (e) { }

                    await sleep(20);
                }
            }
            await sleep(50);
        } catch (e) {
            console.warn(`Error processing route ${route.id}: ${e.message}`);
        }
    }
    process.stdout.write('\n');

    // Save Aggregates
    fs.writeFileSync(path.join(OUTPUT_DIR, `${source.id}_routes.json`), JSON.stringify(routes)); // Save Augmented Routes
    console.log(`Saved ${source.id}_routes.json (Augmented with stops)`);

    fs.writeFileSync(path.join(OUTPUT_DIR, `${source.id}_routes_details.json`), JSON.stringify(routesDetails));
    fs.writeFileSync(path.join(OUTPUT_DIR, `${source.id}_schedules.json`), JSON.stringify(schedules));
    fs.writeFileSync(path.join(OUTPUT_DIR, `${source.id}_polylines.json`), JSON.stringify(polylines));
    console.log(`Saved detailed data for ${source.id}`);
}

async function main() {
    for (const source of SOURCES) {
        await processSource(source);
    }
    console.log('\nAll sources processed.');
}

if (process.env.CI || process.env.GITHUB_ACTIONS) {
    main().catch(e => {
        console.warn('[CI] Prefetch process failed but allowing build to continue:', e);
        process.exit(0);
    });
} else {
    main().catch(e => {
        console.error('Prefetch failed:', e);
        process.exit(1);
    });
}
