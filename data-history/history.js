import { summarizeSchedule, scheduleTimeRows } from './schedule-summary.js';
import './appearance.js';
import { dailyChanges, dayLabel } from './daily-changes.js';
import { combineRouteGroups } from './route-change-groups.js';
import { CHANGE_COLORS } from './stop-change-features.js';
const cityNames = { tbilisi: 'Tbilisi', rustavi: 'Rustavi', kutaisi: 'Kutaisi', batumi: 'Batumi' };
const kindNames = { stops: 'Stops', routes: 'Routes', routes_details: 'Route details', schedules: 'Schedules', polylines: 'Geometry' };
const timeline = document.querySelector('#timeline'), status = document.querySelector('#status');
const search = document.querySelector('#search'), kind = document.querySelector('#kind');
const displayLanguage = 'en';
const fieldNames = { sourceRouteId: 'Source route reference', lat: 'Latitude', lon: 'Longitude', name: 'Name', shortName: 'Route number', longName: 'Route name', stops: 'Stops', patterns: 'Route patterns', _stopsOfPatterns: 'Stops by pattern', color: 'Route color', mode: 'Transport mode' };
const params = new URLSearchParams(location.search);
let city = Object.hasOwn(cityNames, params.get('city')) ? params.get('city') : 'tbilisi';
let index, generation = 0;
const cache = new Map();
const mapDisposers = new Set();
for (const [status, color] of Object.entries(CHANGE_COLORS)) document.documentElement.style.setProperty(`--change-${status}`, color);
const changeOrder = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
const date = dayLabel;
function element(tag, text, className) { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; }
function selectedGroups(entry) {
    return combineRouteGroups(entry.groups, displayLanguage).filter(group => {
        const language = group.kind.endsWith('_ka') ? 'ka' : group.kind.endsWith('_en') ? 'en' : null;
        const base = language ? group.kind.slice(0, -3) : group.kind;
        return (!language || language === displayLanguage) && (!kind.value || base === kind.value);
    }).map(group => ({ ...group, changes: group.changes.filter(change => !search.value.trim() || `${change.id} ${change.label} ${JSON.stringify(change.fields)} ${JSON.stringify(change.context || {})}`.toLowerCase().includes(search.value.trim().toLowerCase())).sort((a, b) => changeOrder.compare(a.context?.route?.shortName || a.label.replace(/^Route /, ''), b.context?.route?.shortName || b.label.replace(/^Route /, '')) || changeOrder.compare(a.id, b.id)) })).filter(group => group.changes.length);
}
async function load(id) {
    if (!cache.has(id)) cache.set(id, fetch(`${id}.json`, { cache: 'no-store' }).then(response => { if (!response.ok) throw new Error('Update details could not be loaded. Reload the page to try again.'); return response.json(); }).catch(error => { cache.delete(id); throw error; }));
    return cache.get(id);
}
function describeChange(change) {
    const context = change.context;
    if (!context) return null;
    const block = element('div', undefined, 'change-context');
    const secondary = displayLanguage === 'en' ? context.names?.ka : context.names?.en;
    if (secondary && secondary !== change.label) block.append(element('div', secondary, 'secondary-name'));
    const stopChanges = [['stopsAdded', 'added'], ['stopsRemoved', 'removed']].filter(([key]) => context[key]?.length).map(([key, action]) => `${context[key].length} ${context[key].length === 1 ? 'stop' : 'stops'} ${action}`);
    const description = context.changeNotes?.length ? context.changeNotes.join(' ') : stopChanges.length ? `${stopChanges.join(', ')}.` : context.description;
    if (context.route?.name && !description?.includes(context.route.name)) block.append(element('div', context.route.name, 'route-name'));
    if (description) block.append(element('div', description, 'change-description'));
    const routeList = (label, routes) => {
        const row = element('div', undefined, 'serving-routes');
        row.append(element('span', label, 'context-label'));
        if (routes === null) row.append(element('span', 'Not recorded in this snapshot'));
        else if (!routes.length) row.append(element('span', 'None listed in this snapshot'));
        else for (const route of routes) {
            const badge = routePlaque(route);
            badge.title = [route.name, route.mode, route.id].filter(Boolean).join(' · ');
            row.append(badge);
        }
        block.append(row);
    };
    if (Object.hasOwn(context, 'routesAfter')) {
        if (change.status === 'removed') routeList('Previously served by', context.routesBefore);
        else {
            routeList('Served by', context.routesAfter);
            if (change.status === 'modified') {
                if (context.routesAdded?.length) routeList('Now also served by', context.routesAdded);
                if (context.routesRemoved?.length) routeList('No longer listed for', context.routesRemoved);
                if (context.routesBefore === null) routeList('Previous service', null);
            }
        }
    }
    if (context.relatedChanges?.length) block.append(element('div', `Also changed: ${context.relatedChanges.map(kind => kindNames[kind].toLowerCase()).join(', ')}.`, 'related-changes'));
    return block;
}

