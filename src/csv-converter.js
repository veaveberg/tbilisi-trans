/**
 * CSV Converter Utility
 * Converts between JSON config format and CSV format for routes and stops
 */

import fs from 'fs';
import { parseCSV, rowsToCSV } from './csv-parser.js';

/**
 * Convert routes config JSON to CSV
 * @param {Object} config - Routes config object { routeOverrides: {...} }
 * @param {string} existingCsvPath - Path to existing CSV file (to preserve original values)
 * @returns {string} CSV content
 */
export async function convertRoutesConfigToCSV(config, existingCsvPath) {
    const overrides = config.routeOverrides || {};

    // Load existing CSV to preserve original value columns
    let existingRows = [];
    if (fs.existsSync(existingCsvPath)) {
        const csvText = fs.readFileSync(existingCsvPath, 'utf-8');
        existingRows = parseCSV(csvText);
    }

    // Create a map of existing rows by ID
    const rowsMap = new Map();
    existingRows.forEach(row => {
        if (row.id) rowsMap.set(row.id, { ...row });
    });

    // Create a normalized overrides map
    const normalizedOverrides = {};
    Object.keys(overrides).forEach(key => {
        const baseId = key.includes(':') ? key.split(':')[1] : key;
        const existing = normalizedOverrides[baseId];
        normalizedOverrides[baseId] = { ...(existing || {}), ...overrides[key] };
    });

    // Process rows
    rowsMap.forEach((row, id) => {
        const baseId = id.includes(':') ? id.split(':')[1] : id;
        const override = normalizedOverrides[baseId];

        if (override) {
            console.log(`[CSV Converter] Applying route override to ${id}`);
            // Clear all override columns
            row.shortName_override = '';
            row.longName_en_override = '';
            row.longName_ka_override = '';
            row.longName_ru_override = '';
            row.dest0_en_override = '';
            row.dest0_ka_override = '';
            row.dest0_ru_override = '';
            row.dest1_en_override = '';
            row.dest1_ka_override = '';
            row.dest1_ru_override = '';
            row.isLoop = '';
            row.terminusStopId_override = '';
            row.invertDirection = '';

            // Apply new overrides
            if (override.shortName) {
                row.shortName_override = override.shortName;
            }

            if (override.longName) {
                if (override.longName.en) row.longName_en_override = override.longName.en;
                if (override.longName.ka) row.longName_ka_override = override.longName.ka;
                if (override.longName.ru) row.longName_ru_override = override.longName.ru;
            }

            if (override.destinations) {
                Object.keys(override.destinations).forEach(dir => {
                    const headsign = override.destinations[dir].headsign;
                    if (headsign) {
                        if (headsign.en) row[`dest${dir}_en_override`] = headsign.en;
                        if (headsign.ka) row[`dest${dir}_ka_override`] = headsign.ka;
                        if (headsign.ru) row[`dest${dir}_ru_override`] = headsign.ru;
                    }
                });
            }

            if (override.isLoop !== undefined) {
                row.isLoop = override.isLoop ? 'true' : '';
            }
            if (override.terminusStopIdOverride !== undefined) {
                row.terminusStopId_override = override.terminusStopIdOverride;
            }
            if (override.invertDirection !== undefined) {
                row.invertDirection = override.invertDirection ? 'true' : '';
            }
            if (override.terminusStopName !== undefined) {
                row.terminusStopName = override.terminusStopName;
            }
        }
    });

    // Convert to array and sort naturally by ID
    const rows = Array.from(rowsMap.values());

    // Natural sort function for IDs (handles numeric parts correctly)
    rows.sort((a, b) => {
        const idA = a.id || '';
        const idB = b.id || '';

        // Split by colon and numbers
        const partsA = idA.split(/(\d+)/).filter(Boolean);
        const partsB = idB.split(/(\d+)/).filter(Boolean);

        for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
            const partA = partsA[i] || '';
            const partB = partsB[i] || '';

            // If both are numbers, compare numerically
            const numA = parseInt(partA);
            const numB = parseInt(partB);

            if (!isNaN(numA) && !isNaN(numB)) {
                if (numA !== numB) return numA - numB;
            } else {
                // String comparison
                if (partA !== partB) return partA.localeCompare(partB);
            }
        }

        return 0;
    });

    const headers = [
        'id', 'shortName', 'shortName_override',
        'longName_en', 'longName_en_override',
        'longName_ka', 'longName_ka_override',
        'longName_ru_override',
        'dest0_en', 'dest0_en_override',
        'dest0_ka', 'dest0_ka_override',
        'dest0_ru_override',
        'dest1_en', 'dest1_en_override',
        'dest1_ka', 'dest1_ka_override',
        'dest1_ru_override',
        'isLoop', 'terminusStopId', 'terminusStopId_override', 'terminusStopName',
        'invertDirection'
    ];

    return rowsToCSV(rows, headers);
}

/**
 * @param {Object} config - Stops config object { overrides: {...}, merges: {...}, hubs: {...} }
 * @param {string} existingCsvPath - Path to existing CSV file (to preserve original values)
 * @returns {Promise<string>} Updated CSV content
 */
