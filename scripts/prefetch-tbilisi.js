import { forEachConcurrent, orderedRecords, routeConcurrency, preserveFailedRoutes } from './prefetch-concurrency.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let requiredFetchFailures = 0;
const failedRouteIds = new Set();
function failedRequest(url) {
    requiredFetchFailures++;
    const id = /\/routes\/([^/?]+)/.exec(url)?.[1];
    if (id) failedRouteIds.add(decodeURIComponent(id));
}

async function fetchWithRetry(url, options, retries = 5) {
    for (let i = 0; i < retries; i++) {
        try {
            const res = await fetch(url, options);
            if (res.ok || res.status === 404) return res;
            if (i < retries - 1) {
                const retryAfter = Number(res.headers.get('retry-after'));
                await sleep(Math.min(30000, Math.max(500 * 2 ** i, Number.isFinite(retryAfter) ? retryAfter * 1000 : 0)));
            }
            else { if (res.status !== 404) { failedRequest(url); console.warn(`[Fetch failed] HTTP ${res.status}: ${url}`); } return res; }
        } catch (e) {
            console.warn(`[Retry ${i + 1}/${retries}] Failed to fetch ${url}: ${e.message}`);
            if (i === retries - 1) { failedRequest(url); throw e; }
            await sleep(500 * (i + 1));
        }
    }
}

const SOURCE = {
    id: 'tbilisi',
    apiBase: 'https://transit.ttc.com.ge/pis-gateway/api/v2'
};

