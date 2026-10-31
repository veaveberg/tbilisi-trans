import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compareRecords, generateHistory } from './data-history.js';

assert.deepEqual(compareRecords([{ id: 'a', name: 'A' }, { id: 'b' }], [{ id: 'b' }, { name: 'A', id: 'a' }]), []);
assert.deepEqual(compareRecords([{ id: 'a', stops: ['1', '2'] }], [{ id: 'a', stops: ['2', '1'] }])[0].fields[0], { field: 'stops', before: ['1', '2'], after: ['2', '1'] });
assert.equal(compareRecords([{ id: 'a' }], [])[0].status, 'removed');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transit-history-'));
const save = (dir, file, value) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, file), JSON.stringify(value)); };
try {
    const archive = path.join(root, 'data-archive/260101-0000'), current = path.join(root, 'public/data');
    save(archive, 'archive-meta.json', { archivedAt: '2026-01-01T00:00:00Z' });
    save(archive, 'tbilisi_stops_en.json', [{ id: '1', name: 'Old name' }]);
    save(current, 'tbilisi_stops_en.json', [{ id: '1', name: 'New name' }]);
    save(current, 'tbilisi_routes_en.json', [{ id: 'route' }]);
    save(current, 'manifest.json', { generatedAt: '2026-01-02T00:00:00Z' });
    const first = generateHistory(root);
    assert.equal(first.entries.length, 2);
    assert.equal(first.entries[0].counts.modified, 1);
    assert.equal(first.entries[0].counts.added, 0, 'Absent historical files must not count as new records');
    const legacyPath = path.join(root, 'public/data-history', `${first.entries[0].id}.json`);
    const legacyEntry = JSON.parse(fs.readFileSync(legacyPath));
    delete legacyEntry.contextVersion;
    for (const group of legacyEntry.groups) for (const change of group.changes) delete change.context;
    fs.writeFileSync(legacyPath, JSON.stringify(legacyEntry));
    const enrichedIndex = generateHistory(root);
    assert.deepEqual(enrichedIndex.entries.map(entry => entry.id), first.entries.map(entry => entry.id), 'Enriching existing reports must preserve their IDs and chronology');
    assert.equal(JSON.parse(fs.readFileSync(legacyPath)).contextVersion, 11);
    assert.equal(generateHistory(root).entries.length, 2, 'Repeated runs must not duplicate history');
    save(current, 'tbilisi_stops_en.json', [{ id: '1', name: 'Another name' }]);
    save(current, 'manifest.json', { generatedAt: '2026-01-03T00:00:00Z' });
    const next = generateHistory(root);
    assert.equal(next.entries.length, 3, 'Updates must be retained without new full archives');
    const detail = JSON.parse(fs.readFileSync(path.join(root, 'public/data-history', `${next.entries[0].id}.json`)));
    assert.equal(detail.groups[0].changes[0].fields[0].before, 'New name');
    assert.equal(detail.groups[0].changes[0].fields[0].after, 'Another name');
    console.log('Data history comparisons, backfill, missing files, and incremental persistence passed.');
} finally { fs.rmSync(root, { recursive: true, force: true }); }

