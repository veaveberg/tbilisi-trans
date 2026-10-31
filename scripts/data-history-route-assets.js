import fs from 'node:fs';
import path from 'node:path';
import { combineRouteGroups } from '../data-history/route-change-groups.js';
import { matchRouteIdentities } from './data-history-identities.js';
const read = filename => fs.existsSync(filename) ? JSON.parse(fs.readFileSync(filename, 'utf8')) : null;
function pathsForRoutes(polylines, ids) {
    if (!polylines) return null;
    const result = new Map(ids.map(id => [id, {}]));
    const longestFirst = [...ids].sort((a, b) => b.length - a.length);
    for (const [key, data] of Object.entries(polylines)) {
        const id = longestFirst.find(id => key === id || key.startsWith(`${id}_`));
        if (id) Object.assign(result.get(id), data);
    }
    return result;
}
export function writeRouteHistoryAssets(root, index) {
    const output = path.join(root, 'public/data-history'), archive = path.join(root, 'data-archive');
    const observations = new Map(), versions = new Map();
    for (const name of fs.existsSync(archive) ? fs.readdirSync(archive).sort() : []) {
        if (!/^\d{6}-\d{4}(?:-\d+)?$/.test(name)) continue;
        const dir = path.join(archive, name), meta = read(path.join(dir, 'archive-meta.json')), manifest = read(path.join(dir, 'manifest.json'));
        if (meta?.archivedAt) observations.set(meta.archivedAt, dir);
        if (manifest?.generatedAt) versions.set(manifest.generatedAt, dir);
    }
    const current = path.join(root, 'public/data'), manifest = read(path.join(current, 'manifest.json'));
    if (manifest?.generatedAt) versions.set(manifest.generatedAt, current);
    const write = (file, value) => { fs.writeFileSync(`${file}.tmp`, JSON.stringify(value) + '\n'); fs.renameSync(`${file}.tmp`, file); };
    for (const item of index.entries) {
        const filename = path.join(output, `${item.id}.json`), entry = read(filename);
        const projected = Object.fromEntries(['en', 'ka'].map(locale => [locale, combineRouteGroups(entry.groups, locale)]));
        item.displayGroupCounts = Object.fromEntries(Object.entries(projected).map(([locale, groups]) => [locale, groups.map(group => {
            const counts = { added: 0, removed: 0, modified: 0 };
            for (const change of group.changes) counts[change.status]++;
            return { kind: group.kind, counts };
        })]));
        if (entry.baseline || entry.routeGeometryVersion === 6) continue;
        const beforeDir = observations.get(entry.comparedWith) || versions.get(entry.comparedWith);
        const afterDir = observations.get(entry.observedAt) || versions.get(entry.observedAt);
        if (!beforeDir || !afterDir) continue;
        const load = (dir, kind) => read(path.join(dir, `${entry.city}_${kind}.json`));
        const beforeRoutes = load(beforeDir, 'routes_en'), afterRoutes = load(afterDir, 'routes_en');
        const aliases = matchRouteIdentities(beforeRoutes, afterRoutes);
        const oldIds = new Map([...aliases].map(([before, after]) => [after, before]));
        const ids = [...new Set(Object.values(projected).flatMap(groups => groups.filter(group => group.kind.startsWith('routes_')).flatMap(group => group.changes.map(change => change.context?.route?.id).filter(Boolean))))];
        const beforePaths = pathsForRoutes(load(beforeDir, 'polylines'), ids.map(id => oldIds.get(id) || id));
        const afterPaths = pathsForRoutes(load(afterDir, 'polylines'), ids);
        const stopsByLocale = Object.fromEntries(['en', 'ka'].map(locale => [locale, {
            before: new Map((load(beforeDir, `stops_${locale}`) || []).map(stop => [String(stop.id), stop])),
            after: new Map((load(afterDir, `stops_${locale}`) || []).map(stop => [String(stop.id), stop]))
        }]));
        const stopPoint = (reference, locale, side) => {
            const stop = stopsByLocale[locale][side].get(reference.id) || stopsByLocale.en[side].get(reference.id);
            return stop && Number.isFinite(stop.lon) && Number.isFinite(stop.lat) ? { id: reference.id, name: reference.name, coordinates: [stop.lon, stop.lat] } : null;
        };
        const data = Object.fromEntries(ids.map(id => [id, {
            before: beforePaths?.get(oldIds.get(id) || id) ?? null,
            after: afterPaths?.get(id) ?? null,
            routeStops: Object.fromEntries(['en', 'ka'].map(locale => [locale, ((afterRoutes?.find(route => String(route.id) === id) || beforeRoutes?.find(route => String(route.id) === (oldIds.get(id) || id)))?.stops || []).map(stopId => stopPoint({ id: String(stopId), name: stopsByLocale[locale].after.get(String(stopId))?.name || stopsByLocale[locale].before.get(String(stopId))?.name || String(stopId) }, locale, afterRoutes?.some(route => String(route.id) === id) ? 'after' : 'before')).filter(Boolean)])),
            stops: Object.fromEntries(['en', 'ka'].map(locale => {
                const change = projected[locale].find(group => group.kind === `routes_${locale}`)?.changes.find(change => change.id === id);
                return [locale, {
                    added: (change?.context.stopsAdded || []).map(stop => stopPoint(stop, locale, 'after')).filter(Boolean),
                    moved: [...stopsByLocale[locale].after.entries()].filter(([stopId, stop]) => {
                        const old = stopsByLocale[locale].before.get(stopId);
                        const route = afterRoutes?.find(route => String(route.id) === id);
                        return old && route?.stops?.map(String).includes(stopId) && (old.lon !== stop.lon || old.lat !== stop.lat);
                    }).map(([stopId, stop]) => ({ id: stopId, before: stopPoint({ id: stopId, name: stopsByLocale[locale].before.get(stopId).name }, locale, 'before'), after: stopPoint({ id: stopId, name: stop.name }, locale, 'after') })).filter(stop => stop.before && stop.after),
                    removed: (change?.context.stopsRemoved || []).map(stop => stopPoint(stop, locale, 'before')).filter(Boolean)
                }];
            }))
        }]));
        entry.routeGeometryFile = `${item.id}-routes.json`;
        entry.routeGeometryVersion = 6;
        write(path.join(output, entry.routeGeometryFile), data);
        write(filename, entry);
    }
}
