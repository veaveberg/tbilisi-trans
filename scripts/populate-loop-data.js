/**
 * Script to populate isLoop and terminus stop data in routes_overrides.csv
 * 
 * This script:
 * 1. Reads static route data from public/data/
 * 2. Detects which routes are loops (first/last stop same)
 * 3. Finds the terminus (midpoint) stop for each loop route
 * 4. Updates routes_overrides.csv with isLoop flag and terminusStopId
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CSV_PATH = path.join(__dirname, '../public/data/routes_overrides.csv');

// Exclusion list - routes that look like loops but shouldn't be treated as such
const EXCLUDED_ROUTES = ['387', '397'];

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
    console.log('Reading route data...');

    const loopData = new Map(); // routeId -> { isLoop, terminusStopId, terminusStopName }

    // Read route details from both Tbilisi and Rustavi
    const dataFiles = [
        path.join(__dirname, '../public/data/tbilisi_routes_details_en.json'),
        path.join(__dirname, '../public/data/rustavi_routes_details_en.json')
    ];

    for (const dataFile of dataFiles) {
        try {
            const content = fs.readFileSync(dataFile, 'utf8');
            const routesData = JSON.parse(content);

            // The file is an object keyed by route ID
            const routeIds = Object.keys(routesData);
            for (const routeId of routeIds) {
                const routeData = routesData[routeId];
                const shortName = routeData.shortName;

                if (routeData.patterns && Array.isArray(routeData.patterns)) {
                    for (const pattern of routeData.patterns) {
                        if (pattern.stops && pattern.stops.length >= 5) {
                            if (isLoop(pattern.stops, shortName)) {
                                const terminus = findTerminusStop(pattern.stops, pattern.headsign);
                                if (terminus) {
                                    loopData.set(routeId, {
                                        isLoop: true,
                                        terminusStopId: terminus.stopId,
                                        terminusStopName: terminus.name,
                                        terminusIndex: terminus.index,
                                        stopsCount: pattern.stops.length
                                    });
                                }
                                break; // Only need to check one pattern per route
                            }
                        }
                    }
                }
            }
            console.log(`Processed ${path.basename(dataFile)}: ${routeIds.length} routes, ${loopData.size} loops found so far`);
        } catch (e) {
            console.error(`Error processing ${dataFile}:`, e.message);
        }
    }

    console.log(`Found ${loopData.size} loop routes total`);

    // Read existing CSV
    const csvContent = fs.readFileSync(CSV_PATH, 'utf8');
    const lines = csvContent.split('\n');
    const header = lines[0];

    // Parse header
    const headerCols = header.split(',');
    const idxId = headerCols.indexOf('id');
    const idxIsLoop = headerCols.indexOf('isLoop');

    // Check if we need to add new columns
    let hasTerminusCol = headerCols.indexOf('terminusStopId') !== -1;

    let newHeader = header;
    if (!hasTerminusCol) {
        // Insert after isLoop column
        const insertPos = idxIsLoop + 1;
        headerCols.splice(insertPos, 0, 'terminusStopId', 'terminusStopId_override', 'terminusStopName');
        newHeader = headerCols.join(',');
    }

    // Get updated column indices
    const newHeaderCols = newHeader.split(',');
    const newIdxTerminusId = newHeaderCols.indexOf('terminusStopId');
    const newIdxTerminusOverride = newHeaderCols.indexOf('terminusStopId_override');
    const newIdxTerminusName = newHeaderCols.indexOf('terminusStopName');

    console.log(`Column positions: terminusStopId=${newIdxTerminusId}, terminusStopId_override=${newIdxTerminusOverride}, terminusStopName=${newIdxTerminusName}`);

    // Process data lines
    const newLines = [newHeader];
    let updatedCount = 0;

    for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (!line.trim()) {
            newLines.push(line);
            continue;
        }

        // Parse CSV line (handle quoted fields)
        const cols = parseCSVLine(line);
        const routeId = cols[idxId];

        // If we added new columns, we need to insert empty values
        if (cols.length < newHeaderCols.length) {
            const insertPos = idxIsLoop + 1;
            const colsToAdd = newHeaderCols.length - cols.length;
            for (let j = 0; j < colsToAdd; j++) {
                cols.splice(insertPos, 0, '');
            }
        }

        // Update isLoop and terminus data if we have loop data for this route
        if (loopData.has(routeId)) {
            const data = loopData.get(routeId);

            // Only update isLoop if it's currently empty
            if (!cols[idxIsLoop] || cols[idxIsLoop] === '') {
                cols[idxIsLoop] = 'true';
                updatedCount++;
            }

            // Set terminus stop ID and name if not already set
            if (newIdxTerminusId !== -1 && (!cols[newIdxTerminusId] || cols[newIdxTerminusId] === '')) {
                cols[newIdxTerminusId] = data.terminusStopId;
            }
            if (newIdxTerminusName !== -1 && (!cols[newIdxTerminusName] || cols[newIdxTerminusName] === '')) {
                cols[newIdxTerminusName] = data.terminusStopName || '';
            }
        }

        newLines.push(cols.map(c => c.includes(',') ? `"${c}"` : c).join(','));
    }

    console.log(`Updated ${updatedCount} routes with isLoop flag`);

    // Write updated CSV
    fs.writeFileSync(CSV_PATH, newLines.join('\n'));
    console.log('CSV updated successfully!');

    // Print summary of loop routes
    console.log('\n--- Loop Routes Summary (first 20) ---');
    let count = 0;
    for (const [routeId, data] of loopData) {
        if (count >= 20) break;
        console.log(`${routeId}: terminus at stop ${data.terminusStopId} (${data.terminusStopName}) [index ${data.terminusIndex}/${data.stopsCount}]`);
        count++;
    }
    if (loopData.size > 20) {
        console.log(`... and ${loopData.size - 20} more`);
    }
}

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

main().catch(console.error);
