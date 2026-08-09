// Route interval pattern descriptions
import { t } from './i18n.ts';
import { getOtaDataFileJson } from './ota-data.js';

let intervalData = null;

export async function loadIntervalData() {
    if (intervalData) return intervalData;
    try {
        const otaData = await getOtaDataFileJson('route_intervals.json');
        if (otaData) {
            intervalData = otaData;
            console.log(`[Intervals] Loaded OTA data for ${Object.keys(intervalData).length} routes`);
            return intervalData;
        }

        const basePath = (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.BASE_URL)
            ? (import.meta.env.BASE_URL.endsWith('/') ? import.meta.env.BASE_URL : `${import.meta.env.BASE_URL}/`)
            : './';
        const response = await fetch(`${basePath}data/route_intervals.json`);
        intervalData = await response.json();
        console.log(`[Intervals] Loaded data for ${Object.keys(intervalData).length} routes`);
        return intervalData;
    } catch (e) {
        console.warn('Could not load interval data:', e);
        return null;
    }
}

export function invalidateIntervalDataCache() {
    intervalData = null;
}

export function getIntervalData(routeId) {
    if (!intervalData) return null;

    // Normalize ID - same logic as other functions
    let data = intervalData[routeId];
    if (!data && !routeId.includes(':')) {
        data = intervalData[`1:${routeId}`] || intervalData[`2:${routeId}`];
    }
    if (!data && routeId.includes(':')) {
        data = intervalData[routeId.split(':')[1]];
    }
    // Handle Rustavi route IDs with 'r' prefix (e.g., rR826 -> 1:R826)
    if (!data && routeId.startsWith('r') && !routeId.includes(':')) {
        const stripped = routeId.slice(1);
        data = intervalData[`1:${stripped}`] || intervalData[stripped];
    }

    return data || null;
}

/**
 * Returns the service state for the current interval window instead of
 * estimating a vehicle arrival from a timetable.
 */
export function getCurrentIntervalState(routeId, now = new Date()) {
    const data = getIntervalData(routeId);
    const pattern = data?.pattern;
    if (!Array.isArray(pattern) || pattern.length === 0) return null;

    const currentHour = now.getHours() + (now.getMinutes() / 60);
    const activeSegment = pattern.find((segment) => {
        const start = Number(segment.start);
        const end = Number(segment.end);
        if (!Number.isFinite(start) || !Number.isFinite(end)) return false;

        // A segment whose end precedes its start runs through midnight.
        return end <= start
            ? currentHour >= start || currentHour < end
            : currentHour >= start && currentHour < end;
    });

    if (!activeSegment || activeSegment.gap || !activeSegment.interval) {
        return { operating: false, interval: null };
    }

    return { operating: true, interval: activeSegment.interval };
}

/**
 * Generate a human-readable interval description string
 * @param {string} routeId - The route ID (e.g., "1:R216088")
 * @returns {string|null} - Description like "Every 8', 15' after 22:00"
 */
