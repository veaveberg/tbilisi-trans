import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CSV_FILE = path.join(__dirname, '../public/data/stops_overrides.csv');

const csv = fs.readFileSync(CSV_FILE, 'utf-8');
const lines = csv.split('\n');
const header = lines[0];
const headers = header.split(',');

// Find column indices
const rotationIndex = headers.indexOf('rotation');
console.log('Header:', headers.join(' | '));
console.log('Rotation column index:', rotationIndex);

// Parse all rows
const rustaviR = new Map();    // rxxx -> row parts
const rustaviTwo = new Map();  // 2:xxx -> row parts  
const otherRows = [];          // non-Rustavi rows

for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;

    const parts = line.split(',');
    const id = parts[0];

    if (id.startsWith('r')) {
        // Store rxxx rows keyed by numeric part
        const numPart = id.substring(1);
        rustaviR.set(numPart, parts);
    } else if (id.startsWith('2:')) {
        // Store 2:xxx rows keyed by numeric part
        const numPart = id.substring(2);
        rustaviTwo.set(numPart, parts);
    } else {
        otherRows.push(parts);
    }
}

console.log(`Found ${rustaviR.size} rxxx stops and ${rustaviTwo.size} 2:xxx stops`);

// Merge: use 2:xxx data but change ID to rxxx and add rotation from rxxx
const mergedRustavi = [];
let merged = 0;
let rOnlyCount = 0;

// Process all 2:xxx stops
for (const [numPart, twoParts] of rustaviTwo) {
    // Change ID from 2:xxx to rxxx
    twoParts[0] = 'r' + numPart;

    // Get rotation from rxxx version if it exists
    if (rustaviR.has(numPart)) {
        const rParts = rustaviR.get(numPart);
        twoParts[rotationIndex] = rParts[rotationIndex];
        merged++;
    }

    mergedRustavi.push(twoParts);
}

// Also add any rxxx stops that don't have a 2:xxx counterpart
for (const [numPart, rParts] of rustaviR) {
    if (!rustaviTwo.has(numPart)) {
        mergedRustavi.push(rParts);
        rOnlyCount++;
    }
}

console.log(`Merged ${merged} stops, kept ${rOnlyCount} r-only stops`);

// Sort merged Rustavi by numeric ID
mergedRustavi.sort((a, b) => {
    const numA = parseInt(a[0].substring(1)) || 0;
    const numB = parseInt(b[0].substring(1)) || 0;
    return numA - numB;
});

// Combine all rows and write
const newLines = [header];
for (const parts of otherRows) {
    newLines.push(parts.join(','));
}
for (const parts of mergedRustavi) {
    newLines.push(parts.join(','));
}

fs.writeFileSync(CSV_FILE, newLines.join('\n'));
console.log(`\nWrote ${newLines.length - 1} stops to ${CSV_FILE}`);
