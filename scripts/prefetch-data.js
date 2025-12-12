
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
            // if (res.status === 404) return res; // Let caller handle 404
            if (i < retries - 1) await sleep(500 * (i + 1));
            else return res; // Return final response even if error
        } catch (e) {
            console.warn(`[Retry ${i + 1}/${retries}] Failed to fetch ${url}: ${e.message}`);
            if (i === retries - 1) throw e;
            await sleep(500 * (i + 1));
        }
    }
}

const API_BASE_URL = 'https://transit.ttc.com.ge/pis-gateway/api/v2';
const API_KEY = 'c0a2f304-551a-4d08-b8df-2c53ecd57f9f';
const OUTPUT_DIR = path.join(__dirname, '../public/data');
// Ensure output directory exists
if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

async function fetchAndSave(endpoint, filename) {
    const url = `${API_BASE_URL}${endpoint}`;
    console.log(`Fetching ${url}...`);
    try {
        const res = await fetch(url, {
            headers: {
                'x-api-key': API_KEY,
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Origin': 'https://transit.ttc.com.ge',
                'Referer': 'https://transit.ttc.com.ge/'
            }
        });
        if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
        const data = await res.json();

        const outputPath = path.join(OUTPUT_DIR, filename);
        fs.writeFileSync(outputPath, JSON.stringify(data));
        console.log(`Saved ${filename} (${(fs.statSync(outputPath).size / 1024).toFixed(2)} KB)`);
    } catch (err) {
        console.error(`Error processing ${filename}:`, err.message);
        // In CI (GitHub Actions), we might be IP blocked. 
        // We should allow the build to proceed if we have committed fallback data.
        if (process.env.CI || process.env.GITHUB_ACTIONS) {
            console.warn(`[CI] Ignoring prefetch error for ${filename}. Using existing file if present.`);
            return;
        }
        process.exit(1);
    }
}

async function main() {
    await fetchAndSave('/stops', 'fallback_stops.json');
    // Fetch routes but keep in memory to augment
    let routes = [];
    try {
        const res = await fetch(`${API_BASE_URL}/routes`, {
            headers: {
                'x-api-key': API_KEY,
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Origin': 'https://transit.ttc.com.ge',
                'Referer': 'https://transit.ttc.com.ge/'
            }
        });
        if (!res.ok) throw new Error('Failed to fetch routes');
        routes = await res.json();
    } catch (e) {
        console.error('Initial routes fetch failed:', e);
        return;
    }

    console.log(`Processing ${routes.length} routes for Stop Mapping & Metro Fallback...`);

    // Iterate ALL routes to attach 'stops' list (for Offline Stop->Routes mapping)
    for (const [index, route] of routes.entries()) {
        if (index % 20 === 0) console.log(`Processing ${index}/${routes.length}...`);

        try {
            // 1. Fetch Details (V3)
            const v3Base = API_BASE_URL.replace('/v2', '/v3');
            const detailsEndpoint = `/routes/${route.id}`;
            const detailsUrl = `${v3Base}${detailsEndpoint}`;

            const headers = {
                'x-api-key': API_KEY,
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Origin': 'https://transit.ttc.com.ge',
                'Referer': 'https://transit.ttc.com.ge/'
            };

            const detailsRes = await fetchWithRetry(detailsUrl, { headers });
            if (!detailsRes.ok) continue;
            const details = await detailsRes.json();

            // 2. Fetch Stops via 'stops-of-patterns' (Required for V3)
            const stopIds = new Set();
            if (details.patterns && details.patterns.length > 0) {
                const suffixes = details.patterns.map(p => p.patternSuffix).join(',');
                const patternsUrl = `${v3Base}/routes/${route.id}/stops-of-patterns?patternSuffixes=${suffixes}&locale=en`;

                try {
                    const patRes = await fetchWithRetry(patternsUrl, { headers });
                    if (patRes.ok) {
                        const patData = await patRes.json();
                        if (Array.isArray(patData)) {
                            patData.forEach(item => {
                                // V3 API Structure: Array of { stop: { id: ... }, patternSuffixes: [...] }
                                if (item.stop && item.stop.id) {
                                    stopIds.add(item.stop.id);
                                }
                                // Fallback for alternative structures
                                else if (item.stops) {
                                    item.stops.forEach(s => stopIds.add(s.id));
                                }
                            });
                        } else if (patData.patterns) {
                            patData.patterns.forEach(pattern => {
                                if (pattern.stops) pattern.stops.forEach(s => stopIds.add(s.id));
                            });
                        }
                    }
                } catch (e) { /* ignore */ }
            }

            // Fallback to basic details if available
            if (details.stops) details.stops.forEach(s => stopIds.add(s.id));

            route.stops = Array.from(stopIds);

            // 3. Metro Specifics (Save Details & Schedules)
            if (route.mode === 'SUBWAY') {
                console.log(`Saving Metro Data for ${route.shortName}...`);
                const detailsFilename = `fallback_route_details_${route.id}.json`;
                fs.writeFileSync(path.join(OUTPUT_DIR, detailsFilename), JSON.stringify(details));

                if (details.patterns) {
                    for (const p of details.patterns) {
                        const suffix = p.patternSuffix;
                        const safeSuffix = suffix.replace(/:/g, '_');
                        const scheduleEndpoint = `/routes/${route.id}/schedule?patternSuffix=${suffix}&locale=en`;
                        const scheduleFilename = `fallback_schedule_${route.id}_${safeSuffix}.json`;
                        const scheduleUrl = `${v3Base}${scheduleEndpoint}`;

                        try {
                            const schedRes = await fetchWithRetry(scheduleUrl, { headers });
                            if (schedRes.ok) {
                                const schedData = await schedRes.json();
                                fs.writeFileSync(path.join(OUTPUT_DIR, scheduleFilename), JSON.stringify(schedData));
                            }
                        } catch (e) { console.warn('Schedule fetch failed', e); }
                    }
                }
            }

            await sleep(50); // Rate limit

        } catch (e) {
            console.warn(`Error processing route ${route.id}:`, e.message);
        }
    }

    // Save Augmented Routes
    fs.writeFileSync(path.join(OUTPUT_DIR, 'fallback_routes.json'), JSON.stringify(routes));
    console.log(`Saved augmented fallback_routes.json with stop mappings.`);

    // --- Metro Pre-fetch (Integrated above) ---
    // (Removed separate block)


    console.log('Pre-fetch complete.');
}

main();
