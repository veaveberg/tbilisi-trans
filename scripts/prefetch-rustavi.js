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

const SOURCE = {
    id: 'rustavi',
    prefix: 'rustavi',
    apiBase: 'https://rustavi-transit.azrycloud.com/pis-gateway/api/v2'
};

const API_KEY = 'c0a2f304-551a-4d08-b8df-2c53ecd57f9f';
const OUTPUT_DIR = path.join(__dirname, '../public/data');
const LOCALES = ['en', 'ka']; // Skipping 'ru' if needed, or keeping if supported. Let's keep strict match with Tbilisi for safety.

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

    const dataByLocale = {};
    LOCALES.forEach(locale => {
        dataByLocale[locale] = {
            stops: [],
            routes: [],
            details: {}
        };
    });

    // 1. Fetch Stops & Routes
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
    }

    // 2. Process Routes
    const guideRoutes = dataByLocale['en'].routes || [];
    console.log(`Processing ${guideRoutes.length} routes for Details/Schedules...`);

    const schedules = {};
    const polylines = {};

    for (const [index, route] of guideRoutes.entries()) {
        if (index % 5 === 0) process.stdout.write(`\r[${source.id}] Processing ${index}/${guideRoutes.length}...`);

        for (const locale of LOCALES) {
            try {
                // A. Fetch V3 Details
                const detailsUrl = `${v3Base}/routes/${route.id}?locale=${locale}`;
                const detailsRes = await fetchWithRetry(detailsUrl, { headers });

                if (detailsRes.ok) {
                    const details = await detailsRes.json();
                    dataByLocale[locale].details[route.id] = details;

                    // B. Stops of Patterns & Schedules
                    if (details.patterns && details.patterns.length > 0) {
                        const uniqueSuffixes = [...new Set(details.patterns.map(p => p.patternSuffix))];
                        const suffixesStr = uniqueSuffixes.join(',');
                        const patternsUrl = `${v3Base}/routes/${route.id}/stops-of-patterns?patternSuffixes=${suffixesStr}&locale=${locale}`;

                        try {
                            // If Rustavi behaves like Tbilisi, it needs this call
                            const patRes = await fetchWithRetry(patternsUrl, { headers });
                            if (patRes.ok) {
                                const patData = await patRes.json();
                                details._stopsOfPatterns = patData;

                                // Augment Route object
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

                                const targetRoute = dataByLocale[locale].routes.find(r => r.id === route.id);
                                if (targetRoute) {
                                    targetRoute.stops = Array.from(stopIds);
                                }
                            }
                        } catch (e) { }

                        // Schedules & Polylines (ONCE, on 'en')
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
    }
    process.stdout.write('\n');

    // 3. Save Files
    for (const locale of LOCALES) {
        fs.writeFileSync(path.join(OUTPUT_DIR, `${source.id}_stops_${locale}.json`), JSON.stringify(dataByLocale[locale].stops));
        fs.writeFileSync(path.join(OUTPUT_DIR, `${source.id}_routes_${locale}.json`), JSON.stringify(dataByLocale[locale].routes));
        fs.writeFileSync(path.join(OUTPUT_DIR, `${source.id}_routes_details_${locale}.json`), JSON.stringify(dataByLocale[locale].details));
        console.log(`Saved ${locale} files for ${source.id}`);
    }

    fs.writeFileSync(path.join(OUTPUT_DIR, `${source.id}_schedules.json`), JSON.stringify(schedules));
    fs.writeFileSync(path.join(OUTPUT_DIR, `${source.id}_polylines.json`), JSON.stringify(polylines));
    console.log(`Saved detailed data for ${source.id}`);
}

processSource(SOURCE).catch(console.error);