function changeMapPanel(group, section, records, geometryFile, collapsible = true) {
    const routes = group.kind.startsWith('routes_');
    const label = routes ? 'routes' : 'stops';
    const panel = element(collapsible ? 'details' : 'div', undefined, 'stop-map-view');
    if (collapsible) {
        panel.open = !(routes && group.changes.every(change => change.context?.scheduleChanged && !change.context?.serviceChanged));
        panel.append(element('summary', `Map of changed ${label}`));
    }
    const legend = element('div', undefined, 'map-legend');
    for (const status of ['added', 'modified', 'removed']) {
        const label = element('span', status[0].toUpperCase() + status.slice(1), status);
        label.prepend(element('span', undefined, 'legend-dot'));
        legend.append(label);
    }
    let routeSelect, movedStopsButton;
    if (routes) {
        if (group.changes.length > 1) {
        const picker = element('label', undefined, 'route-map-picker'); picker.append(element('span', 'Route on map'));
        routeSelect = element('select'); routeSelect.append(new Option('All changed routes', ''));
        for (const change of group.changes) routeSelect.append(new Option(change.label, change.id));
        routeSelect.addEventListener('change', () => controller?.focus?.(routeSelect.value));
        picker.append(routeSelect); panel.append(picker);
        }
        const controls = element('div', undefined, 'route-map-actions');
        for (const [label, action] of [['Fit route', 'fitRoute'], ['Fit all changes', 'fitAll']]) { const button = element('button', label); button.type = 'button'; button.addEventListener('click', () => controller?.[action]?.()); controls.append(button); }
        movedStopsButton = element('button', 'Zoom to moved stops');
        movedStopsButton.type = 'button'; movedStopsButton.hidden = true;
        movedStopsButton.addEventListener('click', () => controller?.fitMoves?.()); controls.append(movedStopsButton);
        panel.append(controls);
    }
    const host = element('div', undefined, 'stop-map'); host.setAttribute('aria-label', `Map of added, modified, and removed ${label}`);
    const message = element('p', `Open the ${label} section to view the map.`, 'map-message'); message.setAttribute('role', 'status');
    panel.append(legend, host, message);
    let controller, request, pending = false, revision = 0, disposed = false;
    async function syncVisibility() {
        const visible = !disposed && section.isConnected && section.open && (!collapsible || panel.open);
        if (!visible) { request?.abort(); revision++; pending = false; controller?.destroy(); controller = null; host.replaceChildren(); return; }
        if (controller || pending) return;
        const currentRevision = ++revision; pending = true;
        request = new AbortController();
        message.textContent = 'Loading map…';
        try {
            const mount = routes ? (await import('./route-change-map.js')).mountRouteChangeMap : (await import('./stop-change-map.js')).mountStopChangeMap;
            if (currentRevision !== revision || disposed || !section.isConnected) return;
            const mounted = await mount(host, message, group.changes, group.kind.endsWith('_ka') ? 'ka' : 'en', id => {
                const record = records.get(id);
                if (record) { record.open = true; record.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); record.querySelector('summary').focus(); }
            }, geometryFile, request.signal);
            if (currentRevision !== revision || disposed) { mounted.destroy(); return; }
            controller = mounted;
            if (movedStopsButton) movedStopsButton.hidden = !mounted.hasMovedStops;
            if (routeSelect?.value) controller.focus?.(routeSelect.value);
        } catch (error) { if (currentRevision === revision) message.textContent = error.message || 'The map could not load. The changes are available in the list below.'; }
        finally { if (currentRevision === revision) pending = false; }
    }
    const attach = () => {
        section.addEventListener('toggle', syncVisibility);
        panel.addEventListener('toggle', syncVisibility);
        const dispose = () => { disposed = true; request?.abort(); revision++; controller?.destroy(); section.removeEventListener('toggle', syncVisibility); panel.removeEventListener('toggle', syncVisibility); };
        mapDisposers.add(dispose);
    };
    return { panel, attach };
}

