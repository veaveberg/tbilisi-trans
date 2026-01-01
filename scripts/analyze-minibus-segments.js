
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, '../public/data');
const OUTPUT_FILE = path.join(__dirname, '../public/data/long_segments.geojson');

// --- Helper Functions (adapted from generate-bearings.js) ---

function toRad(deg) { return deg * Math.PI / 180; }
function toDeg(rad) { return rad * 180 / Math.PI; }

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

// Distance from point to line segment
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
        distance: Math.sqrt(distX * distX + distY * distY), // Euclidean approximation, ok for small segments
        t: t,
        closestX,
        closestY
    };
}

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

// Find closest point on polyline for a given coordinate
function projectPointOnPolyline(lat, lon, polylinePoints, cumDistances) {
    let bestDist = Infinity;
    let bestSegmentIndex = -1;
    let bestT = 0;

    // Iterate segments
    for (let i = 0; i < polylinePoints.length - 1; i++) {
        const [lng1, lat1] = polylinePoints[i];
        const [lng2, lat2] = polylinePoints[i + 1];

        // Note: distanceToSegment uses euclidean dist on lat/lon, which is rough but likely used in original script.
        // For projection "index" it's probably fine, but we might want to be careful.
        // Ideally we project to Haversine, but that's expensive.
        // Let's stick to the cheap one for finding the segment, similar to generate-bearings.js
        const result = distanceToSegment(lon, lat, lng1, lat1, lng2, lat2);

        if (result.distance < bestDist) {
            bestDist = result.distance;
            bestSegmentIndex = i;
            bestT = result.t;
        }
    }

    if (bestSegmentIndex === -1) return null;

    // Calculate distance along polyline
    const [lng1, lat1] = polylinePoints[bestSegmentIndex];
    const [lng2, lat2] = polylinePoints[bestSegmentIndex + 1];
    const segmentLength = haversineDistance(lat1, lng1, lat2, lng2);
    const distanceAlong = cumDistances[bestSegmentIndex] + bestT * segmentLength;

    return {
        distanceAlong,
        segmentIndex: bestSegmentIndex,
        t: bestT
    };
}

// Get point exactly at `targetDist` along polyline
function getPointAtLength(polylinePoints, cumDistances, targetDist) {
    if (targetDist <= 0) return polylinePoints[0];
    const totalLength = cumDistances[cumDistances.length - 1];
    if (targetDist >= totalLength) return polylinePoints[polylinePoints.length - 1];

    // Binary search
    let lo = 0, hi = cumDistances.length - 1;
    while (lo < hi - 1) {
        const mid = Math.floor((lo + hi) / 2);
        if (cumDistances[mid] <= targetDist) lo = mid;
        else hi = mid;
    }

    const segmentDist = cumDistances[lo + 1] - cumDistances[lo];
    const t = segmentDist > 0 ? (targetDist - cumDistances[lo]) / segmentDist : 0;

    const [lng1, lat1] = polylinePoints[lo];
    const [lng2, lat2] = polylinePoints[lo + 1];

    return [
        lng1 + t * (lng2 - lng1),
        lat1 + t * (lat2 - lat1)
    ];
}

// Extract a sub-polyline between startDist and endDist
function slicePolyline(polylinePoints, cumDistances, startDist, endDist) {
    if (startDist >= endDist) return null;

    const totalLength = cumDistances[cumDistances.length - 1];
    startDist = Math.max(0, startDist);
    endDist = Math.min(totalLength, endDist);

    if (startDist >= endDist) return null;

    const points = [];
    points.push(getPointAtLength(polylinePoints, cumDistances, startDist));

    // Add intermediate points
    // Find first index where distance > startDist
    let i = 0;
    while (i < cumDistances.length && cumDistances[i] <= startDist) i++;

    // Add points while distance < endDist
    while (i < cumDistances.length && cumDistances[i] < endDist) {
        points.push(polylinePoints[i]);
        i++;
    }

    points.push(getPointAtLength(polylinePoints, cumDistances, endDist));

    return points;
}

// Decode Google Polyline
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

// --- Data Loading ---

function loadPolylines() {
    const polylines = new Map();
    const filePath = path.join(DATA_DIR, 'tbilisi_polylines.json');
    if (!fs.existsSync(filePath)) return polylines;

    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    for (const [outerKey, suffixData] of Object.entries(data)) {
        if (typeof suffixData === 'object') {
            for (const [suffix, polylineInfo] of Object.entries(suffixData)) {
                if (polylineInfo && polylineInfo.encodedValue) {
                    const parts = outerKey.split('_');
                    const routeId = parts[0];
                    const key = `${routeId}:${suffix}`;
                    polylines.set(key, decodePolyline(polylineInfo.encodedValue));
                }
            }
        }
    }
    return polylines;
}

