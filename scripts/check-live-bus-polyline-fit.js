#!/usr/bin/env node

const TBILISI_API_V3 = 'https://transit.ttc.com.ge/pis-gateway/api/v3';
const RUSTAVI_API_V3 = 'https://rustavi-transit.azrycloud.com/pis-gateway/api/v3';
const API_KEY = 'c0a2f304-551a-4d08-b8df-2c53ecd57f9f';
const fs = await import('node:fs/promises');
const path = await import('node:path');
const { fileURLToPath } = await import('node:url');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.resolve(__dirname, '../public/data');

function parseArgs(argv) {
    const args = {
        thresholdMeters: 10,
        json: false,
        routeIds: []
    };

    for (let i = 0; i < argv.length; i += 1) {
        const token = argv[i];
        if (token === '--json') {
            args.json = true;
            continue;
        }
        if (token.startsWith('--threshold=')) {
            const value = Number(token.split('=')[1]);
            if (Number.isFinite(value) && value >= 0) args.thresholdMeters = value;
            continue;
        }
        if (token === '--threshold' && argv[i + 1]) {
            const value = Number(argv[i + 1]);
            if (Number.isFinite(value) && value >= 0) args.thresholdMeters = value;
            i += 1;
            continue;
        }
        if (token.startsWith('-')) continue;
        args.routeIds.push(token);
    }

    return args;
}

function pickSource(routeId) {
    const isRustavi = /^r/i.test(routeId);
    return {
        id: isRustavi ? 'rustavi' : 'tbilisi',
        baseUrl: isRustavi ? RUSTAVI_API_V3 : TBILISI_API_V3
    };
}

async function fetchJson(url) {
    const res = await fetch(url, {
        headers: {
            'x-api-key': API_KEY,
            accept: 'application/json'
        }
    });
    if (!res.ok) {
        throw new Error(`${res.status} ${res.statusText} for ${url}`);
    }
    return res.json();
}

