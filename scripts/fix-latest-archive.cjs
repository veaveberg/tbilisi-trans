const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Find the latest archive in ~/Library/Developer/Xcode/Archives
const archivesBaseDir = path.join(os.homedir(), 'Library/Developer/Xcode/Archives');

if (!fs.existsSync(archivesBaseDir)) {
  console.error(`Error: Archives directory not found at ${archivesBaseDir}`);
  process.exit(1);
}

// Find all YYYY-MM-DD directories
const dates = fs.readdirSync(archivesBaseDir)
  .filter(file => fs.statSync(path.join(archivesBaseDir, file)).isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(file))
  .sort()
  .reverse();

if (dates.length === 0) {
  console.error('Error: No archive directories found.');
  process.exit(1);
}

let latestArchive = null;

for (const dateDir of dates) {
  const datePath = path.join(archivesBaseDir, dateDir);
  const archives = fs.readdirSync(datePath)
    .filter(file => file.endsWith('.xcarchive'))
    .map(file => ({
      name: file,
      path: path.join(datePath, file),
      mtime: fs.statSync(path.join(datePath, file)).mtime
    }))
    .sort((a, b) => b.mtime - a.mtime);

  if (archives.length > 0) {
    latestArchive = archives[0].path;
    break;
  }
}

if (!latestArchive) {
  console.error('Error: No .xcarchive files found.');
  process.exit(1);
}

console.log(`Found latest archive: ${latestArchive}`);

// Find the Info.plist inside the app bundle in the archive
const productsDir = path.join(latestArchive, 'Products/Applications');
if (!fs.existsSync(productsDir)) {
  console.error(`Error: Products/Applications not found in archive`);
  process.exit(1);
}

const apps = fs.readdirSync(productsDir).filter(file => file.endsWith('.app'));
if (apps.length === 0) {
  console.error('Error: No .app found in Products/Applications');
  process.exit(1);
}

const appPlistPath = path.join(productsDir, apps[0], 'Info.plist');
if (!fs.existsSync(appPlistPath)) {
  console.error(`Error: Info.plist not found at ${appPlistPath}`);
  process.exit(1);
}

// Read current BuildMachineOSBuild
let currentBuild;
try {
  currentBuild = execSync(`plutil -extract BuildMachineOSBuild raw "${appPlistPath}"`).toString().trim();
} catch (e) {
  currentBuild = 'unknown';
}

console.log(`Current BuildMachineOSBuild: ${currentBuild}`);

// Stable macOS Tahoe build version (macOS 26.5.1)
const STABLE_OS_BUILD = '25F80';

if (currentBuild === STABLE_OS_BUILD) {
  console.log(`BuildMachineOSBuild is already set to stable version (${STABLE_OS_BUILD}). No changes needed.`);
  process.exit(0);
}

// Modify BuildMachineOSBuild
try {
  execSync(`/usr/libexec/PlistBuddy -c "Set :BuildMachineOSBuild ${STABLE_OS_BUILD}" "${appPlistPath}"`);
  console.log(`Successfully changed BuildMachineOSBuild to stable build: ${STABLE_OS_BUILD}`);
} catch (err) {
  console.error('Error: Failed to modify plist:', err.message);
  process.exit(1);
}
