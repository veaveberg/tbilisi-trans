import { patternAliases, alignPatternRecords } from './data-history-patterns.js';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { writeRouteHistoryAssets } from './data-history-route-assets.js';
import { matchRouteIdentities, alignRouteRecords } from './data-history-identities.js';
import { cityContext, enrichChanges, linkRelatedChanges, isScheduleDateRollover } from './data-history-context.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CITIES = ['tbilisi', 'rustavi', 'kutaisi', 'batumi'];
const KINDS = ['stops_en', 'stops_ka', 'routes_en', 'routes_ka', 'routes_details_en', 'routes_details_ka', 'schedules', 'polylines'];
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
const read = filename => fs.existsSync(filename) ? JSON.parse(fs.readFileSync(filename, 'utf8')) : null;
const write = (filename, value) => {
    fs.writeFileSync(`${filename}.tmp`, `${JSON.stringify(value)}\n`);
    fs.renameSync(`${filename}.tmp`, filename);
};

// Preserve ordered lists such as stop sequences and coordinates. Only entity
// collections are matched by ID, so changes in API collection order are ignored.
const records = value => new Map(Array.isArray(value) ? value.map(item => [String(item.id), item]) : Object.entries(value));
function compact(value) {
    if (value === undefined) return null;
    if (Array.isArray(value) && value.some(item => item && Array.isArray(item.stops) && item.fromDay)) {
        return value.map(service => {
            const stop = service.stops?.[0];
            const times = String(stop?.arrivalTimes || '').split(',').filter(Boolean);
            return { fromDay: service.fromDay, toDay: service.toDay, serviceDates: service.serviceDates || [], stopCount: service.stops?.length || 0,
                firstStop: stop ? { id: stop.id, name: stop.name, departures: times.length, departureTimes: times, firstDeparture: times[0] || null, lastDeparture: times.at(-1) || null } : null,
                timetableFingerprint: hash(service.stops || []) };
        });
    }
    const serialized = JSON.stringify(value);
    if (serialized.length <= 700) return value;
    return { summary: Array.isArray(value) ? `${value.length} items` : 'Detailed data', fingerprint: hash(value) };
}
// Stop names belong to the stop history. Preserve stop IDs, sequence, locations,
// and pattern metadata when deciding whether the route itself changed.
function withoutEmbeddedStopNames(value, isStop = false) {
    if (Array.isArray(value)) return value.map(item => withoutEmbeddedStopNames(item, isStop));
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).filter(([key]) => !(isStop && key === 'name')).map(([key, child]) => [key, withoutEmbeddedStopNames(child, ['stop', 'stops', 'firstStop', 'lastStop'].includes(key))]));
}
function normalizeNameWhitespace(value) {
    if (typeof value === 'string') return value.trim().replace(/\s+/gu, ' ');
    if (Array.isArray(value)) return value.map(normalizeNameWhitespace);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, ['name', 'longName', 'shortName', 'headsign'].includes(key) ? normalizeNameWhitespace(child) : child && typeof child === 'object' ? normalizeNameWhitespace(child) : child]));
}
export function compareRecords(before, after, { schedules = false, routeDetails = false, ignoredFields = [] } = {}) {
    const previous = records(before), next = records(after), changes = [];
    for (const id of [...new Set([...previous.keys(), ...next.keys()])].sort()) {
        const old = previous.get(id), current = next.get(id);
        if (isDeepStrictEqual(old, current) || schedules && previous.has(id) && next.has(id) && isScheduleDateRollover(old, current)) continue;
        const status = !previous.has(id) ? 'added' : !next.has(id) ? 'removed' : 'modified';
        const record = current || old;
        const fields = [], technicalFields = [];
        if (status === 'modified' && old && current && !Array.isArray(old) && !Array.isArray(current)) {
            for (const field of [...new Set([...Object.keys(old), ...Object.keys(current)])].sort()) {
                if (['name', 'longName', 'shortName', 'headsign', 'patterns', '_stopsOfPatterns'].includes(field) && isDeepStrictEqual(normalizeNameWhitespace(old[field]), normalizeNameWhitespace(current[field]))) continue;
                if (routeDetails && ['_stopsOfPatterns', 'stops', 'patterns'].includes(field) && isDeepStrictEqual(withoutEmbeddedStopNames(old[field], field === 'stops'), withoutEmbeddedStopNames(current[field], field === 'stops'))) continue;
                if (!isDeepStrictEqual(old[field], current[field])) (ignoredFields.includes(field) ? technicalFields : fields).push({ field, before: compact(old[field]), after: compact(current[field]) });
            }
        } else fields.push({ field: 'Record', before: compact(old), after: compact(current) });
        if (routeDetails && status === 'modified') {
            const withoutLabels = value => {
                if (Array.isArray(value)) return value.map(withoutLabels);
                if (!value || typeof value !== 'object') return value;
                return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'headsign').map(([key, child]) => [key, withoutLabels(child)]));
            };
            for (const field of fields) if (field.field === 'patterns' && isDeepStrictEqual(withoutLabels(withoutEmbeddedStopNames(old.patterns)), withoutLabels(withoutEmbeddedStopNames(current.patterns)))) field.semantic = 'rename';
        }
        if (status === 'modified' && !fields.length) continue;
        changes.push({ ...(technicalFields.length ? { technicalFields } : {}), id, label: record?.shortName ? `Route ${record.shortName}` : record?.name || id, status, fields });
    }
    return changes;
}

