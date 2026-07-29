import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ConvexHttpClient } from 'convex/browser';
import * as dotenv from 'dotenv';
import { rowsToCSV } from '../src/csv-parser.js';

dotenv.config({ path: '.env.local' });
dotenv.config();

const CONVEX_URL = process.env.VITE_CONVEX_URL;
if (!CONVEX_URL) {
    console.error('VITE_CONVEX_URL is not defined.');
    process.exit(1);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const OUTPUT_PATH = path.join(__dirname, '../public/data/routes_overrides.csv');

const HEADERS = [
    'id',
    'shortName',
    'shortName_override',
    'isLoop',
    'longName_en',
    'longName_en_override',
    'longName_ka',
    'longName_ka_override',
    'longName_ru',
    'longName_ru_override',
    'dest0_en',
    'dest0_en_override',
    'dest0_ka',
    'dest0_ka_override',
    'dest0_ru',
    'dest0_ru_override',
    'dest1_en',
    'dest1_en_override',
    'dest1_ka',
    'dest1_ka_override',
    'dest1_ru',
    'dest1_ru_override',
    'terminusStopId',
    'terminusStopId_override',
    'terminusStopName',
    'virtualTerminusStopId',
    'invertDirection'
];

function cleanValue(value) {
    if (value === undefined || value === null) return '';
    if (typeof value === 'boolean') return value ? 'true' : '';
    return value;
}

function naturalRouteSort(a, b) {
    return String(a.id || '').localeCompare(String(b.id || ''), undefined, {
        numeric: true,
        sensitivity: 'base'
    });
}

const client = new ConvexHttpClient(CONVEX_URL);
const overrides = await client.query('transit:getAllOverrides');

const rows = overrides
    .filter((override) => override && override.routeId)
    .map((override) => {
        const row = {};
        HEADERS.forEach((header) => {
            row[header] = cleanValue(header === 'id' ? override.routeId : override[header]);
        });
        return row;
    })
    .sort(naturalRouteSort);

fs.writeFileSync(OUTPUT_PATH, `${rowsToCSV(rows, HEADERS)}\n`);
console.log(`[Route Overrides] Exported ${rows.length} rows to ${path.relative(path.join(__dirname, '..'), OUTPUT_PATH)}`);
