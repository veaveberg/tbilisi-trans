/**
 * Script to detect loop routes and find their terminus (cutoff) stops
 * Fetches route data from the API to get full pattern stops
 */

import fs from 'fs';
import path from 'path';
import https from 'https';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CSV_PATH = path.join(__dirname, '../public/data/routes_overrides.csv');
const API_BASE = 'https://transfer.msplus.ge:2443/pis-gateway/api/v3';

// Exclusion list - routes that look like loops but shouldn't be treated as such
const EXCLUDED_ROUTES = ['387', '397'];

// Parse CSV line handling quoted fields
function parseCSVLine(line) {
    const result = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
        const char = line[i];

        if (char === '"') {
            inQuotes = !inQuotes;
        } else if (char === ',' && !inQuotes) {
            result.push(current);
            current = '';
        } else {
            current += char;
        }
    }
    result.push(current);
    return result;
}

// Escape field for CSV
function escapeCSV(field) {
    const str = String(field || '');
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
}

// Fetch with https that ignores SSL errors
function fetchJSON(url) {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(url);
        const options = {
            hostname: urlObj.hostname,
            port: urlObj.port || 443,
            path: urlObj.pathname + urlObj.search,
            method: 'GET',
            rejectUnauthorized: false, // Ignore SSL errors
            headers: {
                'Accept': 'application/json'
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    try {
                        resolve(JSON.parse(data));
                    } catch (e) {
                        reject(new Error(`JSON parse error: ${e.message}`));
                    }
                } else {
                    reject(new Error(`HTTP ${res.statusCode}`));
                }
            });
        });

        req.on('error', reject);
        req.setTimeout(10000, () => {
            req.destroy();
            reject(new Error('Timeout'));
        });
        req.end();
    });
}

async function fetchRouteDetails(routeId) {
    try {
        const url = `${API_BASE}/routes/${encodeURIComponent(routeId)}/stops`;
        return await fetchJSON(url);
    } catch (e) {
        console.error(`  Error fetching ${routeId}:`, e.message);
        return null;
    }
}

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

async function main() {
    console.log('Reading CSV...');

    // Read existing CSV
    const csvContent = fs.readFileSync(CSV_PATH, 'utf8');
    const lines = csvContent.split('\n');
    const header = lines[0];

    // Parse header
    const headerCols = parseCSVLine(header);
    const idxId = headerCols.indexOf('id');
    const idxShortName = headerCols.indexOf('shortName');
    const idxIsLoop = headerCols.indexOf('isLoop');
    const idxTerminusId = headerCols.indexOf('terminusStopId');
    const idxTerminusOverride = headerCols.indexOf('terminusStopId_override');
    const idxTerminusName = headerCols.indexOf('terminusStopName');

    console.log(`CSV has ${lines.length - 1} routes`);
    console.log(`Columns: isLoop=${idxIsLoop}, terminusStopId=${idxTerminusId}, terminusStopName=${idxTerminusName}`);

    // Track loop data found
    const loopData = new Map();
    const routesToCheck = [];

    // First pass: identify routes to check
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (!line.trim()) continue;

        const cols = parseCSVLine(line);
        const routeId = cols[idxId];
        const shortName = cols[idxShortName];
        const currentIsLoop = cols[idxIsLoop];
        const currentTerminus = cols[idxTerminusId];

        // Skip if already has terminus set
        if (currentTerminus && currentTerminus.trim()) continue;

        // Check routes that are marked as isLoop but don't have terminus
        // Also check routes that aren't marked (we'll detect if they're loops)
        routesToCheck.push({ routeId, shortName, lineNum: i, currentIsLoop });
    }

    console.log(`\nChecking ${routesToCheck.length} routes for loop detection...`);

    // Process routes - limit concurrency to avoid rate limiting
    const BATCH_SIZE = 3;
    for (let i = 0; i < routesToCheck.length; i += BATCH_SIZE) {
        const batch = routesToCheck.slice(i, i + BATCH_SIZE);
        console.log(`\nProcessing batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(routesToCheck.length / BATCH_SIZE)}...`);

        await Promise.all(batch.map(async ({ routeId, shortName }) => {
            const details = await fetchRouteDetails(routeId);
            if (!details || !details.patterns) {
                // console.log(`  ${shortName} (${routeId}): No patterns data`);
                return;
            }

            // Check each pattern for loop
            for (const pattern of details.patterns) {
                if (!pattern.stops || pattern.stops.length < 5) continue;

                if (isLoop(pattern.stops, shortName)) {
                    const terminus = findTerminusStop(pattern.stops, pattern.headsign);
                    if (terminus) {
                        loopData.set(routeId, {
                            shortName,
                            isLoop: true,
                            terminusStopId: terminus.stopId,
                            terminusStopName: terminus.name,
                            terminusIndex: terminus.index,
                            stopsCount: pattern.stops.length,
                            headsign: pattern.headsign
                        });
                        console.log(`  ${shortName}: Loop! Terminus: ${terminus.name} (${terminus.stopId}) at ${terminus.index}/${pattern.stops.length}`);
                    }
                    break;
                }
            }
        }));

        // Delay between batches
        if (i + BATCH_SIZE < routesToCheck.length) {
            await new Promise(resolve => setTimeout(resolve, 300));
        }
    }

    console.log(`\n\nFound ${loopData.size} loop routes total`);

    // Update CSV
    const newLines = [header];
    let updatedCount = 0;

    for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (!line.trim()) {
            newLines.push(line);
            continue;
        }

        const cols = parseCSVLine(line);
        const routeId = cols[idxId];

        // Ensure we have enough columns
        while (cols.length < headerCols.length) {
            cols.push('');
        }

        if (loopData.has(routeId)) {
            const data = loopData.get(routeId);

            // Set isLoop if not already set
            if (!cols[idxIsLoop] || cols[idxIsLoop] === '') {
                cols[idxIsLoop] = 'true';
            }

            // Set terminus stop ID and name if not already set (and no override)
            const hasOverride = cols[idxTerminusOverride] && cols[idxTerminusOverride].trim();
            if (!hasOverride && (!cols[idxTerminusId] || cols[idxTerminusId] === '')) {
                cols[idxTerminusId] = data.terminusStopId;
                updatedCount++;
            }
            if (!cols[idxTerminusName] || cols[idxTerminusName] === '') {
                cols[idxTerminusName] = data.terminusStopName || '';
            }
        }

        newLines.push(cols.map(escapeCSV).join(','));
    }

    console.log(`\nUpdated ${updatedCount} routes with terminus data`);

    // Write updated CSV
    fs.writeFileSync(CSV_PATH, newLines.join('\n'));
    console.log('CSV saved!');

    // Print summary
    console.log('\n--- Loop Routes Found ---');
    for (const [routeId, data] of loopData) {
        console.log(`${data.shortName.padEnd(5)} ${routeId.padEnd(25)} -> ${data.terminusStopName} (${data.terminusStopId}) [${data.terminusIndex}/${data.stopsCount}]`);
    }
}

main().catch(console.error);
