import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, '../public/data');

/**
 * Normalize Rustavi IDs to match the internal app format.
 * 
 * API format -> App format:
 *   Stops:  "1:123"   -> "r123"  
 *   Routes: "1:R826"  -> "rR826"
 * 
 * This makes the local prefetched data consistent with how
 * api.js processId() would transform live API responses.
 */

function normalizeStopId(id) {
    if (!id || typeof id !== 'string') return id;
    // 1:123 -> r123
    if (id.startsWith('1:')) {
        return 'r' + id.substring(2);
    }
    // 2:123 -> r123 (alternate prefix)
    if (id.startsWith('2:')) {
        return 'r' + id.substring(2);
    }
    // Already normalized or unknown format
    return id;
}

function normalizeRouteId(id) {
    if (!id || typeof id !== 'string') return id;
    // 1:R826 -> rR826
    if (id.startsWith('1:')) {
        return 'r' + id.substring(2);
    }
    // Already normalized or unknown format
    return id;
}

function normalizeScheduleKey(key) {
    // Keys are like "1:R826_1:01" -> "rR826_1:01"
    // Only transform the route ID part before the underscore
    const underscoreIdx = key.indexOf('_');
    if (underscoreIdx === -1) {
        return normalizeRouteId(key);
    }
    const routePart = key.substring(0, underscoreIdx);
    const suffixPart = key.substring(underscoreIdx);
    return normalizeRouteId(routePart) + suffixPart;
}

// ============================================
// 1. Normalize Stops files
// ============================================
function processStopsFile(filename) {
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath)) {
        console.log(`Skipping ${filename} - not found`);
        return;
    }

    console.log(`Processing ${filename}...`);
    const stops = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    let normalized = 0;

    for (const stop of stops) {
        const oldId = stop.id;
        stop.id = normalizeStopId(stop.id);
        if (stop.id !== oldId) normalized++;
    }

    fs.writeFileSync(filePath, JSON.stringify(stops));
    console.log(`  Normalized ${normalized} stop IDs`);
}

// ============================================
// 2. Normalize Routes list files
// ============================================
function processRoutesFile(filename) {
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath)) {
        console.log(`Skipping ${filename} - not found`);
        return;
    }

    console.log(`Processing ${filename}...`);
    const routes = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    let routesNormalized = 0;
    let stopsNormalized = 0;

    for (const route of routes) {
        const oldId = route.id;
        route.id = normalizeRouteId(route.id);
        if (route.id !== oldId) routesNormalized++;

        // Normalize stops array
        if (route.stops && Array.isArray(route.stops)) {
            route.stops = route.stops.map(sid => {
                const newId = normalizeStopId(sid);
                if (newId !== sid) stopsNormalized++;
                return newId;
            });
        }
    }

    fs.writeFileSync(filePath, JSON.stringify(routes));
    console.log(`  Normalized ${routesNormalized} route IDs, ${stopsNormalized} stop references`);
}

// ============================================
// 3. Normalize Route Details files
// ============================================
function processRouteDetailsFile(filename) {
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath)) {
        console.log(`Skipping ${filename} - not found`);
        return;
    }

    console.log(`Processing ${filename}...`);
    const details = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const newDetails = {};
    let routesNormalized = 0;
    let stopsNormalized = 0;

    for (const [routeId, routeData] of Object.entries(details)) {
        // Normalize the key
        const newRouteId = normalizeRouteId(routeId);
        if (newRouteId !== routeId) routesNormalized++;

        // Normalize the id field inside
        if (routeData.id) {
            routeData.id = normalizeRouteId(routeData.id);
        }

        // Normalize patterns' firstStop/lastStop IDs
        if (routeData.patterns) {
            for (const pattern of routeData.patterns) {
                if (pattern.firstStop?.id) {
                    const oldId = pattern.firstStop.id;
                    pattern.firstStop.id = normalizeStopId(pattern.firstStop.id);
                    if (pattern.firstStop.id !== oldId) stopsNormalized++;
                }
                if (pattern.lastStop?.id) {
                    const oldId = pattern.lastStop.id;
                    pattern.lastStop.id = normalizeStopId(pattern.lastStop.id);
                    if (pattern.lastStop.id !== oldId) stopsNormalized++;
                }
            }
        }

        // Normalize _stopsOfPatterns
        if (routeData._stopsOfPatterns) {
            for (const entry of routeData._stopsOfPatterns) {
                if (entry.stop?.id) {
                    const oldId = entry.stop.id;
                    entry.stop.id = normalizeStopId(entry.stop.id);
                    if (entry.stop.id !== oldId) stopsNormalized++;
                }
            }
        }

        newDetails[newRouteId] = routeData;
    }

    fs.writeFileSync(filePath, JSON.stringify(newDetails));
    console.log(`  Normalized ${routesNormalized} route IDs, ${stopsNormalized} stop IDs`);
}

// ============================================
// 4. Normalize Schedules file
// ============================================
function processSchedulesFile(filename) {
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath)) {
        console.log(`Skipping ${filename} - not found`);
        return;
    }

    console.log(`Processing ${filename}...`);
    const schedules = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const newSchedules = {};
    let keysNormalized = 0;

    for (const [key, value] of Object.entries(schedules)) {
        const newKey = normalizeScheduleKey(key);
        if (newKey !== key) keysNormalized++;
        newSchedules[newKey] = value;
    }

    fs.writeFileSync(filePath, JSON.stringify(newSchedules));
    console.log(`  Normalized ${keysNormalized} schedule keys`);
}

// ============================================
// 5. Normalize Polylines file
// ============================================
function processPolylinesFile(filename) {
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath)) {
        console.log(`Skipping ${filename} - not found`);
        return;
    }

    console.log(`Processing ${filename}...`);
    const polylines = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const newPolylines = {};
    let keysNormalized = 0;

    for (const [key, value] of Object.entries(polylines)) {
        const newKey = normalizeScheduleKey(key); // Same format as schedules
        if (newKey !== key) keysNormalized++;
        newPolylines[newKey] = value;
    }

    fs.writeFileSync(filePath, JSON.stringify(newPolylines));
    console.log(`  Normalized ${keysNormalized} polyline keys`);
}

// ============================================
// Main
// ============================================
console.log('=== Normalizing Rustavi Data Files ===\n');

// Stops
processStopsFile('rustavi_stops_en.json');
processStopsFile('rustavi_stops_ka.json');

// Routes
processRoutesFile('rustavi_routes_en.json');
processRoutesFile('rustavi_routes_ka.json');

// Route Details
processRouteDetailsFile('rustavi_routes_details_en.json');
processRouteDetailsFile('rustavi_routes_details_ka.json');

// Schedules
processSchedulesFile('rustavi_schedules.json');

// Polylines
processPolylinesFile('rustavi_polylines.json');

console.log('\n=== Done! ===');