function loadRouteDetails() {
    const filePath = path.join(DATA_DIR, 'tbilisi_routes_details_en.json');
    if (!fs.existsSync(filePath)) return {};
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function loadRoutes() {
    const filePath = path.join(DATA_DIR, 'tbilisi_routes_en.json');
    if (!fs.existsSync(filePath)) return [];
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

// --- Main ---

async function main() {
    console.log('Loading data...');
    const polylines = loadPolylines();
    const routeDetails = loadRouteDetails();
    const allRoutes = loadRoutes();

    // 1. Filter Routes (4xx and 5xx)
    const targetRoutes = allRoutes.filter(r => {
        if (!r.shortName) return false;
        const num = parseInt(r.shortName, 10);
        return num >= 400 && num <= 599; // Minibuses 4xx and 5xx
    });

    console.log(`Found ${targetRoutes.length} target routes (4xx-5xx).`);

    const resultFeatures = [];

    for (const route of targetRoutes) {
        const details = routeDetails[route.id];
        if (!details || !details.patterns || !details._stopsOfPatterns) continue;

        // Build Stop ID -> Stop Object map for this route
        const stopMap = new Map();
        if (Array.isArray(details._stopsOfPatterns)) {
            details._stopsOfPatterns.forEach(item => {
                if (item.stop && item.stop.id) stopMap.set(item.stop.id, item.stop);
            });
        }

        // Iterate patterns
        for (const pattern of details.patterns) {
            const suffix = pattern.patternSuffix;
            const polylineKey = `${route.id}:${suffix}`;
            const polylinePoints = polylines.get(polylineKey);

            if (!polylinePoints || polylinePoints.length < 2) continue;

            const cumDistances = getCumulativeDistances(polylinePoints);
            const totalLength = cumDistances[cumDistances.length - 1];

            // Get Stops for this pattern
            // pattern.stops only has minimal info usually? ID is key.
            // Check if pattern.stops has fully hydrated objects or just IDs.
            // Usually in V3 it has basic info. We need lat/lon.

            const stopsWithDist = [];

            // Retrieve stops for this pattern from _stopsOfPatterns
            if (details._stopsOfPatterns) {
                details._stopsOfPatterns.forEach(item => {
                    if (item.patternSuffixes && item.patternSuffixes.includes(suffix)) {
                        const fullStop = item.stop;
                        if (fullStop && fullStop.lat && fullStop.lon) {
                            const proj = projectPointOnPolyline(fullStop.lat, fullStop.lon, polylinePoints, cumDistances);
                            if (proj) {
                                stopsWithDist.push({
                                    id: fullStop.id,
                                    name: fullStop.name,
                                    ...proj
                                });
                            }
                        }
                    }
                });
            }

            // Sort stops by distance along route
            stopsWithDist.sort((a, b) => a.distanceAlong - b.distanceAlong);

            // Filter out stops that loop back (decreasing distance) - optional but good for sanity
            // But some loop routes literally go 0 -> L -> 0.
            // If the route is a loop, stops will cover the whole range.
            // We just check gaps between sorted stops.

            // Add start (0) and end (totalLength) to checks?
            // User: "segments that dont have stops for like a kilometer"
            // Usually this means BETWEEN stops.
            // If the bus runs 5km without stops at the start, that counts too?
            // "on some parts of these routes... segments that dont have stops"
            // Yes, let's include Start->FirstStop and LastStop->End.

            const checks = [];
            checks.push({ dist: 0, type: 'start' });
            stopsWithDist.forEach(s => checks.push({ dist: s.distanceAlong, type: 'stop', name: s.name }));
            checks.push({ dist: totalLength, type: 'end' });

            for (let i = 0; i < checks.length - 1; i++) {
                const start = checks[i].dist;
                const end = checks[i + 1].dist;
                const gap = end - start;

                if (gap > 1000) {
                    // Valid long segment
                    // Subtract 100m padding
                    const segStart = start + 100;
                    const segEnd = end - 100;

                    if (segEnd > segStart) {
                        const segmentGeom = slicePolyline(polylinePoints, cumDistances, segStart, segEnd);
                        if (segmentGeom) {
                            resultFeatures.push({
                                type: 'Feature',
                                geometry: {
                                    type: 'LineString',
                                    coordinates: segmentGeom
                                },
                                properties: {
                                    routeNumber: route.shortName,
                                    routeId: route.id,
                                    patternSuffix: suffix,
                                    gapLength: Math.round(gap),
                                    from: checks[i].type === 'stop' ? checks[i].name : 'Route Start',
                                    to: checks[i + 1].type === 'stop' ? checks[i + 1].name : 'Route End'
                                }
                            });
                        }
                    }
                }
            }
        }
    }

    const geoJson = {
        type: 'FeatureCollection',
        features: resultFeatures
    };

    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(geoJson, null, 2));
    console.log(`\nFound ${resultFeatures.length} segments.`);
    console.log(`Written to ${OUTPUT_FILE}`);
}

main().catch(console.error);
