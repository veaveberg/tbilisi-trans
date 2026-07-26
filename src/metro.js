import * as api from './api.js';
import * as turf from '@turf/turf';
import { getSegmentForStop, generateSegmentGeometry, generateConnectionGeometry, getConnectionKey, LINE_1_IDS, LINE_2_IDS } from './metro-utils.js';
import { getIntervalDescription } from './intervals.js';
import { simplifyNumber } from './settings.js';
import { getCurrentStopNamesLanguage, t } from './i18n.ts';
import { setPoint } from './directions.js';

let metroTicker = null;
let _cachedSegments = null;
let _cachedMidpoints = null;
let _cachedExits = null;
let _isFetchingSchematic = false;
let _lastMetroFeatures = null; // Store reference for exit annotation refreshes
let _lastAllStops = null;
let _lastExitsSignature = null;

const RED_LINE_COLOR = '#ef4444';
const GREEN_LINE_COLOR = '#22c55e';

const STATION_DEFINITIONS = [
    { segmentId: 'metro_1_16', displayNameEn: 'Varketili', displayNameKa: 'ვარკეთილი', aliases: ['Varketili', 'მ/ს ვარკეთილი'] },
    { segmentId: 'metro_1_15', displayNameEn: 'Samgori', displayNameKa: 'სამგორი', aliases: ['Samgori', 'მ/ს სამგორი'] },
    { segmentId: 'metro_1_14', displayNameEn: 'Isani', displayNameKa: 'ისანი', aliases: ['Isani', 'მ/ს ისანი'] },
    { segmentId: 'metro_1_13', displayNameEn: '300 Aragveli', displayNameKa: '300 არაგველი', aliases: ['300 Aragveli', 'მ/ს 300 არაგველი'] },
    { segmentId: 'metro_1_12', displayNameEn: 'Avlabari', displayNameKa: 'ავლაბარი', aliases: ['Avlabari', 'მ/ს ავლაბარი'] },
    { segmentId: 'metro_1_11', displayNameEn: 'Liberty Square', displayNameKa: 'თავისუფლების მოედანი', aliases: ['Liberty Square', 'მ/ს თავისუფლების მ-ნი', 'მ/ს თავისუფლების მოედანი'] },
    { segmentId: 'metro_1_10', displayNameEn: 'Rustaveli', displayNameKa: 'რუსთაველი', aliases: ['Rustaveli', 'მ/ს რუსთაველი'] },
    { segmentId: 'metro_1_9', displayNameEn: 'Marjanishvili', displayNameKa: 'მარჯანიშვილი', aliases: ['Marjanishvili', 'მ/ს მარჯანიშვილი'] },
    { segmentId: 'metro_1_8', displayNameEn: 'Station Square', displayNameKa: 'სადგურის მოედანი', aliases: ['Station Square 1', 'მ/ს სადგურის მოედანი 1'] },
    { segmentId: 'metro_1_7', displayNameEn: 'Nadzaladevi', displayNameKa: 'ნაძალადევი', aliases: ['Nadzaladevi', 'მ/ს ნაძალადევი'] },
    { segmentId: 'metro_1_6', displayNameEn: 'Gotsiridze', displayNameKa: 'გოცირიძე', aliases: ['Gotsiridze', 'მ/ს გოცირიძე'] },
    { segmentId: 'metro_1_5', displayNameEn: 'Didube', displayNameKa: 'დიდუბე', aliases: ['Didube', 'მ/ს დიდუბე'] },
    { segmentId: 'metro_1_4', displayNameEn: 'Ghrmaghele', displayNameKa: 'ღრმაღელე', aliases: ['Ghrmaghele', 'Grmaghele', 'მ/ს ღრმაღელე'] },
    { segmentId: 'metro_1_3', displayNameEn: 'Guramishvili', displayNameKa: 'გურამიშვილი', aliases: ['Guramishvili', 'მ/ს გურამიშვილი'] },
    { segmentId: 'metro_1_2', displayNameEn: 'Sarajishvili', displayNameKa: 'სარაჯიშვილი', aliases: ['Sarajishvili', 'Sarajisvhili', 'Saradjishvili', 'მ/ს სარაჯიშვილი'] },
    { segmentId: 'metro_1_1', displayNameEn: 'Akhmeteli Theatre', displayNameKa: 'ახმეტელის თეატრი', aliases: ['Akhmeteli Theatre', 'მ/ს ახმეტელის თეატრი'] },
    { segmentId: 'metro_2_1', displayNameEn: 'Station Square', displayNameKa: 'სადგურის მოედანი', aliases: ['Station Square 2', 'მ/ს სადგურის მოედანი 2'] },
    { segmentId: 'metro_2_2', displayNameEn: 'Tsereteli', displayNameKa: 'წერეთელი', aliases: ['Tsereteli', 'მ/ს წერეთელი'] },
    { segmentId: 'metro_2_3', displayNameEn: 'Technical University', displayNameKa: 'ტექნიკური უნივერსიტეტი', aliases: ['Technical University', 'Technical Univercity', 'Technacal University', 'Techinacal University', 'მ/ს ტექნიკური უნივერსიტეტი'] },
    { segmentId: 'metro_2_4', displayNameEn: 'Medical University', displayNameKa: 'სამედიცინო უნივერსიტეტი', aliases: ['Medical University', 'მ/ს სამედიცინო უნივერსიტეტი'] },
    { segmentId: 'metro_2_5', displayNameEn: 'Delisi', displayNameKa: 'დელისი', aliases: ['Delisi', 'მ/ს დელისი'] },
    { segmentId: 'metro_2_6', displayNameEn: 'Vazha-Pshavela', displayNameKa: 'ვაჟა-ფშაველა', aliases: ['Vazha-Pshavela', 'Vazha Pshavela', 'მ/ს ვაჟა-ფშაველა'] },
    { segmentId: 'metro_2_7', displayNameEn: 'State University', displayNameKa: 'სახელმწიფო უნივერსიტეტი', aliases: ['State University', 'მ/ს სახელმწიფო უნივერსიტეტი'] }
];