function appendFieldValues(parent, fields) {
    for (const field of fields) {
        const row = element('div', undefined, 'field'); row.append(element('div', `${field.sourceLabel ? field.sourceLabel + ' · ' : ''}${fieldNames[field.field] || field.field}${field.language ? ' · ' + ({ en: 'English', ka: 'Georgian' }[field.language]) : ''}`, 'field-name'));
        const values = element('div', undefined, 'values');
        for (const side of ['before', 'after']) { const value = element('div', undefined, 'value'); value.append(element('small', side === 'before' ? 'Before' : 'After'), element('pre', field[side] === null ? 'Not present' : JSON.stringify(field[side], null, 2))); values.append(value); }
        row.append(values); parent.append(row);
    }
}

function appendScheduleChanges(parent, fields) {
    const schedules = fields.filter(field => field.sourceKind === 'schedules');
    if (!schedules.length) return;
    const block = element('div', undefined, 'schedule-changes');
    block.append(element('h4', 'Schedule changes'));
    const time = value => {
        if (!value) return 'Not recorded';
        const match = /^(\d+):(\d{2})$/.exec(String(value));
        return match ? `${Number(match[1]) % 24}:${match[2]}` : String(value);
    };
    for (const field of schedules) {
        const summary = summarizeSchedule(field);
        if (!summary?.groups.length) continue;
        const direction = element('section', undefined, 'schedule-direction');
        direction.append(element('h5', summary.origin ? `Departures from ${summary.origin}` : 'Departure timetable'));
        for (const group of summary.groups) {
            const card = element('div', undefined, 'schedule-card');
            card.append(element('h6', group.label));
            if (!group.before || !group.after) card.append(element('p', group.after ? 'Schedule added.' : 'Schedule removed.'));
            if (group.before?.departures > 0 && group.after?.departures === 0) card.append(element('p', 'Departure times are missing from the new snapshot.', 'warning'));
            const table = element('table');
            const header = element('tr'); for (const label of ['', 'Before', 'After']) header.append(element('th', label));
            const head = element('thead'); head.append(header); table.append(head);
            const body = element('tbody');
            for (const [key, label, format] of [['departures', 'Departures', value => value ?? 'No schedule'], ['first', 'First departure', time], ['last', 'Last departure', time], ['stops', 'Stops', value => value ?? 'No schedule']]) {
                if (key === 'stops' && group.before?.stops === group.after?.stops) continue;
                const row = element('tr', undefined, group.before?.[key] !== group.after?.[key] ? 'schedule-metric-changed' : '');
                const labelCell = element('th', label); labelCell.scope = 'row'; row.append(labelCell);
                for (const side of ['before', 'after']) row.append(element('td', String(format(group[side]?.[key]))));
                body.append(row);
            }
            table.append(body); card.append(table);
            const rows = scheduleTimeRows(group.before?.times || [], group.after?.times || []);
            if (rows?.length) {
                const legend = element('div', undefined, 'timetable-legend');
                legend.append(element('span', 'Added departures', 'added'), element('span', 'Removed departures', 'removed'));
                card.append(legend);
                const timetable = element('div', undefined, 'route-full-schedule');
                timetable.setAttribute('aria-label', 'Full departure timetable with changes');
                for (const { hour, departures } of rows) {
                    const row = element('div', undefined, 'schedule-hour-row');
                    row.append(element('span', String(hour), 'hour-label'));
                    const minutes = element('div', undefined, 'minutes-list');
                    for (const departure of departures) {
                        const value = element('span', departure.minute, `timetable-minute ${departure.status}`);
                        value.setAttribute('aria-label', `${hour}:${departure.minute}, ${departure.status}`);
                        minutes.append(value);
                    }
                    row.append(minutes); timetable.append(row);
                }
                card.append(timetable);
            }
            if (group.before && group.after && group.before.fingerprint !== group.after.fingerprint && ['departures', 'first', 'last'].every(key => group.before[key] === group.after[key])) card.append(element('p', 'Other timetable details changed; the first and last departures stayed the same.', 'schedule-note'));
            direction.append(card);
        }
        block.append(direction);
    }
    const raw = element('details', undefined, 'schedule-source');
    raw.append(element('summary', 'Schedule source data')); appendFieldValues(raw, schedules); block.append(raw);
    parent.append(block);
}

