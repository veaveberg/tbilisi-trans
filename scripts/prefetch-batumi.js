import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.join(ROOT_DIR, 'public/data');
const ARCHIVE_DIR = path.join(ROOT_DIR, 'data-archive/batumi-app-analysis');
const API_BASE = 'https://thetamaps.site:54321';
const LOCALES = ['en', 'ka'];

async function fetchJson(endpoint, archiveFilename) {
    try {
        const response = await fetch(`${API_BASE}${endpoint}`, {
            headers: { accept: 'application/json' }
        });
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        return await response.json();
    } catch (error) {
        const fallbackPath = path.join(ARCHIVE_DIR, archiveFilename);
        if (!fs.existsSync(fallbackPath)) throw error;
        console.warn(`[Batumi Prefetch] ${endpoint} unavailable; using captured ${archiveFilename}`);
        return JSON.parse(fs.readFileSync(fallbackPath, 'utf8'));
    }
}

function suffixForStatus(status) {
    return `${Math.max(0, Number(status) - 1)}:01`;
}

function localizedStopName(stop, locale) {
    const localized = locale === 'ka' ? stop.BusStopNameKA : stop.BusStopNameEN;
    return String(localized || stop.BusStopNameGeoGps || stop.BusStopNumber || '').trim();
}

function stopRecord(stop, locale) {
    return {
        id: stop.BusStopIdGeoGps,
        code: String(stop.BusStopNumber || ''),
        name: localizedStopName(stop, locale),
        lat: Number(stop.BusStopLatitude),
        lon: Number(stop.BusStopLongitude),
        vehicleMode: 'BUS'
    };
}

function routeStopMemberships(db, routeId, status) {
    return Object.values(db.busStops)
        .filter(stop => Number(stop.routes?.[routeId]?.Status) === Number(status))
        .sort((a, b) => Number(a.routes[routeId].Order) - Number(b.routes[routeId].Order));
}

function endpointName(db, stopId, locale) {
    const stop = db.busStops[stopId];
    return stop ? localizedStopName(stop, locale) : '';
}

function routeLongName(db, routeId, locale, statuses) {
    const ends = statuses.flatMap(status => {
        const info = db.routeStatusInfo?.[routeId]?.[status] || {};
        return [endpointName(db, info.lowestId, locale), endpointName(db, info.highestId, locale)];
    }).filter(Boolean);
    return [...new Set(ends)].slice(0, 2).join(' – ');
}

function serviceDates(days = 35) {
    const dates = [];
    const now = new Date();
    for (let i = 0; i < days; i++) {
        const date = new Date(now);
        date.setDate(now.getDate() + i);
        dates.push(date.toISOString().slice(0, 10));
    }
    return dates;
}

function buildLocaleDataset(db, locale) {
    const stops = Object.values(db.busStops).map(stop => stopRecord(stop, locale));
    const routes = [];
    const details = {};
    const schedules = {};
    const dates = serviceDates();

    for (const [routeId, rawRoute] of Object.entries(db.routesNames)) {
        const statuses = Object.keys(db.routeStatusInfo?.[routeId] || {})
            .map(Number)
            .filter(Number.isFinite)
            .sort((a, b) => a - b);
        const effectiveStatuses = statuses.length > 0 ? statuses : [1, 2];
        const patterns = [];
        const stopSuffixes = new Map();
        const routeStopIds = new Set();

        for (const status of effectiveStatuses) {
            const suffix = suffixForStatus(status);
            const rawStops = routeStopMemberships(db, routeId, status);
            const patternStops = rawStops.map(stop => stopRecord(stop, locale));
            patternStops.forEach(stop => {
                routeStopIds.add(stop.id);
                if (!stopSuffixes.has(stop.id)) stopSuffixes.set(stop.id, []);
                stopSuffixes.get(stop.id).push(suffix);
            });

            const statusInfo = db.routeStatusInfo?.[routeId]?.[status] || {};
            const firstStop = patternStops[0] || null;
            const lastStop = patternStops[patternStops.length - 1] || null;
            const headsign = endpointName(db, statusInfo.highestId, locale) || lastStop?.name || '';
            patterns.push({
                patternSuffix: suffix,
                directionId: status - 1,
                firstStop: firstStop ? { id: firstStop.id, name: firstStop.name } : null,
                lastStop: lastStop ? { id: lastStop.id, name: lastStop.name } : null,
                headsign,
                stops: patternStops
            });

            const scheduleStops = rawStops.map((stop, index) => ({
                name: localizedStopName(stop, locale),
                id: stop.BusStopIdGeoGps,
                code: String(stop.BusStopNumber || ''),
                position: index + 1,
                arrivalTimes: (stop.routes?.[routeId]?.times || []).join(',')
            }));
            schedules[`${routeId}_${suffix.replace(/:/g, '_')}`] = [{
                fromDay: 'MONDAY',
                toDay: 'SUNDAY',
                serviceDates: dates,
                stops: scheduleStops
            }];
        }

        const shortName = String(locale === 'ka'
            ? (rawRoute.RouteNameKA || rawRoute.RouteNameGeoGps)
            : (rawRoute.RouteNameEN || rawRoute.RouteNameGeoGps));
        const longName = routeLongName(db, routeId, locale, effectiveStatuses);
        const baseRoute = {
            id: routeId,
            shortName,
            longName,
            color: '11518A',
            mode: 'BUS',
            isLoop: rawRoute.RouteIsCircle === true,
            stops: Array.from(routeStopIds),
            _sourceRouteId: routeId
        };
        routes.push(baseRoute);
        details[routeId] = {
            ...baseRoute,
            patterns,
            defaultPatternSuffix: patterns[0]?.patternSuffix || '0:01',
            _stopsOfPatterns: Array.from(stopSuffixes.entries()).map(([stopId, patternSuffixes]) => ({
                stop: stopRecord(db.busStops[stopId], locale),
                patternSuffixes
            }))
        };
    }

    routes.sort((a, b) => a.shortName.localeCompare(b.shortName, undefined, { numeric: true }));
    return { stops, routes, details, schedules };
}

