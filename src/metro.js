import * as api from './api.js';
import * as turf from '@turf/turf';
import { getSegmentForStop, generateSegmentGeometry, generateConnectionGeometry, getConnectionKey, LINE_1_IDS, LINE_2_IDS } from './metro-utils.js';
import { getIntervalDescription } from './intervals.js';
import { simplifyNumber } from './settings.js';

let metroTicker = null;
let _cachedSegments = null;
let _cachedExits = null;
let _isFetchingSchematic = false;
let _lastMetroFeatures = null; // Store reference for exit annotation refreshes
let _lastAllStops = null;
let _lastExitsSignature = null;

// Explicit mapping from station display names to segment IDs for exit/snapping lookup
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

// Reverse mapping: segment ID -> station name (with cleaned names)
const SEGMENT_ID_TO_STATION = {};
Object.entries(STATION_TO_SEGMENT_ID).forEach(([name, id]) => {
    // Clean the name (remove " 2" suffix from Station Square)
    let cleanName = name.replace('Station Square 2', 'Station Square');
    // Prefer non-alternative spellings (shorter names)
    if (!SEGMENT_ID_TO_STATION[id] || cleanName.length < SEGMENT_ID_TO_STATION[id].length) {
        SEGMENT_ID_TO_STATION[id] = cleanName;
    }
});

// Format station name for 2-line display if it has 2+ long words
function formatStationLabelName(name) {
    const words = name.split(' ');
    // If 2+ words and both are longer than 4 chars, split to 2 lines
    if (words.length >= 2) {
        const longWords = words.filter(w => w.length > 4);
        if (longWords.length >= 2) {
            // Find best split point (roughly middle)
            const mid = Math.ceil(words.length / 2);
            return words.slice(0, mid).join(' ') + '\n' + words.slice(mid).join(' ');
        }
    }
    return name;
}

