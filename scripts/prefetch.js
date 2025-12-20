import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '../public/data');
const BASE_URL = 'https://transit.ttc.com.ge'; // Production URL
const API_KEY = 'c0a2f304-551a-4d08-b8df-2c53ecd57f9f'; // From api.js

const CONCURRENCY = 5;
const DELAY_MS = 100;

const headers = {
    'x-api-key': API_KEY,
    'User-Agent': 'TTC-Prefetch/1.0'
};

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchJson(endpoint) {
    const url = `${BASE_URL}${endpoint}`;
    try {
        // console.log(`Fetching ${url}...`);
        const res = await fetch(url, { headers });
        if (!res.ok) {
            console.warn(`Failed ${res.status} ${url}`);
            return null;
        }
        return await res.json();
    } catch (e) {
        console.error(`Error fetching ${url}:`, e.message);
        return null;
    }
}

async function saveJson(filename, data) {
    if (!data) return;
    const filepath = path.join(DATA_DIR, filename);
    await fs.writeFile(filepath, JSON.stringify(data)); // Minified
    // console.log(`Saved ${filename}`);
}



async function main() {
    console.log('Starting Prefetch...');

    // Ensure dir exists
    await fs.mkdir(DATA_DIR, { recursive: true });

    // 1. Load Routes List
    // We can fetch fresh or use existing file. Let's force fresh fetch if possible, or fallback to file.
    let routes = await fetchJson('/pis-gateway/api/v2/routes');
    if (!routes) {
        console.log('Failed to fetch routes list, trying to read local fallback_routes.json');
        try {
            const data = await fs.readFile(path.join(DATA_DIR, 'fallback_routes.json'), 'utf-8');
            routes = JSON.parse(data);
        } catch (e) {
            console.error('No routes list available.');
            return;
        }
    } else {
        await saveJson('fallback_routes.json', routes);
    }

    console.log(`Found ${routes.length} routes.`);

    // 2. Process Routes with Concurrency
    // Filter? Maybe just process all.
    // Chunking

    // Data Accumulators
    const routesDetails = {};
    const schedules = {};
    const polylines = {};

    let completed = 0;

    // Process function that accumulates instead of saving deeply
    async function processRouteAndAccumulate(route) {
        const routeId = route.id;

        // 1. Fetch Details
        const details = await fetchJson(`/pis-gateway/api/v3/routes/${encodeURIComponent(routeId)}`);
        if (details) {
            routesDetails[routeId] = details; // Key by Route ID

            if (details.patterns && details.patterns.length > 0) {
                const suffixes = [...new Set(details.patterns.map(p => p.patternSuffix))];

                // Prefetch Stops of Patterns (Critical for Schedule mapping)
                try {
                    const patternSuffixesStr = suffixes.join(',');
                    const stopsOfPatterns = await fetchJson(`/pis-gateway/api/v3/routes/${encodeURIComponent(routeId)}/stops-of-patterns?patternSuffixes=${encodeURIComponent(patternSuffixesStr)}&locale=en`);
                    if (stopsOfPatterns) {
                        details._stopsOfPatterns = stopsOfPatterns;
                    }
                } catch (e) {
                    console.warn(`Failed to fetch stops-of-patterns for ${routeId}`, e.message);
                }

                for (const suffix of suffixes) {
                    const safeSuffix = suffix.replace(/:/g, '_').replace(/,/g, '-');
                    const key = `${routeId}_${safeSuffix}`; // Consolidated Key

                    // A. Schedule
                    const schedule = await fetchJson(`/pis-gateway/api/v3/routes/${encodeURIComponent(routeId)}/schedule?patternSuffix=${encodeURIComponent(suffix)}&locale=en`);
                    if (schedule) {
                        schedules[key] = schedule;
                    }

                    // B. Polylines
                    const polyline = await fetchJson(`/pis-gateway/api/v3/routes/${encodeURIComponent(routeId)}/polylines?patternSuffixes=${encodeURIComponent(suffix)}`);
                    if (polyline) {
                        polylines[key] = polyline;
                    }

                    await sleep(DELAY_MS);
                }
            }
        }
    }

    // 2. Process Routes
    for (let i = 0; i < routes.length; i += CONCURRENCY) {
        const chunk = routes.slice(i, i + CONCURRENCY);
        await Promise.all(chunk.map(r => processRouteAndAccumulate(r)));
        completed += chunk.length;
        process.stdout.write(`\rProcessed ${completed}/${routes.length} routes...`);
        await sleep(DELAY_MS);
    }

    console.log('\nSaving aggregated files...');

    // Save Aggregate Files
    await saveJson('fallback_routes_details.json', routesDetails);
    await saveJson('fallback_schedules.json', schedules);
    await saveJson('fallback_polylines.json', polylines);

    console.log('Fetching Stops...');
    // 3. Fetch Stops
    const stops = await fetchJson('/pis-gateway/api/v2/stops');
    if (stops) {
        await saveJson('fallback_stops.json', stops);
        console.log('Saved fallback_stops.json');
    }

    console.log('Done!');
}

main().catch(console.error);