function buildPolylines(db) {
    const polylines = {};
    for (const routeId of Object.keys(db.routesNames)) {
        const coordinates = (db.routeCoordinatesGrouped?.[routeId] || [])
            .map(point => [Number(point.lon), Number(point.lat)])
            .filter(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat));
        const statuses = Object.keys(db.routeStatusInfo?.[routeId] || {}).map(Number).filter(Number.isFinite);
        for (const status of (statuses.length ? statuses : [1, 2])) {
            const suffix = suffixForStatus(status);
            polylines[`${routeId}_${suffix.replace(/:/g, '_')}`] = { [suffix]: coordinates };
        }
    }
    return polylines;
}

function validate(datasets, polylines) {
    const en = datasets.en;
    if (en.stops.length === 0 || en.routes.length === 0) throw new Error('Batumi dataset is empty');
    if (datasets.ka.stops.length !== en.stops.length || datasets.ka.routes.length !== en.routes.length) {
        throw new Error('Batumi locale datasets differ in size');
    }
    const stopIds = new Set(en.stops.map(stop => stop.id));
    for (const [routeId, details] of Object.entries(en.details)) {
        if (!details.patterns?.length) throw new Error(`Route ${routeId} has no patterns`);
        for (const pattern of details.patterns) {
            for (const stop of pattern.stops || []) {
                if (!stopIds.has(stop.id)) throw new Error(`Route ${routeId} references missing stop ${stop.id}`);
            }
        }
    }
    if (Object.keys(polylines).length === 0 || Object.keys(en.schedules).length === 0) {
        throw new Error('Batumi geometry or schedules are empty');
    }
}

async function main() {
    console.log('[Batumi Prefetch] Fetching database and geometry...');
    const [dbResponse, pointsResponse] = await Promise.all([
        fetchJson('/api/getDbData', 'getDbData.json'),
        fetchJson('/api/getPointsBetweenStations', 'getPointsBetweenStations.json')
    ]);
    const db = dbResponse?.data;
    if (!db?.busStops || !db?.routesNames) throw new Error('Unexpected Batumi database response');

    // Fetching detailed points here validates the structural endpoint and keeps
    // it available for future geometry refinement. The coarse route geometry
    // from getDbData is already ordered and directly consumable by the app.
    if (!pointsResponse?.data) throw new Error('Unexpected Batumi points response');

    const datasets = {};
    for (const locale of LOCALES) datasets[locale] = buildLocaleDataset(db, locale);
    const polylines = buildPolylines(db);
    validate(datasets, polylines);

    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    const stagingDir = fs.mkdtempSync(path.join(OUTPUT_DIR, '.batumi-staging-'));
    const files = [];
    for (const locale of LOCALES) {
        for (const [kind, value] of Object.entries({
            stops: datasets[locale].stops,
            routes: datasets[locale].routes,
            routes_details: datasets[locale].details
        })) {
            const filename = `batumi_${kind}_${locale}.json`;
            fs.writeFileSync(path.join(stagingDir, filename), JSON.stringify(value));
            files.push(filename);
        }
    }
    fs.writeFileSync(path.join(stagingDir, 'batumi_schedules.json'), JSON.stringify(datasets.en.schedules));
    fs.writeFileSync(path.join(stagingDir, 'batumi_polylines.json'), JSON.stringify(polylines));
    files.push('batumi_schedules.json', 'batumi_polylines.json');

    for (const filename of files) JSON.parse(fs.readFileSync(path.join(stagingDir, filename), 'utf8'));
    for (const filename of files) fs.renameSync(path.join(stagingDir, filename), path.join(OUTPUT_DIR, filename));
    fs.rmdirSync(stagingDir);

    console.log(`[Batumi Prefetch] Published ${files.length} files: ${datasets.en.routes.length} routes, ${datasets.en.stops.length} stops`);
}

main().catch(error => {
    console.error(`[Batumi Prefetch] Failed: ${error.message}`);
    process.exitCode = 1;
});
