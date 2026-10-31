// This matching is confined to a single city's two snapshots. Require a unique
// number/mode, the same route name and substantial shared stop membership.
// A reused number or ambiguous route remains a separate removal/addition.
export function matchRouteIdentities(before, after) {
    const identity = route => `${String(route.mode || '').trim()}\0${String(route.shortName || '').trim()}`;
    const bucket = routes => {
        const result = new Map();
        for (const route of routes || []) {
            const key = identity(route);
            if (!result.has(key)) result.set(key, []);
            result.get(key).push(route);
        }
        return result;
    };
    const oldRoutes = bucket(before), newRoutes = bucket(after);
    const oldIds = new Set((before || []).map(route => String(route.id)));
    const newIds = new Set((after || []).map(route => String(route.id)));
    const aliases = new Map();
    for (const [key, oldMatches] of oldRoutes) {
        const newMatches = newRoutes.get(key) || [];
        if (oldMatches.length !== 1 || newMatches.length !== 1) continue;
        const old = oldMatches[0], current = newMatches[0];
        if (!old.mode || !old.shortName || !old.longName?.trim() || old.longName.trim() !== current.longName?.trim()) continue;
        if (newIds.has(String(old.id)) || oldIds.has(String(current.id))) continue;
        const oldStops = new Set((old.stops || []).map(String)), newStops = new Set((current.stops || []).map(String));
        const shared = [...oldStops].filter(id => newStops.has(id)).length;
        if (shared / Math.max(oldStops.size, newStops.size, 1) < 0.5) continue;
        aliases.set(String(old.id), String(current.id));
    }
    return aliases;
}

// Normalize only the comparison copy. The fetched datasets and source IDs stay
// untouched, and reports retain the old source key for inspection.
export function alignRouteRecords(value, kind, aliases) {
    if (!value || !aliases.size || kind.startsWith('stops_')) return value;
    const normalize = data => {
        if (Array.isArray(data)) return data.map(normalize);
        if (data && typeof data === 'object') return Object.fromEntries(Object.entries(data).map(([key, item]) => [key, (key === 'id' || key === '_sourceRouteId') && aliases.has(String(item)) ? aliases.get(String(item)) : normalize(item)]));
        return data;
    };
    if (kind.startsWith('routes_') && !kind.startsWith('routes_details_')) return normalize(value);
    const ids = [...aliases.keys()].sort((a, b) => b.length - a.length);
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
        const id = ids.find(id => key === id || key.startsWith(`${id}_`));
        return [id ? aliases.get(id) + key.slice(id.length) : key, normalize(item)];
    }));
}
