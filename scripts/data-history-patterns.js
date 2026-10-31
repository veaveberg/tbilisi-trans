import { isDeepStrictEqual } from 'node:util';
// Reconcile only uniquely matched replacement patterns. Stops and their order
// establish identity; geometry and timetables are still compared afterwards.
export function patternAliases(before = {}, after = {}) {
    const aliases = new Map();
    for (const [route, old] of Object.entries(before || {})) {
        const current = after?.[route];
        if (!current) continue;
        const signature = (detail, pattern) => ({ direction: pattern.directionId,
            first: pattern.firstStop?.id, last: pattern.lastStop?.id,
            stops: (detail._stopsOfPatterns || []).filter(entry => entry.patternSuffixes?.includes(pattern.patternSuffix)).map(entry => entry.stop?.id) });
        const oldPatterns = old.patterns || [], newPatterns = current.patterns || [];
        const removed = oldPatterns.filter(p => !newPatterns.some(n => n.patternSuffix === p.patternSuffix));
        const added = newPatterns.filter(p => !oldPatterns.some(n => n.patternSuffix === p.patternSuffix));
        for (const pattern of removed) {
            const key = signature(old, pattern);
            if (!key.stops.length) continue;
            const matches = added.filter(next => isDeepStrictEqual(key, signature(current, next)));
            if (matches.length !== 1 || removed.filter(other => isDeepStrictEqual(key, signature(old, other))).length !== 1) continue;
            if (!aliases.has(route)) aliases.set(route, new Map());
            aliases.get(route).set(pattern.patternSuffix, matches[0].patternSuffix);
        }
    }
    return aliases;
}
export function alignPatternRecords(value, kind, aliases) {
    if (!aliases.size || (!kind.startsWith('routes_details_') && !['polylines', 'schedules'].includes(kind))) return value;
    const normalize = (value, map, field) => {
        if (typeof value === 'string' && ['patternSuffix', 'patternSuffixes', 'defaultPatternSuffix'].includes(field)) return map.get(value) || value;
        if (Array.isArray(value)) return value.map(item => normalize(item, map, field));
        if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [map.get(key) || key, normalize(child, map, key)]));
        return value;
    };
    return Object.fromEntries(Object.entries(value).map(([key, record]) => {
        const route = [...aliases.keys()].find(id => key === id || key.startsWith(`${id}_`));
        if (!route) return [key, record];
        const map = aliases.get(route);
        const suffix = key.slice(route.length + 1);
        const pattern = [...map.keys()].find(pattern => pattern.replaceAll(':', '_') === suffix);
        return [pattern ? `${route}_${map.get(pattern).replaceAll(':', '_')}` : key, normalize(record, map)];
    }));
}
