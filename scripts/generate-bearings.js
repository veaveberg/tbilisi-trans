
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const API_BASE_URL = 'https://transit.ttc.com.ge/pis-gateway/api/v2';
const API_KEY = 'c0a2f304-551a-4d08-b8df-2c53ecd57f9f';
const OUTPUT_FILE = path.join(__dirname, '../src/data/stop_bearings.json');

// Helper: Calculate Bearings
function toRad(deg) { return deg * Math.PI / 180; }
function toDeg(rad) { return rad * 180 / Math.PI; }

function getBearing(startLat, startLon, destLat, destLon) {
    const startLatRad = toRad(startLat);
    const startLonRad = toRad(startLon);
    const destLatRad = toRad(destLat);
    const destLonRad = toRad(destLon);

    const y = Math.sin(destLonRad - startLonRad) * Math.cos(destLatRad);
    const x = Math.cos(startLatRad) * Math.sin(destLatRad) -
        Math.sin(startLatRad) * Math.cos(destLatRad) * Math.cos(destLonRad - startLonRad);
    const brng = toDeg(Math.atan2(y, x));
    return (brng + 360) % 360;
}

// Fetch Helper
async function fetchWithRetry(url, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            const response = await fetch(url, { headers: { 'x-api-key': API_KEY } });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return await response.json();
        } catch (e) {
            if (i === retries - 1) throw e;
            await new Promise(r => setTimeout(r, 1000 * (i + 1))); // Exponential backoffish
        }
    }
}

async function main() {
    try {
        console.log('Fetching all routes...');
        const routes = await fetchWithRetry(`${API_BASE_URL}/routes?locale=en`);
        console.log(`Found ${routes.length} routes.`);

        const stopBearings = {}; // stopId -> [bearings]
        let processedCount = 0;
        let successfulRoutes = 0;

        // Process in batches
        const BATCH_SIZE = 5;
        for (let i = 0; i < routes.length; i += BATCH_SIZE) {
            const batch = routes.slice(i, i + BATCH_SIZE);

            await Promise.all(batch.map(async (route) => {
                try {
                    // Fetch Stops for THIS route
                    const stops = await fetchWithRetry(`${API_BASE_URL}/routes/${route.id}/stops`);

                    if (Array.isArray(stops) && stops.length > 1) {
                        for (let j = 0; j < stops.length - 1; j++) {
                            const current = stops[j];
                            const next = stops[j + 1];

                            if (current && next && current.lat && current.lon && next.lat && next.lon) {
                                // Skip if coordinates are identical (duplicate stops)
                                if (current.lat === next.lat && current.lon === next.lon) continue;

                                const bearing = getBearing(current.lat, current.lon, next.lat, next.lon);

                                if (!stopBearings[current.id]) {
                                    stopBearings[current.id] = [];
                                }
                                stopBearings[current.id].push(bearing);
                            }
                        }
                        successfulRoutes++;
                    }
                } catch (e) {
                    // console.warn(`Failed to process route ${route.shortName}: ${e.message}`);
                }
            }));

            processedCount += batch.length;
            process.stdout.write(`\rProcessed ${processedCount}/${routes.length} routes (Success: ${successfulRoutes})...`);

            // Small delay between batches to be nice
            await new Promise(r => setTimeout(r, 200));
        }

        console.log('\nCalculating average bearings...');

        const finalData = {};
        let count = 0;

        for (const [id, bearings] of Object.entries(stopBearings)) {
            if (bearings.length === 0) continue;

            // Average the bearings using vector sum
            let sinSum = 0;
            let cosSum = 0;
            for (const b of bearings) {
                sinSum += Math.sin(toRad(b));
                cosSum += Math.cos(toRad(b));
            }
            const avgRad = Math.atan2(sinSum, cosSum);
            const avgDeg = (toDeg(avgRad) + 360) % 360;

            finalData[id] = Math.round(avgDeg);
            count++;
        }

        const dir = path.dirname(OUTPUT_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        fs.writeFileSync(OUTPUT_FILE, JSON.stringify(finalData));
        console.log(`\nDone! Saved bearings for ${count} stops to ${OUTPUT_FILE}`);

    } catch (err) {
        console.error('\nFatal Error:', err);
        process.exit(1);
    }
}

main();