const STATION_TO_SEGMENT_ID = {};
const SEGMENT_ID_TO_STATION = {};
STATION_DEFINITIONS.forEach(({ segmentId, displayNameEn, displayNameKa, aliases }) => {
    SEGMENT_ID_TO_STATION[segmentId] = { en: displayNameEn, ka: displayNameKa };
    aliases.forEach((alias) => {
        STATION_TO_SEGMENT_ID[normalizeMetroLookupName(alias)] = segmentId;
    });
});

function normalizeMetroLookupName(name) {
    return String(name || '')
        .replace(/M\/S\s*/gi, '')
        .replace(/Metro Station\s*/gi, '')
        .replace(/მ\/ს\s*/g, '')
        .replace(/["„“”]/g, '')
        .replace(/\s+/g, ' ')
        .replace('Univercity', 'University')
        .replace('Technacal', 'Technical')
        .replace('Techinacal', 'Technical')
        .replace('Grmaghele', 'Ghrmaghele')
        .replace('Sarajisvhili', 'Sarajishvili')
        .replace('Saradjishvili', 'Sarajishvili')
        .trim()
        .toLowerCase();
}

function getMetroSegmentId(input, fallbackColor = null) {
    const stop = typeof input === 'string' ? null : input;
    const rawId = stop ? String(stop.id || '') : String(input || '');
    const matchedId = rawId.match(/(metro_[12]_\d+)/);
    if (matchedId) return matchedId[1];

    const rawName = stop ? stop.name : input;
    const normalizedName = normalizeMetroLookupName(rawName);
    const directMatch = STATION_TO_SEGMENT_ID[normalizedName];
    if (directMatch) return directMatch;

    if (normalizedName === 'station square' || normalizedName === 'სადგურის მოედანი') {
        return fallbackColor === GREEN_LINE_COLOR ? 'metro_2_1' : 'metro_1_8';
    }

    return null;
}

function getMetroLineColor(segmentId, fallbackColor = RED_LINE_COLOR) {
    if (!segmentId) return fallbackColor;
    return segmentId.startsWith('metro_2_') ? GREEN_LINE_COLOR : RED_LINE_COLOR;
}

function getMetroDisplayName(segmentId) {
    const names = segmentId ? SEGMENT_ID_TO_STATION[segmentId] : null;
    if (!names) return null;
    return getCurrentStopNamesLanguage() === 'ka' ? (names.ka || names.en) : (names.en || names.ka);
}

function isStationSquareSegment(segmentId) {
    return segmentId === 'metro_1_8' || segmentId === 'metro_2_1';
}

function relocalizeMetroStopFeatures(featuresRef = []) {
    featuresRef.forEach((feature) => {
        const segmentId = feature?.properties?.segmentId || getMetroSegmentId(feature?.properties?.id || feature?.properties?.name, feature?.properties?.color);
        const displayName = getMetroDisplayName(segmentId);
        if (displayName) {
            feature.properties.name = displayName;
        }
    });
}

function buildSchematicFeatures(segments, midpoints = {}) {
    const features = [];
    const lines = [
        { ids: LINE_1_IDS, color: RED_LINE_COLOR },
        { ids: LINE_2_IDS, color: GREEN_LINE_COLOR }
    ];

    lines.forEach(({ ids, color }) => {
        for (let i = 0; i < ids.length; i++) {
            const id = ids[i];
            const seg = getSegmentForStop({ id }, segments);
            if (!seg) continue;

            const geom = generateSegmentGeometry(seg);
            const stationName = getMetroDisplayName(id) || id;
            const colorName = color === GREEN_LINE_COLOR ? 'green' : 'red';

            features.push({
                type: 'Feature',
                geometry: {
                    type: 'LineString',
                    coordinates: [geom.leftPt, geom.rightPt]
                },
                properties: {
                    color,
                    colorName,
                    type: 'segment',
                    stationId: id,
                    name: stationName,
                    centerLon: seg.center[0],
                    centerLat: seg.center[1]
                }
            });

            features.push({
                type: 'Feature',
                geometry: {
                    type: 'Point',
                    coordinates: seg.center
                },
                properties: {
                    color,
                    colorName,
                    type: 'segment-center',
                    stationId: id,
                    name: formatStationLabelName(stationName)
                }
            });

            if (i < ids.length - 1) {
                const nextId = ids[i + 1];
                const nextSeg = getSegmentForStop({ id: nextId }, segments);
                const connKey = getConnectionKey(id, nextId);
                const connMidpoints = midpoints[connKey] || [];
                const connGeom = generateConnectionGeometry(seg, nextSeg, connMidpoints);
                if (connGeom) {
                    features.push({
                        type: 'Feature',
                        geometry: connGeom,
                        properties: { color, type: 'connection' }
                    });
                }
            }
        }
    });

    return features;
}

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

    headerContainer.innerHTML = `
        <div class="metro-hours-badge">
            <span class="icon">🕒</span> Entrance open 6:00 – 0:00
        </div>
        <div class="metro-directions-buttons" style="display: flex; gap: 12px; margin-top: 12px; width: 100%;">
            <button class="place-detail-btn btn-secondary metro-dir-from" style="flex: 1;">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 8" class="context-icon" fill="currentColor" style="fill-rule:evenodd;clip-rule:evenodd;stroke-linejoin:round;stroke-miterlimit:2;">
                <g id="Artboard1_metro" transform="matrix(0.58749,0,0,0.259037,0,0)">
                  <rect x="0" y="0" width="26.3" height="30.6" style="fill:none;"/>
                  <clipPath id="_clip1_metro">
                    <rect x="0" y="0" width="26.3" height="30.6"/>
                  </clipPath>
                  <g clip-path="url(#_clip1_metro)">
                    <g transform="matrix(1.702158,0,0,3.86045,-6.955498,-49.139011)">
                      <g transform="matrix(1.224181,0.7659,-0.386971,0.77265,-29.173692,-35.216935)">
                        <path d="M42.037,24.229L43.572,22.71L42.414,22.609C42.034,22.575 41.771,22.028 41.827,21.387C41.883,20.747 42.237,20.254 42.617,20.287L45.946,20.578C46.171,20.598 46.365,20.801 46.467,21.123C46.568,21.444 46.564,21.843 46.457,22.193L44.856,27.371C44.674,27.961 44.251,28.238 43.913,27.987C43.576,27.737 43.45,27.054 43.632,26.464L44.178,24.698L42.664,26.197C42.545,25.468 42.334,24.797 42.037,24.229Z"/>
                      </g>
                      <g transform="matrix(1,0,0,1,-5.049186,-10.007903)">
                        <path d="M15.4,29.9C13.6,31.2 11.2,30.8 9.9,29C8.6,27.2 9,24.8 10.8,23.5C12.6,22.2 15,22.6 16.3,24.4C17.6,26.2 17.2,28.6 15.4,29.9ZM15.184,28.596L13.563,24.547C13.542,24.495 13.492,24.461 13.436,24.461L12.72,24.461C12.664,24.461 12.613,24.495 12.593,24.548L11.016,28.597C11.008,28.616 11.011,28.639 11.022,28.656C11.034,28.674 11.054,28.684 11.075,28.684L11.791,28.684C11.848,28.684 11.899,28.648 11.919,28.594L12.202,27.815C12.222,27.761 12.273,27.725 12.33,27.725L13.829,27.725C13.886,27.725 13.936,27.76 13.957,27.812L14.258,28.597C14.278,28.649 14.329,28.684 14.385,28.684L15.125,28.684C15.146,28.684 15.166,28.674 15.178,28.656C15.19,28.638 15.192,28.616 15.184,28.596ZM13.57,27.013L12.575,27.013C12.557,27.013 12.541,27.005 12.53,26.99C12.52,26.975 12.518,26.956 12.524,26.94L13.049,25.497C13.052,25.49 13.059,25.484 13.067,25.484C13.076,25.484 13.083,25.489 13.086,25.497L13.622,26.939C13.628,26.956 13.626,26.975 13.615,26.99C13.605,27.005 13.588,27.013 13.57,27.013Z"/>
                      </g>
                    </g>
                  </g>
                </g>
              </svg>
              <span>${t('directionsFromHere')}</span>
            </button>
            <button class="place-detail-btn btn-secondary metro-dir-to" style="flex: 1;">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 8" class="context-icon" fill="currentColor" style="fill-rule:evenodd;clip-rule:evenodd;stroke-linejoin:round;stroke-miterlimit:2;">
                <g id="Artboard2_metro" transform="matrix(0.608365,0,0,0.259037,0,0)">
                  <rect x="0" y="0" width="26.3" height="30.6" style="fill:none;"/>
                  <g transform="matrix(1.642285,0,0,3.86045,-6.04509,-64.439011)">
                    <g transform="matrix(1.224181,0.7659,-0.386971,0.77265,-35.498521,-31.253666)">
                      <path d="M45.795,24.333L44.856,27.371C44.674,27.961 44.251,28.238 43.913,27.987C43.576,27.737 43.45,27.054 43.632,26.464L44.178,24.698L41.501,27.347C41.158,27.687 40.74,27.521 40.568,26.977C40.396,26.433 40.536,25.715 40.879,25.375L43.572,22.71L42.414,22.609C42.034,22.575 41.771,22.028 41.827,21.387C41.883,20.747 42.237,20.254 42.617,20.287L44.56,20.457C44.603,22.01 45.037,23.42 45.795,24.333Z"/>
                    </g>
                    <g transform="matrix(1,0,0,1,2.58804,-6.044634)">
                      <path d="M15.4,29.9C13.6,31.2 11.2,30.8 9.9,29C8.6,27.2 9,24.8 10.8,23.5C12.6,22.2 15,22.6 16.3,24.4C17.6,26.2 17.2,28.6 15.4,29.9ZM11.49,24.759L11.49,28.641C11.49,28.687 11.508,28.73 11.54,28.762C11.572,28.794 11.615,28.812 11.66,28.812L12.928,28.812C13.471,28.808 13.814,28.798 13.956,28.783C14.183,28.758 14.373,28.691 14.528,28.583C14.682,28.474 14.804,28.329 14.894,28.148C14.983,27.966 15.028,27.779 15.028,27.587C15.028,27.343 14.959,27.131 14.82,26.951C14.708,26.804 14.556,26.692 14.365,26.614C14.342,26.605 14.326,26.584 14.324,26.56C14.322,26.535 14.334,26.512 14.355,26.499C14.478,26.421 14.58,26.32 14.66,26.196C14.767,26.031 14.82,25.849 14.82,25.651C14.82,25.469 14.777,25.304 14.691,25.157C14.604,25.01 14.496,24.893 14.367,24.804C14.237,24.716 14.09,24.658 13.926,24.63C13.762,24.602 13.512,24.588 13.178,24.588L11.66,24.588C11.615,24.588 11.572,24.606 11.54,24.638C11.508,24.67 11.49,24.713 11.49,24.759ZM12.513,26.971L13.031,26.971C13.419,26.971 13.671,26.991 13.787,27.031C13.904,27.072 13.992,27.136 14.054,27.224C14.115,27.313 14.146,27.42 14.146,27.547C14.146,27.697 14.106,27.816 14.027,27.906C13.947,27.995 13.844,28.051 13.717,28.074C13.634,28.091 13.439,28.1 13.132,28.1L12.513,28.1C12.468,28.1 12.424,28.082 12.393,28.05C12.361,28.018 12.343,27.975 12.343,27.93L12.343,27.141C12.343,27.096 12.361,27.053 12.393,27.021C12.424,26.989 12.468,26.971 12.513,26.971ZM12.513,25.291L12.832,25.291C13.234,25.291 13.477,25.296 13.561,25.306C13.703,25.323 13.81,25.372 13.883,25.454C13.955,25.536 13.991,25.642 13.991,25.772C13.991,25.909 13.949,26.019 13.865,26.102C13.782,26.186 13.667,26.236 13.521,26.253C13.44,26.263 13.234,26.268 12.902,26.268L12.513,26.268C12.419,26.268 12.343,26.192 12.343,26.098L12.343,25.461C12.343,25.367 12.419,25.291 12.513,25.291Z"/>
                    </g>
                  </g>
                </g>
              </svg>
              <span>${t('directionsToHere')}</span>
            </button>
        </div>
    `;

    const fromBtn = headerContainer.querySelector('.metro-dir-from');
    const toBtn = headerContainer.querySelector('.metro-dir-to');

    if (fromBtn) {
        fromBtn.addEventListener('click', () => {
            setPoint('from', {
                lat: stop.lat,
                lng: stop.lon,
                label: stop.name
            });
            setSheetState(panel, 'hidden');
        });
    }

    if (toBtn) {
        toBtn.addEventListener('click', () => {
            setPoint('to', {
                lat: stop.lat,
                lng: stop.lon,
                label: stop.name
            });
            setSheetState(panel, 'hidden');
        });
    }

    // Insert after panel header to span full width
    const existingHeader = panel.querySelector('.metro-header');
    if (existingHeader) existingHeader.remove();
    const panelHeader = panel.querySelector('.panel-header');
    if (panelHeader) {
        panelHeader.parentNode.insertBefore(headerContainer, panelHeader.nextSibling);
    } else {
        nameEl.parentNode.insertBefore(headerContainer, nameEl.nextSibling);
    }

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
            const targetSegmentId = getMetroSegmentId(stop);
            const subwayRoutes = allRoutes.filter(r => r.mode === 'SUBWAY');

            if (isStationSquareSegment(targetSegmentId)) {
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
    orderList.forEach(segmentId => {
        const f = features.find((feat) => feat.properties.segmentId === segmentId);
        if (f) coords.push(f.geometry.coordinates);
    });
    return getSpline(coords);
}


// --- Main Exports ---

export function cleanMetroName(name) {
    if (!name) return 'Metro Station';
    const segmentId = getMetroSegmentId(name);
    const localizedName = getMetroDisplayName(segmentId);
    if (localizedName) {
        return localizedName;
    }
    return String(name)
        .replace('M/S', '')
        .replace('Metro Station', '')
        .replace('მ/ს', '')
        .replace('Station Square 1', 'Station Square')
        .replace('Station Square 2', 'Station Square')
        .trim() || 'Metro Station';
}

export function processMetroStops(stops, stopBearings = {}) {
    const busStops = [];
    const metroFeatures = [];
    const seenMetroNames = new Set();

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
            const segmentId = getMetroSegmentId(stop);
            // Clean Name
            let displayName = cleanMetroName(stop.name);

            // Duplicate Check
            if (!isStationSquareSegment(segmentId) && seenMetroNames.has(displayName)) {
                return;
            }
            if (!seenMetroNames.has(displayName)) {
                seenMetroNames.add(displayName);
            }
            // Logic to prevent triple entries if Station Square appears more than twice is not strictly needed given input data, 
            // but for safety, we allow duplicates generally or rely on the input stops being unique enough.
            // Actually, we just need to bypass the check for Station Square.

            const color = getMetroLineColor(segmentId);

            metroFeatures.push({
                type: 'Feature',
                geometry: {
                    type: 'Point',
                    coordinates: [stop.lon, stop.lat]
                },
                properties: {
                    id: stop.id,
                    name: displayName,
                    segmentId: segmentId,
                    code: stop.code,
                    mode: 'SUBWAY',
                    color: color
                }
            });
        } else {
            const staticRoutes = api.getRoutesForStopStatic ? api.getRoutesForStopStatic(stop.id) : [];
            const hasRoutes = staticRoutes.length > 0;
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
                    gondolaInfo: stop.gondolaInfo || '',
                    inactive: (hasRoutes || (
                        stop.vehicleMode === 'GONDOLA' && (
                            stop._source === 'config' ||
                            stop.provider === 'manual-gondola' ||
                            stop.ticketProvider === 'manual-gondola'
                        )
                    )) ? 0 : 1
                }
            });
        }
    });

    return { busStops, metroFeatures };
}

