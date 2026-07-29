import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DATA_FILES } from './data-files.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'public/data');
const MANIFEST_PATH = path.join(DATA_DIR, 'manifest.json');
const DEFAULT_MIN_APP_VERSION = '26.5.3';

function sha256(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

function formatVersion(date = new Date()) {
    const yy = String(date.getFullYear()).slice(-2);
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    const hh = String(date.getHours()).padStart(2, '0');
    const mi = String(date.getMinutes()).padStart(2, '0');
    return `${yy}${mm}${dd}-${hh}${mi}`;
}

function buildManifest() {
    const generatedAt = new Date().toISOString();
    const baseDatasetVersion = process.env.DATA_VERSION || formatVersion();
    const correctionsVersion = process.env.CORRECTIONS_VERSION || baseDatasetVersion;
    const files = {};

    for (const descriptor of DATA_FILES) {
        const filePath = path.join(DATA_DIR, descriptor.name);
        if (!fs.existsSync(filePath)) {
            console.warn(`[Data Manifest] Skipping missing file: ${descriptor.name}`);
            continue;
        }

        const contents = fs.readFileSync(filePath);
        files[descriptor.name] = {
            category: descriptor.category,
            sha256: sha256(contents),
            size: contents.length,
            url: descriptor.name
        };

        if (descriptor.source) files[descriptor.name].source = descriptor.source;
        if (descriptor.locale) files[descriptor.name].locale = descriptor.locale;
    }

    return {
        manifestVersion: 1,
        generatedAt,
        baseDatasetVersion,
        correctionsVersion,
        minAppVersion: process.env.MIN_APP_VERSION || DEFAULT_MIN_APP_VERSION,
        files
    };
}

const manifest = buildManifest();
fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`[Data Manifest] Wrote ${path.relative(ROOT_DIR, MANIFEST_PATH)}`);
console.log(`[Data Manifest] Version ${manifest.baseDatasetVersion}, ${Object.keys(manifest.files).length} files`);