function routePlaque(route, interactive = false) {
    const badge = element(interactive ? 'button' : 'span', route.shortName, 'route-badge service-plaque');
    if (/^[45]\d{2}$/.test(String(route.shortName))) badge.dataset.minibus = 'true';
    const metro = route.mode === 'SUBWAY' || route.mode === 'METRO';
    if (metro) badge.classList.add('metro-plaque', String(route.shortName) === '2' ? 'metro-line-two' : 'metro-line-one');
    const color = route.color || (metro ? (String(route.shortName) === '2' ? '22c55e' : 'ef4444') : '2563eb');
    badge.style.setProperty('--route-color', color.startsWith('#') ? color : `#${color}`);
    badge.title = [route.name, route.mode].filter(Boolean).join(' · ');
    return badge;
}
function routeSummary(changes, onSelect) {
    const row = element('div', undefined, 'route-summary');
    const groups = [['Added', change => change.context.serviceChanged && change.status === 'added'], ['Cancelled', change => change.context.serviceChanged && change.status === 'removed'], ['Changed', change => change.context.serviceChanged && change.status === 'modified' && !change.context.renameOnly], ['Renamed', change => change.context.renameOnly], ['Only schedule changed for', change => change.context.scheduleChanged && !change.context.serviceChanged]];
    for (const [label, matches] of groups) {
        const routes = changes.filter(matches);
        if (!routes.length) continue;
        const block = element('div', undefined, 'route-summary-block');
        const part = element('div', undefined, 'route-summary-part');
        const panels = element('div', undefined, 'route-summary-panels');
        part.append(element('span', label, 'route-summary-label'));
        for (const change of routes) {
            const plaque = routePlaque(change.context.route || { shortName: change.label }, true);
            plaque.type = 'button';
            plaque.dataset.routeId = change.id;
            plaque.setAttribute('aria-expanded', 'false');
            plaque.setAttribute('aria-label', `${label} · ${change.label}: show changes and map`);
            plaque.addEventListener('click', () => onSelect(change.id, panels));
            part.append(plaque);
        }
        block.append(part, panels);
        row.append(block);
    }
    return row;
}