function compareCity(beforeDir, afterDir, city) {
    const groups = [], unavailable = [];
    const aliases = matchRouteIdentities(beforeDir ? read(path.join(beforeDir, `${city}_routes_en.json`)) : null, read(path.join(afterDir, `${city}_routes_en.json`)));
    const patterns = patternAliases(alignRouteRecords(beforeDir ? read(path.join(beforeDir, `${city}_routes_details_en.json`)) : {}, 'routes_details_en', aliases), read(path.join(afterDir, `${city}_routes_details_en.json`)));
    for (const kind of KINDS) {
        const filename = `${city}_${kind}.json`;
        const before = beforeDir ? read(path.join(beforeDir, filename)) : null;
        const after = read(path.join(afterDir, filename));
        if (!before || !after) { unavailable.push(kind); continue; }
        const alignedBefore = alignPatternRecords(alignRouteRecords(before, kind, aliases), kind, patterns);
        const changes = compareRecords(alignedBefore, after, { schedules: kind === 'schedules', routeDetails: kind.startsWith('routes_details_'), ignoredFields: kind.startsWith('routes_details_') ? ['defaultPatternSuffix'] : [] });
        for (const [oldId, newId] of aliases) {
            if (kind === 'routes_en' || kind === 'routes_ka') {
                let change = changes.find(change => change.id === newId);
                if (!change) {
                    const route = after.find(route => String(route.id) === newId);
                    // Do not infer an association for a missing locale record.
                    if (!route || !before.some(route => String(route.id) === oldId)) continue;
                    change = { id: newId, label: `Route ${route.shortName}`, status: 'modified', fields: [] };
                    changes.push(change);
                }
                change.fields.push({ field: 'sourceRouteId', before: oldId, after: newId });
            }
            for (const change of changes) if (change.id === newId || change.id.startsWith(`${newId}_`)) change.previousId = oldId + change.id.slice(newId.length);
        }
        if (changes.length) {
            groups.push({ kind, changes });
        }
    }
    enrichChanges(groups, Object.fromEntries(['en', 'ka'].map(locale => [locale, cityContext(beforeDir, city, locale)])), Object.fromEntries(['en', 'ka'].map(locale => [locale, cityContext(afterDir, city, locale)])), aliases);
    return { groups, unavailable };
}

