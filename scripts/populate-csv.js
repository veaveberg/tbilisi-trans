/**
 * Populate CSV files with all routes and stops data from API
 * Merges with existing overrides - overrides are preserved
 * New routes/stops from API are added automatically
 * Run with: node scripts/populate-csv.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Import CSV parser logic (copying functions to ensure Node compatibility without complex module setup)
function parseCSVLine(line) {
    const result = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        const nextChar = line[i + 1];
        if (char === '"') {
            if (inQuotes && nextChar === '"') {
                current += '"';
                i++;
            } else {
                inQuotes = !inQuotes;
            }
        } else if (char === ',' && !inQuotes) {
            result.push(current.trim());
            current = '';
        } else {
            current += char;
        }
    }
    result.push(current.trim());
    return result;
}

function parseCSV(csvText) {
    const lines = csvText.split('\n').filter(line => line.trim());
    if (lines.length === 0) return [];
    const headers = parseCSVLine(lines[0]);
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
        const values = parseCSVLine(lines[i]);
        if (values.length === 0) continue;
        const row = {};
        headers.forEach((header, index) => {
            row[header] = values[index] || '';
        });
        rows.push(row);
    }
    return rows;
}

// API configuration (same as prefetch scripts)
const API_KEY = 'c0a2f304-551a-4d08-b8df-2c53ecd57f9f';
const HEADERS = {
    'x-api-key': API_KEY,
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
};

const getHeaders = (url) => {
    const origin = new URL(url).origin;
    return {
        ...HEADERS,
        'Origin': origin,
        'Referer': origin + '/'
    };
};

// Fetch routes from API (both EN and KA)
async function fetchRoutesFromAPI() {
    console.log('Fetching routes from API...');

    try {
        const [tRoutesEn, tRoutesKa, rRoutesEn, rRoutesKa] = await Promise.all([
            fetch('https://transit.ttc.com.ge/pis-gateway/api/v2/routes?locale=en', { headers: getHeaders('https://transit.ttc.com.ge') }).then(r => r.json()),
            fetch('https://transit.ttc.com.ge/pis-gateway/api/v2/routes?locale=ka', { headers: getHeaders('https://transit.ttc.com.ge') }).then(r => r.json()),
            fetch('https://rustavi-transit.azrycloud.com/pis-gateway/api/v2/routes?locale=en', { headers: getHeaders('https://rustavi-transit.azrycloud.com') }).then(r => r.json()),
            fetch('https://rustavi-transit.azrycloud.com/pis-gateway/api/v2/routes?locale=ka', { headers: getHeaders('https://rustavi-transit.azrycloud.com') }).then(r => r.json())
        ]);

        // Create map of routes with both languages
        const routesMap = new Map();

        // Add Tbilisi routes
        tRoutesEn.forEach(route => {
            const id = route.id;
            routesMap.set(id, {
                id,
                shortName: route.shortName || '',
                longName_en: route.longName || '',
                longName_ka: '',
                type: route.type || ''
            });
        });

        tRoutesKa.forEach(route => {
            if (routesMap.has(route.id)) {
                routesMap.get(route.id).longName_ka = route.longName || '';
            }
        });

        // Add Rustavi routes (prefix with rustavi: if they don't have it, but here we use IDs as-is as they are unique in the app)
        rRoutesEn.forEach(route => {
            const id = route.id;
            routesMap.set(id, {
                id,
                shortName: route.shortName || '',
                longName_en: route.longName || '',
                longName_ka: '',
                type: route.type || ''
            });
        });

        rRoutesKa.forEach(route => {
            if (routesMap.has(route.id)) {
                routesMap.get(route.id).longName_ka = route.longName || '';
            }
        });


        console.log('Fetching route destinations from V3 API...');
        const routes = Array.from(routesMap.values());
        let processed = 0;

        for (const route of routes) {
            try {
                const [detailsEn, detailsKa] = await Promise.all([
                    fetch(`https://transit.ttc.com.ge/pis-gateway/api/v3/routes/${route.id}?locale=en`, { headers: HEADERS }).then(r => r.ok ? r.json() : null),
                    fetch(`https://transit.ttc.com.ge/pis-gateway/api/v3/routes/${route.id}?locale=ka`, { headers: HEADERS }).then(r => r.ok ? r.json() : null)
                ]);

                if (detailsEn?.patterns && detailsEn.patterns.length > 0) {
                    const p0 = detailsEn.patterns[0];
                    if (p0) {
                        route.dest0_en = p0.headsign;
                        // Check IsLoop logic (First Stop == Last Stop)
                        if (p0.firstStop?.id && p0.lastStop?.id && p0.firstStop.id === p0.lastStop.id) {
                            route.isLoop = true;
                            // If it's a loop, dest1 (Inbound) is usually the Origin
                            if (!route.dest1_en) route.dest1_en = p0.firstStop.name;
                        }
                    }
                    if (detailsEn.patterns[1]?.headsign) route.dest1_en = detailsEn.patterns[1].headsign;
                }

                if (detailsKa?.patterns && detailsKa.patterns.length > 0) {
                    const p0 = detailsKa.patterns[0];
                    if (p0) {
                        route.dest0_ka = p0.headsign;
                        // Use loop flag from EN or re-detect
                        const isLoop = p0.firstStop?.id && p0.lastStop?.id && p0.firstStop.id === p0.lastStop.id;
                        if (isLoop) {
                            if (!route.dest1_ka) route.dest1_ka = p0.firstStop.name;
                        }
                    }
                    if (detailsKa.patterns[1]?.headsign) route.dest1_ka = detailsKa.patterns[1].headsign;
                }

                processed++;
                if (processed % 20 === 0) process.stdout.write(`\r  Processed ${processed}/${routes.length} routes...`);
                await new Promise(r => setTimeout(r, 50));
            } catch (e) { }
        }
        process.stdout.write(`\r  Processed ${processed}/${routes.length} routes... Done!\n`);

        return routes;
    } catch (e) {
        console.error('Error fetching routes:', e);
        return [];
    }
}

// Fetch stops from API (both EN and KA)
async function fetchStopsFromAPI() {
    console.log('Fetching stops from API...');

    try {
        const [tStopsEn, tStopsKa, rStopsEn, rStopsKa] = await Promise.all([
            fetch('https://transit.ttc.com.ge/pis-gateway/api/v2/stops?locale=en', { headers: getHeaders('https://transit.ttc.com.ge') }).then(r => r.json()),
            fetch('https://transit.ttc.com.ge/pis-gateway/api/v2/stops?locale=ka', { headers: getHeaders('https://transit.ttc.com.ge') }).then(r => r.json()),
            fetch('https://rustavi-transit.azrycloud.com/pis-gateway/api/v2/stops?locale=en', { headers: getHeaders('https://rustavi-transit.azrycloud.com') }).then(r => r.json()),
            fetch('https://rustavi-transit.azrycloud.com/pis-gateway/api/v2/stops?locale=ka', { headers: getHeaders('https://rustavi-transit.azrycloud.com') }).then(r => r.json())
        ]);

        const stopsMap = new Map();

        // Add Tbilisi stops
        tStopsEn.forEach(s => {
            const id = s.id.startsWith('1:') ? s.id : `1:${s.id}`;
            stopsMap.set(id, {
                id,
                name_en: s.name || '',
                name_ka: '',
                lat: s.lat || '',
                lon: s.lon || '',
                rotation: s.bearing || 0
            });
        });

        tStopsKa.forEach(s => {
            const id = s.id.startsWith('1:') ? s.id : `1:${s.id}`;
            if (stopsMap.has(id)) {
                stopsMap.get(id).name_ka = s.name || '';
            }
        });

        // Add Rustavi stops
        rStopsEn.forEach(s => {
            // Force 2: prefix for Rustavi even if API returns 1: or no prefix
            const rawId = s.id.includes(':') ? s.id.split(':')[1] : s.id;
            const id = `2:${rawId}`;
            stopsMap.set(id, {
                id,
                name_en: s.name || '',
                name_ka: '',
                lat: s.lat || '',
                lon: s.lon || '',
                rotation: s.bearing || 0
            });
        });

        rStopsKa.forEach(s => {
            const rawId = s.id.includes(':') ? s.id.split(':')[1] : s.id;
            const id = `2:${rawId}`;
            if (stopsMap.has(id)) {
                stopsMap.get(id).name_ka = s.name || '';
            }
        });

        console.log(`Fetched ${stopsMap.size} stops from API`);
        return Array.from(stopsMap.values());
    } catch (e) {
        console.warn('Failed to fetch stops from API:', e.message);
        return [];
    }
}

// Fallback: Load stops from local files
function loadStopsFromLocal() {
    console.log('Loading stops from local files...');

    const tStopsPath = path.resolve(__dirname, '../t_stops.json');
    const rStopsPath = path.resolve(__dirname, '../r_stops.json');

    let stops = [];

    if (fs.existsSync(tStopsPath)) {
        const tStops = JSON.parse(fs.readFileSync(tStopsPath, 'utf-8'));
        stops = stops.concat(tStops.map(s => ({
            id: `1:${s.id}`,
            name_en: s.name || '',
            name_ka: '',
            lat: s.lat || '',
            lon: s.lon || '',
            bearing: s.bearing || 0
        })));
    }

    if (fs.existsSync(rStopsPath)) {
        const rStops = JSON.parse(fs.readFileSync(rStopsPath, 'utf-8'));
        stops = stops.concat(rStops.map(s => ({
            id: `2:${s.id}`,
            name_en: s.name || '',
            name_ka: '',
            lat: s.lat || '',
            lon: s.lon || '',
            bearing: s.bearing || 0
        })));
    }

    return stops;
}

// Load existing overrides
function loadExistingOverrides(type) {
    const paths = type === 'routes'
        ? [
            path.resolve(__dirname, '../src/data/routes_config.json'),
            path.resolve(__dirname, '../public/data/routes_config.json')
        ]
        : [
            path.resolve(__dirname, '../src/data/stops_config.json'),
            path.resolve(__dirname, '../public/data/stops_config.json')
        ];

    for (const configPath of paths) {
        if (fs.existsSync(configPath)) {
            return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        }
    }

    return type === 'routes'
        ? { routeOverrides: {} }
        : { overrides: {}, merges: {}, hubs: {} };
}

// Load existing CSV overrides
function loadCSVOverrides(filePath) {
    if (!fs.existsSync(filePath)) return new Map();
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const rows = parseCSV(content);
        const map = new Map();
        rows.forEach(row => {
            if (row.id && !row.id.startsWith('---')) {
                map.set(row.id, row);
            }
        });
        return map;
    } catch (e) {
        console.warn(`Failed to load existing CSV from ${filePath}:`, e.message);
        return new Map();
    }
}

// Convert to CSV
function arrayToCSV(headers, rows) {
    const escapeField = (field) => {
        const str = String(field !== undefined && field !== null ? field : '');
        if (str.includes(',') || str.includes('"') || str.includes('\n')) {
            return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
    };

    const lines = [headers.map(escapeField).join(',')];
    rows.forEach(row => {
        const values = headers.map(h => escapeField(row[h]));
        lines.push(values.join(','));
    });

    return lines.join('\n');
}

// Main function
async function main() {
    const OUTPUT_DIR = path.resolve(__dirname, '../public/data');

    // Create output directory if it doesn't exist
    if (!fs.existsSync(OUTPUT_DIR)) {
        fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }

    console.log('Starting CSV population...\n');

    // === ROUTES ===
    console.log('Processing routes...');
    let apiRoutes = await fetchRoutesFromAPI();
    const routesConfig = loadExistingOverrides('routes');
    const routeOverrides = routesConfig.routeOverrides || {};

    // If API failed, create routes from existing overrides
    if (apiRoutes.length === 0 && Object.keys(routeOverrides).length > 0) {
        console.log('API failed, using existing overrides as source...');
        apiRoutes = Object.keys(routeOverrides).map(id => {
            // Add 1: prefix if not already present
            const fullId = id.includes(':') ? id : `1:${id}`;
            return {
                id: fullId,
                shortName: '',
                longName_en: '',
                longName_ka: '',
                dest0_en: '',
                dest0_ka: '',
                dest1_en: '',
                dest1_ka: ''
            };
        });
    }

    console.log(`Found ${apiRoutes.length} routes`);
    console.log(`Found ${Object.keys(routeOverrides).length} existing overrides`);

    // Load existing CSV overrides for merging
    const existingRoutesCSV = loadCSVOverrides(path.join(OUTPUT_DIR, 'routes_overrides.csv'));

    // Merge API data with overrides
    const routeRows = apiRoutes.map(route => {
        const override = routeOverrides[route.id] || routeOverrides[route.id.split(':')[1]] || {};
        const csvRow = existingRoutesCSV.get(route.id) || {};

        return {
            id: route.id,
            shortName: route.shortName,
            shortName_override: csvRow.shortName_override || override.shortName || '',
            isLoop: route.isLoop ? 'true' : '',
            longName_en: route.longName_en,
            longName_en_override: csvRow.longName_en_override || override.longName?.en || '',
            longName_ka: route.longName_ka,
            longName_ka_override: csvRow.longName_ka_override || override.longName?.ka || '',
            longName_ru_override: csvRow.longName_ru_override || override.longName?.ru || '',
            dest0_en: route.dest0_en,
            dest0_en_override: csvRow.dest0_en_override || override.destinations?.[0]?.headsign?.en || '',
            dest0_ka: route.dest0_ka,
            dest0_ka_override: csvRow.dest0_ka_override || override.destinations?.[0]?.headsign?.ka || '',
            dest0_ru_override: csvRow.dest0_ru_override || override.destinations?.[0]?.headsign?.ru || '',
            dest1_en: route.dest1_en,
            dest1_en_override: csvRow.dest1_en_override || override.destinations?.[1]?.headsign?.en || '',
            dest1_ka: route.dest1_ka,
            dest1_ka_override: csvRow.dest1_ka_override || override.destinations?.[1]?.headsign?.ka || '',
            dest1_ru_override: csvRow.dest1_ru_override || override.destinations?.[1]?.headsign?.ru || ''
        };
    });

    const routesHeaders = [
        'id', 'shortName', 'shortName_override',
        'isLoop', // New column
        'longName_en', 'longName_en_override',
        'longName_ka', 'longName_ka_override',
        'longName_ru_override',
        'dest0_en', 'dest0_en_override',
        'dest0_ka', 'dest0_ka_override',
        'dest0_ru_override',
        'dest1_en', 'dest1_en_override',
        'dest1_ka', 'dest1_ka_override',
        'dest1_ru_override'
    ];

    const routesCSV = arrayToCSV(routesHeaders, routeRows);
    const routesPath = path.join(OUTPUT_DIR, 'routes_overrides.csv');
    fs.writeFileSync(routesPath, routesCSV);
    console.log(`✓ Wrote ${routeRows.length} routes to routes_overrides.csv\n`);

    // === STOPS ===
    console.log('Processing stops...');
    let apiStops = await fetchStopsFromAPI();

    // If API failed, use local files
    if (apiStops.length === 0) {
        console.log('API failed, falling back to local files...');
        apiStops = loadStopsFromLocal();
    }

    const stopsConfig = loadExistingOverrides('stops');
    const stopOverrides = stopsConfig.overrides || {};
    const merges = stopsConfig.merges || {};
    const hubs = stopsConfig.hubs || {};

    // Load stop_bearings.json for route-calculated rotations
    let stopBearings = {};
    const bearingsPath = path.resolve(__dirname, '../src/data/stop_bearings.json');
    if (fs.existsSync(bearingsPath)) {
        try {
            stopBearings = JSON.parse(fs.readFileSync(bearingsPath, 'utf-8'));
            console.log(`Loaded ${Object.keys(stopBearings).length} rotations from stop_bearings.json`);
        } catch (e) {
            console.warn('Failed to load stop_bearings.json:', e.message);
        }
    }

    console.log(`Found ${apiStops.length} stops`);

    // Prepare natural sort function for ID
    const naturalSort = (a, b) => {
        const idA = String(a.id || '');
        const idB = String(b.id || '');
        const partsA = idA.split(/(\d+)/).filter(Boolean);
        const partsB = idB.split(/(\d+)/).filter(Boolean);
        for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
            const partA = partsA[i] || '';
            const partB = partsB[i] || '';
            const numA = parseInt(partA);
            const numB = parseInt(partB);
            if (!isNaN(numA) && !isNaN(numB)) {
                if (numA !== numB) return numA - numB;
            } else if (partA !== partB) return partA.localeCompare(partB);
        }
        return 0;
    };

    // Sort API stops first
    apiStops.sort(naturalSort);

    // Load existing CSV overrides for merging
    const existingStopsCSV = loadCSVOverrides(path.join(OUTPUT_DIR, 'stops_overrides.csv'));

    // Restoration Map (Hardcoded missing overrides)
    const restorationMap = {
        '1:20146': { name_en_override: 'Station Square (minibuses)' },
        '1:20254': { name_en_override: 'Darkveti Street #30' },
        '1:20164': { name_en_override: 'Railway Passage Bridge' }
    };

    // Merge API data with overrides
    const stopRows = apiStops.map(stop => {
        const stopIdParts = stop.id.split(':');
        const baseId = stopIdParts[stopIdParts.length - 1];
        const fullId = stop.id;
        const override = stopOverrides[fullId] || stopOverrides[baseId] || {};
        const csvRow = existingStopsCSV.get(stop.id) || {};
        const restoration = restorationMap[stop.id] || {};

        const mergeParent = csvRow.mergeParent || merges[fullId] || merges[baseId] || '';

        // Find hub target - check all hub groups
        let hubTarget = csvRow.hubTarget || '';
        if (!hubTarget) {
            for (const [hubId, members] of Object.entries(hubs)) {
                if ((members || []).some(m => m === fullId || m === baseId || m === `1:${baseId}`)) {
                    hubTarget = hubId;
                    break;
                }
            }
        }

        // Get rotation: CSV override > JSON override > stop_bearings.json > API
        let rotation = stop.rotation || 0;
        if (stopBearings[fullId] !== undefined) rotation = stopBearings[fullId];
        if (stopBearings[`1:${baseId}`] !== undefined) rotation = stopBearings[`1:${baseId}`];
        if (override.bearing !== undefined) rotation = override.bearing;

        // CSV override takes highest priority
        const rotationOverride = csvRow.rotation_override || '';

        return {
            id: stop.id,
            name_en: stop.name_en,
            name_en_override: csvRow.name_en_override || restoration.name_en_override || override.name?.en || '',
            name_ka: stop.name_ka,
            name_ka_override: csvRow.name_ka_override || override.name?.ka || '',
            name_ru_override: csvRow.name_ru_override || override.name?.ru || '',
            lat: stop.lat,
            lat_override: csvRow.lat_override || (override.lat !== undefined ? override.lat : ''),
            lon: stop.lon,
            lon_override: csvRow.lon_override || (override.lon !== undefined ? override.lon : ''),
            rotation: rotation,
            rotation_override: rotationOverride,
            mergeParent: mergeParent,
            hubTarget: hubTarget
        };
    });

    const stopsHeaders = [
        'id',
        'name_en', 'name_en_override',
        'name_ka', 'name_ka_override',
        'name_ru_override',
        'lat', 'lat_override',
        'lon', 'lon_override',
        'rotation', 'rotation_override',
        'mergeParent', 'hubTarget'
    ];

    // Split stops by source
    const tbilisiRows = stopRows.filter(r => r.id.startsWith('1:'));
    const rustaviRows = stopRows.filter(r => r.id.startsWith('2:'));
    const otherRows = stopRows.filter(r => !r.id.startsWith('1:') && !r.id.startsWith('2:'));

    // Create consolidated rows with separators
    const emptyRow = stopsHeaders.reduce((acc, h) => ({ ...acc, [h]: '' }), {});
    const consolidatedRows = [
        ...tbilisiRows,
        { ...emptyRow, id: '--- RUSTAVI STOPS ---' },
        emptyRow,
        ...rustaviRows,
        ...(otherRows.length > 0 ? [emptyRow, { ...emptyRow, id: '--- OTHER ---' }, ...otherRows] : [])
    ];

    // Write consolidated stops
    const combinedCSV = arrayToCSV(stopsHeaders, consolidatedRows);
    const combinedPath = path.join(OUTPUT_DIR, 'stops_overrides.csv');
    fs.writeFileSync(combinedPath, combinedCSV);
    console.log(`✓ Wrote ${consolidatedRows.length} rows to stops_overrides.csv (Consolidated)`);

    console.log('\nDone! CSV files populated successfully.');

    console.log(`\nYou can now edit these files in Excel/Numbers:`);
    console.log(`- ${path.join(OUTPUT_DIR, 'routes_overrides.csv')}`);
    console.log(`- ${path.join(OUTPUT_DIR, 'stops_overrides.csv')}`);

    console.log('\nRun this script again anytime to refresh API data while preserving overrides!');
}

main();
