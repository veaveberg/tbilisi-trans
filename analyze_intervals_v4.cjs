
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
        if (parts.length > 1) idToNumber[parts[1]] = r.shortName;
    });

    // 2. Load and Group Schedules by Route Number
    const schedules = JSON.parse(fs.readFileSync(schedulesPath, 'utf8'));
    const routeNumberToTimes = {}; // Number -> Set of minutes

    Object.keys(schedules).forEach(key => {
        let routeNum = idToNumber[key];
        if (!routeNum) {
            for (const rId in idToNumber) {
                if (key.startsWith(rId)) {
                    routeNum = idToNumber[rId];
                    break;
                }
            }
        }
        if (!routeNum) return;

        const routeData = schedules[key];
        const schedule = routeData.find(s => s.fromDay === 'MONDAY') || routeData[0];
        if (!schedule || !schedule.stops || schedule.stops.length === 0) return;

        const firstStop = schedule.stops[0];
        if (!firstStop.arrivalTimes) return;

        if (!routeNumberToTimes[routeNum]) routeNumberToTimes[routeNum] = new Set();

        firstStop.arrivalTimes.split(',').forEach(tStr => {
            let [h, m] = tStr.split(':').map(Number);
            if (h < 4) h += 24;
            routeNumberToTimes[routeNum].add(h * 60 + m);
        });
    });

    // 3. Analyze each Route Number
    const routeNumbers = Object.keys(routeNumberToTimes).sort((a, b) => {
        // Sort numerically if possible
        const na = parseInt(a), nb = parseInt(b);
        if (!isNaN(na) && !isNaN(nb)) return na - nb;
        return a.localeCompare(b);
    });

    const routeCountLimit = 60;
    let count = 0;

    routeNumbers.forEach(num => {
        if (count >= routeCountLimit) return;
        count++;

        const times = Array.from(routeNumberToTimes[num]).sort((a, b) => a - b);
        if (times.length < 2) return;

        // Calculate median interval for gap detection
        const intervals = [];
        for (let i = 0; i < times.length - 1; i++) {
            intervals.push(times[i + 1] - times[i]);
        }
        const sortedIntervals = [...intervals].sort((a, b) => a - b);
        const medianInterval = sortedIntervals[Math.floor(sortedIntervals.length / 2)];

        const hourStats = new Array(30).fill(null).map(() => ({ sum: 0, count: 0, isGap: false }));

        const minTime = times[0];
        const maxTime = times[times.length - 1];
        const startHour = Math.floor(minTime / 60);
        const endHour = Math.floor(maxTime / 60);

        for (let i = 0; i < times.length - 1; i++) {
            const t1 = times[i];
            const t2 = times[i + 1];
            const interval = t2 - t1;

            // Gap Criteria: 
            // 1. More than 120 minutes AND more than 2x median
            // OR 2. More than 180 minutes regardless of median
            const isSignificantGap = (interval > 120 && interval > medianInterval * 2) || (interval > 180);

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
                // If it's the last hour and no departures start here, it might just be the end
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

        const segmentStrings = segments.map(seg => {
            let s = seg.start % 24, e = seg.end % 24;
            if (seg.type === 'gap') return `${s}–${e}: gap`;
            const avg = Math.round(seg.samples.reduce((a, b) => a + b, 0) / seg.samples.length);
            return `${s}–${e}: ${avg} min`;
        });

        console.log(`Route ${num}: ${segmentStrings.join(', ')}`);
    });

} catch (err) {
    console.error(err);
}
