import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ConvexHttpClient } from "convex/browser";
import * as dotenv from 'dotenv';

// Load env vars
dotenv.config({ path: '.env.local' });
dotenv.config();

const CONVEX_URL = process.env.VITE_CONVEX_URL;
if (!CONVEX_URL) {
    console.error("VITE_CONVEX_URL is not defined. Please check .env.local");
    process.exit(1);
}

const client = new ConvexHttpClient(CONVEX_URL);
// We need the API definition. Since we can't import generated API in generic node script easily without TS,
// We will use string identifiers for mutations.
// "transit:saveStops"

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
    id: 'tbilisi',
    apiBase: 'https://transit.ttc.com.ge/pis-gateway/api/v2'
};

const API_KEY = 'c0a2f304-551a-4d08-b8df-2c53ecd57f9f';
const LOCALES = ['en', 'ka'];

async function processSource(source) {
    console.log(`\n--- Syncing Source: ${source.id.toUpperCase()} to Convex ---`);
    console.log(`Target: ${CONVEX_URL}`);

    const API_BASE_URL = source.apiBase;
    const v3Base = API_BASE_URL.replace('/v2', '/v3');

    const headers = {
        'x-api-key': API_KEY,
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Origin': new URL(API_BASE_URL).origin,
        'Referer': new URL(API_BASE_URL).origin + '/'
    };

    // 1. Fetch Stops & Routes
    for (const locale of LOCALES) {
        // A. Stops
        try {
            console.log(`Fetching Stops [${locale}]...`);
            const sRes = await fetch(`${API_BASE_URL}/stops?locale=${locale}`, { headers });
            if (!sRes.ok) throw new Error(`Failed to fetch stops: ${sRes.status}`);
            const stops = await sRes.json();
            console.log(`Fetched ${stops.length} stops. Pushing to Convex...`);

            await client.mutation("transit:saveStops", { sourceId: source.id, locale, stops });
            console.log(`✓ Saved Stops [${locale}]`);
        } catch (e) {
            console.error(`Error processing stops [${locale}]:`, e.message);
        }

        // B. Routes
        let routes = [];
        try {
            console.log(`Fetching Routes [${locale}]...`);
            const rRes = await fetch(`${API_BASE_URL}/routes?locale=${locale}`, { headers });
            if (!rRes.ok) throw new Error(`Failed to fetch routes: ${rRes.status}`);
            routes = await rRes.json();
            console.log(`Fetched ${routes.length} routes. Pushing to Convex...`);

            await client.mutation("transit:saveRoutes", { sourceId: source.id, locale, routes });
            console.log(`✓ Saved Routes [${locale}]`);
        } catch (e) {
            console.error(`Error processing routes [${locale}]:`, e.message);
        }
    }

    // We can expand this to sync details too, but for now let's test the basics.
    // To sync details:
    // 1. Get List of Routes (En)
    // 2. Iterate and Push Details

    // Let's do details for checking.
    // Fetch EN routes again or use cached?
    // We didn't cache them in variable.
    // Fetch EN routes again.
    const rRes = await fetch(`${API_BASE_URL}/routes?locale=en`, { headers });
    const guideRoutes = await rRes.json();

    console.log(`\nSyncing Details for ${guideRoutes.length} routes...`);

    for (const [index, route] of guideRoutes.entries()) {
        if (index % 5 === 0) process.stdout.write(`\rProcessing ${index}/${guideRoutes.length}...`);

        // Parallelize Locales? No, rate limit.
        const schedules = [];
        const polylines = [];

        for (const locale of LOCALES) {
            try {
                // Details
                const detailsUrl = `${v3Base}/routes/${route.id}?locale=${locale}`;
                const detailsRes = await fetchWithRetry(detailsUrl, { headers });
                if (!detailsRes.ok) continue;
                const details = await detailsRes.json();

                if (details.patterns && details.patterns.length > 0) {
                    const uniqueSuffixes = [...new Set(details.patterns.map(p => p.patternSuffix))];
                    const suffixesStr = uniqueSuffixes.join(',');
                    const patternsUrl = `${v3Base}/routes/${route.id}/stops-of-patterns?patternSuffixes=${suffixesStr}&locale=${locale}`;

                    try {
                        const patRes = await fetchWithRetry(patternsUrl, { headers });
                        if (patRes.ok) {
                            details._stopsOfPatterns = await patRes.json();
                        }
                    } catch (e) { }

                    // Schedules/Polylines (En only)
                    if (locale === 'en') {
                        for (const suffix of uniqueSuffixes) {
                            const key = `${route.id}_${suffix.replace(/:/g, '_').replace(/,/g, '-')}`;
                            // Schedule
                            try {
                                const sRes = await fetchWithRetry(`${v3Base}/routes/${route.id}/schedule?patternSuffix=${suffix}&locale=en`, { headers });
                                if (sRes.ok) schedules.push({ key, suffix, data: await sRes.json() });
                            } catch (e) { }
                            // Polyline
                            try {
                                const pRes = await fetchWithRetry(`${v3Base}/routes/${route.id}/polylines?patternSuffixes=${suffix}`, { headers });
                                if (pRes.ok) polylines.push({ key, suffix, data: await pRes.json() });
                            } catch (e) { }
                            await sleep(50);
                        }
                    }
                }

                // Push to Convex
                await client.mutation("transit:saveRouteDetails", {
                    sourceId: source.id,
                    locale,
                    routeId: route.id,
                    details,
                    schedules: locale === 'en' ? schedules : [],
                    polylines: locale === 'en' ? polylines : []
                });

            } catch (e) {
                // ignore
            }
        }
        await sleep(100);
    }
    console.log("\nDone!");
}

processSource(SOURCE).catch(console.error);
