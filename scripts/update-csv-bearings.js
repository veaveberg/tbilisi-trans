import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseCSV, rowsToCSV } from '../src/csv-parser.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BEARINGS_FILE = path.join(__dirname, '../src/data/stop_bearings.json');
const CSV_FILE = path.join(__dirname, '../public/data/stops_overrides.csv');
const RUSTAVI_STOPS_FILE = path.join(__dirname, '../public/data/rustavi_stops_en.json');
const RUSTAVI_STOPS_KA_FILE = path.join(__dirname, '../public/data/rustavi_stops_ka.json');

const bearings = JSON.parse(fs.readFileSync(BEARINGS_FILE, 'utf-8'));
const csv = fs.readFileSync(CSV_FILE, 'utf-8');
const rows = parseCSV(csv);
const rustaviStops = JSON.parse(fs.readFileSync(RUSTAVI_STOPS_FILE, 'utf-8'));
const rustaviStopsKa = fs.existsSync(RUSTAVI_STOPS_KA_FILE)
    ? JSON.parse(fs.readFileSync(RUSTAVI_STOPS_KA_FILE, 'utf-8'))
    : [];

const kaNameById = new Map(rustaviStopsKa.map(stop => [stop.id, stop.name || '']));
const rowById = new Map(rows.map(row => [row.id, row]));
const headers = [
    'id',
    'name_en',
    'name_en_override',
    'name_ka',
    'name_ka_override',
    'name_ru_override',
    'lat',
    'lat_override',
    'lon',
    'lon_override',
    'rotation',
    'rotation_override',
    'mergeParent',
    'hubTarget',
    'vehicleMode_override',
    'provider_override',
    'gondolaInfo_override'
];

// Track existing IDs
let updated = 0;

for (const stop of rustaviStops) {
    const appId = 'r' + stop.id.replace('1:', '');
    const bearing = bearings[appId];

    if (!rowById.has(appId)) continue;
    if (bearing === undefined) continue;

    const row = rowById.get(appId);
    if (String(row.rotation || '') !== String(bearing)) {
        row.rotation = String(bearing);
        updated++;
    }
}

console.log(`Updated rotation for ${updated} existing Rustavi stops`);

// Add missing Rustavi stops
let added = 0;

for (const stop of rustaviStops) {
    const appId = 'r' + stop.id.replace('1:', '');
    if (rowById.has(appId)) continue;

    rows.push({
        id: appId,
        name_en: stop.name || '',
        name_en_override: '',
        name_ka: kaNameById.get(stop.id) || '',
        name_ka_override: '',
        name_ru_override: '',
        lat: stop.lat || '',
        lat_override: '',
        lon: stop.lon || '',
        lon_override: '',
        rotation: String(bearings[appId] ?? 0),
        rotation_override: '',
        mergeParent: '',
        hubTarget: '',
        vehicleMode_override: '',
        provider_override: '',
        gondolaInfo_override: ''
    });
    added++;
}

console.log(`Added ${added} new Rustavi stops`);

rows.sort((a, b) => String(a.id || '').localeCompare(String(b.id || ''), undefined, { numeric: true }));
fs.writeFileSync(CSV_FILE, rowsToCSV(rows, headers));
console.log(`\nTotal: ${updated} updated, ${added} added to ${CSV_FILE}`);
