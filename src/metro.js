import * as api from './api.js';

let metroTicker = null;

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
    updateBackButtons
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
    headerContainer.innerHTML = `
        <div class="metro-hours-badge">
            <span class="icon">🕒</span> Entrance open 6:00 – 0:00
        </div>
    `;
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

            let arrivalHTML = '';

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
                            let headsign = pattern.headsign || "Unknown Direction";
                            headsign = headsign.replace(/ [12]$/, '').trim();

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

                            arrivalHTML += `
                                <div class="arrival-item metro-consolidated-item" style="border-left-color: #${route.color || 'ef4444'}">
                                    <div class="metro-card-top">
                                        <div class="route-info">
                                            <div class="route-number" style="color: #${route.color || 'ef4444'}">${route.shortName}</div>
                                            <div class="destination">${headsign}</div>
                                        </div>
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

                                        const mm = String(upcoming[0].diff).padStart(2, '0');
                                        return `<div class="time-container">
                                                    <div class="led-text scheduled-time metro-countdown" data-target="${currentTarget}" ${nextTargets}>88:88</div>
                                                    <div class="scheduled-disclaimer">Scheduled</div>
                                                </div>`;
                                    })()
                                    : `<div class="status-closed">End of Service</div>`
                                }
                                        </div>
                                    </div>
                                    <div class="metro-card-bottom">
                                        <div class="first-last-row">
                                            <span>First: <b>${formatTime(firstTrain)}</b></span>
                                            <span class="separator">•</span>
                                            <span>Last: <b>${formatTime(lastTrain)}</b></span>
                                        </div>
                                    </div>
                                </div>
                             `;
                        });
                    });

                } catch (e) {
                    console.error(`Failed to process route ${route.id}`, e);
                }
            }

            if (arrivalHTML) {
                listEl.innerHTML = arrivalHTML;
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
    'Varketili', 'Samgori', 'Isani', 'Aviabar', '300 Aragveli', 'Avlabari', 'Liberty Square', 'Rustaveli', 'Marjanishvili', 'Station Square', 'Nadzaladevi', 'Gotsiridze', 'Didube', 'Ghrmaghele', 'Guramishvili', 'Sarajishvili', 'Akhmeteli Theatre'
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

    stops.forEach(stop => {
        // Inject Bearing
        if (stop.bearing === undefined) {
            stop.bearing = stopBearings[stop.id] || 0;
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

            if (seenMetroNames.has(displayName)) return;
            seenMetroNames.add(displayName);

            // Determine Color
            let color = '#ef4444'; // Red Line Default
            if (GREEN_LINE_STOPS.some(n => stop.name.includes(n) || displayName.includes(n))) {
                color = '#22c55e'; // Green Line
            }
            if (displayName.includes('Technical University') || stop.name.includes('Technical Univercity')) {
                color = '#22c55e';
            }
            if (displayName.includes('Vazha-Pshavela')) color = '#22c55e';
            if (displayName.includes('Tsereteli')) color = '#22c55e';

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
                    bearing: stop.bearing
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

export function addMetroLayers(map, metroFeatures, { redLineCoords, greenLineCoords }) {
    // 1. Metro Lines
    if (!map.getSource('metro-lines-manual')) {
        map.addSource('metro-lines-manual', {
            type: 'geojson',
            data: {
                type: 'FeatureCollection',
                features: [
                    {
                        type: 'Feature',
                        properties: { color: '#ef4444' }, // Red
                        geometry: { type: 'LineString', coordinates: redLineCoords }
                    },
                    {
                        type: 'Feature',
                        properties: { color: '#22c55e' }, // Green
                        geometry: { type: 'LineString', coordinates: greenLineCoords }
                    }
                ]
            }
        });
    }

    if (!map.getLayer('metro-lines-layer')) {
        map.addLayer({
            id: 'metro-lines-layer',
            type: 'line',
            source: 'metro-lines-manual',
            slot: 'top', // Render above 3D buildings
            layout: {
                'line-join': 'round',
                'line-cap': 'round'
            },
            paint: {
                'line-color': ['get', 'color'],
                'line-width': 8,
                'line-opacity': 0.3,
                'line-z-offset': 100, // Elevate above 3D buildings
                'line-occlusion-opacity': 1, // Prevent occlusion by 3D buildings
                'line-emissive-strength': 1 // Standard Style Night Mode Support
            }
        });
        // Try to place under stops if possible, but addStopsToMap in main.js handles ordering usually
    }

    // 2. Metro Source & Layers (Dots)
    if (!map.getSource('metro-stops')) {
        map.addSource('metro-stops', {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: metroFeatures },
            promoteId: 'id' // Required for feature-state
        });
    }

    // Metro Circles
    if (!map.getLayer('metro-layer-circle')) {
        map.addLayer({
            id: 'metro-layer-circle',
            type: 'circle',
            source: 'metro-stops',
            filter: ['!=', 'name', 'Station Square'],
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
                'circle-emissive-strength': 1 // Standard Style Night Mode Support
            }
        });
    }

    // Metro Hover Overlay (White Tint)
    if (!map.getLayer('metro-layer-overlay')) {
        map.addLayer({
            id: 'metro-layer-overlay',
            type: 'circle',
            source: 'metro-stops',
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
                    12, ['literal', [0, 1.1]], // Reduced from 1.2, closer to original 1.0
                    16, ['literal', [0, 1.6]]  // Reduced from 1.8
                ],
                'text-anchor': 'top',
                'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
                'text-allow-overlap': true,    // Fix for Station Square
                'text-ignore-placement': true  // Ensure it shows over icons
            },
            paint: {
                'text-color': '#000000',
                'text-halo-color': '#ffffff',
                'text-halo-width': 2,
                'text-emissive-strength': 1 // Standard Style Night Mode Support
            }
        });
    }


    // Metro Transfer Station (Station Square only)
    if (!map.getLayer('metro-transfer-layer')) {
        map.addLayer({
            id: 'metro-transfer-layer',
            type: 'symbol',
            source: 'metro-stops',
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
                'icon-emissive-strength': 1,
                'icon-halo-color': '#ffffff',
                'icon-halo-width': 4,
                'icon-halo-opacity': [
                    'case',
                    ['boolean', ['feature-state', 'hover'], false],
                    0.5,
                    0
                ]
            }
        });
    }
}
