import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
const read = filename => fs.existsSync(filename) ? JSON.parse(fs.readFileSync(filename, 'utf8')) : null;
const stopId = stop => String(typeof stop === 'object' ? stop.id : stop);
function routeStopIds(route = {}) {
    return new Set([
        ...(route.stops || []).map(stopId),
        ...(Array.isArray(route._stopsOfPatterns) ? route._stopsOfPatterns : []).flatMap(entry => entry.stop ? [stopId(entry.stop)] : (entry.stops || []).map(stopId)),
        ...(route.patterns || []).flatMap(pattern => [...(pattern.stops || []).map(stopId), ...[pattern.firstStop, pattern.lastStop].filter(Boolean).map(stopId)])
    ]);
}
export function cityContext(dir, city, locale) {
    const load = kind => dir ? read(path.join(dir, `${city}_${kind}_${locale}.json`)) : null;
    const routes = load('routes'), details = load('routes_details'), stops = load('stops');
    const byId = new Map((routes || []).map(route => [String(route.id), { ...route }]));
    for (const [id, detail] of Object.entries(details || {})) byId.set(id, { ...detail, ...byId.get(id), patterns: detail.patterns, _stopsOfPatterns: detail._stopsOfPatterns });
    const serving = new Map();
    for (const route of byId.values()) for (const id of routeStopIds(route)) {
        if (!serving.has(id)) serving.set(id, []);
        serving.get(id).push(route);
    }
    for (const list of serving.values()) list.sort((a, b) => collator.compare(String(a.shortName), String(b.shortName)) || collator.compare(String(a.id), String(b.id)));
    return { routes: byId, stops: new Map((stops || []).map(stop => [String(stop.id), stop])), serving,
        // A missing route list cannot establish that a stop has no service.
        hasRoutes: routes !== null, dir, city, locale };
}
const routeRef = route => ({ id: String(route.id), shortName: String(route.shortName || route.id), name: route.longName || '', mode: route.mode || '', color: route.color || '' });
const stopRef = (id, primary, fallback) => ({ id, name: primary.stops.get(id)?.name || fallback.stops.get(id)?.name || id });
function movement(old, current) {
    if (![old?.lat, old?.lon, current?.lat, current?.lon].every(value => typeof value === 'number' && Number.isFinite(value))) return null;
    const radians = degrees => degrees * Math.PI / 180;
    const a = Math.sin(radians(current.lat - old.lat) / 2) ** 2 + Math.cos(radians(old.lat)) * Math.cos(radians(current.lat)) * Math.sin(radians(current.lon - old.lon) / 2) ** 2;
    return Math.round(6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a))));
}

// Calendar dates advance routinely. Weekday applicability, stop order and all
// stop times still participate in the comparison.
export function isScheduleDateRollover(before, after) {
    if (!Array.isArray(before) || !Array.isArray(after)) return false;
    const withoutDates = schedule => schedule.map(({ serviceDates, ...service }) => service);
    return isDeepStrictEqual(withoutDates(before), withoutDates(after));
}

