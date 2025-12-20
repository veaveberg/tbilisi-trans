/**
 * LoopUtils: Handles splitting of circular loop routes into virtual directions.
 * 
 * Logic:
 * 1. Detect if a route is a loop (Starts and Ends at effectively the same place).
 * 2. Split it into two pattern segments: Outbound (Start->Mid) and Inbound (Mid->Start).
 */

export const LoopUtils = {
    /**
     * Checks if a pattern is circular enough to be split.
     * @param {Array} stops 
     * @param {string} routeIdent 
     * @returns {boolean}
     */
    isLoop: (stops, routeIdent) => {
        if (!stops || stops.length < 5) return false;

        // Exclusion List (User Request)
        const EXCLUDED_ROUTES = ['387', '397'];
        if (routeIdent && EXCLUDED_ROUTES.includes(String(routeIdent))) return false;

        const first = stops[0];
        const last = stops[stops.length - 1];

        const fId = String(first.id || first.stopId).split(':')[1] || String(first.id || first.stopId);
        const lId = String(last.id || last.stopId).split(':')[1] || String(last.id || last.stopId);

        return fId === lId || first.name === last.name;
    },

    /**
     * Parses a route long name "Origin - Destination" into parts.
     * @param {String} longName 
     * @returns {Object} { origin: String, destination: String } (or nulls)
     */
    parseRouteName: (longName) => {
        if (!longName) return { origin: null, destination: null };

        let parts;
        if (longName.includes(' - ')) {
            parts = longName.split(' - ');
        } else if (longName.includes(' – ')) { // En Dash with spaces
            parts = longName.split(' – ');
        } else if (longName.includes('–')) { // En Dash dense
            // Allow splitting dense En Dash as it is often clear delimiter
            parts = longName.split('–');
        } else if (longName.includes('-')) {
            // Fallback for dense strings like "Rustavi-Tbilisi"
            // User Request: Disable automatic splitting for Rustavi buses/dense strings
            // parts = longName.split('-');
            return { origin: null, destination: null };
        } else {
            return { origin: null, destination: null };
        }

        parts = parts.map(s => s.trim()).filter(s => s.length > 0);

        if (parts.length < 2) return { origin: null, destination: null };
        return {
            origin: parts[0],
            destination: parts[parts.length - 1]
        };
    },

    /**
     * Splits a single loop pattern into two virtual patterns.
     * Splits at the stop matching the pattern headsign (Destination), checking name inclusion.
     * @param {Object} originalPattern 
     * @param {Array} stops 
     * @param {String} [longName] 
     * @returns {Array}
     */
    generateVirtualPatterns: (originalPattern, stops, longName) => {
        // Default: 50/50 Fallback
        let splitIndex = Math.ceil(stops.length * 0.5);
        let startIndex = Math.floor(stops.length * 0.5);

        let splitStop = null;

        // Smart Split: Find the stop matching the Headsign (Destination)
        const targetName = originalPattern.headsign;

        if (targetName) {
            // Scan for destination stop (middle 60% search window)
            const searchStart = Math.floor(stops.length * 0.2);
            const searchEnd = Math.floor(stops.length * 0.8);

            for (let i = searchStart; i < searchEnd; i++) {
                // Check for exact match or substring match (e.g. "Station Square" vs "Station Square (A)")
                if (stops[i].name === targetName || stops[i].name.includes(targetName)) {
                    splitIndex = i + 1; // Split AFTER the destination
                    startIndex = i;     // Start INBOUND from the destination
                    splitStop = stops[i];
                    break;
                }
            }
        }

        // If fallback was used, try to grab the stop at the fallback index
        if (!splitStop && stops[splitIndex - 1]) {
            splitStop = stops[splitIndex - 1];
        }

        const headsignOut = targetName;
        // Inbound headsign is usually origin (stops[0])
        const headsignIn = stops[0] ? stops[0].name : 'Origin';

        // Part 0
        const p0 = {
            ...originalPattern,
            headsign: headsignOut,
            patternSuffix: `${originalPattern.patternSuffix}_PART0`,
            _virtual: true,
            _slice: [0, splitIndex],
            _splitPoint: splitStop ? { lat: splitStop.lat, lon: splitStop.lon } : null
        };

        // Part 1
        const p1 = {
            ...originalPattern,
            headsign: headsignIn,
            patternSuffix: `${originalPattern.patternSuffix}_PART1`,
            _virtual: true,
            _slice: [startIndex, stops.length],
            _splitPoint: splitStop ? { lat: splitStop.lat, lon: splitStop.lon } : null
        };

        return [p0, p1];
    },

    /**
     * Slices stops based on a parsed suffix ending in _PARTx.
     */
    sliceStops: (stops, suffix, sliceRange = null) => {
        if (!suffix.includes('_PART')) return stops;

        if (sliceRange && Array.isArray(sliceRange) && sliceRange.length === 2) {
            return stops.slice(sliceRange[0], sliceRange[1]);
        }

        const splitRatio = 0.5;
        const overlapStartRatio = 0.5;

        const splitIndex = Math.ceil(stops.length * splitRatio);
        const startIndex = Math.floor(stops.length * overlapStartRatio);

        if (suffix.endsWith('_PART0')) { // PART0
            return stops.slice(0, splitIndex);
        } else if (suffix.endsWith('_PART1')) { // PART1
            return stops.slice(startIndex);
        }
        return stops;
    },

    /**
     * Slices a polyline geometry for virtual patterns.
     * Use splitPoint (lat/lon) if available for accurate splitting.
     */
    slicePolyline: (polyline, suffix, splitPoint = null) => {
        if (!suffix.includes('_PART') || !polyline || polyline.length === 0) return polyline;

        let splitIndex = Math.ceil(polyline.length * 0.5);
        let startIndex = Math.floor(polyline.length * 0.5);

        // Smart Coordinate-Based Splitting
        if (splitPoint && splitPoint.lat && splitPoint.lon) {
            let minDist = Infinity;
            let closestIndex = -1;

            // Find point on polyline closest to splitPoint
            // Polyline points are [lng, lat]
            for (let i = 0; i < polyline.length; i++) {
                const [plng, plat] = polyline[i];
                // Simple Euclidean distance squared (sufficient for comparison)
                const d = Math.pow(plng - splitPoint.lon, 2) + Math.pow(plat - splitPoint.lat, 2);
                if (d < minDist) {
                    minDist = d;
                    closestIndex = i;
                }
            }

            if (closestIndex !== -1) {
                // PART0: Start -> Closest
                // PART1: Closest -> End
                splitIndex = closestIndex + 1; // Include the point
                startIndex = closestIndex;
            }
        }

        if (suffix.endsWith('_PART0')) {
            return polyline.slice(0, splitIndex);
        } else if (suffix.endsWith('_PART1')) {
            return polyline.slice(startIndex);
        }
        return polyline;
    },
};