const API_KEY = 'c0a2f304-551a-4d08-b8df-2c53ecd57f9f';
const OUTPUT_DIR = path.join(__dirname, '../public/data');
const LOCALES = ['en', 'ka']; // Skipping 'ru' for now as it errors on Tbilisi API

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

    // Containers per locale
    const dataByLocale = {};
    LOCALES.forEach(locale => {
        dataByLocale[locale] = {
            stops: [],
            routes: [],
            details: {}
        };
    });

    // 1. Fetch Stops & Routes for each locale
    for (const locale of LOCALES) {
        // A. Stops
        try {
            console.log(`Fetching Stops [${locale}] from ${API_BASE_URL}/stops...`);
            const sRes = await fetch(`${API_BASE_URL}/stops?locale=${locale}`, { headers });
            if (!sRes.ok) throw new Error(`Failed to fetch stops: ${sRes.status}`);
            dataByLocale[locale].stops = await sRes.json();
            console.log(`Saved ${dataByLocale[locale].stops.length} stops for [${locale}]`);
        } catch (e) {
            console.error(`Error fetching stops for ${source.id} [${locale}]:`, e.message);
        }

        // B. Routes
        try {
            console.log(`Fetching Routes [${locale}] from ${API_BASE_URL}/routes...`);
            const rRes = await fetch(`${API_BASE_URL}/routes?locale=${locale}`, { headers });
            if (!rRes.ok) throw new Error(`Failed to fetch routes: ${rRes.status}`);
            dataByLocale[locale].routes = await rRes.json();
            console.log(`Saved ${dataByLocale[locale].routes.length} routes for [${locale}]`);
        } catch (e) {
            console.error(`Error fetching routes for ${source.id} [${locale}]:`, e.message);
        }
        await sleep(500);
    }

    // 2. Process Route Details (using 'en' to drive the loop, but fetching for all)
    const guideRoutes = dataByLocale['en'].routes || [];
    console.log(`Processing ${guideRoutes.length} routes for Details/Schedules...`);

    // Schedules and Polylines are locale-independent (fetched once using EN)
    const schedules = {};
    const polylines = {};

    console.log(`Route concurrency: ${routeConcurrency()}`);
    await forEachConcurrent(guideRoutes, async (route, index) => {
        if (index % 5 === 0) process.stdout.write(`\r[${source.id}] Processing ${index}/${guideRoutes.length}...`);

        for (const locale of LOCALES) {
            try {
                // A. Route Details
                const detailsUrl = `${v3Base}/routes/${route.id}?locale=${locale}`;
                const detailsRes = await fetchWithRetry(detailsUrl, { headers });

                if (detailsRes.ok) {
                    const details = await detailsRes.json();
                    dataByLocale[locale].details[route.id] = details;

                    // B. Stops of Patterns (Augment Route object with stop IDs)
                    // We need stop IDs to augment the route list.
                    // This logic only needs to run if we want to augment the 'routes' list with 'stops' array.
                    // The 'stops' array is crucial for fallback.
                    // Stop IDs are numeric, so technically we could compute it once (EN) and apply to all?
                    // BUT, the pattern structure might technically vary? Unlikely.
                    // Let's compute it once per route (using EN) and apply to ALL locale route lists.
                    // Or just do it per locale to be safe if we are fetching details anyway.

                    if (details.patterns && details.patterns.length > 0) {
                        const uniqueSuffixes = [...new Set(details.patterns.map(p => p.patternSuffix))];

                        // We ONLY need to fetch stops-of-patterns if we need the stops list or if we want to save it inside details.
                        // For Separate Files, 'routes_details_[locale].json' should probably contain it if the client uses it.
                        // Client uses `_stopsOfPatterns` property injected into details.

                        const suffixesStr = uniqueSuffixes.join(',');
                        const patternsUrl = `${v3Base}/routes/${route.id}/stops-of-patterns?patternSuffixes=${suffixesStr}&locale=${locale}`;

                        try {
                            const patRes = await fetchWithRetry(patternsUrl, { headers });
                            if (patRes.ok) {
                                const patData = await patRes.json();
                                details._stopsOfPatterns = patData;

                                // Extract Stop IDs to augment the main Route List
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

                                // Find route in THIS locale's list and update it
                                const targetRoute = dataByLocale[locale].routes.find(r => r.id === route.id);
                                if (targetRoute) {
                                    targetRoute.stops = Array.from(stopIds);
                                }
                            }
                        } catch (e) { }

                        // C. Schedules & Polylines (ONCE, when locale is EN)
                        if (locale === 'en') {
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
                    }
                }
            } catch (e) {
                console.warn(`Error processing route ${route.id} [${locale}]: ${e.message}`);
            }
        }
        await sleep(50);
    });
    process.stdout.write('\n');

    if (process.env.TRANSIT_PREFETCH_STRICT === '1' && requiredFetchFailures) {
        if (!failedRouteIds.size) throw new Error('Upstream refresh failed without a cached route fallback');
        const readPrevious = kind => JSON.parse(fs.readFileSync(path.join(OUTPUT_DIR, `${source.id}_${kind}.json`), 'utf8'));
        const previous = { locales: Object.fromEntries(LOCALES.map(locale => [locale, { routes: readPrevious(`routes_${locale}`), details: readPrevious(`routes_details_${locale}`) }])), schedules: readPrevious('schedules'), polylines: readPrevious('polylines') };
        preserveFailedRoutes(failedRouteIds, previous, { locales: dataByLocale, schedules, polylines });
        console.warn(`[Preserved cached routes] ${[...failedRouteIds].join(', ')}; provider errors prevented refreshing these routes`);
    }
    if (process.env.TRANSIT_PREFETCH_STRICT === '1' && LOCALES.some(locale => !dataByLocale[locale].routes.length || !dataByLocale[locale].stops.length)) throw new Error('Empty route or stop list; refusing to publish partial data');

    // 3. Save Files
    for (const locale of LOCALES) {
        fs.writeFileSync(path.join(OUTPUT_DIR, `${source.id}_stops_${locale}.json`), JSON.stringify(dataByLocale[locale].stops));
        fs.writeFileSync(path.join(OUTPUT_DIR, `${source.id}_routes_${locale}.json`), JSON.stringify(dataByLocale[locale].routes));
        fs.writeFileSync(path.join(OUTPUT_DIR, `${source.id}_routes_details_${locale}.json`), JSON.stringify(orderedRecords(dataByLocale[locale].details)));
        console.log(`Saved ${locale} files for ${source.id}`);
    }

    // Shared files
    fs.writeFileSync(path.join(OUTPUT_DIR, `${source.id}_schedules.json`), JSON.stringify(orderedRecords(schedules)));
    fs.writeFileSync(path.join(OUTPUT_DIR, `${source.id}_polylines.json`), JSON.stringify(orderedRecords(polylines)));
    console.log(`Saved shared schedules/polylines for ${source.id}`);
}

processSource(SOURCE).catch(error => { console.error(error); process.exitCode = 1; });
