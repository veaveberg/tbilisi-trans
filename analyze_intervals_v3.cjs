
const fs = require('fs');
const path = require('path');

const schedulesPath = path.join(process.cwd(), 'public/data/tbilisi_schedules.json');
const routesPath = path.join(process.cwd(), 'public/data/tbilisi_routes_en.json');

try {
    // 1. Load Route Metadata
    const routesData = JSON.parse(fs.readFileSync(routesPath, 'utf8'));
    const idToNumber = {};
    routesData.forEach(r => {
        idToNumber[r.id] = r.shortName;
        const parts = r.id.split(':');
        if (parts.length > 1) {
            idToNumber[parts[1]] = r.shortName;
        }
    });

    // 2. Load Schedules
    const schedules = JSON.parse(fs.readFileSync(schedulesPath, 'utf8'));
    const keys = Object.keys(schedules);

    const selectedRoutes = [];
    const MAX_ROUTES = 20;

    // Helper: Time string to minutes
    function timeToMinutes(timeStr) {
        let [h, m] = timeStr.split(':').map(Number);
        if (h < 4) h += 24; // Handle late night (00:00 - 03:00) as 24+
        return h * 60 + m;
    }

    let count = 0;
    for (const key of keys) {
        if (count >= MAX_ROUTES) break;

        let routeNum = null;
        if (idToNumber[key]) routeNum = idToNumber[key];
        if (!routeNum) {
            for (const rId in idToNumber) {
                if (key.startsWith(rId)) {
                    routeNum = idToNumber[rId];
                    break;
                }
            }
        }

        if (!routeNum) continue;

        const routeData = schedules[key];
        if (!routeData || !Array.isArray(routeData) || routeData.length === 0) continue;

        const schedule = routeData.find(s => s.fromDay === 'MONDAY') || routeData[0];
        if (!schedule.stops || schedule.stops.length === 0) continue;
        const firstStop = schedule.stops[0];
        if (!firstStop.arrivalTimes) continue;

        const times = firstStop.arrivalTimes.split(',').map(timeToMinutes).sort((a, b) => a - b);
        if (times.length < 5) continue;

        selectedRoutes.push({
            number: routeNum,
            originalId: key,
            times
        });
        count++;
    }

    // 3. Analyze Patterns
    selectedRoutes.forEach(route => {
        // Prepare hours 0..30 (covering late night)
        const hourStats = new Array(30).fill(null).map(() => ({
            sum: 0,
            count: 0,
            isGap: false
        }));

        // Determine range
        const minTime = route.times[0];
        const maxTime = route.times[route.times.length - 1];
        const startHour = Math.floor(minTime / 60);
        // We want to display until the route stops. 
        // If last bus is 23:50, we want to show stats for hour 23.
        // If last bus is 00:10 (24:10), we show hour 24.
        const endHour = Math.floor(maxTime / 60);

        for (let i = 0; i < route.times.length - 1; i++) {
            const t1 = route.times[i];
            const t2 = route.times[i + 1];
            const interval = t2 - t1;

            if (interval > 60) {
                // Detected a Gap
                // The gap spans from t1 to t2.
                // Mark full hours between them as gaps.
                // e.g. 6:55 to 23:00. Gap starts 7:00, ends 23:00.
                const gapStartHour = Math.ceil(t1 / 60); // 7
                const gapEndHour = Math.floor(t2 / 60); // 23

                // Mark intermediate hours as gap
                for (let h = gapStartHour; h < gapEndHour; h++) {
                    if (h < hourStats.length) hourStats[h].isGap = true;
                }
            } else {
                // Normal Interval
                const h = Math.floor(t1 / 60);
                if (h < hourStats.length) {
                    hourStats[h].sum += interval;
                    hourStats[h].count++;
                }
            }
        }

        const segments = [];
        let currentSegment = null;

        // Iterate from startHour to endHour inclusive
        // Note: endHour contains the last departures, so we include it if it has departures
        let loopEnd = endHour;

        // Safety clamp
        if (loopEnd >= 30) loopEnd = 29;

        for (let h = startHour; h <= loopEnd; h++) {
            const stat = hourStats[h];
            let type = 'value';
            let avg = 0;

            if (stat.isGap) {
                type = 'gap';
            } else if (stat.count > 0) {
                avg = Math.round(stat.sum / stat.count);
            } else {
                // No data for this hour, but supposedly within range.
                // It was likely swallowed by a gap logic or simply empty end of range.
                // If it wasn't explicitly marked gap by interval logic, checks if it's truly empty.
                // If empty and inside range, treat as gap (or continue previous if very end?)
                // Actually, if count is 0 and not marked gap, it means no departure happened in this hour
                // AND no interval crossed over it? 
                // Wait, if no departure happened, an interval MUST have crossed over it or stopped before it.
                // Since we iterate min to max, an interval must have connected previous to next.
                // So the GAP logic above should have caught it (interval > 60).
                // Exception: The very last hour might have one arrival at start and no "next".
                // But loop is timestamps.length - 1.
                // If stat.count is 0, it means no intervals started in this hour.
                // This usually happens at the very last hour if the last bus is the only event there?
                // e.g. last bus 23:05. Interval 22:50->23:05 attributed to 22.
                // Hour 23 has 0 count.
                // So usually we can stop listing if count is 0.
                if (h === endHour) continue; // Skip trailing empty hour
                type = 'gap'; // Otherwise assume gap
            }

            if (!currentSegment) {
                currentSegment = { start: h, end: h + 1, type, avg, samples: [avg] };
            } else {
                // Merge Logic
                let shouldMerge = false;
                if (type === 'gap' && currentSegment.type === 'gap') {
                    shouldMerge = true;
                } else if (type === 'value' && currentSegment.type === 'value') {
                    const currentAvg = Math.round(currentSegment.samples.reduce((a, b) => a + b, 0) / currentSegment.samples.length);
                    // Merge if similar
                    const diff = Math.abs(currentAvg - avg);
                    // Threshold: 3 mins or 25%
                    if (diff <= 3 || (diff / currentAvg) < 0.25) {
                        shouldMerge = true;
                    }
                }

                if (shouldMerge) {
                    currentSegment.end = h + 1;
                    if (type === 'value') currentSegment.samples.push(avg);
                } else {
                    segments.push(currentSegment);
                    currentSegment = { start: h, end: h + 1, type, avg, samples: [avg] };
                }
            }
        }
        if (currentSegment) segments.push(currentSegment);

        // Format
        const segmentStrings = segments.map(seg => {
            let start = seg.start;
            let end = seg.end;
            if (start >= 24) start -= 24;
            if (end >= 24) end -= 24;

            if (seg.type === 'gap') {
                return `${start}–${end}: gap`;
            } else {
                const finalAvg = Math.round(seg.samples.reduce((a, b) => a + b, 0) / seg.samples.length);
                return `${start}–${end}: ${finalAvg} min`;
            }
        });

        console.log(`Route ${route.number}: ${segmentStrings.join(', ')}`);
    });

} catch (err) {
    console.error('Error:', err);
}
