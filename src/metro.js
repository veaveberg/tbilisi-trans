import * as api from './api.js';
import * as turf from '@turf/turf';
import { getSegmentForStop, generateSegmentGeometry, generateConnectionGeometry, getConnectionKey, LINE_1_IDS, LINE_2_IDS } from './metro-utils.js';
import { getIntervalDescription } from './intervals.js';
import { simplifyNumber } from './settings.js';

let metroTicker = null;
let _cachedSegments = null;
let _isFetchingSchematic = false;

export function startMetroTicker() {
    if (metroTicker) return;
    metroTicker = setInterval(() => {
        const now = Date.now();
        const elements = document.querySelectorAll('.metro-countdown');
        elements.forEach(el => {
            let target = parseInt(el.getAttribute('data-target'));
            if (!target) return;

            let remainingMs = target - now;

            // If expired, check for blink state or next target
            if (remainingMs <= 0) {
                const blinkUntil = parseInt(el.getAttribute('data-blink-until'));

                if (!blinkUntil) {
                    // Start blinking for 10 seconds
                    el.setAttribute('data-blink-until', now + 10000);
                    el.classList.add('led-blink');
                    el.textContent = '00:00';
                    return;
                } else if (now < blinkUntil) {
                    // Still in blink phase
                    el.textContent = '00:00';
                    return;
                } else {
                    // Blink finished, move to next target
                    el.classList.remove('led-blink');
                    el.removeAttribute('data-blink-until');

                    const queue = el.getAttribute('data-next-targets');
                    if (queue) {
                        const targets = queue.split(',');
                        const nextTarget = targets.shift();
                        el.setAttribute('data-target', nextTarget);
                        if (targets.length > 0) el.setAttribute('data-next-targets', targets.join(','));
                        else el.removeAttribute('data-next-targets');

                        target = parseInt(nextTarget);
                        remainingMs = target - now;
                    }
                }
            }

            if (remainingMs <= 0) {
                el.textContent = '00:00';
                return;
            }

            const totalSeconds = Math.floor(remainingMs / 1000);
            const mm = Math.floor(totalSeconds / 60);
            const ss = totalSeconds % 60;
            el.textContent = `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
        });
    }, 1000);
}

export function stopMetroTicker() {
    if (metroTicker) {
        clearInterval(metroTicker);
        metroTicker = null;
    }
}

export async function handleMetroStop(stop, panel, nameEl, listEl, {
    allRoutes,
    stopToRoutesMap,
    setSheetState,
    updateBackButtons,
    showRouteOnMap
}) {
    panel.classList.add('metro-mode');
    // Ensure ticker starts
    startMetroTicker();

    // --- Metro Display Logic ---
    setSheetState(panel, 'half'); // Open panel immediately
    updateBackButtons();

    // Use helper for consistent naming
    nameEl.textContent = cleanMetroName(stop.name);

    // Add Open Hours Badge
    const headerContainer = document.createElement('div');
    headerContainer.className = 'metro-header';

    if (cleanMetroName(stop.name) === 'Varketili') {
        headerContainer.innerHTML = `
            <div class="metro-hours-badge warning">
                <span class="icon">⚠️</span>
                <div style="display: flex; flex-direction: column;">
                     <span>Entrance open 7:00 – 23:00</span>
                     <span style="font-weight: 500; font-size: 0.85em; margin-top: 4px; line-height: 1.3;">In mornings 6:00–7:00 and evenings 23:00–0:00 use bus 174 between Samgori and Varketili</span>
                </div>
            </div>
        `;
    } else {
        headerContainer.innerHTML = `
            <div class="metro-hours-badge">
                <span class="icon">🕒</span> Entrance open 6:00 – 0:00
            </div>
        `;
    }
    // Insert after name
    const existingHeader = panel.querySelector('.metro-header');
    if (existingHeader) existingHeader.remove();
    nameEl.parentNode.insertBefore(headerContainer, nameEl.nextSibling);

    listEl.innerHTML = '<div class="loading">Loading metro schedule...</div>';

    // Clean up any old "All Routes" container if switching from bus stop
    const oldContainer = panel.querySelector('.all-routes-container');
    if (oldContainer) oldContainer.remove();

    try {
        // Identify Route ID for this station
        let metroRoutes = [];
        // Try to use the stopToRoutesMap if populated, otherwise search
        if (stopToRoutesMap.has(stop.id)) {
            metroRoutes = stopToRoutesMap.get(stop.id);
        } else {
            metroRoutes = allRoutes.filter(r => r.mode === 'SUBWAY');
        }

        if (metroRoutes.length === 0) {
            // Fallback for Station Square etc
            const targetName = cleanMetroName(stop.name).replace(/[12]$/, '');
            const subwayRoutes = allRoutes.filter(r => r.mode === 'SUBWAY');

            if (targetName.includes('Station Square')) {
                metroRoutes = subwayRoutes; // Show both lines
            } else {
                // Optimization: Pass all subway routes, logic will filter empty ones
                metroRoutes = subwayRoutes;
            }
        }

        if (metroRoutes.length > 0) {
            // Sort Routes: Line 1 (Red) first, then Line 2 (Green)
            metroRoutes.sort((a, b) => (parseInt(a.shortName) || 0) - (parseInt(b.shortName) || 0));

            const arrivalItems = [];

            const dayOfWeek = new Date().getDay(); // 0 = Sunday, 6 = Saturday
            const isWeekend = (dayOfWeek === 0 || dayOfWeek === 6);
            const dayType = isWeekend ? 'SATURDAY' : 'MONDAY';
            const currentMinutes = new Date().getHours() * 60 + new Date().getMinutes();

            // Process EACH route (for transfer stations like Station Square)
            for (const route of metroRoutes) {
                try {
                    // 1. Get Route Details to find patterns (directions)
                    const routeDetails = await api.fetchRouteDetailsV3(route.id, { strategy: 'cache-first' });
                    const patterns = routeDetails.patterns || [];

                    // 2. Fetch Schedule for EACH pattern to cover both directions
                    const patternPromises = patterns.map(p =>
                        api.fetchMetroSchedulePattern(route.id, p.patternSuffix).then(data => ({
                            pattern: p,
                            data: data
                        }))
                    );

                    const results = await Promise.all(patternPromises);

                    results.forEach(({ pattern, data }) => {
                        if (!data) return;

                        const scheduleGroup = data.find(g => g.fromDay === dayType) || data[0];
                        if (!scheduleGroup) return;

                        // Find stops for this station
                        const targetName = cleanMetroName(stop.name).replace(/[12]$/, '');

                        const matchingStops = scheduleGroup.stops.filter(s => {
                            if (s.id === stop.id) return true;
                            const sName = cleanMetroName(s.name).replace(/[12]$/, '');
                            return sName === targetName || sName.includes(targetName) || targetName.includes(sName);
                        });

                        matchingStops.forEach(s => {
                            const times = s.arrivalTimes.split(',');
                            if (!times || times.length === 0) return;

                            const firstTrain = times[0];
                            const lastTrain = times[times.length - 1];

                            const upcoming = [];
                            for (const t of times) {
                                const [h, m] = t.split(':').map(Number);
                                let timeMins = h * 60 + m;
                                if (h < 4) timeMins += 24 * 60;

                                let cmpTime = timeMins;
                                if (h < 4) cmpTime += 24 * 60; // Extend night
                                let cmpCurrent = currentMinutes;
                                if (new Date().getHours() < 4) cmpCurrent += 24 * 60;

                                if (cmpTime >= cmpCurrent) {
                                    upcoming.push({ time: t, diff: cmpTime - cmpCurrent });
                                    if (upcoming.length >= 3) break;
                                }
                            }

                            // Build UI
                            const rawHeadsign = pattern.headsign || "Unknown Direction";
                            let headsign = rawHeadsign.replace(/ [12]$/, '').trim();

                            const currentStopName = cleanMetroName(stop.name).replace(/[12]$/, '');
                            if (headsign === currentStopName || headsign.includes(currentStopName) || currentStopName.includes(headsign)) {
                                headsign = "Arriving trains";
                            }

                            const formatTime = (t) => {
                                if (!t) return 'N/A';
                                const [h, m] = t.split(':');
                                if (parseInt(h) >= 24) {
                                    return `${parseInt(h) - 24}:${m}`;
                                }
                                return t;
                            };

                            let intervalDesc = getIntervalDescription(route.id);
                            // Fallback for Metro Line 2 if missing from route_intervals.json
                            if (!intervalDesc && route.shortName === '2') {
                                intervalDesc = "every 5', after 21:00 — every 10'";
                            }

                            let bottomHTML = `<span class="schedule-times">${formatTime(firstTrain)} – ${formatTime(lastTrain)}</span>`;
                            if (intervalDesc) {
                                bottomHTML += `,<span class="interval-desc">&nbsp;${intervalDesc}</span>`;
                            }

                            arrivalItems.push(`
                                <div class="arrival-item metro-consolidated-item" 
                                     style="border-left-color: #${route.color || 'ef4444'}; cursor: pointer;"
                                     data-route-id="${route.id}"
                                     data-headsign="${rawHeadsign}">
                                    <div class="arrival-card-left">
                                        <div class="arrival-card-top">
                                            <div class="route-number" style="color: #${route.color || 'ef4444'}">${simplifyNumber(route.shortName)}</div>
                                            <div class="destination">${headsign}</div>
                                        </div>
                                        <div class="arrival-card-bottom">
                                            ${bottomHTML}
                                        </div>
                                    </div>
                                    <div class="arrival-card-right">
                                        <div class="next-arrival">
                                             ${upcoming.length > 0
                                    ? (() => {
                                        const targets = upcoming.map(u => {
                                            const [hu, mu] = u.time.split(':').map(Number);
                                            const tDate = new Date();
                                            if (hu < 4 && tDate.getHours() >= 4) tDate.setDate(tDate.getDate() + 1);
                                            else if (hu >= 4 && tDate.getHours() < 4) tDate.setDate(tDate.getDate() - 1);
                                            const offset = Math.floor(Math.random() * 25) - 12;
                                            tDate.setHours(hu, mu, 30 + offset, 0);
                                            return tDate.getTime();
                                        });

                                        const currentTarget = targets.shift();
                                        const nextTargets = targets.length > 0 ? `data-next-targets="${targets.join(',')}"` : '';

                                        return `<div class="time-container">
                                                    <div class="led-text scheduled-time metro-countdown" data-target="${currentTarget}" ${nextTargets}>88:88</div>
                                                    <div class="scheduled-disclaimer">Scheduled</div>
                                                </div>`;
                                    })()
                                    : `<div class="status-closed">End of Service</div>`
                                }
                                        </div>
                                    </div>
                                </div>
                                ${(headsign === 'Varketili' || (route.shortName === '1' && headsign.includes('Varketili'))) ? `
                                <div class="metro-hours-badge warning" style="margin: -8px 16px 16px 16px; width: calc(100% - 32px);">
                                    <span class="icon">⚠️</span>
                                    <div style="display: flex; flex-direction: column;">
                                         <span style="font-weight: 500; font-size: 0.85em; line-height: 1.3;">In mornings 6:00–7:00 and evenings 23:00–0:00 trains terminate at Samgori. Between Samgori and Varketili use replacement bus 174</span>
                                    </div>
                                </div>
                                ` : ''}
                            `);
                        });
                    });

                } catch (e) {
                    console.error(`Failed to process route ${route.id}`, e);
                }
            }

            if (arrivalItems.length > 0) {
                listEl.innerHTML = arrivalItems.join(''); // Set all items at once

                // Attach click handlers to the newly added items
                const items = listEl.querySelectorAll('.arrival-item.metro-consolidated-item');
                items.forEach(item => {
                    item.onclick = () => {
                        const routeId = item.dataset.routeId;
                        const headsign = item.dataset.headsign;
                        const targetRoute = metroRoutes.find(r => r.id === routeId);

                        if (showRouteOnMap && targetRoute) {
                            showRouteOnMap(targetRoute, true, {
                                fromStopId: stop.id,
                                targetHeadsign: headsign,
                                fitToRoute: false,
                                preserveBounds: true
                            });
                            setSheetState(panel, 'collapsed'); // Collapse the sheet after showing route
                        }
                    };
                });
            } else {
                listEl.innerHTML = '<div class="empty">No schedules found.</div>';
            }


        } else {
            listEl.innerHTML = '<div class="error">Metro data not found.</div>';
        }

    } catch (err) {
        console.error(err);
        listEl.innerHTML = '<div class="error">Failed to load metro schedule.</div>';
    }
}

// --- Metro Configuration & Helpers ---

const RED_LINE_ORDER = [
    'Varketili', 'Samgori', 'Isani', '300 Aragveli', 'Avlabari', 'Liberty Square', 'Rustaveli', 'Marjanishvili', 'Station Square', 'Nadzaladevi', 'Gotsiridze', 'Didube', 'Ghrmaghele', 'Guramishvili', 'Sarajishvili', 'Akhmeteli Theatre'
];

const GREEN_LINE_ORDER = [
    'State University', 'Vazha-Pshavela', 'Delisi', 'Medical University', 'Technical University', 'Tsereteli', 'Station Square'
];

const GREEN_LINE_STOPS = [
    'State University', 'Vazha-Pshavela', 'Vazha Pshavela', 'Delisi', 'Medical University', 'Technical University', 'Tsereteli', 'Station Square 2'
];

const ALL_METRO_NAMES = [...RED_LINE_ORDER, ...GREEN_LINE_ORDER, ...GREEN_LINE_STOPS];

// Derived Helpers
function getSpline(points, tension = 0.25, numOfSegments = 16) {
    if (points.length < 2) return points;

    let res = [];
    const _points = points.slice();
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
}

function getLineCoordinates(orderList, features) {
    const coords = [];
    orderList.forEach(name => {
        const f = features.find(feat => feat.properties.name.includes(name) || name.includes(feat.properties.name));
        if (f) coords.push(f.geometry.coordinates);
    });
    return getSpline(coords);
}


// --- Main Exports ---

export function cleanMetroName(name) {
    if (!name) return 'Metro Station';
    return name
        .replace('M/S', '')
        .replace('Metro Station', '')
        .replace('Station Square 1', 'Station Square')
        .replace('Station Square 2', 'Station Square')
        .replace('Univercity', 'University')
        .replace('Technacal', 'Technical')
        .replace('Techinacal', 'Technical') // Specific typo fix for user
        .replace('Grmaghele', 'Ghrmaghele')
        .replace('Sarajisvhili', 'Sarajishvili')
        .replace('Saradjishvili', 'Sarajishvili')
        .trim() || 'Metro Station';
}

export function processMetroStops(stops, stopBearings = {}) {
    const busStops = [];
    const metroFeatures = [];
    const seenMetroNames = new Set();
    const allowDuplicateNames = ['Station Square'];

    stops.forEach(stop => {
        // Inject Bearing
        if (stop.rotation === undefined) {
            stop.rotation = stopBearings[stop.id] || 0;
        }

        // Metro Check
        const nameMatch = ALL_METRO_NAMES.some(m => stop.name.includes(m));
        const codeMissing = !stop.code || stop.code.length === 0 || !stop.code.match(/^\d+$/);

        const isMetro = stop.vehicleMode === 'SUBWAY' ||
            stop.name.includes('Metro Station') ||
            (stop.id && stop.id.startsWith('M:')) ||
            (nameMatch && codeMissing);

        if (isMetro) {
            // Clean Name
            let displayName = cleanMetroName(stop.name);

            // Duplicate Check
            if (!allowDuplicateNames.some(allowed => displayName.includes(allowed)) && seenMetroNames.has(displayName)) {
                return;
            }
            if (!seenMetroNames.has(displayName)) {
                seenMetroNames.add(displayName);
            }
            // Logic to prevent triple entries if Station Square appears more than twice is not strictly needed given input data, 
            // but for safety, we allow duplicates generally or rely on the input stops being unique enough.
            // Actually, we just need to bypass the check for Station Square.

            // Determine Color
            let color = '#ef4444'; // Red Line Default
            if (GREEN_LINE_STOPS.some(n => stop.name.includes(n))) {
                color = '#22c55e'; // Green Line
            }
            if (displayName.includes('Technical University') || stop.name.includes('Technical Univercity')) {
                color = '#22c55e';
            }
            if (displayName.includes('Vazha-Pshavela')) color = '#22c55e';
            if (displayName.includes('Tsereteli')) color = '#22c55e';

            // Critical: Use raw name to catch Station Square 2 since displayName strips number
            if (stop.name.includes('Station Square 2')) color = '#22c55e';

            metroFeatures.push({
                type: 'Feature',
                geometry: {
                    type: 'Point',
                    coordinates: [stop.lon, stop.lat]
                },
                properties: {
                    id: stop.id,
                    name: displayName,
                    code: stop.code,
                    mode: 'SUBWAY',
                    color: color
                }
            });
        } else {
            busStops.push({
                type: 'Feature',
                geometry: {
                    type: 'Point',
                    coordinates: [stop.lon, stop.lat]
                },
                properties: {
                    id: stop.id,
                    name: stop.name,
                    code: stop.code,
                    mode: stop.vehicleMode || 'BUS',
                    rotation: stop.rotation
                }
            });
        }
    });

    return { busStops, metroFeatures };
}

export function generateMetroLines(metroFeatures) {
    const redLineCoords = getLineCoordinates(RED_LINE_ORDER, metroFeatures);
    const greenLineCoords = getLineCoordinates(GREEN_LINE_ORDER, metroFeatures);
    return { redLineCoords, greenLineCoords };
}




export function addMetroLayers(map, metroFeaturesRef, { redLineCoords, greenLineCoords }) {
    // 1. Fetch & Render Schematic Metro Lines
    const addSchematicLayer = () => {
        if (!map.getLayer('metro-lines-layer') && map.getSource('metro-schematic-source')) {
            map.addLayer({
                id: 'metro-lines-layer',
                type: 'line',
                source: 'metro-schematic-source',
                slot: 'top', // Render above 3D buildings
                layout: {
                    'line-join': 'round',
                    'line-cap': 'round'
                },
                paint: {
                    'line-color': ['get', 'color'],
                    'line-width': 8,
                    'line-opacity': 0.3,
                    'line-emissive-strength': 1
                }
            });
            console.log('[Metro] Schematic layer added (re-add).');
        }
    };

    // Helper: Snap stations using segments
    const snapStationsToSegments = (segments, featuresRef) => {
        // Explicit mapping from station display names to segment IDs
        const STATION_TO_SEGMENT_ID = {
            // Line 1 (Red) - Varketili to Akhmeteli Theatre (16 to 1)
            'Varketili': 'metro_1_16',
            'Samgori': 'metro_1_15',
            'Isani': 'metro_1_14',
            '300 Aragveli': 'metro_1_13',
            'Avlabari': 'metro_1_12',
            'Liberty Square': 'metro_1_11',
            'Rustaveli': 'metro_1_10',
            'Marjanishvili': 'metro_1_9',
            'Station Square': 'metro_1_8', // Red line version
            'Nadzaladevi': 'metro_1_7',
            'Gotsiridze': 'metro_1_6',
            'Didube': 'metro_1_5',
            'Ghrmaghele': 'metro_1_4',
            'Guramishvili': 'metro_1_3',
            'Sarajishvili': 'metro_1_2',
            'Akhmeteli Theatre': 'metro_1_1',
            // Line 2 (Green) - Station Square 2 to State University (1 to 7)
            'Station Square 2': 'metro_2_1', // Green line version (will be mapped by color)
            'Tsereteli': 'metro_2_2',
            'Technical University': 'metro_2_3',
            'Medical University': 'metro_2_4',
            'Delisi': 'metro_2_5',
            'Vazha-Pshavela': 'metro_2_6',
            'Vazha Pshavela': 'metro_2_6', // Alternative spelling
            'State University': 'metro_2_7'
        };

        let snappedCount = 0;

        // Mutate the original reference so that if addMetroLayers is called again (which uses this ref),
        // it uses the snapped coordinates.
        featuresRef.forEach(f => {
            const name = f.properties.name;
            const color = f.properties.color;
            let targetId = null;

            // Special handling for Station Square (exists on both lines)
            if (name === 'Station Square' || name.includes('Station Square')) {
                if (color === '#22c55e') { // Green line
                    targetId = 'metro_2_1';
                } else { // Red line
                    targetId = 'metro_1_8';
                }
            } else {
                // Use explicit mapping
                targetId = STATION_TO_SEGMENT_ID[name];
            }

            let matchedSeg = null;

            if (targetId && segments[targetId] && segments[targetId].center) {
                matchedSeg = segments[targetId];
            } else if (segments[f.properties.id] && segments[f.properties.id].center) {
                // Fallback to direct ID match
                matchedSeg = segments[f.properties.id];
            }

            if (matchedSeg) {
                snappedCount++;
                // Mutate in place!
                f.geometry.coordinates = matchedSeg.center;
                console.log(`[Metro] Snapped "${name}" -> in-place at [${matchedSeg.center[0].toFixed(4)}, ${matchedSeg.center[1].toFixed(4)}]`);
            } else {
                console.log(`[Metro] Failed to snap "${name}". TargetID: ${targetId}`);
            }
        });

        console.log(`[Metro] Snapped ${snappedCount}/${featuresRef.length} stations to schematic centers.`);
    };

    if (!_cachedSegments) {
        if (_isFetchingSchematic) return; // Prevent double fetch
        _isFetchingSchematic = true;

        const basePath = import.meta.env.BASE_URL.endsWith('/') ? import.meta.env.BASE_URL : `${import.meta.env.BASE_URL}/`;
        const segmentsUrl = `${basePath}data/metro_segments.json?t=${Date.now()}`;
        const midpointsUrl = `${basePath}data/metro_midpoints.json?t=${Date.now()}`;
        console.log('[Metro] Fetching schematic data from:', segmentsUrl, midpointsUrl);

        // Fetch both segments and midpoints
        Promise.all([
            fetch(segmentsUrl, { cache: 'no-store' }).then(res => res.json()),
            fetch(midpointsUrl, { cache: 'no-store' }).then(res => res.ok ? res.json() : {}).catch(() => ({}))
        ])
            .then(([segments, midpoints]) => {
                _isFetchingSchematic = false;
                _cachedSegments = segments; // Cache it!
                console.log('[Metro] Schematic segments loaded. Midpoints:', Object.keys(midpoints).length);
                const features = [];

                const lines = [
                    { ids: LINE_1_IDS, color: '#ef4444' }, // Red
                    { ids: LINE_2_IDS, color: '#22c55e' }  // Green
                ];

                lines.forEach(({ ids, color }) => {
                    for (let i = 0; i < ids.length; i++) {
                        const id = ids[i];
                        const stopObj = { id: id };
                        let seg = getSegmentForStop(stopObj, segments);

                        // 1. Add Station Segment
                        const geom = generateSegmentGeometry(seg);
                        features.push({
                            type: 'Feature',
                            geometry: {
                                type: 'LineString',
                                coordinates: [geom.leftPt, geom.rightPt]
                            },
                            properties: { color: color, type: 'segment' }
                        });

                        // 2. Add Connection to Next (with midpoints if available)
                        if (i < ids.length - 1) {
                            const nextId = ids[i + 1];
                            const nextStopObj = { id: nextId };
                            const nextSeg = getSegmentForStop(nextStopObj, segments);

                            // Look up midpoints for this connection
                            const connKey = getConnectionKey(id, nextId);
                            const connMidpoints = midpoints[connKey] || [];

                            const connGeom = generateConnectionGeometry(seg, nextSeg, connMidpoints);
                            if (connGeom) {
                                features.push({
                                    type: 'Feature',
                                    geometry: connGeom,
                                    properties: { color: color, type: 'connection' }
                                });
                            }
                        }
                    }
                });

                if (map.getSource('metro-schematic-source')) {
                    map.getSource('metro-schematic-source').setData({ type: 'FeatureCollection', features });
                } else {
                    map.addSource('metro-schematic-source', {
                        type: 'geojson',
                        data: { type: 'FeatureCollection', features }
                    });
                }

                addSchematicLayer();

                // 3. Snap Stations (First time)
                snapStationsToSegments(segments, metroFeaturesRef);

                // Update the source (and force refresh layers)
                updateMetroStopsSource(map, metroFeaturesRef);
            })
            .catch(err => {
                _isFetchingSchematic = false;
                console.warn('[Metro] Failed to load schematic segments:', err);
            });
    } else {
        // Cache exists!
        // 1. Ensure schematic layers are there
        if (!map.getSource('metro-schematic-source')) {
            // We have _cachedSegments but source is gone (rare, maybe style change?)
            // We need to re-generate the schematic features.
            // For simplicity, let's just trigger the fetch path again by clearing cache?
            // Or better, just skipping schematic source regeneration if it's too complex to duplicate logic.
            // But we MUST snap.
        } else {
            addSchematicLayer();
        }

        // 2. Snap Stations Synchronously!
        console.log('[Metro] Using cached segments for snapping.');
        snapStationsToSegments(_cachedSegments, metroFeaturesRef);
        // Source update happens below in the main flow
    }

    // Helper to update source and layers (extracted from previous logic)
    function updateMetroStopsSource(map, features) {
        const source = map.getSource('metro-stops');
        if (source) {
            source.setData({ type: 'FeatureCollection', features });
            console.log('[Metro] setData called on metro-stops source. Re-adding layer to force update.');

            // Force refresh by removing and re-adding the layer
            if (map.getLayer('metro-layer-circle')) {
                map.removeLayer('metro-layer-circle');
            }

            map.addLayer({
                id: 'metro-layer-circle',
                type: 'circle',
                source: 'metro-stops',
                slot: 'top',
                paint: {
                    'circle-color': ['get', 'color'],
                    'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, 4, 16, 6],
                    'circle-stroke-width': 2,
                    'circle-stroke-color': '#ffffff',
                    'circle-emissive-strength': 1
                }
            });

            if (map.getLayer('metro-layer-label')) map.removeLayer('metro-layer-label');
            map.addLayer({
                id: 'metro-layer-label',
                type: 'symbol',
                source: 'metro-stops',
                slot: 'top',
                minzoom: 13,
                layout: {
                    'text-field': ['get', 'name'],
                    'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
                    'text-size': 12,
                    'text-offset': [0, 1.5],
                    'text-anchor': 'top'
                },
                paint: {
                    'text-color': '#000000',
                    'text-halo-color': '#ffffff',
                    'text-halo-width': 2,
                    'text-emissive-strength': 1,
                    'text-opacity': [
                        'interpolate',
                        ['linear'],
                        ['zoom'],
                        14, ['case', ['all', ['==', ['get', 'name'], 'Station Square'], ['==', ['get', 'color'], '#22c55e']], 0, 1],
                        15, 1
                    ]
                }
            });
        } else {
            // Add source logic handled by main flow below...
            // But we should probably consolidate it.
        }
    }

    // 2. Metro Source & Layers (Dots - Keep these for station locations)
    if (!map.getSource('metro-stops')) {
        map.addSource('metro-stops', {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: metroFeaturesRef },
            promoteId: 'id' // Required for feature-state
        });
    }

    // Metro Circles
    if (!map.getLayer('metro-layer-circle')) {
        map.addLayer({
            id: 'metro-layer-circle',
            type: 'circle',
            source: 'metro-stops',
            slot: 'top',
            // filter: ['!=', 'name', 'Station Square'],
            paint: {
                'circle-color': ['get', 'color'],
                'circle-radius': [
                    'interpolate',
                    ['linear'],
                    ['zoom'],
                    10, 3,
                    14, 8,
                    16, 12
                ],
                'circle-stroke-width': 2,
                'circle-stroke-color': '#fff',
                'circle-emissive-strength': 1
            }
        });
    }

    // Metro Hover Overlay (White Tint)
    if (!map.getLayer('metro-layer-overlay')) {
        map.addLayer({
            id: 'metro-layer-overlay',
            type: 'circle',
            source: 'metro-stops',
            slot: 'top',
            // No filter: Apply overlay to ALL metro stops including Station Square
            paint: {
                'circle-color': '#ffffff',
                'circle-radius': [
                    'interpolate',
                    ['linear'],
                    ['zoom'],
                    10, 3,
                    14, 8,
                    16, 12
                ],
                'circle-opacity': [
                    'case',
                    ['boolean', ['feature-state', 'hover'], false],
                    0.5, // 50% white tint on hover
                    0
                ],
                'circle-stroke-width': 0
            }
        });
    }

    // Metro Text Labels
    if (!map.getLayer('metro-layer-label')) {
        map.addLayer({
            id: 'metro-layer-label',
            type: 'symbol',
            source: 'metro-stops',
            slot: 'top',
            minzoom: 12, // Visible earlier
            layout: {
                'text-field': ['get', 'name'],
                'text-size': [
                    'interpolate',
                    ['linear'],
                    ['zoom'],
                    12, 10,
                    16, 14
                ],
                'text-offset': [
                    'interpolate',
                    ['linear'],
                    ['zoom'],
                    12, ['literal', [0, 1]],
                    16, ['literal', [0, 1.5]]
                ],
                'text-anchor': 'top',
                'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
                'text-allow-overlap': true,
                'text-ignore-placement': true
            },
            paint: {
                'text-color': '#000000',
                'text-halo-color': '#ffffff',
                'text-halo-width': 2,
                'text-emissive-strength': 1,
                'text-opacity': [
                    'interpolate',
                    ['linear'],
                    ['zoom'],
                    14, ['case', ['all', ['==', ['get', 'name'], 'Station Square'], ['==', ['get', 'color'], '#22c55e']], 0, 1],
                    15, 1
                ]
            }
        });
    }


    /*
    // Metro Transfer Station (Station Square only)
    if (!map.getLayer('metro-transfer-layer')) {
        map.addLayer({
            id: 'metro-transfer-layer',
            type: 'symbol',
            source: 'metro-stops',
            slot: 'top',
            filter: ['==', 'name', 'Station Square'],
            layout: {
                'icon-image': 'station-transfer',
                'icon-allow-overlap': true,
                'icon-size': [
                    'interpolate',
                    ['linear'],
                    ['zoom'],
                    12, 0.6,
                    16, 1.0
                ]
            },
            paint: {
                'icon-opacity': 1,
                'icon-emissive-strength': 1
            }
        });
    }
    */
}