export function enrichChanges(groups, before, after, aliases = new Map()) {
    const previousRouteIds = new Map([...aliases].map(([oldId, newId]) => [newId, oldId]));
    for (const group of groups) {
        const locale = group.kind.endsWith('_ka') ? 'ka' : 'en';
        const previous = before[locale], next = after[locale];
        const base = group.kind.replace(/_(en|ka)$/, '');
        for (const change of group.changes) {
            const context = { description: '' };
            if (base === 'stops') {
                const old = previous.stops.get(change.id), current = next.stops.get(change.id);
                context.namesBefore = Object.fromEntries(['en', 'ka'].map(language => [language, before[language].stops.get(change.id)?.name || null]));
                context.namesAfter = Object.fromEntries(['en', 'ka'].map(language => [language, after[language].stops.get(change.id)?.name || null]));
                context.entityBefore = ['en', 'ka'].some(language => before[language].stops.has(change.id));
                context.entityAfter = ['en', 'ka'].some(language => after[language].stops.has(change.id));
                const location = stop => stop && Number.isFinite(stop.lon) && Number.isFinite(stop.lat) && Math.abs(stop.lon) <= 180 && Math.abs(stop.lat) <= 90 ? { name: stop.name, coordinates: [stop.lon, stop.lat] } : null;
                context.locationsBefore = Object.fromEntries(['en', 'ka'].map(language => [language, location(before[language].stops.get(change.id))]));
                context.locationsAfter = Object.fromEntries(['en', 'ka'].map(language => [language, location(after[language].stops.get(change.id))]));
                context.locationBefore = location(old);
                context.locationAfter = location(current);
                const descriptions = [];
                if (change.status === 'added') descriptions.push('Stop added.');
                else if (change.status === 'removed') descriptions.push('Stop removed from the saved data.');
                else {
                    if (old && current && old.name !== current.name) descriptions.push(`Renamed from "${old.name}" to "${current.name}".`);
                    const meters = movement(old, current);
                    if (meters !== null && (old.lat !== current.lat || old.lon !== current.lon)) descriptions.push(meters ? `Location moved about ${meters} m.` : 'Location coordinates adjusted.');
                }
                context.description = descriptions.join(' ') || 'Stop information updated.';
                context.routesBefore = previous.hasRoutes ? (previous.serving.get(change.id) || []).map(routeRef) : null;
                context.routesAfter = next.hasRoutes ? (next.serving.get(change.id) || []).map(routeRef) : null;
                if (context.routesBefore && context.routesAfter) {
                    context.routesAdded = context.routesAfter.filter(route => !context.routesBefore.some(old => (aliases.get(old.id) || old.id) === route.id));
                    context.routesRemoved = context.routesBefore.filter(route => !context.routesAfter.some(current => current.id === (aliases.get(route.id) || route.id)));
                }
            } else {
                const ids = [...new Set([...previous.routes.keys(), ...next.routes.keys()])].sort((a, b) => b.length - a.length);
                const routeId = ids.find(id => change.id === id || change.id.startsWith(`${id}_`));
                const old = previous.routes.get(previousRouteIds.get(routeId) || routeId), current = next.routes.get(routeId), route = current || old;
                if (route) {
                    context.route = routeRef(route);
                    context.routeNames = Object.fromEntries(['en', 'ka'].map(language => [language, after[language].routes.get(routeId)?.longName || before[language].routes.get(previousRouteIds.get(routeId) || routeId)?.longName || null]));
                    context.entityBefore = ['en', 'ka'].some(language => before[language].routes.has(previousRouteIds.get(routeId) || routeId));
                    context.entityAfter = ['en', 'ka'].some(language => after[language].routes.has(routeId));
                    change.label = `Route ${route.shortName || route.id}`;
                    context.description = route.longName || '';
                }
                if (base === 'routes' || base === 'routes_details') {
                    const oldIds = routeStopIds(old), newIds = routeStopIds(current);
                    // Only claim route membership changes when both snapshots know the route.
                    if (old && current) {
                        context.stopsAdded = [...newIds].filter(id => !oldIds.has(id)).map(id => stopRef(id, next, previous));
                        context.stopsRemoved = [...oldIds].filter(id => !newIds.has(id)).map(id => stopRef(id, previous, next));
                    }
                    if (change.status === 'added') context.description = `Route added${route?.longName ? `: ${route.longName}` : ''}.`;
                    else if (change.status === 'removed') context.description = 'Route removed from the saved data.';
                    else if (context.stopsAdded?.length || context.stopsRemoved?.length) context.description = `${context.stopsAdded.length} stops added, ${context.stopsRemoved.length} stops removed from the route.`;
                    else if (change.fields.some(field => field.field === 'patterns')) context.description = 'Route patterns updated.';
                    else if (change.fields.some(field => field.field === 'stops')) context.description = 'Route stop list reordered.';
                    else if (change.fields.every(field => field.field === 'sourceRouteId')) context.description = 'Route reference updated; service data unchanged.';
                    else context.description = `Updated ${change.fields.filter(field => field.field !== 'sourceRouteId').map(field => ({ shortName: 'route number', longName: 'route name', _stopsOfPatterns: 'stop details' })[field.field] || field.field).join(', ')}.`;
                } else if (base === 'schedules') {
                    const load = snapshot => {
                        if (!Object.hasOwn(snapshot, 'schedules')) snapshot.schedules = snapshot.dir ? read(path.join(snapshot.dir, `${snapshot.city}_schedules.json`)) : null;
                        return snapshot.schedules?.[snapshot === previous ? change.previousId || change.id : change.id];
                    };
                    const oldSchedule = load(previous), newSchedule = load(next);
                    context.description = change.status === 'added' ? 'Schedule added.' : change.status === 'removed' ? 'Schedule removed from the saved data.' : oldSchedule && newSchedule && isScheduleDateRollover(oldSchedule, newSchedule) ? 'Service dates updated; timetable unchanged.' : 'Timetable or service information updated.';
                    const hasTimes = schedule => Array.isArray(schedule) && schedule.some(service => service.stops?.some(stop => String(stop.arrivalTimes || '').split(',').some(time => time.trim())));
                    if (change.status === 'modified' && hasTimes(oldSchedule) && !hasTimes(newSchedule)) context.description = 'Departure times are missing from the new snapshot.';
                } else if (base === 'polylines') context.description = change.status === 'modified' ? 'Route geometry updated.' : `Route geometry ${change.status}.`;
            }
            change.context = context;
        }
        group.changes.sort((a, b) => collator.compare(a.context.route?.shortName || a.label, b.context.route?.shortName || b.label) || collator.compare(a.id, b.id));
    }
    return linkRelatedChanges(groups);
}

export function linkRelatedChanges(groups) {
    // Connect the route's record, details, timetable and geometry from this
    // same observation, without counting translated records as separate events.
    for (const group of groups) for (const change of group.changes) {
        const route = change.context?.route;
        if (!route) continue;
        const ownKind = group.kind.replace(/_(en|ka)$/, '');
        const ownLocale = group.kind.endsWith('_ka') ? 'ka' : 'en';
        const related = new Set();
        for (const other of groups) {
            const otherKind = other.kind.replace(/_(en|ka)$/, '');
            if (otherKind === ownKind || other.kind.endsWith('_ka') && ownLocale !== 'ka' || other.kind.endsWith('_en') && ownLocale !== 'en') continue;
            if (other.changes.some(candidate => candidate.context?.route?.id === route.id)) related.add(otherKind);
        }
        change.context.relatedChanges = [...related];
    }
    return groups;
}
