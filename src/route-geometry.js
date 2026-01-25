/**
 * RouteGeometry: Handles geometric operations for routes, including splitting, splicing, and interpolation.
 * 
 * Logic:
 * 1. Detect if a route is a loop.
 * 2. Split it into virtual patterns.
 * 3. Slice polylines based on stops.
 * 4. Interpolate points for smoother lines (Splines).
 */

import * as api from './api.js';

export const RouteGeometry = {
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

        return fId === lId || (first.name && last.name && first.name === last.name);
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
    generateVirtualPatterns: (originalPattern, stops, longName, forcedSplitStopId = null) => {
        // Default: 50/50 Fallback
        let splitIndex = Math.ceil(stops.length * 0.5);
        let startIndex = Math.floor(stops.length * 0.5);

        let splitStop = null;

        if (forcedSplitStopId) {
            console.log(`[VirtualPattern] Forced Split Requested: ${forcedSplitStopId} (Type: ${typeof forcedSplitStopId})`);
            // Priority 1: Forced Split Stop ID from Overrides
            for (let i = 0; i < stops.length; i++) {
                const sId = String(stops[i].id || stops[i].stopId);
                // Robust check (handle "1:123" vs "123")
                if (sId === String(forcedSplitStopId) || sId.endsWith(`:${forcedSplitStopId}`)) {
                    console.log(`[VirtualPattern] MATCH FOUND at index ${i}: ${sId}`);
                    splitIndex = i + 1;
                    startIndex = i;
                    splitStop = stops[i];
                    break;
                }
            }
            if (!splitStop) {
                console.warn(`[VirtualPattern] Forced split stop ${forcedSplitStopId} NOT found in stops list.`);
                console.warn(`[VirtualPattern] Available Stops:`, stops.map(s => `"${s.id || s.stopId}" (${s.name})`).join(', '));
            }
        }

        // Priority 2: Smart Split based on Headsign (if no forced split found/provided)
        const targetName = originalPattern.headsign;

        if (!splitStop && targetName) {
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
            stops: stops.slice(0, splitIndex), // Slice stops immediately
            _splitPoint: splitStop ? { lat: splitStop.lat, lon: splitStop.lon, id: splitStop.id || splitStop.stopId } : null
        };

        // Part 1
        const p1 = {
            ...originalPattern,
            headsign: headsignIn,
            patternSuffix: `${originalPattern.patternSuffix}_PART1`,
            _virtual: true,
            _slice: [startIndex, stops.length],
            stops: stops.slice(startIndex), // Slice stops immediately
            _splitPoint: splitStop ? { lat: splitStop.lat, lon: splitStop.lon, id: splitStop.id || splitStop.stopId } : null
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
    * 
    * Also handles complex slicing between two specific stops (originStop, targetStop)
    * if intermediateStops array is provided, using a robust proximity clustering algorithm.
    *
    * @param {Array} points - Array of [lng, lat] coordinates
    * @param {Object|string} originStopOrSuffix - Stop object (for routing) or Suffix string (for virtual split)
    * @param {Object} [targetStop] - Target Stop object (required for route slicing)
    * @param {Array} [intermediateStops] - Array of stops between origin and target (optional, improves accuracy)
    */
    slicePolyline: (points, originStopOrSuffix, targetStop = null, intermediateStops = null) => {
        if (!points || points.length < 2) return points; // Return original if not slicable

        // CASE 1: Virtual Pattern Splitting (Suffix Based)
        if (typeof originStopOrSuffix === 'string') {
            const suffix = originStopOrSuffix;
            const splitPoint = targetStop; // In this case, targetStop arg is used as splitPoint

            if (!suffix.includes('_PART')) return points;

            let splitIndex = Math.ceil(points.length * 0.5);
            let startIndex = Math.floor(points.length * 0.5);

            // Smart Coordinate-Based Splitting
            if (splitPoint && splitPoint.lat && splitPoint.lon) {
                let minDist = Infinity;
                let closestIndex = -1;

                for (let i = 0; i < points.length; i++) {
                    const [plng, plat] = points[i];
                    const d = Math.pow(plng - splitPoint.lon, 2) + Math.pow(plat - splitPoint.lat, 2);
                    if (d < minDist) {
                        minDist = d;
                        closestIndex = i;
                    }
                }

                if (closestIndex !== -1) {
                    console.log(`[SlicePolyline] Split closest index: ${closestIndex}, dist: ${minDist.toFixed(7)}`);
                    splitIndex = closestIndex + 1;
                    startIndex = closestIndex;
                }
            }

            if (suffix.endsWith('_PART0')) {
                return points.slice(0, splitIndex);
            } else if (suffix.endsWith('_PART1')) {
                return points.slice(startIndex);
            }
            return points;
        }

        // CASE 2: Route Segment Slicing (Origin -> Target)
        const originStop = originStopOrSuffix;
        if (!originStop || !targetStop) return null;

        // Helper: Find nearest index within a range, preferring the FIRST occurrence (cluster)
        const getNearestIndex = (pt, startIndex = 0, endIndex = points.length) => {
            let minDist = Infinity;
            let globalBestIndex = -1;

            let currentClusterBestIndex = -1;
            let currentClusterMinDist = Infinity;
            let foundFirstCluster = false;

            // Threshold: Approx 30m radius squared
            const THRESHOLD_SQ = 0.0000001;

            for (let i = startIndex; i < endIndex; i++) {
                const lng = points[i][0];
                const lat = points[i][1];

                const d = (lng - pt.lon) ** 2 + (lat - pt.lat) ** 2;

                if (d < minDist) {
                    minDist = d;
                    globalBestIndex = i;
                }

                if (d < THRESHOLD_SQ) {
                    if (!foundFirstCluster) {
                        if (d < currentClusterMinDist) {
                            currentClusterMinDist = d;
                            currentClusterBestIndex = i;
                        }
                    }
                } else {
                    if (currentClusterBestIndex !== -1 && !foundFirstCluster) {
                        foundFirstCluster = true;
                    }
                }
            }

            if (foundFirstCluster) return currentClusterBestIndex;
            if (currentClusterBestIndex !== -1) return currentClusterBestIndex;
            return globalBestIndex;
        };

        // NEW APPROACH: If we have intermediate stops, use them to guide finding the correct segment
        // This is essential for loop routes where each stop appears twice on the polyline
        if (intermediateStops && intermediateStops.length >= 2) {
            // First, find ALL occurrences of the first stop on the polyline
            // For loop routes, the same stop may appear at multiple positions
            const firstStop = intermediateStops[0];
            if (!firstStop.lat || !firstStop.lon) {
                // Fall through to fallback
            } else {
                const THRESHOLD_SQ = 0.0000001; // ~30m
                const firstStopOccurrences = [];

                for (let i = 0; i < points.length; i++) {
                    const d = (points[i][0] - firstStop.lon) ** 2 + (points[i][1] - firstStop.lat) ** 2;
                    if (d < THRESHOLD_SQ) {
                        // Found a match - record the cluster center
                        let clusterBest = i;
                        let clusterMinDist = d;
                        // Skip through the cluster to avoid duplicates
                        while (i + 1 < points.length) {
                            const d2 = (points[i + 1][0] - firstStop.lon) ** 2 + (points[i + 1][1] - firstStop.lat) ** 2;
                            if (d2 < THRESHOLD_SQ) {
                                if (d2 < clusterMinDist) {
                                    clusterMinDist = d2;
                                    clusterBest = i + 1;
                                }
                                i++;
                            } else {
                                break;
                            }
                        }
                        firstStopOccurrences.push(clusterBest);
                    }
                }

                // Try each occurrence and find the one that gives the best (shortest) valid path
                let bestResult = null;
                let bestLength = Infinity;

                for (const startIdx of firstStopOccurrences) {
                    // Try to trace the path from this starting position
                    const stopIndices = [{ stopId: firstStop.id, idx: startIdx }];
                    let searchStart = startIdx;
                    let valid = true;

                    for (let i = 1; i < intermediateStops.length; i++) {
                        const stop = intermediateStops[i];
                        if (!stop.lat || !stop.lon) continue;

                        // Skip consecutive duplicate stop IDs (avoid failing on same stop at same position)
                        const prevStop = stopIndices[stopIndices.length - 1];
                        if (prevStop && prevStop.stopId === stop.id) {
                            continue; // Same stop ID as previous, skip it
                        }

                        const idx = getNearestIndex(stop, searchStart);
                        // console.log(`[Slice Debug] Stop ${i}/${intermediateStops.length}: ${stop.id} at [${stop.lat}, ${stop.lon}] -> idx=${idx} (searchStart=${searchStart})`);
                        if (idx !== -1 && idx > searchStart) {
                            stopIndices.push({ stopId: stop.id, idx });
                            searchStart = idx;
                        } else {
                            // console.log(`[Slice Debug] FAILED to find stop ${stop.id} after idx ${searchStart}`);
                            valid = false;
                            break;
                        }
                    }

                    if (valid && stopIndices.length >= 2) {
                        const firstIdx = stopIndices[0].idx;
                        const lastIdx = stopIndices[stopIndices.length - 1].idx;
                        const segmentLength = lastIdx - firstIdx;
                        // console.log(`[Slice Debug] Valid path found: firstIdx=${firstIdx}, lastIdx=${lastIdx}, segmentLength=${segmentLength}`);

                        // IMPORTANT: Validate that the last point is actually close to the target stop
                        // This prevents selecting a "short" path that ends at the wrong location
                        const lastPoint = points[lastIdx];
                        const targetStop = intermediateStops[intermediateStops.length - 1];
                        if (targetStop && targetStop.lat && targetStop.lon && lastPoint) {
                            const endDist = (lastPoint[0] - targetStop.lon) ** 2 + (lastPoint[1] - targetStop.lat) ** 2;
                            const MAX_ENDPOINT_DIST_SQ = 0.000005; // ~70m threshold

                            if (endDist > MAX_ENDPOINT_DIST_SQ) {
                                // Endpoint is too far from target - this is likely the wrong path
                                // console.log(`[Slice Debug] Rejecting path - endpoint too far from target: ${Math.sqrt(endDist).toFixed(6)}`);
                                continue; // Skip this path, try next starting point
                            }
                        }

                        if (segmentLength > 0 && segmentLength < bestLength) {
                            bestLength = segmentLength;
                            bestResult = points.slice(firstIdx, lastIdx + 1);
                        }
                    }
                }

                if (bestResult) {
                    return bestResult;
                }
            }
        }

        // FALLBACK: Original approach for non-loop routes or when intermediate stops aren't available
        const idxOrigin = getNearestIndex(originStop);
        if (idxOrigin === -1) return null;

        const idxTargetForward = getNearestIndex(targetStop, idxOrigin);

        // Validate that the forward target point is actually close to the target coordinates
        if (idxTargetForward !== -1 && idxOrigin <= idxTargetForward) {
            const targetPoint = points[idxTargetForward];
            const endDist = (targetPoint[0] - targetStop.lon) ** 2 + (targetPoint[1] - targetStop.lat) ** 2;
            const MAX_ENDPOINT_DIST_SQ = 0.000005; // ~70m threshold

            if (endDist <= MAX_ENDPOINT_DIST_SQ) {
                return points.slice(idxOrigin, idxTargetForward + 1);
            }
        }

        // If we can't find a valid forward path with correct endpoint, return null
        return null;
    },

    /**
     * Catmull-Rom Spline Interpolation for smooth curves (Global Version)
     */
    getCatmullRomSpline: (points, tension = 0.25, numOfSegments = 16) => {
        if (points.length < 2) return points;

        let res = [];
        const _points = points.slice();
        // duplicate first and last points to close the curve segment
        _points.unshift(points[0]);
        _points.push(points[points.length - 1]);

        for (let i = 1; i < _points.length - 2; i++) {
            const p0 = _points[i - 1];
            const p1 = _points[i];
            const p2 = _points[i + 1];
            const p3 = _points[i + 2];

            for (let t = 0; t <= numOfSegments; t++) {
                const t1 = t / numOfSegments;
                const t2 = t1 * t1;
                const t3 = t2 * t1;

                // Catmull-Rom factors
                const f1 = -0.5 * t3 + t2 - 0.5 * t1;
                const f2 = 1.5 * t3 - 2.5 * t2 + 1.0;
                const f3 = -1.5 * t3 + 2.0 * t2 + 0.5 * t1;
                const f4 = 0.5 * t3 - 0.5 * t2;

                const x = p0[0] * f1 + p1[0] * f2 + p2[0] * f3 + p3[0] * f4;
                const y = p0[1] * f1 + p1[1] * f2 + p2[1] * f3 + p3[1] * f4;

                res.push([x, y]);
            }
        }
        return res;
    },

    /**
     * Fetches and caches route geometry (polyline) from API.
     */
    fetchAndCacheGeometry: async (route, pattern, options = {}, context) => {
        // Context required for callbacks: { updateConnectionLine, filterManager }
        if (pattern._fetchingPolyline || pattern._polyfailed) return;
        pattern._fetchingPolyline = true;

        try {
            console.log(`[RouteGeometry] Fetching poly for ${route.id} ${pattern.suffix}. SplitPoint:`, pattern._splitPoint);
            const fetchOptions = { ...options, splitPoint: pattern._splitPoint };
            const data = await api.fetchRoutePolylineV3(route.id, pattern.suffix, fetchOptions);

            let entry = data[pattern.suffix];
            let encoded = null;

            if (typeof entry === 'string') {
                encoded = entry;
            } else if (Array.isArray(entry)) {
                encoded = entry;
            } else if (entry && typeof entry === 'object') {
                encoded = entry.encodedValue || entry.points || entry.geometry;
            }

            // Robust Fallback Fallbacks
            if (!encoded) {
                if (Array.isArray(data)) {
                    const match = data.find(p => p.suffix === pattern.suffix || p.patternSuffix === pattern.suffix);
                    if (match) encoded = match.encodedValue || match.points || match.geometry;
                } else if (data.polylines && Array.isArray(data.polylines)) {
                    const match = data.polylines.find(p => p.suffix === pattern.suffix || p.patternSuffix === pattern.suffix);
                    if (match) encoded = match.encodedValue || match.points || match.geometry;
                } else if (data.points) {
                    encoded = data.points;
                }
            }

            if (typeof encoded === 'string' || Array.isArray(encoded)) {
                pattern._decodedPolyline = (typeof encoded === 'string') ? api.decodePolyline(encoded) : encoded;

                // Trigger update if provided in context
                if (context && context.filterManager && context.filterManager.state.active && context.filterManager.state.targetIds.size > 0) {
                    if (context.updateConnectionLine) {
                        context.updateConnectionLine(context.filterManager.state.originId, context.filterManager.state.targetIds, false);
                    }
                }
            } else {
                console.warn(`[RouteGeometry] No polyline string for ${route.shortName} suffix ${pattern.suffix}`);
                pattern._polyfailed = true;
            }

        } catch (e) {
            console.error('Failed to fetch polyline', e);
            pattern._polyfailed = true;
        } finally {
            pattern._fetchingPolyline = false;
        }
    }
};
