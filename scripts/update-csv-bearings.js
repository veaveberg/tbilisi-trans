import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BEARINGS_FILE = path.join(__dirname, '../src/data/stop_bearings.json');
const CSV_FILE = path.join(__dirname, '../public/data/stops_overrides.csv');
const RUSTAVI_STOPS_FILE = path.join(__dirname, '../public/data/rustavi_stops_en.json');

const bearings = JSON.parse(fs.readFileSync(BEARINGS_FILE, 'utf-8'));
const csv = fs.readFileSync(CSV_FILE, 'utf-8');
const lines = csv.split('\n');
const header = lines[0];

// Find column indices
const headers = header.split(',');
const rotationIndex = headers.indexOf('rotation');
console.log('Rotation column index:', rotationIndex);

// Track existing IDs
const existingIds = new Set();

let updated = 0;
const newLines = [header];

// Update existing lines
for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;

    const parts = line.split(',');
    const id = parts[0];
    existingIds.add(id);

    // Update rotation column with new bearing
    if (bearings[id] !== undefined) {
        parts[rotationIndex] = String(bearings[id]);
        updated++;
    }

    newLines.push(parts.join(','));
}

console.log(`Updated rotation for ${updated} existing stops`);

// Add missing Rustavi stops
let added = 0;
const rustaviStops = JSON.parse(fs.readFileSync(RUSTAVI_STOPS_FILE, 'utf-8'));

for (const stop of rustaviStops) {
    // Convert 1:xxx to rxxx
    const appId = 'r' + stop.id.replace('1:', '');

    if (existingIds.has(appId)) continue;

    const rotation = bearings[appId] || 0;

    // Build row: id,name_en,name_en_override,name_ka,name_ka_override,name_ru_override,lat,lat_override,lon,lon_override,rotation,rotation_override,mergeParent,hubTarget
    const row = [
        appId,                    // id
        stop.name || '',          // name_en
        '',                       // name_en_override
        '',                       // name_ka (will need to get from ka file)
        '',                       // name_ka_override
        '',                       // name_ru_override
        stop.lat || '',           // lat
        '',                       // lat_override
        stop.lon || '',           // lon
        '',                       // lon_override
        rotation,                 // rotation
        '',                       // rotation_override
        '',                       // mergeParent
        ''                        // hubTarget
    ];

    newLines.push(row.join(','));
    added++;
}

console.log(`Added ${added} new Rustavi stops`);

fs.writeFileSync(CSV_FILE, newLines.join('\n'));
console.log(`\nTotal: ${updated} updated, ${added} added to ${CSV_FILE}`);