// Enrich existing reports from their original snapshots, preserving entry IDs
// and dates. Never use today's memberships to describe a historical change.
function enrichStoredHistory(root, index) {
    const snapshots = new Map(), aliases = new Map();
    const archiveRoot = path.join(root, 'data-archive');
    for (const id of fs.existsSync(archiveRoot) ? fs.readdirSync(archiveRoot).sort() : []) {
        if (!/^\d{6}-\d{4}(?:-\d+)?$/.test(id)) continue;
        const dir = path.join(archiveRoot, id);
        const meta = read(path.join(dir, 'archive-meta.json'));
        if (meta?.archivedAt) snapshots.set(meta.archivedAt, dir);
        const manifest = read(path.join(dir, 'manifest.json'));
        if (manifest?.generatedAt) aliases.set(manifest.generatedAt, dir);
    }
    const current = path.join(root, 'public/data');
    const manifest = read(path.join(current, 'manifest.json'));
    if (manifest?.generatedAt && !snapshots.has(manifest.generatedAt)) aliases.set(manifest.generatedAt, current);
    for (const item of index.entries) {
        const filename = path.join(root, 'public/data-history', `${item.id}.json`);
        const entry = read(filename);
        if (entry.contextVersion >= 11 || entry.baseline) continue;
        const originalBefore = snapshots.get(entry.comparedWith) || aliases.get(entry.comparedWith);
        const originalAfter = snapshots.get(entry.observedAt) || aliases.get(entry.observedAt);
        if (originalBefore && originalAfter) {
            const comparison = compareCity(originalBefore, originalAfter, entry.city);
            entry.groups = comparison.groups;
            entry.unavailable = comparison.unavailable;
            entry.contextVersion = 11;
            write(filename, entry);
            summarizeEntry(item, entry);
            continue;
        }
        if (entry.contextVersion === 2) continue;
        if (entry.contextVersion === 1) {
            linkRelatedChanges(entry.groups);
            entry.contextVersion = 2;
            write(filename, entry);
            continue;
        }
        const beforeDir = snapshots.get(entry.comparedWith) || aliases.get(entry.comparedWith);
        const afterDir = snapshots.get(entry.observedAt) || aliases.get(entry.observedAt);
        if (!beforeDir || !afterDir) continue;
        const contexts = dir => Object.fromEntries(['en', 'ka'].map(locale => [locale, cityContext(dir, entry.city, locale)]));
        enrichChanges(entry.groups, contexts(beforeDir), contexts(afterDir));
        entry.contextVersion = 2;
        write(filename, entry);
    }
}

function summarizeEntry(item, entry) {
    item.counts = { added: 0, removed: 0, modified: 0 };
    item.groupCounts = entry.groups.map(group => {
        const counts = { added: 0, removed: 0, modified: 0 };
        for (const change of group.changes) { counts[change.status]++; item.counts[change.status]++; }
        return { kind: group.kind, counts };
    });
}

// Remove non-service changes from older reports too, including reports whose
// original snapshots are unavailable. Refresh counts and related-change links.
function removeStoredNonServiceChanges(output, index) {
    for (const item of index.entries) {
        const filename = path.join(output, `${item.id}.json`);
        const entry = read(filename);
        let removed = false;
        for (const group of entry.groups) {
            if (group.kind.startsWith('routes_details_')) {
                group.changes = group.changes.filter(change => {
                    if (change.status !== 'modified') return true;
                    const ignored = change.fields.filter(field => field.field === 'defaultPatternSuffix');
                    if (!ignored.length) return true;
                    removed = true;
                    change.technicalFields = [...(change.technicalFields || []), ...ignored];
                    change.fields = change.fields.filter(field => field.field !== 'defaultPatternSuffix');
                    if (change.context?.description?.includes('defaultPatternSuffix')) change.context.description = 'Route details updated.';
                    return change.fields.length > 0;
                });
            }
            if (group.kind !== 'schedules') continue;
            group.changes = group.changes.filter(change => {
                const rollover = change.status === 'modified' && change.context?.description === 'Service dates updated; timetable unchanged.';
                if (rollover) removed = true;
                return !rollover;
            });
        }
        if (!removed) continue;
        entry.groups = entry.groups.filter(group => group.changes.length);
        linkRelatedChanges(entry.groups);
        write(filename, entry);
        item.counts = { added: 0, removed: 0, modified: 0 };
        item.groupCounts = entry.groups.map(group => {
            const counts = { added: 0, removed: 0, modified: 0 };
            for (const change of group.changes) { counts[change.status]++; item.counts[change.status]++; }
            return { kind: group.kind, counts };
        });
    }
    index.entries = index.entries.filter(item => item.baseline || Object.values(item.counts).some(count => count > 0));
}