// Enrichment joins the two original snapshots; route IDs intentionally sort in
// the opposite order from the public numbers.
const contextRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'transit-history-context-'));
try {
    const { cityContext, enrichChanges } = await import('./data-history-context.js');
    const previousDir = path.join(contextRoot, 'before'), nextDir = path.join(contextRoot, 'after');
    const oldRoutes = [{ id: 'z', shortName: '2', stops: ['s1', 's2'] }, { id: 'a', shortName: '10', stops: [] }];
    const newRoutes = [{ id: 'z', shortName: '2', stops: ['s2', 's3'] }, { id: 'a', shortName: '10', stops: ['s1'] }];
    const oldStops = [{ id: 's1', name: 'Old stop', lat: 41, lon: 44 }, { id: 's2', name: 'Removed stop' }];
    const newStops = [{ id: 's1', name: 'Renamed stop', lat: 41.001, lon: 44 }, { id: 's3', name: 'New stop' }];
    for (const [dir, routes, stops] of [[previousDir, oldRoutes, oldStops], [nextDir, newRoutes, newStops]]) {
        save(dir, 'tbilisi_routes_en.json', routes);
        save(dir, 'tbilisi_stops_en.json', stops);
    }
    const oldSchedule = [{ fromDay: 'MONDAY', serviceDates: ['2026-01-01'], stops: [{ id: 's1', arrivalTimes: '08:00,09:00' }] }];
    const newSchedule = [{ ...oldSchedule[0], serviceDates: ['2026-01-08'] }];
    save(previousDir, 'tbilisi_schedules.json', { z_0_01: oldSchedule });
    save(nextDir, 'tbilisi_schedules.json', { z_0_01: newSchedule });
    const contexts = dir => Object.fromEntries(['en', 'ka'].map(locale => [locale, cityContext(dir, 'tbilisi', locale)]));
    const groups = enrichChanges([
        { kind: 'routes_en', changes: compareRecords(oldRoutes, newRoutes) },
        { kind: 'stops_en', changes: compareRecords(oldStops, newStops) },
        { kind: 'schedules', changes: compareRecords({ z_0_01: oldSchedule }, { z_0_01: newSchedule }) }
    ], contexts(previousDir), contexts(nextDir));
    assert.deepEqual(groups[0].changes.map(change => change.context.route.shortName), ['2', '10']);
    const changedStop = groups[1].changes.find(change => change.id === 's1');
    assert.deepEqual(changedStop.context.routesBefore.map(route => route.shortName), ['2']);
    assert.deepEqual(changedStop.context.routesAfter.map(route => route.shortName), ['10']);
    assert.deepEqual(changedStop.context.routesRemoved.map(route => route.shortName), ['2']);
    assert.match(changedStop.context.description, /Renamed.*Location moved about 111 m/);
    assert.deepEqual(changedStop.context.locationBefore.coordinates, [44, 41]);
    assert.deepEqual(changedStop.context.locationAfter.coordinates, [44, 41.001]);
    assert.deepEqual(groups[1].changes.find(change => change.id === 's2').context.routesBefore.map(route => route.shortName), ['2']);
    assert.deepEqual(groups[1].changes.find(change => change.id === 's3').context.routesAfter.map(route => route.shortName), ['2']);
    assert.equal(groups[2].changes[0].context.description, 'Service dates updated; timetable unchanged.');
    assert.deepEqual(groups[0].changes[0].context.relatedChanges, ['schedules']);
    assert.equal(groups[0].changes[0].context.stopsAdded[0].name, 'New stop');
    assert.equal(groups[0].changes[0].context.stopsRemoved[0].name, 'Old stop');
    assert.equal(contexts(nextDir).ka.hasRoutes, false, 'Missing locale data must remain unknown');
    console.log('Numeric route order, historical stop service, named route changes and timetable descriptions passed.');
} finally { fs.rmSync(contextRoot, { recursive: true, force: true }); }

const scheduleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'transit-schedule-history-'));
try {
    const oldSchedule = [{ fromDay: 'MONDAY', toDay: 'FRIDAY', serviceDates: ['2026-01-01'], stops: [{ id: 'first', arrivalTimes: '08:00,09:00' }, { id: 'later', arrivalTimes: '08:15,09:15' }] }];
    const rolled = [{ ...oldSchedule[0], serviceDates: ['2026-01-08'] }];
    const changed = structuredClone(rolled);
    changed[0].stops[1].arrivalTimes = '08:20,09:20';
    const options = { schedules: true };
    assert.deepEqual(compareRecords({ route: oldSchedule }, { route: rolled }, options), [], 'Date rollovers must not be modified schedules');
    assert.equal(compareRecords({ route: rolled }, { route: changed }, options).length, 1, 'Later-stop departure changes must remain visible');
    assert.equal(compareRecords({ route: oldSchedule }, { route: [{ ...rolled[0], fromDay: 'SATURDAY' }] }, options).length, 1, 'Weekday service changes must remain visible');
    assert.equal(compareRecords({}, { route: rolled }, options)[0].status, 'added');
    assert.equal(compareRecords({ route: oldSchedule }, {}, options)[0].status, 'removed');
    const archive = path.join(scheduleRoot, 'data-archive/260101-0000'), current = path.join(scheduleRoot, 'public/data');
    save(archive, 'archive-meta.json', { archivedAt: '2026-01-01T00:00:00Z' });
    save(archive, 'tbilisi_schedules.json', { route: oldSchedule });
    save(current, 'tbilisi_schedules.json', { route: rolled });
    save(current, 'manifest.json', { generatedAt: '2026-01-02T00:00:00Z' });
    assert.equal(generateHistory(scheduleRoot).entries.length, 1, 'A rollover-only update must not create a timeline entry');
    save(current, 'tbilisi_schedules.json', { route: changed });
    save(current, 'manifest.json', { generatedAt: '2026-01-03T00:00:00Z' });
    const index = generateHistory(scheduleRoot);
    assert.equal(index.entries[0].counts.modified, 1);
    const rolloverChange = { ...compareRecords({ route: oldSchedule }, { route: rolled })[0], context: { route: { id: 'route', shortName: '2' }, description: 'Service dates updated; timetable unchanged.' } };
    const routeChange = { id: 'route', status: 'modified', label: 'Route 2', fields: [], context: { route: { id: 'route', shortName: '2' }, relatedChanges: ['schedules'] } };
    const output = path.join(scheduleRoot, 'public/data-history');
    for (const [id, groups] of [
        ['legacy-mixed', [{ kind: 'routes_en', changes: [routeChange] }, { kind: 'schedules', changes: [rolloverChange] }]],
        ['legacy-rollover-only', [{ kind: 'schedules', changes: [rolloverChange] }]]
    ]) {
        save(output, `${id}.json`, { contextVersion: 2, city: 'tbilisi', observedAt: '2026-01-02T12:00:00Z', comparedWith: '2026-01-01T00:00:00Z', baseline: false, groups, unavailable: [] });
        index.entries.push({ id, city: 'tbilisi', observedAt: '2026-01-02T12:00:00Z', comparedWith: '2026-01-01T00:00:00Z', baseline: false, counts: { added: 0, removed: 0, modified: groups.length }, groupCounts: [] });
    }
    save(output, 'index.json', index);
    const migrated = generateHistory(scheduleRoot);
    assert.equal(migrated.entries.some(entry => entry.id === 'legacy-rollover-only'), false, 'Old rollover-only entries must be removed from the timeline');
    const mixed = migrated.entries.find(entry => entry.id === 'legacy-mixed');
    assert.equal(mixed.counts.modified, 1);
    assert.deepEqual(mixed.groupCounts.map(group => group.kind), ['routes_en']);
    const report = JSON.parse(fs.readFileSync(path.join(output, 'legacy-mixed.json')));
    assert.deepEqual(report.groups[0].changes[0].context.relatedChanges, [], 'Date rollovers must not appear as related schedule changes');
    assert.deepEqual(generateHistory(scheduleRoot).entries, migrated.entries, 'Migration must be idempotent');
    console.log('Schedule rollover exclusion, actual timetable changes, historical counts and cross-references passed.');
} finally { fs.rmSync(scheduleRoot, { recursive: true, force: true }); }

const identityRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'transit-route-identity-'));
try {
    const { matchRouteIdentities, alignRouteRecords } = await import('./data-history-identities.js');
    const oldRoute = { id: 'old_route', shortName: '9', longName: 'A to B', mode: 'BUS', stops: ['s1', 's2', 's3'], _sourceRouteId: 'old_route' };
    const newRoute = { ...oldRoute, id: 'new_route', _sourceRouteId: 'new_route', stops: ['s1', 's2', 's4'] };
    const aliases = matchRouteIdentities([oldRoute], [newRoute]);
    assert.deepEqual([...aliases], [['old_route', 'new_route']]);
    for (const [before, after] of [
        [[oldRoute, { ...oldRoute, id: 'duplicate' }], [newRoute]],
        [[oldRoute], [{ ...newRoute, mode: 'TRAM' }]],
        [[oldRoute], [{ ...newRoute, longName: 'Unrelated route' }]],
        [[oldRoute], [{ ...newRoute, stops: ['x', 'y', 'z'] }]],
        [[oldRoute], [oldRoute, newRoute]]
    ]) assert.equal(matchRouteIdentities(before, after).size, 0, 'Ambiguous or unrelated services must not be merged');
    const preserved = structuredClone(oldRoute);
    assert.equal(alignRouteRecords([oldRoute], 'routes_en', aliases)[0].id, 'new_route');
    assert.deepEqual(oldRoute, preserved, 'Matching must never modify the fetched dataset');
    const archive = path.join(identityRoot, 'data-archive/260101-0000'), current = path.join(identityRoot, 'public/data');
    save(archive, 'archive-meta.json', { archivedAt: '2026-01-01T00:00:00Z' });
    const oldSchedule = [{ fromDay: 'MONDAY', serviceDates: ['2026-01-01'], stops: [{ id: 's1', arrivalTimes: '08:00,09:00' }] }];
    const newSchedule = [{ ...oldSchedule[0], serviceDates: ['2026-01-08'] }];
    for (const [dir, route, schedule] of [[archive, oldRoute, oldSchedule], [current, newRoute, newSchedule]]) {
        save(dir, 'tbilisi_routes_en.json', [route]);
        save(dir, 'tbilisi_stops_en.json', ['s1', 's2', 's3', 's4'].map(id => ({ id, name: id, lon: 44 + Number(id.slice(1)) / 1000, lat: 41 })));
        save(dir, 'tbilisi_routes_details_en.json', { [route.id]: route });
        save(dir, 'tbilisi_schedules.json', { [`${route.id}_0_01`]: schedule });
        save(dir, 'tbilisi_polylines.json', { [`${route.id}_0_01`]: { '0:01': [[44, 41], [45, 42]] } });
    }
    save(current, 'manifest.json', { generatedAt: '2026-01-02T00:00:00Z' });
    const index = generateHistory(identityRoot);
    const reportPath = path.join(identityRoot, 'public/data-history', `${index.entries[0].id}.json`);
    const report = JSON.parse(fs.readFileSync(reportPath));
    assert.equal(index.entries[0].counts.added, 0);
    assert.equal(index.entries[0].counts.removed, 0);
    assert.deepEqual(report.groups.map(group => group.kind), ['routes_en', 'routes_details_en'], 'Unchanged geometry and date-only timetables must not be reported under the new ID');
    const routeChange = report.groups[0].changes[0];
    assert.equal(routeChange.status, 'modified');
    const paths = JSON.parse(fs.readFileSync(path.join(identityRoot, 'public/data-history', report.routeGeometryFile)));
    assert.deepEqual(paths.new_route.before['0:01'], [[44, 41], [45, 42]]);
    assert.deepEqual(paths.new_route.after['0:01'], [[44, 41], [45, 42]]);
    assert.deepEqual(paths.new_route.stops.en.added[0].coordinates, [44.004, 41]);
    assert.deepEqual(paths.new_route.stops.en.removed[0].coordinates, [44.003, 41]);
    assert.equal(index.entries[0].displayGroupCounts.en.find(group => group.kind === 'routes_en').counts.modified, 1, 'Display totals must count the unified route only once');
    assert.equal(routeChange.previousId, 'old_route');
    assert.deepEqual(routeChange.context.stopsAdded.map(stop => stop.id), ['s4']);
    assert.deepEqual(routeChange.context.stopsRemoved.map(stop => stop.id), ['s3']);
    assert.deepEqual(routeChange.fields.find(field => field.field === 'sourceRouteId'), { field: 'sourceRouteId', before: 'old_route', after: 'new_route' });
    // Rebuild an existing report in place from its original observations.
    report.contextVersion = 2;
    fs.writeFileSync(reportPath, JSON.stringify(report));
    const migrated = generateHistory(identityRoot);
    assert.equal(migrated.entries[0].id, index.entries[0].id);
    assert.deepEqual(migrated.entries[0].counts, index.entries[0].counts);
    assert.equal(JSON.parse(fs.readFileSync(reportPath)).contextVersion, 11);
    console.log('Route identity reconciliation, conservative matching, source preservation and historical migration passed.');
} finally { fs.rmSync(identityRoot, { recursive: true, force: true }); }