export function startMetroTicker() {
    if (metroTicker) return;
    metroTicker = setInterval(() => {
        if (document.hidden) return;
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
                            const showVarketiliWarning = headsign === 'Varketili' || (route.shortName === '1' && headsign.includes('Varketili'));
                            const warningHTML = showVarketiliWarning
                                ? `<div class="metro-inline-warning"><span class="icon">⚠️</span><span class="text">In mornings 6:00–7:00 and evenings 23:00–0:00 trains terminate at Samgori. Between Samgori and Varketili use replacement bus 174</span></div>`
                                : '';

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
                                            ${warningHTML}
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
        // A stop is a metro station if:
        // 1. vehicleMode is explicitly SUBWAY, OR
        // 2. ID starts with 'M:' (schematic metro stops), OR
        // 3. Name includes 'Metro Station' AND has no numeric code (actual metro entrances, not nearby bus stops)
        // Note: Bus stops near metro stations have names like "M/S Akhmeteli Theatre" but have numeric codes
        const hasNumericCode = stop.code && stop.code.length > 0 && /^\d+$/.test(stop.code);

        const isMetro = stop.vehicleMode === 'SUBWAY' ||
            (stop.id && stop.id.startsWith('M:')) ||
            (stop.name.includes('Metro Station') && !hasNumericCode);

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
                    rotation: stop.rotation,
                    source: stop._source || '',
                    provider: stop.provider || '',
                    ticketProvider: stop.ticketProvider || '',
                    gondolaInfo: stop.gondolaInfo || ''
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




export function addMetroLayers(map, metroFeaturesRef, { redLineCoords, greenLineCoords }, allStopsRef) {
    _lastMetroFeatures = metroFeaturesRef;
    _lastAllStops = allStopsRef;
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
                    'line-width': [
                        'interpolate',
                        ['linear'],
                        ['zoom'],
                        10, 4,
                        12, 6,
                        14, ['case', ['==', ['get', 'type'], 'segment'], 12, 6],
                        16, ['case', ['==', ['get', 'type'], 'segment'], 14, 8]
                    ],
                    'line-opacity': [
                        'interpolate',
                        ['linear'],
                        ['zoom'],
                        10, 0.25,
                        12, 0.3,
                        14, ['case', ['==', ['get', 'type'], 'segment'], 0.6, 0.2],
                        16, ['case', ['==', ['get', 'type'], 'segment'], 0.7, 0.25]
                    ],
                    'line-emissive-strength': 1
                }
            });
            console.log('[Metro] Schematic layer added (re-add).');
        }

        // Add segment center label layer (station names on platforms at high zoom)
        if (!map.getLayer('metro-segment-center-label') && map.getSource('metro-schematic-source')) {
            map.addLayer({
                id: 'metro-segment-center-label',
                type: 'symbol',
                source: 'metro-schematic-source',
                slot: 'top',
                minzoom: 15.2,
                filter: ['==', ['get', 'type'], 'segment-center'],
                layout: {
                    'text-field': ['get', 'name'],
                    'text-size': 24,
                    'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
                    'text-anchor': 'center',
                    'text-justify': 'center',
                    'text-allow-overlap': true,
                    'text-ignore-placement': true,
                    'text-padding': 4
                },
                paint: {
                    'text-color': '#000000',       // Black text (same as regular labels)
                    'text-halo-color': '#ffffff',  // White stroke
                    'text-halo-width': 2,
                    'text-halo-blur': 0,
                    'text-emissive-strength': 1,
                    'text-opacity': [
                        'step', ['zoom'],
                        0,        // Hidden below zoom 15.2
                        15.2, 1   // Visible at zoom 15.2+
                    ]
                }
            });  // No before-layer = placed on top
            console.log('[Metro] Segment center label layer added.');
        }
    };

    // Helper: Snap stations using segments
    const snapStationsToSegments = (segments, featuresRef) => {
        let snappedCount = 0;

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

                // ALSO update the original stop objects in allStops to ensure FlyTo works correctly
                if (_lastAllStops) {
                    const stopObj = _lastAllStops.find(s => String(s.id) === String(f.properties.id));
                    if (stopObj) {
                        stopObj.lon = matchedSeg.center[0];
                        stopObj.lat = matchedSeg.center[1];
                        stopObj.segmentCenterLon = matchedSeg.center[0];
                        stopObj.segmentCenterLat = matchedSeg.center[1];
                    }
                }


            }
        });


    };

    if (!_cachedSegments) {
        if (_isFetchingSchematic) return; // Prevent double fetch
        _isFetchingSchematic = true;

        const basePath = import.meta.env.BASE_URL.endsWith('/') ? import.meta.env.BASE_URL : `${import.meta.env.BASE_URL}/`;
        const segmentsUrl = `${basePath}data/metro_segments.json?t=${Date.now()}`;
        const midpointsUrl = `${basePath}data/metro_midpoints.json?t=${Date.now()}`;
        const exitsUrl = `${basePath}data/metro_exits.json?t=${Date.now()}`;
        console.log('[Metro] Fetching schematic data from:', segmentsUrl, midpointsUrl, exitsUrl);

        // Fetch segments, midpoints, and exits
        Promise.all([
            fetch(segmentsUrl, { cache: 'no-store' }).then(res => res.json()),
            fetch(midpointsUrl, { cache: 'no-store' }).then(res => res.ok ? res.json() : {}).catch(() => ({})),
            fetch(exitsUrl, { cache: 'no-store' }).then(res => res.ok ? res.json() : {}).catch(() => ({}))
        ])
            .then(([segments, midpoints, exits]) => {
                _isFetchingSchematic = false;
                _cachedSegments = segments; // Cache it!
                _cachedExits = exits; // Cache exits!
                console.log('[Metro] Schematic segments loaded. Midpoints:', Object.keys(midpoints).length, 'Exits:', Object.keys(exits).length);

                // Annotate station features with hasExits property and segment center
                metroFeaturesRef.forEach(f => {
                    const name = f.properties.name;
                    const color = f.properties.color;
                    let sid = null;
                    if (name === 'Station Square' || name.includes('Station Square')) {
                        sid = (color === '#22c55e') ? 'metro_2_1' : 'metro_1_8';
                    } else {
                        sid = STATION_TO_SEGMENT_ID[name];
                    }
                    const hasExits = sid && exits[sid] && exits[sid].exits && exits[sid].exits.length > 0;
                    f.properties.hasExits = hasExits;

                    // Add segment center for label repositioning
                    if (sid && segments[sid] && segments[sid].center) {
                        f.properties.segmentCenterLon = segments[sid].center[0];
                        f.properties.segmentCenterLat = segments[sid].center[1];
                    }
                });

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

                        // 1. Add Station Segment (line)
                        const geom = generateSegmentGeometry(seg);
                        const stationName = SEGMENT_ID_TO_STATION[id] || id;
                        const colorName = color === '#22c55e' ? 'green' : 'red';
                        features.push({
                            type: 'Feature',
                            geometry: {
                                type: 'LineString',
                                coordinates: [geom.leftPt, geom.rightPt]
                            },
                            properties: {
                                color: color,
                                colorName: colorName,
                                type: 'segment',
                                stationId: id,
                                name: stationName,
                                centerLon: seg.center[0],
                                centerLat: seg.center[1]
                            }
                        });

                        // 2. Add Segment Center (point for label placement)
                        const labelName = formatStationLabelName(stationName);
                        features.push({
                            type: 'Feature',
                            geometry: {
                                type: 'Point',
                                coordinates: seg.center
                            },
                            properties: {
                                color: color,
                                colorName: colorName,
                                type: 'segment-center',
                                stationId: id,
                                name: labelName
                            }
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

                // Snap station markers to segment centers
                snapStationsToSegments(segments, metroFeaturesRef);

                // Update the source if needed
                if (map.getSource('metro-stops')) {
                    map.getSource('metro-stops').setData({ type: 'FeatureCollection', features: metroFeaturesRef });
                }

                // Ensure exits are added after data is loaded
                addMetroExitsLayers(map);
            })
            .catch(err => {
                _isFetchingSchematic = false;
                console.warn('[Metro] Failed to load schematic segments:', err);
            });
    } else {
        // Cache exists!
        // 1. Ensure schematic layers are there
        if (!map.getSource('metro-schematic-source')) {
            // We have _cachedSegments but source is gone
        } else {
            addSchematicLayer();
        }

        // Snap station markers to segment centers (using cached segments)
        if (_cachedSegments) {
            snapStationsToSegments(_cachedSegments, metroFeaturesRef);
        }

        // Re-annotate in case exits were updated
        if (_cachedExits) {
            metroFeaturesRef.forEach(f => {
                const name = f.properties.name;
                const color = f.properties.color;
                let sid = null;
                if (name === 'Station Square' || name.includes('Station Square')) {
                    sid = (color === '#22c55e') ? 'metro_2_1' : 'metro_1_8';
                } else {
                    sid = STATION_TO_SEGMENT_ID[name];
                }
                const hasExits = sid && _cachedExits[sid] && _cachedExits[sid].exits && _cachedExits[sid].exits.length > 0;
                f.properties.hasExits = hasExits;
            });
        }
    }

    // Helper to update source and layers
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
                maxzoom: 15.2,  // Hide at 15.2+ when exits/segment labels appear
                paint: {
                    'circle-color': ['get', 'color'],
                    'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 5, 12, 7, 14, 10, 16, 14],
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
                maxzoom: 15.2,  // Hide at 15.2+ when segment labels appear
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
                        'step',
                        ['zoom'],
                        ['case', ['all', ['==', ['get', 'name'], 'Station Square'], ['==', ['get', 'color'], '#22c55e']], 0, 1],  // Default (below zoom 16)
                        15.2, 0  // Hidden at zoom 15.2+
                    ]
                }
            });
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

    // Metro Glow Layer (for hover effects)
    if (!map.getLayer('metro-layer-glow')) {
        map.addLayer({
            id: 'metro-layer-glow',
            type: 'circle',
            source: 'metro-stops',
            slot: 'top',
            paint: {
                'circle-color': ['get', 'color'],
                'circle-radius': [
                    'interpolate',
                    ['linear'],
                    ['zoom'],
                    10, 12,
                    12, 18,
                    14, 25,
                    16, 35
                ],
                'circle-opacity': 0, // Controlled by interactions/hover
                'circle-blur': 0.8,
                'circle-emissive-strength': 1
            }
        });
    }

    // Metro Circles
    if (!map.getLayer('metro-layer-circle')) {
        map.addLayer({
            id: 'metro-layer-circle',
            type: 'circle',
            source: 'metro-stops',
            slot: 'top',
            maxzoom: 15.2,  // Hide at 15.2+ when exits/segment labels appear
            // filter: ['!=', 'name', 'Station Square'],
            paint: {
                'circle-color': ['get', 'color'],
                'circle-radius': [
                    'interpolate',
                    ['linear'],
                    ['zoom'],
                    10, 5,
                    12, 7,
                    14, 10,
                    16, 14
                ],
                'circle-opacity': [
                    'interpolate',
                    ['linear'],
                    ['zoom'],
                    15, 1,
                    15.5, ['case', ['boolean', ['get', 'hasExits'], false], 0, 1]
                ],
                'circle-stroke-width': 2,
                'circle-stroke-color': '#fff',
                'circle-stroke-opacity': [
                    'interpolate',
                    ['linear'],
                    ['zoom'],
                    15, 1,
                    15.5, ['case', ['boolean', ['get', 'hasExits'], false], 0, 1]
                ],
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
                    10, 5,
                    12, 7,
                    14, 10,
                    16, 14
                ],
                'circle-opacity': [
                    'interpolate',
                    ['linear'],
                    ['zoom'],
                    15, ['case', ['boolean', ['feature-state', 'hover'], false], 0.5, 0],
                    15.5, ['case', ['boolean', ['get', 'hasExits'], false], 0, ['case', ['boolean', ['feature-state', 'hover'], false], 0.5, 0]]
                ],
                'circle-stroke-width': 0
            }
        });
    }

    // Metro Text Labels (visible from zoom 12 to 15.2, then segment labels take over)
    if (!map.getLayer('metro-layer-label')) {
        map.addLayer({
            id: 'metro-layer-label',
            type: 'symbol',
            source: 'metro-stops',
            slot: 'top',
            minzoom: 12,
            maxzoom: 15.2,  // Hide at 15.2+ when segment labels appear
            layout: {
                'text-field': ['get', 'name'],
                'text-size': [
                    'interpolate',
                    ['linear'],
                    ['zoom'],
                    12, 10,
                    16, 14
                ],
                'text-offset': [0, 1.2],
                'text-anchor': 'top',
                'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
                'text-allow-overlap': true,
                'text-ignore-placement': true
            },
            paint: {
                'text-color': ['get', 'color'],  // Colored text (red/green matching line)
                'text-halo-color': '#ffffff',    // White stroke
                'text-halo-width': 2,
                'text-emissive-strength': 1,
                'text-opacity': [
                    'step',
                    ['zoom'],
                    ['case', ['all', ['==', ['get', 'name'], 'Station Square'], ['==', ['get', 'color'], '#22c55e']], 0, 1],  // Default (below zoom 16)
                    15.2, 0  // Hidden at zoom 15.2+ (segment labels take over)
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

    // Ensure proper layer ordering: glow below circle
    if (map.getLayer('metro-layer-glow') && map.getLayer('metro-layer-circle')) {
        map.moveLayer('metro-layer-glow', 'metro-layer-circle');
    }

    // Ensure segment center labels are on top of everything
    if (map.getLayer('metro-segment-center-label')) {
        map.moveLayer('metro-segment-center-label');  // Move to top
    }

    // --- Metro Exits Layer (visible at zoom > 15) ---
    addMetroExitsLayers(map);
}

// Helper to add/update exit layers
function addMetroExitsLayers(map) {
    if (!_cachedExits) return;

    // Collect all exit features from cached data
    const exitFeatures = [];
    Object.entries(_cachedExits).forEach(([stationId, stationData]) => {
        if (!stationData.exits) return;
        stationData.exits.forEach((exit, idx) => {
            // Determine line color from station ID
            const isGreenLine = stationId.startsWith('metro_2_');
            const lineColor = isGreenLine ? '#22c55e' : '#ef4444';
            const colorName = isGreenLine ? 'green' : 'red';
            exitFeatures.push({
                type: 'Feature',
                geometry: { type: 'Point', coordinates: exit.coords },
                properties: {
                    id: `${stationId}_exit_${exit.id || idx}`,
                    stationId: stationId,
                    stationName: stationData.stationName || stationId,
                    label: exit.label || '',
                    color: lineColor,
                    colorName: colorName
                }
            });
        });
    });

    const exitsSignature = exitFeatures.map(f => f.properties.id).join('|');
    const sourceExists = !!map.getSource('metro-exits');
    if (sourceExists && exitsSignature === _lastExitsSignature) {
        return;
    }
    _lastExitsSignature = exitsSignature;

    console.log(`[Metro] Adding ${exitFeatures.length} exit markers`);

    // Add/update exits source
    if (map.getSource('metro-exits')) {
        map.getSource('metro-exits').setData({ type: 'FeatureCollection', features: exitFeatures });
    } else {
        map.addSource('metro-exits', {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: exitFeatures },
            promoteId: 'id'
        });
    }

    // Exit marker layer - rounded square with number
    if (!map.getLayer('metro-exits-layer')) {
        map.addLayer({
            id: 'metro-exits-layer',
            type: 'symbol',
            source: 'metro-exits',
            slot: 'top',
            minzoom: 15,
            layout: {
                'icon-image': [
                    'case',
                    ['!=', ['get', 'label'], ''],
                    ['concat', 'exit-', ['get', 'colorName'], '-', ['get', 'label']],
                    ['concat', 'exit-', ['get', 'colorName'], '-arrow']
                ],
                'icon-size': [
                    'interpolate', ['linear'], ['zoom'],
                    15, 0.36,
                    18, 0.6
                ],
                'icon-allow-overlap': true,
                'icon-ignore-placement': true
            },
            paint: {
                'icon-opacity': [
                    'interpolate', ['linear'], ['zoom'],
                    15, 0,
                    15.5, 1
                ],
                'icon-emissive-strength': 1
            }
        });
    }

    // Exit glow layer for hover effects
    if (!map.getLayer('metro-exits-glow')) {
        map.addLayer({
            id: 'metro-exits-glow',
            type: 'circle',
            source: 'metro-exits',
            slot: 'top',
            minzoom: 15,
            paint: {
                'circle-color': ['get', 'color'],
                'circle-radius': [
                    'interpolate', ['linear'], ['zoom'],
                    15, 20,
                    18, 30
                ],
                'circle-opacity': 0,
                'circle-blur': 0.8,
                'circle-emissive-strength': 1
            }
        }, 'metro-exits-layer');
    }

    if (map.getLayer('metro-exits-glow')) {
        map.moveLayer('metro-exits-glow');
    }
    if (map.getLayer('metro-exits-layer')) {
        map.moveLayer('metro-exits-layer');
    }
}

// Export function to refresh exits (for editor)
export function refreshMetroExits(map, exits) {
    _cachedExits = exits;

    // Re-annotate features if we have the reference
    if (_lastMetroFeatures && map.getSource('metro-stops')) {
        _lastMetroFeatures.forEach(f => {
            const name = f.properties.name;
            const color = f.properties.color;
            let sid = null;
            if (name === 'Station Square' || name.includes('Station Square')) {
                sid = (color === '#22c55e') ? 'metro_2_1' : 'metro_1_8';
            } else {
                sid = STATION_TO_SEGMENT_ID[name];
            }
            const hasExits = sid && exits[sid] && exits[sid].exits && exits[sid].exits.length > 0;
            f.properties.hasExits = hasExits;
        });
        map.getSource('metro-stops').setData({ type: 'FeatureCollection', features: _lastMetroFeatures });
    }

    addMetroExitsLayers(map);
}
