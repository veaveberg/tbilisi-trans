import { combineLocalizedGroups } from './localized-change-groups.js';
const routeKinds = new Set(['routes', 'routes_details', 'polylines', 'schedules']);
const names = { routes: 'Route', routes_details: 'Route details', polylines: 'Geometry', schedules: 'Schedule' };
const order = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
export function combineRouteGroups(groups, locale) {
    const visible = combineLocalizedGroups(groups, locale);
    const byRoute = new Map();
    for (const group of visible) {
        const base = group.kind.replace(/_(en|ka)$/, '');
        if (!routeKinds.has(base)) continue;
        for (const change of group.changes) {
            // Unknown source identities stay separate rather than being joined
            // by a public route number that may belong to several services.
            const id = change.context?.route?.id || `${group.kind}:${change.id}`;
            if (!byRoute.has(id)) byRoute.set(id, []);
            byRoute.get(id).push({ base, change });
        }
    }
    const routes = [];
    for (const [id, members] of byRoute) {
        const primary = members.find(member => member.base === 'routes') || members.find(member => member.base === 'routes_details') || members[0];
        const context = { ...primary.change.context };
        context.relatedChanges = [...new Set(members.flatMap(member => member.change.context?.relatedChanges || []))].filter(kind => !routeKinds.has(kind));
        context.serviceChanged = members.some(member => member.base !== 'schedules');
        context.scheduleChanged = members.some(member => member.base === 'schedules');
        context.geometryChanged = members.some(member => member.base === 'polylines');
        context.renameOnly = context.serviceChanged && members.filter(member => member.base !== 'schedules').every(({ base, change }) => change.status === 'modified' && change.fields.every(field => (base === 'routes' && ['longName', 'shortName'].includes(field.field)) || field.semantic === 'rename'));
        const notes = [];
        if (context.scheduleChanged) notes.push('Schedule changed.');
        for (const key of ['stopsAdded', 'stopsRemoved']) {
            context[key] = [...new Map(members.flatMap(member => member.change.context?.[key] || []).map(stop => [stop.id, stop])).values()];
        }
        const countStops = (key, action) => context[key].length ? `${context[key].length} ${context[key].length === 1 ? 'stop' : 'stops'} ${action}` : null;
        const stopNotes = [countStops('stopsAdded', 'added'), countStops('stopsRemoved', 'removed')].filter(Boolean);
        if (stopNotes.length) notes.push(`${stopNotes.join(', ')}.`);
        const baseChanges = members.filter(member => member.base === 'routes');
        if (!stopNotes.length && baseChanges.length) notes.push(primary.change.context?.description || 'Route information updated.');
        const detailMembers = members.filter(member => member.base === 'routes_details');
        if (detailMembers.length && context.renameOnly) notes.push('Destination label changed.');
        else if (detailMembers.length) notes.push(detailMembers.some(member => member.change.fields.some(field => field.field === 'patterns')) ? 'Route patterns updated.' : 'Stop details updated.');
        const geometry = members.filter(member => member.base === 'polylines');
        if (geometry.length) notes.push(`Geometry changed for ${geometry.length} ${geometry.length === 1 ? 'pattern' : 'patterns'}.`);
        // Metadata changes remain visible even when stop membership also changed.
        const fieldLabels = { shortName: 'Route number changed.', longName: 'Route name changed.', color: 'Route color changed.', mode: 'Transport mode changed.' };
        for (const field of baseChanges.flatMap(member => member.change.fields)) if (fieldLabels[field.field]) notes.push(fieldLabels[field.field]);
        context.changeNotes = [...new Set(notes)];
        context.description = context.changeNotes.join(' ');
        const status = baseChanges[0]?.change.status || 'modified';
        const fieldsOf = key => members.flatMap(({ base, change }) => (change[key] || []).map(field => ({ ...field, sourceKind: base, sourceLabel: `${names[base]}${['polylines', 'schedules'].includes(base) ? ` · ${change.id.slice(id.length + 1)}` : ''}` })));
        routes.push({
            id, label: primary.change.label, status, context,
            fields: fieldsOf('fields'), technicalFields: fieldsOf('technicalFields')
        });
    }
    routes.sort((a, b) => order.compare(a.context?.route?.shortName || a.label, b.context?.route?.shortName || b.label) || order.compare(a.id, b.id));
    return [
        ...visible.filter(group => group.kind.startsWith('stops_')),
        ...(routes.length ? [{ kind: `routes_${locale}`, changes: routes }] : []),
        ...visible.filter(group => !group.kind.startsWith('stops_') && !routeKinds.has(group.kind.replace(/_(en|ka)$/, '')))
    ];
}