export async function convertStopsConfigToCSV(config, existingCsvPath) {
    const overrides = config.overrides || {};
    const merges = config.merges || {};
    const hubs = config.hubs || {};

    console.log('[CSV Converter] Converting stops config to CSV');
    console.log('[CSV Converter] Input: overrides=', Object.keys(overrides).length, 'merges=', Object.keys(merges).length, 'hubs=', Object.keys(hubs).length);

    // Load existing CSV to preserve original value columns
    let existingRows = [];
    if (fs.existsSync(existingCsvPath)) {
        const csvText = fs.readFileSync(existingCsvPath, 'utf-8');
        existingRows = parseCSV(csvText);
        console.log('[CSV Converter] Loaded', existingRows.length, 'existing rows from CSV');
    } else {
        console.log('[CSV Converter] No existing CSV found at', existingCsvPath);
    }

    // Create a map of existing rows by ID
    const rowsMap = new Map();
    existingRows.forEach(row => {
        if (row.id) rowsMap.set(row.id, { ...row });
    });
    console.log('[CSV Converter] Created rowsMap with', rowsMap.size, 'entries');

    const stopKey = (id) => {
        const raw = String(id || '');
        const stripped = raw.replace(/^(rustavi:|[12]:)/i, '');
        if (/^r\d/i.test(stripped) || raw.startsWith('2:') || raw.toLowerCase().startsWith('rustavi:')) {
            return `rustavi:${stripped.replace(/^r/i, '')}`;
        }
        return `tbilisi:${stripped}`;
    };

    const findRowId = (id) => {
        const key = stopKey(id);
        for (const rowId of rowsMap.keys()) {
            if (stopKey(rowId) === key) return rowId;
        }
        return null;
    };

    const preferAppIdLast = (a, b) => {
        const apiPrefixA = /^(rustavi:|[12]:)/i.test(String(a));
        const apiPrefixB = /^(rustavi:|[12]:)/i.test(String(b));
        return Number(apiPrefixB) - Number(apiPrefixA);
    };

    const getByStopId = (collection, id) => {
        if (!collection) return undefined;
        const key = stopKey(id);
        let match;
        Object.keys(collection).sort(preferAppIdLast).forEach(collectionId => {
            if (stopKey(collectionId) === key) match = collection[collectionId];
        });
        return match;
    };

    const hasHubMember = (members, id) => {
        if (!Array.isArray(members)) return false;
        const key = stopKey(id);
        return members.some(memberId => stopKey(memberId) === key);
    };

    // Create a normalized overrides map to handle duplicates like "1:811" and "811"
    // without colliding with Rustavi IDs like "2:811" or "r811".
    const normalizedOverrides = {};
    Object.keys(overrides).sort(preferAppIdLast).forEach(key => {
        const baseId = stopKey(key);
        const existing = normalizedOverrides[baseId];

        // If we already have a prefixed one and this is a base one, or vice-versa, merge them
        // We assume the one from the client's memory is what we want.
        // Actually, let's just use the baseId as the key for the search map.
        normalizedOverrides[baseId] = { ...(existing || {}), ...overrides[key] };
    });

    // Process ALL existing rows first (to preserve them)
    rowsMap.forEach((row, id) => {
        // Clear all override columns
        row.name_en_override = '';
        row.name_ka_override = '';
        row.name_ru_override = '';
        row.lat_override = '';
        row.lon_override = '';
        row.rotation_override = '';
        row.mergeParent = '';
        row.hubTarget = '';
        row.vehicleMode_override = '';
        row.provider_override = '';
        row.gondolaInfo_override = '';

        // Try to find override using normalized map
        const baseId = stopKey(id);
        const override = normalizedOverrides[baseId];

        if (override) {
            console.log(`[CSV Converter] Applying override to ${id}:`, JSON.stringify(override));
            if (override.name) {
                if (override.name.en !== undefined) row.name_en_override = override.name.en;
                if (override.name.ka !== undefined) row.name_ka_override = override.name.ka;
                if (override.name.ru !== undefined) row.name_ru_override = override.name.ru;
            }
            if (override.lat !== undefined) row.lat_override = override.lat;
            if (override.lon !== undefined) row.lon_override = override.lon;
            if (override.rotation !== undefined) row.rotation_override = override.rotation;
            if (override.bearing !== undefined) row.rotation_override = override.bearing;
            if (override.vehicleMode !== undefined) row.vehicleMode_override = override.vehicleMode;
            if (override.provider !== undefined) row.provider_override = override.provider;
            if (override.gondolaInfo !== undefined) row.gondolaInfo_override = override.gondolaInfo;
        }

        // Apply merges (normalize incoming merges too)
        const normalizedMerges = {};
        Object.keys(merges).sort(preferAppIdLast).forEach(k => {
            const b = stopKey(k);
            normalizedMerges[b] = merges[k];
        });

        const mergeParent = normalizedMerges[baseId];
        if (mergeParent) {
            row.mergeParent = mergeParent;
        }

        // Apply hubs
        Object.keys(hubs).forEach(hubId => {
            const members = hubs[hubId];
            if (hasHubMember(members, id)) {
                row.hubTarget = hubId;
            }
        });
    });

    // Add any NEW stops that aren't in the existing CSV
    const allStopIds = new Set([
        ...Object.keys(overrides),
        ...Object.keys(merges),
        ...Object.values(hubs).flat()
    ]);

    allStopIds.forEach(id => {
        // Find if we already have this ID or one with the same baseId
        let existingId = null;
        if (rowsMap.has(id)) {
            existingId = id;
        } else {
            existingId = findRowId(id);
        }

        if (!existingId) {
            // Create new row for this stop
            let row = { id };

            // Clear all override columns
            row.name_en_override = '';
            row.name_ka_override = '';
            row.name_ru_override = '';
            row.lat_override = '';
            row.lon_override = '';
            row.rotation_override = '';
            row.mergeParent = '';
            row.hubTarget = '';
            row.vehicleMode_override = '';
            row.provider_override = '';
            row.gondolaInfo_override = '';

            // Apply overrides
            const override = getByStopId(overrides, id);
            if (override) {
                if (override.name) {
                    if (override.name.en !== undefined) row.name_en_override = override.name.en;
                    if (override.name.ka !== undefined) row.name_ka_override = override.name.ka;
                    if (override.name.ru !== undefined) row.name_ru_override = override.name.ru;
                }
                if (override.lat !== undefined) row.lat_override = override.lat;
                if (override.lon !== undefined) row.lon_override = override.lon;
                if (override.rotation !== undefined) row.rotation_override = override.rotation;
                if (override.vehicleMode !== undefined) row.vehicleMode_override = override.vehicleMode;
                if (override.provider !== undefined) row.provider_override = override.provider;
                if (override.gondolaInfo !== undefined) row.gondolaInfo_override = override.gondolaInfo;
            }

            // Apply merges
            const mergeParent = getByStopId(merges, id);
            if (mergeParent) {
                row.mergeParent = mergeParent;
            }

            // Apply hubs
            Object.keys(hubs).forEach(hubId => {
                if (hasHubMember(hubs[hubId], id)) {
                    row.hubTarget = hubId;
                }
            });

            rowsMap.set(id, row);
        }
    });

    console.log('[CSV Converter] After processing: rowsMap has', rowsMap.size, 'entries');

    // Count rows with overrides for debugging
    let overrideCount = 0;
    rowsMap.forEach(row => {
        if (row.name_en_override || row.name_ka_override || row.lat_override || row.lon_override || row.rotation_override) {
            overrideCount++;
        }
    });
    console.log('[CSV Converter] Rows with overrides:', overrideCount);

    // Convert to array and filter out previously saved separators
    let rows = Array.from(rowsMap.values()).filter(r => r.id && !r.id.startsWith('---'));

    // Natural sort function for IDs (handles numeric parts correctly)
    const naturalSort = (a, b) => {
        const idA = a.id || '';
        const idB = b.id || '';

        // Split by colon and numbers
        const partsA = idA.split(/(\d+)/).filter(Boolean);
        const partsB = idB.split(/(\d+)/).filter(Boolean);

        for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
            const partA = partsA[i] || '';
            const partB = partsB[i] || '';

            // If both are numbers, compare numerically
            const numA = parseInt(partA);
            const numB = parseInt(partB);

            if (!isNaN(numA) && !isNaN(numB)) {
                if (numA !== numB) return numA - numB;
            } else {
                // String comparison
                if (partA !== partB) return partA.localeCompare(partB);
            }
        }
        return 0;
    };

    // Split into groups and sort each
    const tbilisiRows = rows.filter(r => r.id.startsWith('1:')).sort(naturalSort);
    const rustaviRows = rows.filter(r => r.id.startsWith('2:')).sort(naturalSort);
    const otherRows = rows.filter(r => !r.id.startsWith('1:') && !r.id.startsWith('2:')).sort(naturalSort);

    const stopsHeaders = [
        'id',
        'name_en', 'name_en_override',
        'name_ka', 'name_ka_override',
        'name_ru_override',
        'lat', 'lat_override',
        'lon', 'lon_override',
        'rotation', 'rotation_override',
        'mergeParent', 'hubTarget',
        'vehicleMode_override', 'provider_override', 'gondolaInfo_override'
    ];

    const emptyRow = stopsHeaders.reduce((acc, h) => ({ ...acc, [h]: '' }), {});

    const consolidatedRows = [
        ...tbilisiRows,
        { ...emptyRow, id: '--- RUSTAVI STOPS ---' },
        emptyRow,
        ...rustaviRows,
        ...(otherRows.length > 0 ? [emptyRow, { ...emptyRow, id: '--- OTHER ---' }, ...otherRows] : [])
    ];

    console.log('[CSV Converter] Generating consolidated CSV with', consolidatedRows.length, 'rows');
    return rowsToCSV(consolidatedRows, stopsHeaders);
}