export function getIntervalDescription(routeId) {
    if (!routeId || !intervalData) return null;

    // Normalize ID - try exact, then with prefix, then without prefix
    let data = intervalData[routeId];
    if (!data && !routeId.includes(':')) {
        data = intervalData[`1:${routeId}`] || intervalData[`2:${routeId}`];
    }
    if (!data && routeId.includes(':')) {
        data = intervalData[routeId.split(':')[1]];
    }
    // Handle Rustavi route IDs with 'r' prefix (e.g., rR826 -> 1:R826)
    if (!data && routeId.startsWith('r') && !routeId.includes(':')) {
        const stripped = routeId.slice(1); // Remove 'r' prefix
        data = intervalData[`1:${stripped}`] || intervalData[stripped];
    }

    if (!data || !data.pattern || data.pattern.length === 0) return null;

    // Special case for route 174 (Varketili shuttle) - just return interval
    // The service windows come from parseSchedule's serviceWindows field
    if (data.shortName === '174') {
        return t('everyMinutes', 6);
    }

    const pattern = data.pattern;

    // Calculate total hours of service vs gaps
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

    // If no service segments, return null
    if (serviceSegments.length === 0) return null;

    // Check if gap is overwhelming (>50% of operating window)
    const totalHours = serviceHours + gapHours;
    const gapIsOverwhelming = gapHours > totalHours * 0.5;

    // Get dominant interval (most common or longest-duration interval)
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

    // Find segments that differ from dominant
    const differentSegments = serviceSegments.filter(s =>
        Math.abs(s.interval - dominantInterval) > 3 &&
        (Math.abs(s.interval - dominantInterval) / dominantInterval) > 0.25
    );

    // Build description
    let description = t('everyMinutes', dominantInterval);

    // Case 1: Overwhelming gap - describe when service runs
    if (gapIsOverwhelming && gapSegments.length > 0) {
        // Merge adjacent service segments for cleaner output
        const mergedRanges = mergeServiceRanges(serviceSegments);
        description += `, ${t('onlyServiceRanges', mergedRanges.join(' & '))}`;
        return description;
    }

    // Case 2: Has gaps but not overwhelming - mention the gap
    if (gapSegments.length > 0) {
        const gapRanges = gapSegments.map(s => `${formatHour(s.start)} – ${formatHour(s.end)}`);
        if (gapRanges.length === 1) {
            description += `, ${t('noServiceRanges', gapRanges[0])}`;
        } else {
            description += `, ${t('noServiceRanges', gapRanges.join(' & '))}`;
        }
        return description;
    }

    // Case 3: No gaps, check for evening/late changes
    if (differentSegments.length > 0) {
        // Find the latest segment that's different (usually evening slowdown)
        const sortedDiff = differentSegments.sort((a, b) => b.start - a.start);
        const eveningChange = sortedDiff[0];

        // Check if it's at end of day (after 20:00)
        if (eveningChange.start >= 20 || (eveningChange.start < 4)) {
            description += `, ${t('afterTimeEveryMinutes', formatHour(eveningChange.start), eveningChange.interval)}`;
        } else if (differentSegments.length <= 2) {
            // Midday variation
            const midday = differentSegments.find(s => s.start >= 12 && s.start < 16);
            if (midday) {
                description += `, ${t('lessFrequentBetween', formatHour(midday.start), formatHour(midday.end))}`;
                // Also check for evening
                const evening = differentSegments.find(s => s.start >= 20);
                if (evening) {
                    description += ` ${t('andAfterTime', formatHour(evening.start))}`;
                }
            } else {
                // Just mention "less frequent" for complex patterns
                description += `, ${t('variesDuringDay')}`;
            }
        } else {
            // Too many variations - simplified message
            description += `, ${t('variesDuringDay')}`;
        }
    }

    return description;
}

function segmentDuration(seg) {
    let end = seg.end;
    let start = seg.start;
    if (end <= start) end += 24; // Handle wrap-around
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

    // Sort by start time, treating late night (0-4) as after midnight
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
        // Check if this segment is adjacent (end matches start, or wraps at midnight)
        if (seg.start === currentEnd || (currentEnd === 0 && seg.start === 0) || (currentEnd === 24 && seg.start === 0)) {
            // Extend the range
            currentEnd = seg.end;
        } else {
            // Push current range and start new one
            ranges.push(`${formatHour(currentStart)} – ${formatHour(currentEnd)}`);
            currentStart = seg.start;
            currentEnd = seg.end;
        }
    }
    // Push final range
    ranges.push(`${formatHour(currentStart)}–${formatHour(currentEnd)}`);

    return ranges;
}

/**
 * Get a compact interval string (just the number, for tight spaces)
 * @param {string} routeId 
 * @returns {string|null} - e.g., "~8'" or "3–9'"
 */
export function getCompactInterval(routeId) {
    if (!intervalData) return null;

    // Normalize ID - same logic as getIntervalDescription
    let data = intervalData[routeId];
    if (!data && !routeId.includes(':')) {
        data = intervalData[`1:${routeId}`] || intervalData[`2:${routeId}`];
    }
    if (!data && routeId.includes(':')) {
        data = intervalData[routeId.split(':')[1]];
    }
    // Handle Rustavi route IDs with 'r' prefix (e.g., rR826 -> 1:R826)
    if (!data && routeId.startsWith('r') && !routeId.includes(':')) {
        const stripped = routeId.slice(1);
        data = intervalData[`1:${stripped}`] || intervalData[stripped];
    }

    if (!data || !data.pattern || data.pattern.length === 0) return null;

    const intervals = data.pattern
        .filter(s => !s.gap && s.interval)
        .map(s => s.interval);

    if (intervals.length === 0) return null;

    const minFreq = Math.min(...intervals);
    const maxFreq = Math.max(...intervals);

    if (maxFreq - minFreq <= 3) {
        return `~${minFreq}'`;
    } else {
        return `${minFreq}–${maxFreq}'`;
    }
}
