
const fs = require('fs');
const path = require('path');

const schedulesPath = path.join(process.cwd(), 'public/data/tbilisi_schedules.json');
const routesPath = path.join(process.cwd(), 'public/data/tbilisi_routes_en.json');

try {
    // 1. Load Route Metadata
    const routesData = JSON.parse(fs.readFileSync(routesPath, 'utf8'));
    const idToNumber = {};
    routesData.forEach(r => {
        // Map both raw ID "1:R123" and just "R123" to the number
        idToNumber[r.id] = r.shortName;
        // Also handle cases where ID might be prefixed differently in schedules
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

    // Helper: Minutes to formatted time
    function minToTime(m) {
        let h = Math.floor(m / 60);
        if (h >= 24) h -= 24;
        return h; // Return just the hour for compact display
    }

    let count = 0;
    for (const key of keys) {
        if (count >= MAX_ROUTES) break;

        // Try to find a route number for this schedule key
        // Keys usually look like "1:Metro_Metro_1_1_01" or "1:R216088_1_01"
        // We need to extract the base ID.
        // Heuristic: take distinct parts.
        let routeNum = null;

        // Exact match check
        if (idToNumber[key]) routeNum = idToNumber[key];

        // fuzzy match: check if key contains any known route ID
        if (!routeNum) {
            for (const rId in idToNumber) {
                // If keys are like "1:R216088_1_01", and ID is "1:R216088", we check startswith
                if (key.startsWith(rId)) {
                    routeNum = idToNumber[rId];
                    break;
                }
            }
        }

        if (!routeNum) continue;

        const routeData = schedules[key];
        if (!routeData || !Array.isArray(routeData) || routeData.length === 0) continue;

        // Prefer Monday, else first
        const schedule = routeData.find(s => s.fromDay === 'MONDAY') || routeData[0];
        if (!schedule.stops || schedule.stops.length === 0) continue;
        const firstStop = schedule.stops[0];
        if (!firstStop.arrivalTimes) continue;

        const times = firstStop.arrivalTimes.split(',').map(timeToMinutes).sort((a, b) => a - b);
        if (times.length < 5) continue; // Skip very sparse routes

        selectedRoutes.push({
            number: routeNum,
            originalId: key,
            times
        });
        count++;
    }

    // 3. Analyze Patterns
    selectedRoutes.forEach(route => {
        const hourlyStats = {}; // hour -> { sum: 0, count: 0 }

        for (let i = 0; i < route.times.length - 1; i++) {
            const t1 = route.times[i];
            const t2 = route.times[i + 1];
            const interval = t2 - t1;

            // Assign this interval to the hour of departure
            const hour = Math.floor(t1 / 60); // e.g. 6, 7, ... 25

            if (!hourlyStats[hour]) hourlyStats[hour] = { sum: 0, count: 0, intervals: [] };
            hourlyStats[hour].sum += interval;
            hourlyStats[hour].count++;
            hourlyStats[hour].intervals.push(interval);
        }

        // Fill gaps? No, just iterate defined hours.
        const hours = Object.keys(hourlyStats).map(Number).sort((a, b) => a - b);

        const segments = [];
        let currentSegment = null;

        for (const h of hours) {
            const data = hourlyStats[h];
            // Filter outlier intervals within the hour (simple median/filtering usually better, but average is ok for first pass)
            // Let's us median if possible? simpler: just average.
            const avg = Math.round(data.sum / data.count);

            if (!currentSegment) {
                currentSegment = { start: h, end: h + 1, avg: avg, samples: [avg] };
            } else {
                // Check if we should merge
                // Merge condition: New average is within X minutes or Y percent of the cumulative average
                const currentAvg = Math.round(currentSegment.samples.reduce((a, b) => a + b, 0) / currentSegment.samples.length);
                const diff = Math.abs(currentAvg - avg);

                // Allow merge if diff is small (< 3 mins) or relative diff is small (< 25%)
                const isSimilar = diff <= 3 || (diff / currentAvg) < 0.25;

                if (isSimilar) {
                    currentSegment.end = h + 1;
                    currentSegment.samples.push(avg);
                } else {
                    // Push and start new
                    // Recalculate weighted average for the finished segment? Simple avg of hours is fine for display
                    segments.push(currentSegment);
                    currentSegment = { start: h, end: h + 1, avg: avg, samples: [avg] };
                }
            }
        }
        if (currentSegment) segments.push(currentSegment);

        // Format Output
        const segmentStrings = segments.map(seg => {
            const finalAvg = Math.round(seg.samples.reduce((a, b) => a + b, 0) / seg.samples.length);

            // Format hours: 24 becomes 0, 25 becomes 1...
            let start = seg.start;
            let end = seg.end;
            if (start >= 24) start -= 24;
            if (end >= 24) end -= 24;

            return `${start}–${end}: ${finalAvg} min`;
        });

        console.log(`Route ${route.number}: ${segmentStrings.join(', ')}`);
    });

} catch (err) {
    console.error('Error:', err);
}
