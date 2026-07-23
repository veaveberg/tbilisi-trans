/**
 * Re-syncs route R98389 (Bus 397) from the live Tbilisi API into Convex.
 * This refreshes _stopsOfPatterns and _schedules to remove stale stop associations
 * (e.g. stops 814, 815, 821 which no longer appear in the live API for this route).
 */

import { ConvexHttpClient } from "convex/browser";
import * as dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });
dotenv.config();

const CONVEX_URL = process.env.VITE_CONVEX_URL;
if (!CONVEX_URL) {
    console.error("VITE_CONVEX_URL is not defined. Please check .env.local");
    process.exit(1);
}

const client = new ConvexHttpClient(CONVEX_URL);

const API_KEY = 'c0a2f304-551a-4d08-b8df-2c53ecd57f9f';
const API_BASE = 'https://transit.ttc.com.ge/pis-gateway/api/v2';
const V3_BASE = 'https://transit.ttc.com.ge/pis-gateway/api/v3';
const ROUTE_ID = 'R98389'; // Bus 397
const LOCALES = ['en', 'ka'];

const headers = {
    'x-api-key': API_KEY,
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    'Origin': 'https://transit.ttc.com.ge',
    'Referer': 'https://transit.ttc.com.ge/'
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchWithRetry(url, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            const res = await fetch(url, { headers });
            if (res.ok) return res;
            console.warn(`  [Retry ${i + 1}] ${res.status} for ${url}`);
            if (i < retries - 1) await sleep(500 * (i + 1));
            else return res;
        } catch (e) {
            console.warn(`  [Retry ${i + 1}] Error: ${e.message}`);
            if (i === retries - 1) throw e;
            await sleep(500 * (i + 1));
        }
    }
}

async function run() {
    console.log(`Re-syncing route ${ROUTE_ID} (Bus 397) into Convex...`);
    console.log(`Convex: ${CONVEX_URL}\n`);

    const schedules = [];
    const polylines = [];

    for (const locale of LOCALES) {
        console.log(`\n--- Locale: ${locale} ---`);

        // 1. Fetch route details
        const detailsUrl = `${V3_BASE}/routes/${ROUTE_ID}?locale=${locale}`;
        console.log(`Fetching details: ${detailsUrl}`);
        const detailsRes = await fetchWithRetry(detailsUrl);
        if (!detailsRes || !detailsRes.ok) {
            console.error(`  Failed to fetch details for ${locale}`);
            continue;
        }
        const details = await detailsRes.json();
        console.log(`  Patterns: ${details.patterns?.length ?? 0}`);

        if (details.patterns && details.patterns.length > 0) {
            const uniqueSuffixes = [...new Set(details.patterns.map(p => p.patternSuffix))];
            const suffixesStr = uniqueSuffixes.join(',');
            console.log(`  Pattern suffixes: ${suffixesStr}`);

            // 2. Fetch stops-of-patterns
            const patternsUrl = `${V3_BASE}/routes/${ROUTE_ID}/stops-of-patterns?patternSuffixes=${encodeURIComponent(suffixesStr)}&locale=${locale}`;
            console.log(`Fetching stops-of-patterns: ${patternsUrl}`);
            try {
                const patRes = await fetchWithRetry(patternsUrl);
                if (patRes && patRes.ok) {
                    const patData = await patRes.json();
                    details._stopsOfPatterns = patData;
                    console.log(`  stops-of-patterns entries: ${Array.isArray(patData) ? patData.length : Object.keys(patData).length}`);

                    // Log which stops are now in the data
                    if (Array.isArray(patData)) {
                        const stopIds = patData.map(s => s.stop?.id || s.stop);
                        const relevant = stopIds.filter(id => ['814','815','821'].some(n => String(id).includes(n)));
                        if (relevant.length > 0) {
                            console.warn(`  ⚠️  Stops 814/815/821 still found in _stopsOfPatterns:`, relevant);
                        } else {
                            console.log(`  ✓ Stops 814/815/821 NOT present in updated _stopsOfPatterns`);
                        }
                    }
                } else {
                    console.warn(`  Failed to fetch stops-of-patterns`);
                }
            } catch (e) {
                console.warn(`  Error fetching stops-of-patterns: ${e.message}`);
            }

            // 3. Schedules and Polylines (en only)
            if (locale === 'en') {
                for (const suffix of uniqueSuffixes) {
                    const key = `${ROUTE_ID}_${suffix.replace(/:/g, '_').replace(/,/g, '-')}`;

                    // Schedule
                    try {
                        const schedUrl = `${V3_BASE}/routes/${ROUTE_ID}/schedule?patternSuffix=${encodeURIComponent(suffix)}&locale=en`;
                        console.log(`  Fetching schedule for suffix ${suffix}...`);
                        const sRes = await fetchWithRetry(schedUrl);
                        if (sRes && sRes.ok) {
                            schedules.push({ key, suffix, data: await sRes.json() });
                            console.log(`    ✓ Schedule fetched`);
                        }
                    } catch (e) {
                        console.warn(`    Schedule error: ${e.message}`);
                    }

                    // Polyline
                    try {
                        const polyUrl = `${V3_BASE}/routes/${ROUTE_ID}/polylines?patternSuffixes=${encodeURIComponent(suffix)}`;
                        const pRes = await fetchWithRetry(polyUrl);
                        if (pRes && pRes.ok) {
                            polylines.push({ key, suffix, data: await pRes.json() });
                            console.log(`    ✓ Polyline fetched`);
                        }
                    } catch (e) {
                        console.warn(`    Polyline error: ${e.message}`);
                    }

                    await sleep(100);
                }
            }
        }

        // 4. Push to Convex
        console.log(`Saving to Convex [${locale}]...`);
        try {
            await client.mutation("transit:saveRouteDetails", {
                sourceId: 'tbilisi',
                locale,
                routeId: ROUTE_ID,
                details,
                schedules: locale === 'en' ? schedules : [],
                polylines: locale === 'en' ? polylines : []
            });
            console.log(`  ✓ Saved route ${ROUTE_ID} [${locale}] to Convex`);
        } catch (e) {
            console.error(`  ✗ Failed to save to Convex [${locale}]:`, e.message);
        }

        await sleep(200);
    }

    console.log('\nDone! Route 397 synced from live API into Convex.');
    console.log('The _stopsOfPatterns now reflects the current live API data.');
}

run().catch(e => {
    console.error('Fatal error:', e);
    process.exit(1);
});
