
const fs = require('fs');
const path = require('path');

const filePath = path.join(process.cwd(), 'public/data/tbilisi_schedules.json');

try {
    const rawData = fs.readFileSync(filePath, 'utf8');
    const schedules = JSON.parse(rawData);

    const keys = Object.keys(schedules);
    const selectedRoutes = [];
    const MAX_ROUTES = 20;

    // Helper to parse "HH:MM" to minutes
    function timeToMinutes(timeStr) {
        const [h, m] = timeStr.split(':').map(Number);
        return h * 60 + m;
    }

    // Helper to format minutes to "HH:MM"
    function minutesToTime(mins) {
        const h = Math.floor(mins / 60);
        const m = Math.round(mins % 60);
        return `${h}:${m.toString().padStart(2, '0')}`;
    }

    let count = 0;
    for (const key of keys) {
        if (count >= MAX_ROUTES) break;

        const routeData = schedules[key];
        if (!routeData || !Array.isArray(routeData) || routeData.length === 0) continue;

        // Try to find a schedule for "MONDAY" or generic
        const schedule = routeData.find(s => s.fromDay === 'MONDAY') || routeData[0];

        if (!schedule.stops || schedule.stops.length === 0) continue;

        // Use the first stop's times to calculate headway
        const firstStop = schedule.stops[0];
        if (!firstStop.arrivalTimes) continue;

        const timesStr = firstStop.arrivalTimes.split(',');
        const times = timesStr.map(timeToMinutes).sort((a, b) => a - b);

        if (times.length < 2) continue;

        selectedRoutes.push({
            id: key,
            times
        });
        count++;
    }

    console.log(`Analyzing ${selectedRoutes.length} route schedules...\n`);

    const buckets = [
        { label: '06:00 - 09:00', start: 6 * 60, end: 9 * 60 },
        { label: '09:00 - 13:00', start: 9 * 60, end: 13 * 60 },
        { label: '13:00 - 17:00', start: 13 * 60, end: 17 * 60 },
        { label: '17:00 - 20:00', start: 17 * 60, end: 20 * 60 },
        { label: '20:00 - 23:00', start: 20 * 60, end: 23 * 60 },
    ];

    selectedRoutes.forEach(route => {
        console.log(`Route: ${route.id}`);
        const intervalsByBucket = buckets.map(() => []);

        for (let i = 0; i < route.times.length - 1; i++) {
            const current = route.times[i];
            const next = route.times[i + 1];
            const interval = next - current;

            // Find bucket
            for (let b = 0; b < buckets.length; b++) {
                if (current >= buckets[b].start && current < buckets[b].end) {
                    intervalsByBucket[b].push(interval);
                    break;
                }
            }
        }

        buckets.forEach((bucket, index) => {
            const intervals = intervalsByBucket[index];
            let summary = 'No service';
            if (intervals.length > 0) {
                const avg = intervals.reduce((a, b) => a + b, 0) / intervals.length;
                const min = Math.min(...intervals);
                const max = Math.max(...intervals);
                summary = `~${Math.round(avg)} min (${min}-${max})`;
            }
            console.log(`  ${bucket.label}: ${summary}`);
        });
        console.log('');
    });

} catch (err) {
    console.error('Error:', err);
}