{
    const { stopChangeFeatures, CHANGE_COLORS } = await import('../data-history/stop-change-features.js');
    const { getBasemapOptions } = await import('../src/map-basemap.js');
    const location = (name, lon, lat) => ({ name, coordinates: [lon, lat] });
    const changes = [
        { id: 'added', label: 'Added stop', status: 'added', context: { locationAfter: location('Added stop', 44, 41) } },
        { id: 'removed', label: 'Removed stop', status: 'removed', context: { locationBefore: location('Old stop name', 45, 42) } },
        { id: 'moved', label: 'Moved stop', status: 'modified', context: { locationBefore: location('Before', 44.5, 41.5), locationAfter: location('After', 44.6, 41.6) } },
        { id: 'renamed', label: 'Renamed stop', status: 'modified', context: { locationBefore: location('Old', 43, 42), locationAfter: location('New', 43, 42) } },
        { id: 'unknown', status: 'removed', context: {} }
    ];
    const features = stopChangeFeatures(changes);
    assert.equal(features.points.features.length, 5);
    assert.equal(features.moves.features.length, 1);
    assert.equal(features.unavailable, 1);
    assert.deepEqual(features.points.features.find(feature => feature.properties.id === 'removed').geometry.coordinates, [45, 42]);
    assert.equal(features.points.features.find(feature => feature.properties.id === 'removed').properties.name, 'Old stop name');
    assert.equal(features.points.features.filter(feature => feature.properties.previous).length, 1);
    assert.equal(features.points.features.find(feature => feature.properties.previous).properties.name, 'Before');
    assert.equal(stopChangeFeatures([changes[0]]).points.features.length, 1, 'The map must respect the filtered change list');
    assert.equal(stopChangeFeatures([{ status: 'added', context: { locationAfter: location('Invalid', 200, 91) } }]).unavailable, 1);
    assert.deepEqual(CHANGE_COLORS, { added: '#176b46', modified: '#175d9e', removed: '#a72d3d' });
    assert.equal(getBasemapOptions().style, 'mapbox://styles/mapbox/standard');
    assert.equal(getBasemapOptions().config.basemap.showTransitLabels, false);
    console.log('Historical map locations, movement lines, filtered markers, change colors and shared basemap passed.');
}

