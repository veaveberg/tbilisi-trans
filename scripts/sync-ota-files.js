import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'public/data');
const PUBLIC_MANIFEST_PATH = path.join(DATA_DIR, 'manifest.json');
const OTA_DIR = path.join(ROOT_DIR, 'ota');
const OTA_FILES_DIR = path.join(OTA_DIR, 'files');
const OTA_MANIFEST_PATH = path.join(OTA_DIR, 'manifest.json');

function readPublicManifest() {
    if (!fs.existsSync(PUBLIC_MANIFEST_PATH)) {
        throw new Error('public/data/manifest.json does not exist. Run scripts/write-data-manifest.js first.');
    }

    return JSON.parse(fs.readFileSync(PUBLIC_MANIFEST_PATH, 'utf8'));
}

function syncOtaFiles(manifest) {
    fs.rmSync(OTA_FILES_DIR, { recursive: true, force: true });
    fs.mkdirSync(OTA_FILES_DIR, { recursive: true });

    let copied = 0;
    for (const filename of Object.keys(manifest.files || {})) {
        const sourcePath = path.join(DATA_DIR, filename);
        if (!fs.existsSync(sourcePath)) {
            console.warn(`[OTA] Skipping missing manifest file: ${filename}`);
            continue;
        }

        fs.copyFileSync(sourcePath, path.join(OTA_FILES_DIR, filename));
        copied += 1;
    }

    return copied;
}

function buildOtaManifest(manifest) {
    const files = {};
    for (const [filename, entry] of Object.entries(manifest.files || {})) {
        files[filename] = {
            ...entry,
            url: `files/${filename}`
        };
    }

    return {
        ...manifest,
        distribution: 'ota',
        files
    };
}

const publicManifest = readPublicManifest();
const copied = syncOtaFiles(publicManifest);
const otaManifest = buildOtaManifest(publicManifest);

fs.mkdirSync(OTA_DIR, { recursive: true });
fs.writeFileSync(OTA_MANIFEST_PATH, `${JSON.stringify(otaManifest, null, 2)}\n`);

console.log(`[OTA] Copied ${copied} file(s) to ${path.relative(ROOT_DIR, OTA_FILES_DIR)}`);
console.log(`[OTA] Wrote ${path.relative(ROOT_DIR, OTA_MANIFEST_PATH)}`);
