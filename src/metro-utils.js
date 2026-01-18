
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

export function generateConnectionGeometry(segA, segB, midpoints = []) {
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

    // If we have midpoints, generate a multi-segment bezier through them
    if (midpoints && midpoints.length > 0) {
        return generateMultiSegmentBezier(startPt, endPt, midpoints, exitAngle, entryAngle, handleLenA, handleLenB);
    }

    // Control Points for simple cubic bezier
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

/**
 * Generate a smooth bezier curve through multiple midpoints
 * Each midpoint has: { position: [lng, lat], handleIn: length, handleOut: length, angle: bearing }
 */
function generateMultiSegmentBezier(startPt, endPt, midpoints, startAngle, endAngle, startHandleLen, endHandleLen) {
    const allPoints = [
        { pos: startPt, angle: startAngle, handleOut: startHandleLen },
        ...midpoints.map(mp => ({
            pos: mp.position,
            angle: mp.angle || 0,
            handleIn: mp.handleIn || 0.1,
            handleOut: mp.handleOut || 0.1
        })),
        { pos: endPt, angle: endAngle + 180, handleIn: endHandleLen } // Flip entry angle for inbound handle
    ];

    const coordinates = [];
    const stepsPerSegment = 20;

    for (let seg = 0; seg < allPoints.length - 1; seg++) {
        const ptA = allPoints[seg];
        const ptB = allPoints[seg + 1];

        // Start point of this segment
        const p0 = ptA.pos;
        // End point of this segment  
        const p3 = ptB.pos;

        // Control point 1: extend from p0 in the direction of ptA's outgoing angle
        const cp1 = ptA.handleOut
            ? turf.destination(turf.point(p0), ptA.handleOut, ptA.angle).geometry.coordinates
            : p0;

        // Control point 2: extend from p3 in the opposite direction of ptB's incoming angle
        const cp2 = ptB.handleIn
            ? turf.destination(turf.point(p3), ptB.handleIn, ptB.angle + 180).geometry.coordinates
            : p3;

        // Generate bezier points for this segment
        for (let i = 0; i <= stepsPerSegment; i++) {
            // Skip first point on subsequent segments to avoid duplicates
            if (seg > 0 && i === 0) continue;

            const t = i / stepsPerSegment;
            const mt = 1 - t;
            const mt2 = mt * mt;
            const mt3 = mt2 * mt;
            const t2 = t * t;
            const t3 = t2 * t;

            const x = mt3 * p0[0] + 3 * mt2 * t * cp1[0] + 3 * mt * t2 * cp2[0] + t3 * p3[0];
            const y = mt3 * p0[1] + 3 * mt2 * t * cp1[1] + 3 * mt * t2 * cp2[1] + t3 * p3[1];

            coordinates.push([x, y]);
        }
    }

    return {
        type: 'LineString',
        coordinates
    };
}

/**
 * Get the connection key for storing midpoints between two stations
 */
export function getConnectionKey(idA, idB) {
    // Ensure consistent ordering so A->B and B->A use same key
    const sorted = [idA, idB].sort();
    return `${sorted[0]}__${sorted[1]}`;
}