function categoryCounts(changes) {
    const counts = { added: 0, removed: 0, modified: 0 };
    for (const change of changes) counts[change.status]++;
    const row = element('span', undefined, 'counts');
    row.setAttribute('role', 'img');
    row.setAttribute('aria-label', `${counts.added} added, ${counts.removed} removed, ${counts.modified} modified`);
    for (const type of ['added', 'removed', 'modified']) {
        const count = element('span', undefined, `${type} change-count${counts[type] === 0 ? ' zero' : ''}`);
        count.setAttribute('aria-hidden', 'true');
        if (type === 'modified') { const icon = element('span', undefined, 'pencil-icon'); icon.setAttribute('aria-hidden', 'true'); count.append(icon, document.createTextNode(String(counts[type]))); }
        else count.textContent = `${type === 'added' ? '+' : '-'}${counts[type]}`;
        row.append(count);
    }
    return row;
}

function renderDetails(body, entry) {
    body.replaceChildren();
    if (entry.baseline) body.append(element('p', 'First saved snapshot. Earlier changes are not available.'));
    if (entry.unavailable.length && !entry.baseline) body.append(element('p', `No comparison available for: ${entry.unavailable.join(', ')}. These files were absent from one or both snapshots.`, 'warning'));
    const groups = selectedGroups(entry);
    if (!entry.baseline && !groups.length) body.append(element('p', 'No changes match these filters.'));
    for (const group of groups) {
        const base = group.kind.replace(/_(en|ka)$/, '');
        const routeSection = base === 'routes';
        const section = element(routeSection ? 'section' : 'details', undefined, 'group');
        const heading = element(routeSection ? 'div' : 'summary', undefined, 'group-heading');
        const records = new Map();
        const toggleRoute = (id, panels) => {
            const target = records.get(id);
            const open = !target.open;
            if (open) panels.append(target);
            for (const [routeId, record] of records) record.open = open && routeId === id;
            for (const plaque of section.querySelectorAll('button[data-route-id]')) plaque.setAttribute('aria-expanded', String(open && plaque.dataset.routeId === id));
        };
        const headingContent = element('h3', undefined, 'group-heading-content');
        headingContent.append(element('span', kindNames[base]));
        if (!routeSection) headingContent.append(categoryCounts(group.changes));
        heading.append(headingContent);
        section.append(heading); body.append(section);
        if (routeSection) {
            const mappable = group.changes.filter(change => change.status === 'added' || change.status === 'removed' || change.context.geometryChanged);
            if (mappable.length) {
                const mapButton = element('button', 'Map', 'routes-map-button');
                mapButton.type = 'button';
                mapButton.setAttribute('aria-expanded', 'false');
                mapButton.setAttribute('aria-label', 'Map of added, removed, and geometry-changed routes');
                const overview = element('details', undefined, 'route-overview');
                overview.append(element('summary', 'Route changes map'));
                const view = changeMapPanel({ ...group, changes: mappable }, overview, records, entry.routeGeometryFile, false);
                overview.append(view.panel); section.append(overview); view.attach();
                mapButton.addEventListener('click', () => { overview.open = !overview.open; mapButton.setAttribute('aria-expanded', String(overview.open)); });
                headingContent.append(mapButton);
            }
            section.append(routeSummary(group.changes, toggleRoute));
        }
        if (base === 'stops') { const view = changeMapPanel(group, section, records, entry.routeGeometryFile); section.append(view.panel); view.attach(); }
        for (const change of group.changes) {
            const record = element('details', undefined, routeSection ? 'record route-panel' : 'record');
            const summary = element('summary'); summary.append(element('span', `${change.status[0].toUpperCase()}${change.status.slice(1)} · ${change.label}`, change.status), element('span', `  ${change.id}`, 'id')); const description = describeChange(change); if (description) summary.append(description); record.append(summary);
            if (routeSection) {
                const title = element('h4', `${change.status[0].toUpperCase()}${change.status.slice(1)} · ${change.label}`, change.status);
                record.append(title);
                const description = describeChange(change);
                if (description) record.append(description);
                const view = changeMapPanel({ ...group, changes: [change] }, record, records, entry.routeGeometryFile);
                record.append(view.panel); view.attach();
            }
            // Build before/after values on demand, keeping large updates responsive.
            record.addEventListener('toggle', () => {
                if (!record.open || record.dataset.loaded) return;
                record.dataset.loaded = 'true';
                for (const [key, label] of [['stopsAdded', 'Stops added'], ['stopsRemoved', 'Stops removed']]) {
                    if (change.context?.[key]?.length) record.append(element('div', `${label}: ${change.context[key].map(stop => stop.name).join('; ')}`, 'stop-membership'));
                }
                appendScheduleChanges(record, change.fields);
                appendFieldValues(record, change.fields.filter(field => field.sourceKind !== 'schedules'));
                if (change.technicalFields?.length) {
                    const technical = element('details', undefined, 'technical-details');
                    technical.append(element('summary', 'Technical details, excluded from change counts'));
                    appendFieldValues(technical, change.technicalFields);
                    record.append(technical);
                }
            });
            records.set(change.id, record);
            if (!routeSection) section.append(record);
        }
    }
}
async function render() {
    const version = ++generation;
    document.body.dataset.city = city;
    for (const button of document.querySelectorAll('#cities button')) button.setAttribute('aria-pressed', String(button.dataset.city === city));
    for (const dispose of mapDisposers) dispose();
    mapDisposers.clear();
    timeline.replaceChildren();
    if (!index) return;
    const entries = index.entries.filter(entry => entry.city === city);
    status.hidden = false;
    status.textContent = 'Loading history…';
    try {
        const reports = await Promise.all(entries.map(async entry => ({ entry, data: await load(entry.id) })));
        if (version !== generation) return;
        for (const data of dailyChanges(reports.map(({ data }) => data))) {
            const entry = data;
            if (!entry.baseline && !selectedGroups(data).length) continue;
            if (entry.baseline && (search.value.trim() || kind.value)) continue;
            const section = element('section', undefined, 'update');
            section.dataset.observedAt = entry.observedAt;
            const heading = element('h2', undefined, 'update-date');
            const timestamp = element('time', date(entry.observedAt)); timestamp.dateTime = entry.observedAt;
            heading.append(timestamp); section.append(heading);
            const body = element('div', undefined, 'body'); section.append(body); timeline.append(section);
            renderDetails(body, data);
        }
        if (!timeline.children.length) timeline.append(element('p', 'No changes match these filters.'));
        status.textContent = '';
        status.hidden = true;
    } catch (error) { if (version === generation) { status.hidden = false; status.textContent = error.message; } }
}
for (const [id, name] of Object.entries(cityNames)) {
    const button = element('button', name); button.dataset.city = id; button.addEventListener('click', () => { city = id; const url = new URL(location.href); url.searchParams.set('city', id); history.replaceState(null, '', url); render(); }); document.querySelector('#cities').append(button);
}
let timer;
search.addEventListener('input', () => { generation++; clearTimeout(timer); timer = setTimeout(render, 180); });
kind.addEventListener('change', render);
let checkingHistory = false;
async function refreshHistory() {
    if (checkingHistory || document.hidden) return;
    checkingHistory = true;
    try {
        const response = await fetch('index.json', { cache: 'no-store' });
        if (!response.ok) throw new Error('History is not available yet.');
        const updated = await response.json();
        if (JSON.stringify(updated) !== JSON.stringify(index)) {
            index = updated;
            cache.clear();
            await render();
        }
    } catch (error) {
        // Keep the current history usable if a background refresh fails.
        if (!index) { status.hidden = false; status.textContent = error.message; }
    } finally { checkingHistory = false; }
}
refreshHistory();
setInterval(refreshHistory, 60000);
window.addEventListener('focus', refreshHistory);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshHistory(); });
