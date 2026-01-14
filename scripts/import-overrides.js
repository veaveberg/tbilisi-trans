import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ConvexHttpClient } from "convex/browser";
import * as dotenv from 'dotenv';

// Load env vars
dotenv.config({ path: '.env.local' });
dotenv.config();

const CONVEX_URL = process.env.VITE_CONVEX_URL;
if (!CONVEX_URL) {
    console.error("VITE_CONVEX_URL is not defined.");
    process.exit(1);
}

const client = new ConvexHttpClient(CONVEX_URL);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CSV_PATH = path.join(__dirname, '../routes_overrides_260111.csv');

function parseCSV(filePath) {
    return new Promise((resolve, reject) => {
        const results = [];
        fs.createReadStream(filePath)
            .pipe(csv())
            .on('data', (data) => results.push(data))
            .on('end', () => resolve(results))
            .on('error', reject);
    });
}

// Manual CSV Parser just in case
function parseCSVManual(text) {
    const lines = text.trim().split('\n');
    const headers = lines[0].split(',').map(h => h.trim());

    return lines.slice(1).map(line => {
        // Handle quoted fields
        const values = [];
        let currentValue = '';
        let inQuotes = false;

        for (let i = 0; i < line.length; i++) {
            const char = line[i];
            if (char === '"') {
                inQuotes = !inQuotes;
            } else if (char === ',' && !inQuotes) {
                values.push(currentValue);
                currentValue = '';
            } else {
                currentValue += char;
            }
        }
        values.push(currentValue); // last value

        const obj = {};
        headers.forEach((h, i) => {
            let val = values[i] ? values[i].trim() : '';
            // Remove wrapping quotes if present
            if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1).replace(/""/g, '"');

            // Convert types
            if (h === 'isLoop' || h === 'invertDirection') {
                obj[h] = val.toLowerCase() === 'true';
            } else {
                obj[h] = val === '' ? undefined : val;
            }
        });
        return obj;
    });
}


async function run() {
    console.log(`Reading CSV from ${CSV_PATH}...`);
    const fileContent = fs.readFileSync(CSV_PATH, 'utf-8');
    const overrides = parseCSVManual(fileContent);

    console.log(`Parsed ${overrides.length} overrides. Uploading to Convex...`);

    // We need a mutation to save these. We'll use a generic internal mutation exposed or make a new one.
    // Let's create `transit:saveOverrides` first.

    // Since we can't edit transit.ts mid-script efficiently without restarting loop, 
    // I assume we'll add the mutation in the next step.
    // For now, let's just log what we WOULD do.

    // Chunking
    const BATCH_SIZE = 50;
    for (let i = 0; i < overrides.length; i += BATCH_SIZE) {
        const batch = overrides.slice(i, i + BATCH_SIZE);
        console.log(`Uploading batch ${i} - ${i + BATCH_SIZE}...`);
        await client.mutation("transit:saveOverrides", { overrides: batch });
    }

    console.log("Done!");
}

run().catch(console.error);