export function generateHistory(root = ROOT) {
    const archiveRoot = path.join(root, 'data-archive');
    const output = path.join(root, 'public/data-history');
    const state = path.join(archiveRoot, 'history-state');
    const current = path.join(root, 'public/data');
    fs.mkdirSync(output, { recursive: true });
    const indexPath = path.join(output, 'index.json');
    const index = read(indexPath) || { version: 1, entries: [] };
    const stateMeta = read(path.join(state, 'observation.json'));
    const observations = [];
    if (!stateMeta) {
        // Backfill only from dated archive folders, never research captures.
        for (const id of fs.existsSync(archiveRoot) ? fs.readdirSync(archiveRoot).sort() : []) {
            if (!/^\d{6}-\d{4}(?:-\d+)?$/.test(id)) continue;
            const dir = path.join(archiveRoot, id), meta = read(path.join(dir, 'archive-meta.json'));
            if (meta?.archivedAt) observations.push({ id, at: meta.archivedAt, dir });
        }
        observations.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id, undefined, { numeric: true }));
    } else observations.push({ ...stateMeta, dir: state });
    const manifest = read(path.join(current, 'manifest.json'));
    observations.push({ id: 'current', at: manifest?.generatedAt || new Date().toISOString(), dir: current });
    for (let i = 0; i < observations.length; i++) {
        const observation = observations[i], previous = observations[i - 1];
        if (i === 0 && stateMeta) continue;
        for (const city of CITIES) {
            const available = KINDS.filter(kind => fs.existsSync(path.join(observation.dir, `${city}_${kind}.json`)));
            if (!available.length) continue;
            const { groups, unavailable } = compareCity(previous?.dir, observation.dir, city);
            const baseline = !previous || unavailable.length === KINDS.length;
            if (!baseline && !groups.length) continue;
            if (baseline && index.entries.some(entry => entry.city === city)) continue;
            const entry = { contextVersion: 11, city, observedAt: observation.at, comparedWith: previous?.at || null, baseline, groups, unavailable };
            if (index.entries.some(item => item.city === city && item.observedAt === entry.observedAt && item.comparedWith === entry.comparedWith)) continue;
            const id = `${city}-${hash(entry)}`;
            if (index.entries.some(item => item.id === id)) continue;
            write(path.join(output, `${id}.json`), entry);
            const counts = { added: 0, removed: 0, modified: 0 };
            for (const group of groups) for (const change of group.changes) counts[change.status]++;
            index.entries.push({ groupCounts: groups.map(group => ({ kind: group.kind, counts: Object.fromEntries(['added', 'removed', 'modified'].map(status => [status, group.changes.filter(change => change.status === status).length])) })), id, city, observedAt: entry.observedAt, comparedWith: entry.comparedWith, baseline, counts, unavailable });
        }
    }
    enrichStoredHistory(root, index);
    removeStoredNonServiceChanges(output, index);
    writeRouteHistoryAssets(root, index);
    index.entries.sort((a, b) => b.observedAt.localeCompare(a.observedAt) || a.city.localeCompare(b.city));
    index.lastCheckedAt = new Date().toISOString();
    write(indexPath, index);
    fs.mkdirSync(state, { recursive: true });
    for (const city of CITIES) for (const kind of KINDS) {
        const filename = `${city}_${kind}.json`, source = path.join(current, filename), target = path.join(state, filename);
        if (fs.existsSync(source)) fs.copyFileSync(source, target);
        else fs.rmSync(target, { force: true });
    }
    write(path.join(state, 'observation.json'), { id: 'previous-update', at: observations.at(-1).at });
    console.log(`[Data History] ${index.entries.length} entries. Open /data-history/`);
    return index;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) generateHistory();