{
    const { combineRouteGroups } = await import('../data-history/route-change-groups.js');
    const { routeChangeFeatures } = await import('../data-history/route-change-features.js');
    const { decodePolyline } = await import('../src/polyline.js');
    const route = { id: 'r', shortName: '9', name: 'A to B' };
    const change = (id, field, status = 'modified', context = {}) => ({ id, label: 'Route 9', status, fields: [{ field, before: 'old', after: 'new' }], context: { route, description: 'Updated.', relatedChanges: ['routes', 'routes_details', 'polylines', 'schedules'], ...context } });
    const groups = [
        { kind: 'routes_en', changes: [change('r', 'stops', 'modified', { stopsAdded: [{ id: 's1', name: 'First' }] })] },
        { kind: 'routes_details_en', changes: [change('r', 'patterns', 'modified', { stopsAdded: [{ id: 's1', name: 'First' }] })] },
        { kind: 'routes_ka', changes: [{ ...change('r', 'longName'), label: 'Other language' }] },
        { kind: 'polylines', changes: [change('r_0_01', '0:01'), change('r_1_01', '1:01', 'added')] },
        { kind: 'schedules', changes: [change('r_0_01', 'Record')] }
    ];
    const combined = combineRouteGroups(groups, 'en');
    assert.deepEqual(combined.map(group => group.kind), ['routes_en']);
    assert.equal(combined[0].changes.length, 1, 'A route must appear once across route, details and geometry records');
    const unified = combined[0].changes[0];
    assert.equal(unified.status, 'modified', 'Adding a geometry pattern must not turn an existing route into an added route');
    assert.equal(unified.context.stopsAdded.length, 1);
    assert.match(unified.context.description, /1 stop added.*Route patterns updated.*Geometry changed for 2 patterns/);
    assert.deepEqual(unified.context.relatedChanges, []);
    assert.equal(unified.context.scheduleChanged, true);
    assert.equal(unified.context.geometryChanged, true);
    const scheduleOnly = combineRouteGroups([groups[4]], 'en')[0].changes[0];
    assert.equal(scheduleOnly.context.scheduleChanged, true);
    assert.equal(scheduleOnly.context.serviceChanged, false);
    assert.equal(scheduleOnly.context.geometryChanged, false);
    assert.equal(unified.fields.length, 6, 'Changes from both languages must remain inspectable in the same route entry');
    assert.equal(unified.fields.find(field => field.field === 'longName').language, 'ka');
    const geometryOnly = combineRouteGroups([groups[3]], 'en')[0].changes[0];
    assert.equal(geometryOnly.status, 'modified');
    assert.equal(combineRouteGroups([{ kind: 'routes_en', changes: [change('r', 'Record', 'removed')] }], 'en')[0].changes[0].status, 'removed');
    const features = routeChangeFeatures([unified], { r: { before: { '0:01': [[44, 41], [45, 42]] }, after: { '0:01': [[44, 41], [46, 42]] } } });
    assert.equal(features.features.length, 2);
    assert.equal(features.features.filter(feature => feature.properties.previous).length, 1);
    const same = { '0:01': [[44, 41], [45, 42]] };
    assert.equal(routeChangeFeatures([unified], { r: { before: same, after: same } }).features.length, 1, 'Unchanged paths must not be drawn twice');
    assert.equal(routeChangeFeatures([{ ...unified, status: 'removed' }], { r: { before: same, after: {} } }).features[0].properties.status, 'removed');
    assert.equal(routeChangeFeatures([unified], {}).unavailable.length, 1, 'Missing source geometry must not be approximated');
    const decoded = decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
    assert.ok(Math.abs(decoded[0][0] + 120.2) < 0.00001 && Math.abs(decoded[0][1] - 38.5) < 0.00001);
    assert.equal(decoded.length, 3);
    console.log('Unified route records, unique counts, preserved fields and before/after route geometry passed.');
}

{
    const { changedPathSections } = await import('../data-history/route-geometry-diff.js');
    const { routeChangeFeatures } = await import('../data-history/route-change-features.js');
    const a = [44, 41], b = [44.001, 41], c = [44.002, 41], detour = [44.0015, 41.001];
    assert.deepEqual(changedPathSections([[a, c]], [[a, b, c]]), { added: [], removed: [] }, 'Resampling the same alignment must not appear as a reroute');
    assert.deepEqual(changedPathSections([[a, b, c]], [[c, b, a]]), { added: [], removed: [] }, 'Direction reversal must not change the physical alignment');
    const diff = changedPathSections([[a, b, c]], [[a, b, detour, c]]);
    assert.deepEqual(diff.added, [[b, detour, c]], 'Highlights must preserve original new vertices');
    assert.deepEqual(diff.removed, [[b, c]], 'Highlights must preserve original previous vertices');
    assert.deepEqual(changedPathSections([[a, c]], [[[44, 41.00004], [44.002, 41.00004]]]), { added: [], removed: [] });
    const change = { id: 'r', label: 'Route 9', status: 'modified', context: { description: 'Edited.' } };
    const paths = { r: { before: { p: [a, b, c] }, after: { p: [a, b, detour, c] }, stops: { en: {
        added: [{ id: 'new', name: 'Added stop', coordinates: detour }],
        removed: [{ id: 'old', name: 'Removed stop', coordinates: b }]
    } } } };
    const features = routeChangeFeatures([change], paths);
    assert.equal(features.highlights.features.filter(feature => feature.properties.status === 'added').length, 1);
    assert.equal(features.highlights.features.filter(feature => feature.properties.status === 'removed').length, 1);
    assert.equal(features.stops.features.length, 2);
    assert.deepEqual(features.stops.features.find(feature => feature.properties.status === 'removed').geometry.coordinates, b);
    assert.equal(features.stops.features.find(feature => feature.properties.status === 'added').properties.stopName, 'Added stop');
    assert.equal(routeChangeFeatures([change], { r: { ...paths.r, before: null } }).highlights.features.length, 0, 'Unknown previous paths must not be reported as added geometry');
    console.log('Added/removed route stops, geometry differences, original vertices and resampling tolerance passed.');
}

const metadataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'transit-history-metadata-'));
try {
    const options = { ignoredFields: ['defaultPatternSuffix'] };
    const before = { r: { id: 'r', shortName: '9', defaultPatternSuffix: '1:01', patterns: [{ patternSuffix: '1:01', headsign: 'A' }, { patternSuffix: '0:01', headsign: 'B' }] } };
    const metadataOnly = structuredClone(before); metadataOnly.r.defaultPatternSuffix = '0:01';
    assert.deepEqual(compareRecords(before, metadataOnly, options), []);
    const substantive = structuredClone(metadataOnly); substantive.r.patterns.reverse();
    const changes = compareRecords(before, substantive, options);
    assert.deepEqual(changes[0].fields.map(field => field.field), ['patterns'], 'Real pattern-order changes must remain visible');
    assert.deepEqual(changes[0].technicalFields, [{ field: 'defaultPatternSuffix', before: '1:01', after: '0:01' }]);
    assert.equal(compareRecords({}, before, options)[0].status, 'added');
    assert.equal(compareRecords(before, {}, options)[0].status, 'removed');
    const archive = path.join(metadataRoot, 'data-archive/260101-0000'), current = path.join(metadataRoot, 'public/data');
    save(archive, 'archive-meta.json', { archivedAt: '2026-01-01T00:00:00Z' });
    save(archive, 'tbilisi_routes_details_en.json', before);
    save(current, 'tbilisi_routes_details_en.json', metadataOnly);
    save(current, 'manifest.json', { generatedAt: '2026-01-02T00:00:00Z' });
    assert.equal(generateHistory(metadataRoot).entries.length, 1, 'Metadata-only updates must not create timeline entries');
    substantive.r.defaultPatternSuffix = '1:01';
    save(current, 'tbilisi_routes_details_en.json', substantive);
    save(current, 'manifest.json', { generatedAt: '2026-01-03T00:00:00Z' });
    const index = generateHistory(metadataRoot);
    assert.equal(index.entries.length, 2);
    assert.equal(index.entries[0].counts.modified, 1);
    const output = path.join(metadataRoot, 'public/data-history');
    const report = JSON.parse(fs.readFileSync(path.join(output, `${index.entries[0].id}.json`)));
    assert.deepEqual(report.groups[0].changes[0].fields.map(field => field.field), ['patterns']);
    assert.equal(report.groups[0].changes[0].technicalFields[0].field, 'defaultPatternSuffix');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(current, 'tbilisi_routes_details_en.json'))), substantive, 'Source metadata must remain untouched');
    // An older report may remain after its source snapshots have disappeared.
    const legacy = { id: 'legacy-metadata-only', city: 'tbilisi', observedAt: '2026-01-02T12:00:00Z', comparedWith: '2026-01-01T12:00:00Z', baseline: false, counts: { added: 0, removed: 0, modified: 1 }, groupCounts: [] };
    save(output, `${legacy.id}.json`, { ...legacy, contextVersion: 4, unavailable: [], groups: [{ kind: 'routes_details_en', changes: [{ id: 'r', status: 'modified', label: 'Route 9', fields: [{ field: 'defaultPatternSuffix', before: '1:01', after: '0:01' }], context: { description: 'Updated defaultPatternSuffix.', route: { id: 'r', shortName: '9' } } }] }] });
    index.entries.push(legacy); save(output, 'index.json', index);
    const cleaned = generateHistory(metadataRoot);
    assert.equal(cleaned.entries.some(entry => entry.id === legacy.id), false);
    assert.deepEqual(generateHistory(metadataRoot).entries, cleaned.entries, 'Metadata exclusion must remain idempotent');
    console.log('Default-pattern metadata exclusion, real pattern changes, technical values, legacy counts and source preservation passed.');
} finally { fs.rmSync(metadataRoot, { recursive: true, force: true }); }

{
    const { combineRouteGroups } = await import('../data-history/route-change-groups.js');
    const { stopChangeFeatures } = await import('../data-history/stop-change-features.js');
    const namesBefore = { en: 'Old name', ka: 'ძველი სახელი' }, namesAfter = { en: 'New name', ka: 'ახალი სახელი' };
    const context = { entityBefore: true, entityAfter: true, namesBefore, namesAfter, locationBefore: { name: 'Old name', coordinates: [44, 41] }, locationAfter: { name: 'New name', coordinates: [44.001, 41] }, description: 'Location moved about 84 m.' };
    const stop = language => ({ id: 'same-stop', status: 'modified', label: namesAfter[language], fields: [{ field: 'name', before: namesBefore[language], after: namesAfter[language] }, { field: 'lon', before: 44, after: 44.001 }], context });
    const groups = ['en', 'ka'].map(language => ({ kind: `stops_${language}`, changes: [stop(language)] }));
    for (const preferred of ['en', 'ka']) {
        const projected = combineRouteGroups(groups, preferred);
        assert.equal(projected.length, 1);
        assert.equal(projected[0].changes.length, 1, 'Two changed translations must be one stop change');
        const change = projected[0].changes[0];
        assert.equal(change.label, namesAfter[preferred]);
        assert.deepEqual(new Set(change.fields.filter(field => field.field === 'name').map(field => field.language)), new Set(['en', 'ka']));
        assert.equal(change.fields.filter(field => field.field === 'lon').length, 1, 'The same coordinate change in two locales must be shown once');
        assert.equal(stopChangeFeatures(projected[0].changes).points.features.filter(feature => !feature.properties.previous).length, 1);
    }
    const georgianOnly = combineRouteGroups([groups[1]], 'en')[0].changes;
    assert.equal(georgianOnly.length, 1, 'Georgian-only changes must be visible with English display names');
    assert.equal(georgianOnly[0].label, 'New name');
    assert.equal(georgianOnly[0].fields.find(field => field.field === 'name').language, 'ka');
    assert.equal(combineRouteGroups([groups[0]], 'ka')[0].changes.length, 1, 'English-only changes must remain visible in Georgian display mode');
    const addedTranslation = { ...stop('ka'), status: 'added', fields: [{ field: 'Record', before: null, after: { id: 'same-stop', name: namesAfter.ka } }], context: { ...context, namesBefore: { en: 'New name', ka: null } } };
    assert.equal(combineRouteGroups([{ kind: 'stops_ka', changes: [addedTranslation] }], 'en')[0].changes[0].status, 'modified', 'A new translation must not be counted as a newly added physical stop');
    const differentIds = [{ ...groups[0], changes: [stop('en'), { ...stop('en'), id: 'different-stop' }] }, groups[1]];
    assert.equal(combineRouteGroups(differentIds, 'en')[0].changes.length, 2, 'Identical names must not merge different stop IDs');
    console.log('Bilingual entity deduplication, one-language changes, field labels, counts and map markers passed.');
}

