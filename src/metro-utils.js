
import * as turf from '@turf/turf';

export const SEGMENT_LENGTH_M = 100;

// Helper to generate IDs
const generateIds = (lineNum, count) => Array.from({ length: count }, (_, i) => `metro_${lineNum}_${i + 1}`);

export const LINE_1_IDS = generateIds(1, 16);
export const LINE_2_IDS = generateIds(2, 7);

export function getStationId(stopId) {
    // Standardize ID: "1:metro_1_1" -> "metro_1_1" (if needed) or keep as is?
    // The segments file uses mixture. Let's just strip prefixes for lookup if needed.
    return stopId;
}

export function getSegmentForStop(stop, segments) {
    let segment = segments[stop.id];
    if (!segment) {
        // Try looking up without "1:" prefix
        const strippedId = stop.id.replace(/^1:/, '');
        segment = segments[strippedId];
    }

    // Default fallback
    if (!segment) {
        segment = {
            center: [parseFloat(stop.lon), parseFloat(stop.lat)],
            rotation: 0,
            handleL: 0.2,
            handleR: 0.2
        };
    }

    // Ensure numbers
    return {
        center: [parseFloat(segment.center[0]), parseFloat(segment.center[1])],
        rotation: parseFloat(segment.rotation),
        handleL: parseFloat(segment.handleL || 0.2),
        handleR: parseFloat(segment.handleR || 0.2)
    };
}

export function generateSegmentGeometry(segment) {
    const { center, rotation } = segment;
    const centerPt = turf.point(center);
    const halfLen = SEGMENT_LENGTH_M / 2 / 1000;

    const leftPt = turf.destination(centerPt, halfLen, rotation - 90);
    const rightPt = turf.destination(centerPt, halfLen, rotation + 90);

    return {
        leftPt: leftPt.geometry.coordinates,
        rightPt: rightPt.geometry.coordinates
    };
}

export function generateConnectionGeometry(segA, segB) {
    const halfLen = SEGMENT_LENGTH_M / 2 / 1000; // km

    // Segment A (Exit) - Uses Handle R
    const centA = turf.point(segA.center);
    const exitAngle = segA.rotation + 90;
    const startPt = turf.destination(centA, halfLen, exitAngle).geometry.coordinates;
    const handleLenA = segA.handleR;

    // Segment B (Entry) - Uses Handle L
    const centB = turf.point(segB.center);
    const entryAngle = segB.rotation - 90;
    const endPt = turf.destination(centB, halfLen, entryAngle).geometry.coordinates;
    const handleLenB = segB.handleL;

    // Control Points
    const cp1 = turf.destination(turf.point(startPt), handleLenA, exitAngle).geometry.coordinates;
    const cp2 = turf.destination(turf.point(endPt), handleLenB, entryAngle).geometry.coordinates;

    // Generate Cubic Bezier Points Manually
    const points = [];
    const steps = 30;

    for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const mt = 1 - t;
        const mt2 = mt * mt;
        const mt3 = mt2 * mt;
        const t2 = t * t;
        const t3 = t2 * t;

        const x = mt3 * startPt[0] + 3 * mt2 * t * cp1[0] + 3 * mt * t2 * cp2[0] + t3 * endPt[0];
        const y = mt3 * startPt[1] + 3 * mt2 * t * cp1[1] + 3 * mt * t2 * cp2[1] + t3 * endPt[1];

        points.push([x, y]);
    }

    return {
        type: 'LineString',
        coordinates: points
    };
}
