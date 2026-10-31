const zone = 'Asia/Tbilisi';
export const dayKey = value => new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
export function dayLabel(value, now = new Date()) {
    const year = date => new Intl.DateTimeFormat('en', { timeZone: zone, year: 'numeric' }).format(new Date(date));
    return new Intl.DateTimeFormat('en-GB', { timeZone: zone, day: 'numeric', month: 'short', ...(year(value) !== year(now) ? { year: 'numeric' } : {}) }).format(new Date(value));
}
// Merge source records before combining languages and route-related categories.
export function dailyChanges(reports) {
    const days = new Map();
    for (const report of [...reports].sort((a, b) => a.observedAt.localeCompare(b.observedAt))) {
        const key = dayKey(report.observedAt);
        if (!days.has(key)) days.set(key, { ...report, groups: [], unavailable: [], routeGeometryFile: [], baseline: true, records: new Map() });
        const day = days.get(key);
        day.baseline &&= report.baseline;
        day.observedAt = report.observedAt;
        day.unavailable = [...new Set([...day.unavailable, ...report.unavailable])];
        if (report.routeGeometryFile) day.routeGeometryFile.push(report.routeGeometryFile);
        for (const group of report.groups) for (const change of group.changes) {
            const id = `${group.kind}:${change.id}`;
            const previous = day.records.get(id);
            const next = structuredClone(change);
            if (previous) {
                next.status = ['added', 'cancelled'].includes(previous.status) ? (change.status === 'removed' ? 'cancelled' : 'added') : change.status === 'removed' ? 'removed' : 'modified';
                for (const name of ['fields', 'technicalFields']) {
                    const fields = new Map((previous[name] || []).map(field => [field.field, field]));
                    for (const field of next[name] || []) fields.set(field.field, { ...field, before: fields.has(field.field) ? fields.get(field.field).before : field.before });
                    next[name] = [...fields.values()].filter(field => JSON.stringify(field.before) !== JSON.stringify(field.after));
                }
                next.context = { ...previous.context, ...next.context };
                for (const name of Object.keys(previous.context || {}).filter(key => key.endsWith('Before'))) next.context[name] = previous.context[name];
                for (const [added, removed] of [['stopsAdded', 'stopsRemoved'], ['routesAdded', 'routesRemoved']]) {
                    const plus = new Map((previous.context?.[added] || []).map(item => [item.id, item]));
                    const minus = new Map((previous.context?.[removed] || []).map(item => [item.id, item]));
                    for (const item of change.context?.[added] || []) { if (!minus.delete(item.id)) plus.set(item.id, item); }
                    for (const item of change.context?.[removed] || []) { if (!plus.delete(item.id)) minus.set(item.id, item); }
                    if (plus.size || minus.size || added in next.context) { next.context[added] = [...plus.values()]; next.context[removed] = [...minus.values()]; }
                }
            }
            next._kind = group.kind;
            day.records.set(id, next);
        }
    }
    return [...days.values()].reverse().map(day => {
        const groups = new Map();
        for (const { _kind, ...change } of day.records.values()) {
            if (change.status === 'cancelled' || (change.status === 'modified' && !change.fields.length)) continue;
            if (!groups.has(_kind)) groups.set(_kind, { kind: _kind, changes: [] });
            groups.get(_kind).changes.push(change);
        }
        const { records, ...result } = day;
        return { ...result, groups: [...groups.values()] };
    });
}