{
    const { dailyChanges, dayKey, dayLabel } = await import('../data-history/daily-changes.js');
    const report = (observedAt, before, after) => ({ observedAt, baseline: false, unavailable: [], groups: [{ kind: 'stops_en', changes: [{ id: 's', status: 'modified', fields: [{ field: 'name', before, after }], context: {} }] }] });
    const merged = dailyChanges([report('2026-10-24T09:00:00Z', 'A', 'B'), report('2026-10-24T12:00:00Z', 'B', 'C')]);
    assert.equal(merged.length, 1);
    assert.deepEqual(merged[0].groups[0].changes[0].fields, [{ field: 'name', before: 'A', after: 'C' }]);
    assert.equal(dailyChanges([report('2026-10-24T09:00:00Z', 'A', 'B'), report('2026-10-24T12:00:00Z', 'B', 'A')])[0].groups.length, 0);
    assert.equal(dayKey('2026-10-23T21:00:00Z'), dayKey('2026-10-24T09:00:00Z'));
    assert.equal(dayLabel('2026-10-24T09:00:00Z', '2026-12-01'), '24 Oct');
    assert.equal(dayLabel('2025-10-24T09:00:00Z', '2026-12-01'), '24 Oct 2025');
    console.log('Daily merging, reverted changes, Tbilisi day boundaries and date labels passed.');
}

{
    const old = { r: { _stopsOfPatterns: [{ stop: { id: 's', name: 'Old', lat: 41 }, patternSuffix: '0:01' }] } };
    const renamed = structuredClone(old);
    renamed.r._stopsOfPatterns[0].stop.name = 'New';
    assert.deepEqual(compareRecords(old, renamed, { routeDetails: true }), [], 'Embedded stop renames must not classify the route as changed');
    assert.equal(compareRecords(old, renamed).length, 1, 'The stop name must still participate outside route details');
    const moved = structuredClone(renamed);
    moved.r._stopsOfPatterns[0].stop.lat = 42;
    assert.equal(compareRecords(old, moved, { routeDetails: true }).length, 1, 'Stop location changes remain route changes');
    const replaced = structuredClone(renamed);
    replaced.r._stopsOfPatterns[0].stop.id = 'other';
    assert.equal(compareRecords(old, replaced, { routeDetails: true }).length, 1, 'Stop membership changes must remain visible');
    console.log('Embedded stop renames excluded from route changes; stop identities and locations preserved.');
}

