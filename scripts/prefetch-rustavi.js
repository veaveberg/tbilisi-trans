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

const SOURCES = {
    rustavi: {
        id: 'rustavi',
        apiBase: 'https://rustavi-transit.azrycloud.com/pis-gateway/api/v2'
    },
    kutaisi: {
        id: 'kutaisi',
        apiBase: 'https://pis.tbc-pts.azrycloud.com/pis-gateway/api/v2'
    }
};
const SOURCE_ID = process.env.TRANSIT_PREFETCH_SOURCE || 'rustavi';
const SOURCE = SOURCES[SOURCE_ID];
if (!SOURCE) throw new Error(`Unsupported Azry source: ${SOURCE_ID}`);

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

    // 2b. Fallback to V2 schedule for routes missing from V3
    const routesWithSchedules = new Set(Object.keys(schedules).map(k => k.split('_')[0]));
    const missingRoutes = guideRoutes.filter(r => !routesWithSchedules.has(r.id));
    
    if (missingRoutes.length > 0) {
        console.log(`\nFetching V2 schedules for ${missingRoutes.length} routes missing from V3...`);
        for (const route of missingRoutes) {
            try {
                const v2ScheduleUrl = `${API_BASE_URL}/routes/${route.id}/schedule?locale=en`;
                const schedRes = await fetchWithRetry(v2ScheduleUrl, { headers });
                if (schedRes.ok) {
                    const schedData = await schedRes.json();
                    // V2 schedules don't have pattern suffix, use a default key
                    const key = `${route.id}_v2`;
                    schedules[key] = schedData;
                    console.log(`  ✓ Got V2 schedule for ${route.id} (${route.shortName})`);
                } else {
                    console.log(`  ✗ V2 schedule failed for ${route.id}: ${schedRes.status}`);
                }
            } catch (e) {
                console.log(`  ✗ V2 schedule error for ${route.id}: ${e.message}`);
            }
            await sleep(100);
        }
    }

    applyRouteStopOverrides(source, dataByLocale);
    validateDataset(source, dataByLocale, schedules, polylines);

    // 3. Publish the complete validated dataset from a staging directory.
    const stagingDir = fs.mkdtempSync(path.join(OUTPUT_DIR, `.${source.id}-staging-`));
    const filenames = [];
    for (const locale of LOCALES) {
        const entries = [
            [`${source.id}_stops_${locale}.json`, dataByLocale[locale].stops],
            [`${source.id}_routes_${locale}.json`, dataByLocale[locale].routes],
            [`${source.id}_routes_details_${locale}.json`, dataByLocale[locale].details]
        ];
        for (const [filename, value] of entries) {
            fs.writeFileSync(path.join(stagingDir, filename), JSON.stringify(value));
            filenames.push(filename);
        }
    }
    fs.writeFileSync(path.join(stagingDir, `${source.id}_schedules.json`), JSON.stringify(schedules));
    fs.writeFileSync(path.join(stagingDir, `${source.id}_polylines.json`), JSON.stringify(polylines));
    filenames.push(`${source.id}_schedules.json`, `${source.id}_polylines.json`);

    for (const filename of filenames) {
        JSON.parse(fs.readFileSync(path.join(stagingDir, filename), 'utf8'));
    }
    for (const filename of filenames) {
        fs.renameSync(path.join(stagingDir, filename), path.join(OUTPUT_DIR, filename));
    }
    fs.rmdirSync(stagingDir);
    console.log(`Published ${filenames.length} validated files for ${source.id}`);
}

function applyRouteStopOverrides(source, dataByLocale) {
    if (source.id !== 'rustavi') return;

    // Routes 23 and 24 currently bypass the closed central Rustaveli corridor.
    // Keep the restored Simon Janashia Street and Tbilisi Concert Hall stops;
    // only remove the remaining closed-corridor stops from route markers and
    // the static stop index.
    const closedStopIds = new Set([
        '1:17017', '1:17025', // Opera Theatre
        '1:17042', '1:17102', // Liberty Square
        '1:17068', '1:17107', // Rustaveli metro
        '1:17087', '1:17100'  // First Classical Gymnasium
    ]);
    const affectedRouteIds = new Set(['1:R15907', '1:R16671']);
    let removed = 0;

    for (const locale of LOCALES) {
        for (const route of dataByLocale[locale].routes) {
            if (!affectedRouteIds.has(route.id) || !Array.isArray(route.stops)) continue;
            const before = route.stops.length;
            route.stops = route.stops.filter(stopId => !closedStopIds.has(stopId));
            removed += before - route.stops.length;
        }

        for (const routeId of affectedRouteIds) {
            const details = dataByLocale[locale].details[routeId];
            if (!Array.isArray(details?._stopsOfPatterns)) continue;
            const before = details._stopsOfPatterns.length;
            details._stopsOfPatterns = details._stopsOfPatterns.filter(entry => !closedStopIds.has(entry?.stop?.id));
            removed += before - details._stopsOfPatterns.length;
        }
    }

    console.log(`[Route Overrides] Removed ${removed} closed-corridor route-stop references for Rustavi 23/24`);
}

function validateDataset(source, dataByLocale, schedules, polylines) {
    const enStops = dataByLocale.en.stops;
    const enRoutes = dataByLocale.en.routes;
    if (!Array.isArray(enStops) || enStops.length === 0) throw new Error('Validation failed: no English stops');
    if (!Array.isArray(enRoutes) || enRoutes.length === 0) throw new Error('Validation failed: no English routes');

    const expectedRouteIds = new Set(enRoutes.map(route => route.id));
    for (const locale of LOCALES) {
        const localeRouteIds = new Set(dataByLocale[locale].routes.map(route => route.id));
        if (localeRouteIds.size !== expectedRouteIds.size || [...expectedRouteIds].some(id => !localeRouteIds.has(id))) {
            throw new Error(`Validation failed: ${locale} route IDs differ from English`);
        }
        const detailIds = Object.keys(dataByLocale[locale].details);
        const missingDetailIds = [...expectedRouteIds].filter(routeId => !dataByLocale[locale].details[routeId]);
        const missingWithoutV2Schedule = missingDetailIds.filter(routeId => !schedules[`${routeId}_v2`]);
        if (missingWithoutV2Schedule.length > 0) {
            throw new Error(
                `Validation failed: ${locale} has ${detailIds.length}/${expectedRouteIds.size} route details; ` +
                `missing fallback schedules for ${missingWithoutV2Schedule.join(', ')}`
            );
        }

        const stopIds = new Set(dataByLocale[locale].stops.map(stop => stop.id));
        for (const [routeId, details] of Object.entries(dataByLocale[locale].details)) {
            for (const entry of details._stopsOfPatterns || []) {
                const stopId = entry?.stop?.id;
                if (stopId && !stopIds.has(stopId)) {
                    throw new Error(`Validation failed: ${locale} route ${routeId} references missing stop ${stopId}`);
                }
            }
        }
    }

    if (source.id === 'kutaisi') {
        const invalidId = [...enStops, ...enRoutes].find(item => !String(item.id || '').startsWith('1:'));
        if (invalidId) throw new Error(`Validation failed: unexpected Kutaisi ID ${invalidId.id}`);
    }
    if (Object.keys(schedules).length === 0) throw new Error('Validation failed: no schedules');
    if (Object.keys(polylines).length === 0) throw new Error('Validation failed: no polylines');
}

processSource(SOURCE).catch(error => {
    console.error(error);
    process.exitCode = 1;
});
