import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DATA_FILES } from './data-files.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'public/data');
const ARCHIVE_ROOT = path.join(ROOT_DIR, 'data-archive');

function formatArchiveId(date = new Date()) {
    const yy = String(date.getFullYear()).slice(-2);
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    const hh = String(date.getHours()).padStart(2, '0');
    const mi = String(date.getMinutes()).padStart(2, '0');
    return `${yy}${mm}${dd}-${hh}${mi}`;
}

function getArchiveDir() {
    const baseId = process.env.DATA_ARCHIVE_ID || formatArchiveId();
    let archiveDir = path.join(ARCHIVE_ROOT, baseId);
    let suffix = 2;

    while (fs.existsSync(archiveDir)) {
        archiveDir = path.join(ARCHIVE_ROOT, `${baseId}-${suffix}`);
        suffix += 1;
    }

    return archiveDir;
}

function copyIfExists(filename, archiveDir) {
    const source = path.join(DATA_DIR, filename);
    if (!fs.existsSync(source)) return false;
    fs.copyFileSync(source, path.join(archiveDir, filename));
    return true;
}

function archiveCurrentData() {
    fs.mkdirSync(ARCHIVE_ROOT, { recursive: true });
    const archiveDir = getArchiveDir();
    fs.mkdirSync(archiveDir, { recursive: true });

    let copied = 0;
    for (const { name } of DATA_FILES) {
        if (copyIfExists(name, archiveDir)) copied += 1;
    }
    if (copyIfExists('manifest.json', archiveDir)) copied += 1;

    const meta = {
        archivedAt: new Date().toISOString(),
        sourceDir: 'public/data',
        fileCount: copied
    };
    fs.writeFileSync(path.join(archiveDir, 'archive-meta.json'), `${JSON.stringify(meta, null, 2)}\n`);

    console.log(`[Data Update] Archived ${copied} file(s) to ${path.relative(ROOT_DIR, archiveDir)}`);
}

function run(command, args) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd: ROOT_DIR,
            stdio: 'inherit',
            shell: false
        });
        child.on('error', reject);
        child.on('exit', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`${command} ${args.join(' ')} exited with ${code}`));
        });
    });
}

async function main() {
    const skipArchive = process.argv.includes('--skip-archive');
    const skipFetch = process.argv.includes('--skip-fetch');

    if (!skipArchive) archiveCurrentData();

    if (!skipFetch) {
        console.log('[Data Update] Regenerating public/data from upstream APIs...');
        await run('npm', ['run', 'prefetch']);
    }

    console.log('[Data Update] Writing public/data/manifest.json...');
    await run('node', ['scripts/write-data-manifest.js']);

    console.log('[Data Update] Done');
}

main().catch((error) => {
    console.error(`[Data Update] Failed: ${error.message}`);
    process.exit(1);
});