{
    const { patternAliases, alignPatternRecords } = await import('./data-history-patterns.js');
    const { combineRouteGroups } = await import('../data-history/route-change-groups.js');
    const detail = suffix => ({ patterns: [{ patternSuffix: suffix, directionId: 1, firstStop: { id: 'a' }, lastStop: { id: 'b' }, headsign: 'Destination' }], _stopsOfPatterns: ['a', 'b'].map(id => ({ stop: { id, name: id }, patternSuffixes: [suffix] })), defaultPatternSuffix: suffix });
    const old = { r: detail('1:01') }, next = { r: detail('1:02') };
    const aliases = patternAliases(old, next);
    assert.equal(aliases.get('r').get('1:01'), '1:02');
    assert.deepEqual(compareRecords(alignPatternRecords(old, 'routes_details_en', aliases), next, { routeDetails: true }), []);
    const paths = { r_1_01: { '1:01': { encodedValue: 'path' } } };
    assert.deepEqual(alignPatternRecords(paths, 'polylines', aliases), { r_1_02: { '1:02': { encodedValue: 'path' } } });
    const schedule = [{ fromDay: 'MONDAY', toDay: 'SUNDAY', stops: [{ id: 'a', arrivalTimes: '8:00' }] }];
    const aligned = alignPatternRecords({ r_1_01: schedule }, 'schedules', aliases);
    assert.deepEqual(compareRecords(aligned, { r_1_02: schedule }, { schedules: true }), []);
    const changed = structuredClone(schedule); changed[0].stops[0].arrivalTimes = '8:30';
    assert.equal(compareRecords(aligned, { r_1_02: changed }, { schedules: true }).length, 1, 'Real timetable changes survive a pattern-code replacement');
    const reordered = { r: detail('1:02') }; reordered.r._stopsOfPatterns.reverse();
    assert.equal(patternAliases(old, reordered).size, 0, 'A changed stop sequence cannot be dismissed as a code replacement');
    const renamed = structuredClone(old); renamed.r.patterns[0].headsign = 'New destination label';
    const changes = compareRecords(old, renamed, { routeDetails: true });
    assert.equal(changes[0].fields[0].semantic, 'rename');
    changes[0].context = { route: { id: 'r', shortName: '401' } };
    assert.equal(combineRouteGroups([{ kind: 'routes_details_en', changes }], 'en')[0].changes[0].context.renameOnly, true);
    console.log('Pattern-code replacements suppressed across details, paths and schedules; real changes and rename classification preserved.');
}

{
    assert.deepEqual(compareRecords([{ id: 'r', longName: 'მუხიანის IV ბ მ/რ  -  ფიროსმანის მოედანი' }], [{ id: 'r', longName: 'მუხიანის IV ბ მ/რ  - ფიროსმანის მოედანი' }]), []);
    assert.deepEqual(compareRecords([{ id: 's', name: ' Stop  name ' }], [{ id: 's', name: 'Stop name' }]), []);
    assert.equal(compareRecords([{ id: 's', name: 'Old stop' }], [{ id: 's', name: 'New stop' }]).length, 1);
    console.log('Whitespace-only name edits excluded; genuine renames preserved.');
}

{
    const { routeChangeFeatures } = await import('../data-history/route-change-features.js');
    const moved = { id: 's', before: { name: 'Stop', coordinates: [44.791684, 41.785745] }, after: { name: 'Stop', coordinates: [44.793253, 41.785567] } };
    const result = routeChangeFeatures([{ id: 'r', label: 'Route 292', status: 'modified' }], { r: { stops: { en: { moved: [moved] } } } });
    assert.equal(result.stops.features.length, 2);
    assert.deepEqual(result.stops.features.map(feature => feature.properties.previous), [true, false]);
    assert.equal(result.stops.features[0].properties.status, 'modified');
    assert.deepEqual(result.moves.features[0].geometry.coordinates, [moved.before.coordinates, moved.after.coordinates]);
    console.log('Route maps preserve both historical stop positions and the movement connector.');
}

{
    const { summarizeSchedule } = await import('../data-history/schedule-summary.js');
    const service = (fromDay, toDay, departures, first, fingerprint) => ({ fromDay, toDay, stopCount: 20, firstStop: { name: 'Terminal', departures, firstDeparture: first, lastDeparture: '23:00' }, timetableFingerprint: fingerprint });
    const result = summarizeSchedule({ before: [service('MONDAY', 'TUESDAY', 10, '8:00', 'a'), service('WEDNESDAY', 'FRIDAY', 12, '7:00', 'b')], after: [service('MONDAY', 'FRIDAY', 12, '7:00', 'b')] });
    assert.equal(result.groups.length, 1);
    assert.equal(result.groups[0].label, 'Mon, Tue');
    assert.equal(result.groups[0].before.departures, 10);
    assert.equal(result.groups[0].after.departures, 12);
    const rollover = service('MONDAY', 'SUNDAY', 10, '8:00', 'a');
    assert.equal(summarizeSchedule({ before: [{ ...rollover, serviceDates: ['old'] }], after: [{ ...rollover, serviceDates: ['new'] }] }).groups.length, 0);
    assert.equal(summarizeSchedule({ before: null, after: [rollover] }).groups[0].before, null);
    assert.equal(summarizeSchedule({ before: [rollover, rollover], after: [rollover] }), null, 'Ambiguous overlapping schedules remain available as source data');
    console.log('Readable schedule comparisons align weekday groups and exclude calendar-only rollovers.');
}

{
    const { scheduleTimeRows } = await import('../data-history/schedule-summary.js');
    const rows = scheduleTimeRows(['7:00', '7:20', '24:00'], ['07:00', '7:30', '0:00']);
    assert.deepEqual(rows.map(row => row.hour), [7, 0]);
    assert.deepEqual(rows[0].departures, [{ minute: '00', status: 'unchanged' }, { minute: '20', status: 'removed' }, { minute: '30', status: 'added' }]);
    assert.deepEqual(rows[1].departures, [{ minute: '00', status: 'unchanged' }]);
    assert.equal(scheduleTimeRows(['8:00', '8:00'], ['8:00'])[0].departures.filter(time => time.status === 'removed').length, 1);
    console.log('Full timetables highlight added/removed departures and normalize midnight without losing duplicate trips.');
}
