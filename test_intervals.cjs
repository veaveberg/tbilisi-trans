
const fs = require('fs');

const intervalData = JSON.parse(fs.readFileSync('public/data/route_intervals.json', 'utf8'));

function segmentDuration(seg) {
    let end = seg.end;
    let start = seg.start;
    if (end <= start) end += 24;
    return end - start;
}

function formatHour(h) {
    if (h === 0 || h === 24) return '0:00';
    if (h < 0) h += 24;
    if (h >= 24) h -= 24;
    return `${h}:00`;
}

function mergeServiceRanges(segments) {
    if (segments.length === 0) return [];
    const sorted = [...segments].sort((a, b) => {
        const aStart = a.start < 5 ? a.start + 24 : a.start;
        const bStart = b.start < 5 ? b.start + 24 : b.start;
        return aStart - bStart;
    });
    const ranges = [];
    let currentStart = sorted[0].start;
    let currentEnd = sorted[0].end;
    for (let i = 1; i < sorted.length; i++) {
        const seg = sorted[i];
        if (seg.start === currentEnd || (currentEnd === 0 && seg.start === 0) || (currentEnd === 24 && seg.start === 0)) {
            currentEnd = seg.end;
        } else {
            ranges.push(`${formatHour(currentStart)} – ${formatHour(currentEnd)}`);
            currentStart = seg.start;
            currentEnd = seg.end;
        }
    }
    ranges.push(`${formatHour(currentStart)} – ${formatHour(currentEnd)}`);
    return ranges;
}

function getIntervalDescription(routeId) {
    const data = intervalData[routeId];
    if (!data || !data.pattern || data.pattern.length === 0) return null;

    const pattern = data.pattern;

    let serviceHours = 0;
    let gapHours = 0;
    const serviceSegments = [];
    const gapSegments = [];

    for (const seg of pattern) {
        const duration = segmentDuration(seg);
        if (seg.gap) {
            gapHours += duration;
            gapSegments.push(seg);
        } else {
            serviceHours += duration;
            serviceSegments.push(seg);
        }
    }

    if (serviceSegments.length === 0) return null;

    const totalHours = serviceHours + gapHours;
    const gapIsOverwhelming = gapHours > totalHours * 0.5;

    const intervalCounts = {};
    let maxDuration = 0;
    let dominantInterval = serviceSegments[0].interval;

    for (const seg of serviceSegments) {
        const duration = segmentDuration(seg);
        if (!intervalCounts[seg.interval]) intervalCounts[seg.interval] = 0;
        intervalCounts[seg.interval] += duration;
        if (intervalCounts[seg.interval] > maxDuration) {
            maxDuration = intervalCounts[seg.interval];
            dominantInterval = seg.interval;
        }
    }

    const differentSegments = serviceSegments.filter(s =>
        Math.abs(s.interval - dominantInterval) > 3 &&
        (Math.abs(s.interval - dominantInterval) / dominantInterval) > 0.25
    );

    let description = `every ${dominantInterval}'`;

    if (gapIsOverwhelming && gapSegments.length > 0) {
        const mergedRanges = mergeServiceRanges(serviceSegments);
        description += `, only ${mergedRanges.join(' & ')}`;
        return description;
    }

    if (gapSegments.length > 0) {
        const gapRanges = gapSegments.map(s => `${formatHour(s.start)} – ${formatHour(s.end)}`);
        if (gapRanges.length === 1) {
            description += `, no service ${gapRanges[0]}`;
        } else {
            description += `, no service ${gapRanges.join(' & ')}`;
        }
        return description;
    }

    if (differentSegments.length > 0) {
        const sortedDiff = differentSegments.sort((a, b) => b.start - a.start);
        const eveningChange = sortedDiff[0];

        if (eveningChange.start >= 20 || (eveningChange.start < 4)) {
            description += `, after ${formatHour(eveningChange.start)} — every ${eveningChange.interval}'`;
        } else if (differentSegments.length <= 2) {
            const midday = differentSegments.find(s => s.start >= 12 && s.start < 16);
            if (midday) {
                description += `, less frequent ${formatHour(midday.start)} – ${formatHour(midday.end)}`;
                const evening = differentSegments.find(s => s.start >= 20);
                if (evening) {
                    description += ` & after ${formatHour(evening.start)}`;
                }
            } else {
                description += `, varies during day`;
            }
        } else {
            description += `, varies during day`;
        }
    }

    return description;
}

// Test with sample routes
const testRoutes = [
    '1:Metro_Metro_1',  // Metro Line 1
    '1:R239274',        // Route 174 (gap route)
    '1:R101490',        // Route 293
    '1:R99201',         // Route 298
    '1:R216088',        // Route 101
    '1:R101498',        // Route 294
    '1:R97714',         // Route 309
    '1:R98445',         // Route 316
    '1:R97618',         // Route 322
    '1:R101831',        // Route 297
];

console.log('Testing interval descriptions:\n');

for (const id of testRoutes) {
    const data = intervalData[id];
    if (data) {
        const desc = getIntervalDescription(id);
        console.log(`Route ${data.shortName}: ${desc}`);
        console.log(`  Pattern: ${JSON.stringify(data.pattern)}`);
        console.log('');
    }
}
