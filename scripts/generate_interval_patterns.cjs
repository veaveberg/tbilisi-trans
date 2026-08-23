'use strict';

const fs = require('fs');
const path = require('path');

const dataDir = path.join(process.cwd(), 'public/data');

const sources = [
    {
        name: 'tbilisi',
        schedules: 'tbilisi_schedules.json',
        routes: 'tbilisi_routes_en.json'
    },
    {
        name: 'rustavi',
        schedules: 'rustavi_schedules.json',
        routes: 'rustavi_routes_en.json'
    },
    {
        name: 'kutaisi',
        appPrefix: 'k',
        schedules: 'kutaisi_schedules.json',
        routes: 'kutaisi_routes_en.json'
    },
    {
        name: 'batumi',
        appPrefix: 'b',
        schedules: 'batumi_schedules.json',
        routes: 'batumi_routes_en.json'
    }
];

function timeToMinutes(timeStr) {
    let [h, m] = String(timeStr).trim().split(':').map(Number);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
    if (h < 4) h += 24; // Late night hours
    return h * 60 + m;
}

function resolveRouteForScheduleKey(key, routeIds, idToRoute) {
    const directMatch = idToRoute[key];
    if (directMatch) return directMatch;

    const matchedId = routeIds.find(routeId => key === routeId || key.startsWith(`${routeId}_`));
    return matchedId ? idToRoute[matchedId] : null;
}

function analyzeRoute(times) {
    if (times.length < 2) return null;

    // Calculate intervals
    const intervals = [];
    for (let i = 0; i < times.length - 1; i++) {
        intervals.push(times[i + 1] - times[i]);
    }
    const sortedIntervals = [...intervals].sort((a, b) => a - b);
    const medianInterval = sortedIntervals[Math.floor(sortedIntervals.length / 2)];

    const hourStats = new Array(30).fill(null).map(() => ({ sum: 0, count: 0, isGap: false }));

    const startHour = Math.floor(times[0] / 60);
    const endHour = Math.floor(times[times.length - 1] / 60);

    for (let i = 0; i < times.length - 1; i++) {
        const t1 = times[i];
        const t2 = times[i + 1];
        const interval = t2 - t1;

        // Gap: >100min AND >2.5x median, OR >240min
        const isSignificantGap = (interval > 100 && interval > medianInterval * 2.5) || (interval > 240);

        if (isSignificantGap) {
            const h1 = Math.ceil(t1 / 60);
            const h2 = Math.floor(t2 / 60);
            for (let h = h1; h < h2; h++) {
                if (h < hourStats.length) hourStats[h].isGap = true;
            }
        } else {
            const h = Math.floor(t1 / 60);
            if (h < hourStats.length) {
                hourStats[h].sum += interval;
                hourStats[h].count++;
            }
        }
    }

    // Build segments
    const segments = [];
    let cur = null;

    for (let h = startHour; h <= endHour; h++) {
        const s = hourStats[h];
        let type = 'value', val = 0;

        if (s.isGap) {
            type = 'gap';
        } else if (s.count > 0) {
            val = Math.round(s.sum / s.count);
        } else {
            if (h === endHour) continue;
            type = 'gap';
        }

        if (!cur) {
            cur = { start: h, end: h + 1, type, samples: [val] };
        } else {
            let merge = false;
            if (type === cur.type) {
                if (type === 'gap') merge = true;
                else {
                    const curAvg = cur.samples.reduce((a, b) => a + b, 0) / cur.samples.length;
                    const diff = Math.abs(curAvg - val);
                    if (diff <= 3 || diff / curAvg < 0.25) merge = true;
                }
            }
            if (merge) {
                cur.end = h + 1;
                if (type === 'value') cur.samples.push(val);
            } else {
                segments.push(cur);
                cur = { start: h, end: h + 1, type, samples: [val] };
            }
        }
    }
    if (cur) segments.push(cur);

    // Convert to output format
    const pattern = segments.map(seg => {
        let s = seg.start % 24, e = seg.end % 24;
        if (seg.type === 'gap') {
            return { start: s, end: e, gap: true };
        } else {
            const avg = Math.round(seg.samples.reduce((a, b) => a + b, 0) / seg.samples.length);
            return { start: s, end: e, interval: avg };
        }
    });

    return {
        firstDeparture: times[0] % (24 * 60),
        lastDeparture: times[times.length - 1] % (24 * 60),
        pattern
    };
}

try {
    const allPatterns = {};

    for (const source of sources) {
        console.log(`Processing ${source.name}...`);

        const routesPath = path.join(dataDir, source.routes);
        const schedulesPath = path.join(dataDir, source.schedules);

        if (!fs.existsSync(routesPath) || !fs.existsSync(schedulesPath)) {
            console.log(`  Skipping ${source.name}: files not found`);
            continue;
        }

        const routesData = JSON.parse(fs.readFileSync(routesPath, 'utf8'));
        const schedules = JSON.parse(fs.readFileSync(schedulesPath, 'utf8'));

        // Build ID mappings
        const idToRoute = {};
        routesData.forEach(r => {
            idToRoute[r.id] = r;
            const parts = r.id.split(':');
            if (parts.length > 1) idToRoute[parts[1]] = r;
        });
        const routeIdsByLength = routesData
            .map(r => r.id)
            .filter(Boolean)
            .sort((a, b) => b.length - a.length);

        // Find best schedule key per route ID. Match against real route IDs because
        // route IDs can contain underscores (e.g. 1:Metro_Metro_1).
        const routeIdToBestKey = {};
        Object.keys(schedules).forEach(key => {
            const route = resolveRouteForScheduleKey(key, routeIdsByLength, idToRoute);
            if (!route) return;

            const data = schedules[key];
            if (!data || !Array.isArray(data)) return;
            const monday = data.find(s => s.fromDay === 'MONDAY') || data[0];
            if (!monday || !monday.stops || !monday.stops[0] || !monday.stops[0].arrivalTimes) return;

            const count = monday.stops[0].arrivalTimes.split(',').length;
            if (!routeIdToBestKey[route.id] || count > routeIdToBestKey[route.id].count) {
                routeIdToBestKey[route.id] = { key, count };
            }
        });

        // Process each route
        Object.entries(routeIdToBestKey).forEach(([routeId, { key }]) => {
            const route = idToRoute[routeId];
            if (!route) return;
            const routeData = schedules[key];
            if (!routeData || !Array.isArray(routeData)) return;
            const schedule = routeData.find(s => s.fromDay === 'MONDAY') || routeData[0];
            const firstStop = schedule.stops[0];

            const times = firstStop.arrivalTimes.split(',')
                .map(timeToMinutes)
                .filter(Number.isFinite)
                .sort((a, b) => a - b);

            const analysis = analyzeRoute(times);
            if (!analysis) return;

            // Use full route ID as key
            const outputRouteId = source.appPrefix
                ? `${source.appPrefix}${String(route.id).replace(/^\d+:/, '')}`
                : route.id;
            allPatterns[outputRouteId] = {
                shortName: route.shortName,
                longName: route.longName,
                mode: route.mode,
                source: source.name,
                ...analysis
            };
        });

        console.log(`  Processed ${Object.keys(routeIdToBestKey).length} routes from ${source.name}`);
    }

    // Write output
    const outputPath = path.join(dataDir, 'route_intervals.json');
    fs.writeFileSync(outputPath, JSON.stringify(allPatterns, null, 2));
    console.log(`\nWrote ${Object.keys(allPatterns).length} route patterns to ${outputPath}`);

} catch (err) {
    console.error('Error:', err);
}