function decodePolyline(encoded) {
    if (Array.isArray(encoded)) return encoded;
    if (!encoded || typeof encoded !== 'string') return [];

    const points = [];
    let index = 0;
    let lat = 0;
    let lng = 0;

    while (index < encoded.length) {
        let b;
        let shift = 0;
        let result = 0;

        do {
            b = encoded.charCodeAt(index++) - 63;
            result |= (b & 0x1f) << shift;
            shift += 5;
        } while (b >= 0x20);
        const dlat = (result & 1) ? ~(result >> 1) : (result >> 1);
        lat += dlat;

        shift = 0;
        result = 0;
        do {
            b = encoded.charCodeAt(index++) - 63;
            result |= (b & 0x1f) << shift;
            shift += 5;
        } while (b >= 0x20);
        const dlng = (result & 1) ? ~(result >> 1) : (result >> 1);
        lng += dlng;

        points.push([lng * 1e-5, lat * 1e-5]);
    }

    return points;
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function haversineMeters(a, b) {
    const toRad = (deg) => deg * (Math.PI / 180);
    const dLat = toRad(b[1] - a[1]);
    const dLon = toRad(b[0] - a[0]);
    const lat1 = toRad(a[1]);
    const lat2 = toRad(b[1]);
    const sinLat = Math.sin(dLat / 2);
    const sinLon = Math.sin(dLon / 2);
    const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon;
    return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

function lineLength(coords) {
    let total = 0;
    for (let i = 1; i < coords.length; i += 1) {
        total += haversineMeters(coords[i - 1], coords[i]);
    }
    return total;
}

function distanceToPolylineMeters(coords, lng, lat) {
    if (!Array.isArray(coords) || coords.length < 2) {
        return { distanceMeters: Infinity, fraction: null };
    }

    const total = lineLength(coords);
    if (!total) return { distanceMeters: Infinity, fraction: null };

    const latRad = (lat * Math.PI) / 180;
    const metersPerDegLon = 111320 * Math.cos(latRad);
    const metersPerDegLat = 110540;
    const p = { x: 0, y: 0 };
    let best = { distanceMeters: Infinity, fraction: 0 };
    let traveled = 0;

    for (let i = 1; i < coords.length; i += 1) {
        const a = coords[i - 1];
        const b = coords[i];
        const ax = (a[0] - lng) * metersPerDegLon;
        const ay = (a[1] - lat) * metersPerDegLat;
        const bx = (b[0] - lng) * metersPerDegLon;
        const by = (b[1] - lat) * metersPerDegLat;
        const abx = bx - ax;
        const aby = by - ay;
        const abLen2 = abx * abx + aby * aby;
        if (abLen2 === 0) continue;

        const apx = p.x - ax;
        const apy = p.y - ay;
        let t = (apx * abx + apy * aby) / abLen2;
        t = clamp(t, 0, 1);

        const projX = ax + abx * t;
        const projY = ay + aby * t;
        const distMeters = Math.hypot(projX, projY);
        const segLen = haversineMeters(a, b);
        const along = traveled + segLen * t;

        if (distMeters < best.distanceMeters) {
            best = {
                distanceMeters: distMeters,
                fraction: along / total
            };
        }

        traveled += segLen;
    }

    return {
        distanceMeters: best.distanceMeters,
        fraction: clamp(best.fraction, 0, 1)
    };
}

function normalizeRouteId(raw) {
    return String(raw || '').trim();
}

async function loadJson(fileName) {
    const filePath = path.join(DATA_DIR, fileName);
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
}

function loadRouteIndex(sourceId) {
    const fileName = sourceId === 'rustavi'
        ? 'rustavi_routes_details_en.json'
        : 'tbilisi_routes_details_en.json';
    return loadJson(fileName);
}

function loadPolylineIndex(sourceId) {
    const fileName = sourceId === 'rustavi'
        ? 'rustavi_polylines.json'
        : 'tbilisi_polylines.json';
    return loadJson(fileName);
}

function resolveRouteEntry(routeIndex, inputRouteId) {
    const raw = String(inputRouteId || '').trim();
    const bare = raw.replace(/^r/i, '');

    const entries = Object.entries(routeIndex);
    const direct = entries.find(([key, route]) =>
        key === raw ||
        String(route?.id) === raw ||
        String(route?.id) === bare ||
        String(route?.shortName) === raw ||
        String(route?.shortName) === bare
    );
    if (direct) {
        const [key, route] = direct;
        return { key, route };
    }

    const numericMatch = bare.replace(/^\d+:/, '');
    const byShortName = entries.find(([, route]) => String(route?.shortName) === numericMatch);
    if (byShortName) {
        const [key, route] = byShortName;
        return { key, route };
    }

    return null;
}

function summarize(values) {
    if (!values.length) {
        return {
            count: 0,
            min: null,
            mean: null,
            median: null,
            p95: null,
            max: null
        };
    }
    const sorted = [...values].sort((a, b) => a - b);
    const sum = sorted.reduce((acc, v) => acc + v, 0);
    const percentile = (p) => {
        const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
        return sorted[idx];
    };
    return {
        count: sorted.length,
        min: sorted[0],
        mean: sum / sorted.length,
        median: percentile(50),
        p95: percentile(95),
        max: sorted[sorted.length - 1]
    };
}

async function checkRoute(routeId, thresholdMeters) {
    const source = pickSource(routeId);
    const [routeIndex, polylineIndex] = await Promise.all([
        loadRouteIndex(source.id),
        loadPolylineIndex(source.id)
    ]);

    const resolved = resolveRouteEntry(routeIndex, routeId);
    if (!resolved) {
        return {
            routeId,
            source: source.id,
            error: 'Route not found in local route-details cache'
        };
    }

    const route = resolved.route;
    const patterns = Array.isArray(route?.patterns) ? route.patterns : [];
    const realSuffixes = [...new Set(
        patterns
            .map((p) => p?.patternSuffix || p?.suffix)
            .filter(Boolean)
            .map((suffix) => suffix.includes('_PART') ? suffix.split('_PART')[0] : suffix)
    )];

    if (realSuffixes.length === 0) {
        return {
            routeId,
            source: source.id,
            error: 'No patterns found in local route-details cache'
        };
    }

    const canonicalRouteId = route.id || resolved.key;
    const suffixesParam = encodeURIComponent(realSuffixes.join(','));
    const positionsUrl = `${source.baseUrl}/routes/${encodeURIComponent(canonicalRouteId)}/positions?patternSuffixes=${suffixesParam}`;
    const positionsData = await fetchJson(positionsUrl);

    const results = [];
    for (const suffix of realSuffixes) {
        const polylineKey = `${canonicalRouteId}_${suffix.replace(/:/g, '_').replace(/,/g, '-')}`;
        const rawPolyline = polylineIndex?.[polylineKey]?.[suffix];
        let encodedValue = rawPolyline;
        if (encodedValue && typeof encodedValue === 'object' && !Array.isArray(encodedValue)) {
            encodedValue = encodedValue.encodedValue || encodedValue.points || encodedValue.geometry;
        }
        const coords = decodePolyline(encodedValue);
        const buses = Array.isArray(positionsData?.[suffix]) ? positionsData[suffix] : [];
        const busResults = buses.map((bus) => {
            const lon = Number(bus?.lon);
            const lat = Number(bus?.lat);
            if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
                return null;
            }
            const { distanceMeters, fraction } = distanceToPolylineMeters(coords, lon, lat);
            return {
                vehicleId: bus?.vehicleId ?? null,
                lon,
                lat,
                heading: Number.isFinite(Number(bus?.heading)) ? Number(bus.heading) : null,
                distanceMeters,
                fraction,
                precise: distanceMeters <= thresholdMeters
            };
        }).filter(Boolean);

        const distances = busResults.map((r) => r.distanceMeters);
        const stats = summarize(distances);
        const preciseCount = busResults.filter((r) => r.precise).length;

        results.push({
            suffix,
            busCount: busResults.length,
            preciseCount,
            thresholdMeters,
            stats,
            buses: busResults
        });
    }

    return {
        routeId,
        source: source.id,
        routeName: route?.shortName || route?.longName || null,
        routeKey: resolved.key,
        patterns: results
    };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const routeIds = args.routeIds.map(normalizeRouteId).filter(Boolean);

    if (routeIds.length === 0) {
        console.error('Usage: node scripts/check-live-bus-polyline-fit.js [--threshold=N] [--json] <routeId...>');
        process.exitCode = 1;
        return;
    }

    const output = [];
    for (const routeId of routeIds) {
        try {
            output.push(await checkRoute(routeId, args.thresholdMeters));
        } catch (err) {
            output.push({
                routeId,
                error: err?.message || String(err)
            });
        }
    }

    if (args.json) {
        console.log(JSON.stringify({ thresholdMeters: args.thresholdMeters, routes: output }, null, 2));
        return;
    }

    for (const route of output) {
        if (route.error) {
            console.log(`${route.routeId}: ERROR ${route.error}`);
            continue;
        }

        const label = route.routeName ? `${route.routeId} (${route.routeName})` : route.routeId;
        console.log(`\n${label} [${route.source}]`);
        for (const pattern of route.patterns) {
            const stats = pattern.stats;
            console.log(
                `  ${pattern.suffix}: ${pattern.preciseCount}/${pattern.busCount} within ${pattern.thresholdMeters}m, ` +
                `min=${stats.min?.toFixed?.(1) ?? 'n/a'}m, mean=${stats.mean?.toFixed?.(1) ?? 'n/a'}m, ` +
                `p95=${stats.p95?.toFixed?.(1) ?? 'n/a'}m, max=${stats.max?.toFixed?.(1) ?? 'n/a'}m`
            );
        }
    }
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