export function generateMetroLines(metroFeatures) {
    const redLineCoords = getLineCoordinates(LINE_1_IDS, metroFeatures);
    const greenLineCoords = getLineCoordinates(LINE_2_IDS, metroFeatures);
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
            const targetId = f.properties.segmentId || getMetroSegmentId(f.properties.name, f.properties.color);

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
                _cachedMidpoints = midpoints;
                _cachedExits = exits; // Cache exits!
                console.log('[Metro] Schematic segments loaded. Midpoints:', Object.keys(midpoints).length, 'Exits:', Object.keys(exits).length);

                // Annotate station features with hasExits property and segment center
                metroFeaturesRef.forEach(f => {
                    const sid = f.properties.segmentId || getMetroSegmentId(f.properties.name, f.properties.color);
                    const hasExits = sid && exits[sid] && exits[sid].exits && exits[sid].exits.length > 0;
                    f.properties.hasExits = hasExits;

                    // Add segment center for label repositioning
                    if (sid && segments[sid] && segments[sid].center) {
                        f.properties.segmentCenterLon = segments[sid].center[0];
                        f.properties.segmentCenterLat = segments[sid].center[1];
                    }
                });

                const features = buildSchematicFeatures(segments, midpoints);

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
        relocalizeMetroStopFeatures(metroFeaturesRef);

        if (_cachedSegments) {
            const schematicFeatures = buildSchematicFeatures(_cachedSegments, _cachedMidpoints || {});
            if (map.getSource('metro-schematic-source')) {
                map.getSource('metro-schematic-source').setData({ type: 'FeatureCollection', features: schematicFeatures });
            } else {
                map.addSource('metro-schematic-source', {
                    type: 'geojson',
                    data: { type: 'FeatureCollection', features: schematicFeatures }
                });
            }
        }
        addSchematicLayer();

        // Snap station markers to segment centers (using cached segments)
        if (_cachedSegments) {
            snapStationsToSegments(_cachedSegments, metroFeaturesRef);
        }

        // Re-annotate in case exits were updated
        if (_cachedExits) {
            metroFeaturesRef.forEach(f => {
                const sid = f.properties.segmentId || getMetroSegmentId(f.properties.name, f.properties.color);
                const hasExits = sid && _cachedExits[sid] && _cachedExits[sid].exits && _cachedExits[sid].exits.length > 0;
                f.properties.hasExits = hasExits;
            });
        }

        if (map.getSource('metro-stops')) {
            map.getSource('metro-stops').setData({ type: 'FeatureCollection', features: metroFeaturesRef });
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
                filter: ['!=', 'segmentId', 'metro_2_1'],  // Permanently hide duplicate Station Square label for green line
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
                        ['case', ['==', ['get', 'segmentId'], 'metro_2_1'], 0, 1],  // Hide duplicate Station Square label for green line
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
            filter: ['!=', 'segmentId', 'metro_2_1'],  // Permanently hide duplicate Station Square label for green line
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
                    ['case', ['==', ['get', 'segmentId'], 'metro_2_1'], 0, 1],  // Hide duplicate Station Square label for green line
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
            const sid = f.properties.segmentId || getMetroSegmentId(f.properties.name, f.properties.color);
            const hasExits = sid && exits[sid] && exits[sid].exits && exits[sid].exits.length > 0;
            f.properties.hasExits = hasExits;
        });
        map.getSource('metro-stops').setData({ type: 'FeatureCollection', features: _lastMetroFeatures });
    }

    addMetroExitsLayers(map);
}
