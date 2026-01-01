
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, '../public/data');
const OUTPUT_FILE = path.join(__dirname, '../src/data/stop_bearings.json');

// Helper: Calculate Bearings
function toRad(deg) { return deg * Math.PI / 180; }
function toDeg(rad) { return rad * 180 / Math.PI; }

function getBearing(startLat, startLon, destLat, destLon) {
    const startLatRad = toRad(startLat);
    const startLonRad = toRad(startLon);
    const destLatRad = toRad(destLat);
    const destLonRad = toRad(destLon);

    const y = Math.sin(destLonRad - startLonRad) * Math.cos(destLatRad);
    const x = Math.cos(startLatRad) * Math.sin(destLatRad) -
        Math.sin(startLatRad) * Math.cos(destLatRad) * Math.cos(destLonRad - startLonRad);
    const brng = toDeg(Math.atan2(y, x));
    return (brng + 360) % 360;
}

// Distance from point to line segment (for finding closest point on polyline)
function distanceToSegment(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lenSq = dx * dx + dy * dy;

    let t = 0;
    if (lenSq > 0) {
        t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq));
    }

    const closestX = x1 + t * dx;
    const closestY = y1 + t * dy;

    const distX = px - closestX;
    const distY = py - closestY;

    return {
        distance: Math.sqrt(distX * distX + distY * distY),
        t: t,
        closestX,
        closestY
    };
}

// Haversine distance in meters between two points
function haversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371000; // Earth radius in meters
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

// Calculate cumulative distances along polyline
function getCumulativeDistances(polylinePoints) {
    const distances = [0];
    for (let i = 1; i < polylinePoints.length; i++) {
        const [lng1, lat1] = polylinePoints[i - 1];
        const [lng2, lat2] = polylinePoints[i];
        const d = haversineDistance(lat1, lng1, lat2, lng2);
        distances.push(distances[i - 1] + d);
    }
    return distances;
}

// Find point at a specific distance along the polyline
function getPointAtDistance(polylinePoints, cumDistances, targetDist) {
    if (targetDist <= 0) return polylinePoints[0];
    if (targetDist >= cumDistances[cumDistances.length - 1]) {
        return polylinePoints[polylinePoints.length - 1];
    }

    // Binary search to find segment
    let lo = 0, hi = cumDistances.length - 1;
    while (lo < hi - 1) {
        const mid = Math.floor((lo + hi) / 2);
        if (cumDistances[mid] <= targetDist) lo = mid;
        else hi = mid;
    }

    // Interpolate on segment [lo, lo+1]
    const segmentDist = cumDistances[lo + 1] - cumDistances[lo];
    const t = segmentDist > 0 ? (targetDist - cumDistances[lo]) / segmentDist : 0;

    const [lng1, lat1] = polylinePoints[lo];
    const [lng2, lat2] = polylinePoints[lo + 1];

    return [
        lng1 + t * (lng2 - lng1),
        lat1 + t * (lat2 - lat1)
    ];
}

// Find the bearing of the polyline at the point closest to a stop
// Uses a ~30m segment average to smooth out stop "bumps" in the polyline
function getBearingFromPolyline(stopLat, stopLon, polylinePoints) {
    if (!polylinePoints || polylinePoints.length < 2) return null;

    let bestDist = Infinity;
    let bestSegmentIndex = -1;
    let bestT = 0;

    // Find the closest segment to the stop
    for (let i = 0; i < polylinePoints.length - 1; i++) {
        const [lng1, lat1] = polylinePoints[i];
        const [lng2, lat2] = polylinePoints[i + 1];

        const result = distanceToSegment(stopLon, stopLat, lng1, lat1, lng2, lat2);

        if (result.distance < bestDist) {
            bestDist = result.distance;
            bestSegmentIndex = i;
            bestT = result.t;
        }
    }

    if (bestSegmentIndex === -1) return null;

    // Calculate cumulative distances
    const cumDistances = getCumulativeDistances(polylinePoints);

    // Find the distance along the polyline to the closest point
    const [lng1, lat1] = polylinePoints[bestSegmentIndex];
    const [lng2, lat2] = polylinePoints[bestSegmentIndex + 1];
    const segmentLength = haversineDistance(lat1, lng1, lat2, lng2);
    const closestDist = cumDistances[bestSegmentIndex] + bestT * segmentLength;

    // Sample points 15m before and 15m after (total ~30m segment)
    const SAMPLE_OFFSET = 15; // meters

    const startDist = Math.max(0, closestDist - SAMPLE_OFFSET);
    const endDist = Math.min(cumDistances[cumDistances.length - 1], closestDist + SAMPLE_OFFSET);

    const startPoint = getPointAtDistance(polylinePoints, cumDistances, startDist);
    const endPoint = getPointAtDistance(polylinePoints, cumDistances, endDist);

    // Calculate bearing from start to end of the sampled segment
    return getBearing(startPoint[1], startPoint[0], endPoint[1], endPoint[0]);
}

// Decode Google Polyline Algorithm
function decodePolyline(encoded) {
    if (Array.isArray(encoded)) return encoded;
    if (!encoded) return [];

    let points = [];
    let index = 0, len = encoded.length;
    let lat = 0, lng = 0;

    while (index < len) {
        let b, shift = 0, result = 0;
        do {
            b = encoded.charCodeAt(index++) - 63;
            result |= (b & 0x1f) << shift;
            shift += 5;
        } while (b >= 0x20);
        let dlat = ((result & 1) ? ~(result >> 1) : (result >> 1));
        lat += dlat;

        shift = 0;
        result = 0;
        do {
            b = encoded.charCodeAt(index++) - 63;
            result |= (b & 0x1f) << shift;
            shift += 5;
        } while (b >= 0x20);
        let dlng = ((result & 1) ? ~(result >> 1) : (result >> 1));
        lng += dlng;

        points.push([lng * 1e-5, lat * 1e-5]);
    }
    return points;
}

// Load polylines - returns Map of "routeId:suffix" -> decoded polyline points
function loadPolylines() {
    const polylines = new Map();

    const files = ['tbilisi_polylines.json', 'rustavi_polylines.json'];

    for (const file of files) {
        const filePath = path.join(DATA_DIR, file);
        if (!fs.existsSync(filePath)) continue;

        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

        // Structure: { "routeId_patternSuffix_key": { "suffix": { encodedValue: "..." } } }
        for (const [outerKey, suffixData] of Object.entries(data)) {
            if (typeof suffixData === 'object') {
                for (const [suffix, polylineInfo] of Object.entries(suffixData)) {
                    if (polylineInfo && polylineInfo.encodedValue) {
                        // Parse route ID from outer key
                        // Example: "1:R216088_1_01" -> routeId = "1:R216088"
                        const parts = outerKey.split('_');
                        const routeId = parts[0];
                        const key = `${routeId}:${suffix}`;
                        polylines.set(key, decodePolyline(polylineInfo.encodedValue));
                    }
                }
            }
        }
    }

    console.log(`Loaded and decoded ${polylines.size} polylines.`);
    return polylines;
}

// Load route details - returns Map of routeId -> { patterns, _stopsOfPatterns, isRustavi }
function loadRouteDetails() {
    const routeDetails = new Map();

    const files = [
        { file: 'tbilisi_routes_details_en.json', isRustavi: false },
        { file: 'rustavi_routes_details_en.json', isRustavi: true }
    ];

    for (const { file, isRustavi } of files) {
        const filePath = path.join(DATA_DIR, file);
        if (!fs.existsSync(filePath)) continue;

        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

        for (const [routeId, details] of Object.entries(data)) {
            if (details) {
                details._isRustavi = isRustavi;
                routeDetails.set(routeId, details);
            }
        }
    }

    console.log(`Loaded details for ${routeDetails.size} routes.`);
    return routeDetails;
}

// Normalize stop ID for app format
// Rustavi: 1:145 -> r145, Tbilisi: 1:799 -> 1:799
function normalizeStopId(rawId, isRustavi) {
    if (!isRustavi) return rawId;

    // Convert 1:xxx to rxxx
    if (rawId.startsWith('1:')) {
        return 'r' + rawId.substring(2);
    }
    return rawId;
}

async function main() {
    try {
        console.log('Loading local data files...\n');

        const polylines = loadPolylines();
        const routeDetails = loadRouteDetails();

        const stopBearings = {}; // stopId -> [bearings]
        let processedPatterns = 0;
        let bearingsAdded = 0;

        console.log('\nProcessing routes...');

        for (const [routeId, details] of routeDetails) {
            if (!details.patterns || !details._stopsOfPatterns) continue;

            const isRustavi = details._isRustavi || false;

            // Build a map of stop -> patternSuffixes from _stopsOfPatterns
            const stopToPatterns = new Map();
            for (const entry of details._stopsOfPatterns) {
                if (entry.stop && entry.patternSuffixes) {
                    stopToPatterns.set(entry.stop.id, {
                        stop: entry.stop,
                        suffixes: entry.patternSuffixes
                    });
                }
            }

            // For each pattern, find the polyline and calculate bearings for its stops
            for (const pattern of details.patterns) {
                const suffix = pattern.patternSuffix;
                const polylineKey = `${routeId}:${suffix}`;
                const polylinePoints = polylines.get(polylineKey);

                if (!polylinePoints || polylinePoints.length < 2) continue;

                // Find stops that belong to this pattern
                for (const [rawStopId, stopData] of stopToPatterns) {
                    if (!stopData.suffixes.includes(suffix)) continue;

                    const stop = stopData.stop;
                    if (!stop.lat || !stop.lon) continue;

                    const bearing = getBearingFromPolyline(stop.lat, stop.lon, polylinePoints);
                    if (bearing === null) continue;

                    // Normalize stop ID (Rustavi: 1:xxx -> rxxx)
                    const stopId = normalizeStopId(rawStopId, isRustavi);

                    if (!stopBearings[stopId]) {
                        stopBearings[stopId] = [];
                    }
                    stopBearings[stopId].push(bearing);
                    bearingsAdded++;
                }

                processedPatterns++;
            }
        }

        console.log(`Processed ${processedPatterns} patterns, added ${bearingsAdded} bearing samples.`);
        console.log(`Found bearings for ${Object.keys(stopBearings).length} unique stops.`);
        console.log('\nCalculating average bearings...');

        const finalData = {};
        let count = 0;

        for (const [id, bearings] of Object.entries(stopBearings)) {
            if (bearings.length === 0) continue;

            // Average the bearings using vector sum (handles circular wrap-around)
            let sinSum = 0;
            let cosSum = 0;
            for (const b of bearings) {
                sinSum += Math.sin(toRad(b));
                cosSum += Math.cos(toRad(b));
            }
            const avgRad = Math.atan2(sinSum, cosSum);
            const avgDeg = (toDeg(avgRad) + 360) % 360;

            finalData[id] = Math.round(avgDeg);
            count++;
        }

        fs.writeFileSync(OUTPUT_FILE, JSON.stringify(finalData));
        console.log(`\nDone! Saved bearings for ${count} stops to ${OUTPUT_FILE}`);

    } catch (err) {
        console.error('\nFatal Error:', err);
        process.exit(1);
    }
}

main();
