import mapboxgl from 'mapbox-gl';
import { map } from './map-setup.js';
import { updateStopHoverEffects } from './map-visuals.js';
import { getCurrentMapLanguage } from './i18n.ts';
import { showPlaceInfoSheet } from './search.js';
import { flyToPointInView, isCurrentMapCameraIntent, invalidateMapCameraIntent } from './map-camera.js';
import { stopTracking } from './geolocation.js';

let lastHoveredStopId = null;
let hoverTimeout = null;
let pendingTouchMapActionTimeout = null;
let lastMapTouchTs = 0;

function cancelPendingTouchMapAction() {
    if (pendingTouchMapActionTimeout !== null) {
        clearTimeout(pendingTouchMapActionTimeout);
        pendingTouchMapActionTimeout = null;
    }
}

function isTouchTriggeredMapClick(event) {
    if (Date.now() - lastMapTouchTs < 700) return true;

    const original = event?.originalEvent;
    if (!original) return false;
    if (original.pointerType === 'touch') return true;
    if (typeof original.type === 'string' && original.type.startsWith('touch')) return true;
    if (original.sourceCapabilities?.firesTouchEvents) return true;
    return false;
}

export function runMapAction(event, action) {
    if (!isTouchTriggeredMapClick(event)) {
        action();
        return;
    }

    cancelPendingTouchMapAction();
    pendingTouchMapActionTimeout = window.setTimeout(() => {
        pendingTouchMapActionTimeout = null;
        action();
    }, 280);
}

export function setMapFocus(active) {
    if (active && window.isFilterModeActive === true) {
        active = false;
    }
    const isDark = document.body.classList.contains('dark-mode');
    const baseOpacity = isDark ? 0.3 : 0.4;
    const selectedId = window.currentStopId || "";
    const isMetroSelected = window.currentStopMode === 'SUBWAY';

    const metroDetails = (typeof window.getActiveDirectionsMetroDetails === 'function')
        ? window.getActiveDirectionsMetroDetails()
        : null;

    let opacityExpr;
    if (active) {
        opacityExpr = [
            'case',
            ['==', ['get', 'id'], selectedId], 1.0,
            baseOpacity
        ];
    } else {
        opacityExpr = 1.0;
    }

    const labelColor = isDark ? '#ffffff' : '#000000';
    const haloColor = isDark ? '#000000' : '#ffffff';

    if (map.getLayer('stops-layer')) {
        map.setPaintProperty('stops-layer', 'icon-opacity', opacityExpr);
    }
    if (map.getLayer('stops-layer-circle')) {
        map.setPaintProperty('stops-layer-circle', 'circle-opacity', opacityExpr);
        map.setPaintProperty('stops-layer-circle', 'circle-stroke-opacity', opacityExpr);
    }

    if (map.getLayer('metro-layer-circle')) {
        // If metro is selected, hide the circle for THAT station, dim others.
        // Otherwise use standard opacity logic.
        let metroOpacity;
        if (active) {
            if (metroDetails && metroDetails.stationIds && metroDetails.stationIds.length > 0) {
                metroOpacity = [
                    'interpolate',
                    ['linear'],
                    ['zoom'],
                    15, ['case',
                        ['==', ['get', 'id'], selectedId], (isMetroSelected ? 0 : 1.0),
                        ['in', ['get', 'segmentId'], ['literal', metroDetails.stationIds]], 1.0,
                        baseOpacity
                    ],
                    15.5, ['case',
                        ['==', ['get', 'id'], selectedId], (isMetroSelected ? 0 : 1.0),
                        ['boolean', ['get', 'hasExits'], false], 0,
                        ['in', ['get', 'segmentId'], ['literal', metroDetails.stationIds]], 1.0,
                        baseOpacity
                    ]
                ];
            } else {
                metroOpacity = [
                    'interpolate',
                    ['linear'],
                    ['zoom'],
                    15, ['case',
                        ['==', ['get', 'id'], selectedId], (isMetroSelected ? 0 : 1.0),
                        baseOpacity
                    ],
                    15.5, ['case',
                        ['==', ['get', 'id'], selectedId], (isMetroSelected ? 0 : 1.0),
                        ['boolean', ['get', 'hasExits'], false], 0,
                        baseOpacity
                    ]
                ];
            }
        } else {
            metroOpacity = [
                'interpolate',
                ['linear'],
                ['zoom'],
                15, 1,
                15.5, ['case', ['boolean', ['get', 'hasExits'], false], 0, 1]
            ];
        }

        map.setPaintProperty('metro-layer-circle', 'circle-opacity', metroOpacity);
        map.setPaintProperty('metro-layer-circle', 'circle-stroke-opacity', metroOpacity);

        // Radius: Enlarge selected (if not hidden)
        const radiusExpr = [
            'interpolate',
            ['linear'],
            ['zoom'],
            10, ['case', ['==', ['get', 'id'], selectedId], 8, 5],
            12, ['case', ['==', ['get', 'id'], selectedId], 10, 7],
            14, ['case', ['==', ['get', 'id'], selectedId], 14, 10],
            16, ['case', ['==', ['get', 'id'], selectedId], 18, 14]
        ];
        map.setPaintProperty('metro-layer-circle', 'circle-radius', radiusExpr);

        if (map.getLayer('metro-layer-overlay')) {
            map.setPaintProperty('metro-layer-overlay', 'circle-radius', radiusExpr);
            
            let overlayOpacityExpr = active ? (isMetroSelected ? 0 : 0.3) : 0;
            if (active && metroDetails && metroDetails.stationIds && metroDetails.stationIds.length > 0) {
                overlayOpacityExpr = [
                    'case',
                    ['==', ['get', 'id'], selectedId], 0,
                    ['in', ['get', 'segmentId'], ['literal', metroDetails.stationIds]], 0,
                    isMetroSelected ? 0 : 0.3
                ];
            }
            map.setPaintProperty('metro-layer-overlay', 'circle-opacity', overlayOpacityExpr);
        }
    }

    if (map.getLayer('metro-lines-layer')) {
        // If metro is selected, keep lines bright. Otherwise dim.
        map.setPaintProperty('metro-lines-layer', 'line-opacity', active ? (isMetroSelected ? 0.8 : 0.3) : 0.8);
    }

    if (map.getLayer('metro-layer-label')) {
        map.setPaintProperty('metro-layer-label', 'text-color', labelColor);
        map.setPaintProperty('metro-layer-label', 'text-halo-color', haloColor);
        let labelOpacity;
        if (active) {
            if (metroDetails && metroDetails.terminalIds && metroDetails.terminalIds.length > 0) {
                labelOpacity = [
                    'step',
                    ['zoom'],
                    ['case',
                        ['==', ['get', 'id'], selectedId], (isMetroSelected ? 0 : 1.0),
                        ['in', ['get', 'segmentId'], ['literal', metroDetails.terminalIds]], 1.0,
                        baseOpacity
                    ],
                    15.2, 0
                ];
            } else {
                labelOpacity = [
                    'step',
                    ['zoom'],
                    ['case', ['==', ['get', 'id'], selectedId], (isMetroSelected ? 0 : 1.0), baseOpacity],
                    15.2, 0
                ];
            }
        } else {
            labelOpacity = [
                'step',
                ['zoom'],
                ['case', ['==', ['get', 'segmentId'], 'metro_2_1'], 0, 1.0],
                15.2, 0
            ];
        }
        map.setPaintProperty('metro-layer-label', 'text-opacity', labelOpacity);
    }

    // Handle close-up segment labels if present
    if (map.getLayer('metro-segment-center-label')) {
        if (active && isMetroSelected) {
            // Highlight ONLY the selected station label, dim others
            map.setPaintProperty('metro-segment-center-label', 'text-opacity', [
                'step',
                ['zoom'],
                0,
                15.2, ['case', ['==', ['get', 'stationId'], selectedId], 1.0, 0.2]
            ]);
        } else {
            // Reset to default zoom-based visibility
            map.setPaintProperty('metro-segment-center-label', 'text-opacity', [
                'step',
                ['zoom'],
                0,
                15.2, 1.0
            ]);
        }
    }

    if (map.getLayer('metro-transfer-layer')) {
        let transferOpacity = opacityExpr;
        if (active && metroDetails && metroDetails.stationIds && metroDetails.stationIds.length > 0) {
            transferOpacity = [
                'case',
                ['==', ['get', 'id'], selectedId], 1.0,
                ['in', ['get', 'segmentId'], ['literal', metroDetails.stationIds]], 1.0,
                baseOpacity
            ];
        }
        map.setPaintProperty('metro-transfer-layer', 'icon-opacity', transferOpacity);
        map.setPaintProperty('metro-transfer-layer', 'text-opacity', transferOpacity);
        map.setPaintProperty('metro-transfer-layer', 'text-color', labelColor);
        map.setPaintProperty('metro-transfer-layer', 'text-halo-color', haloColor);
    }

    if (map.getLayer('stops-label-selected')) {
        const selectedLabelOpacity = window.isFilterModeActive === true ? 1.0 : opacityExpr;
        map.setPaintProperty('stops-label-selected', 'text-opacity', selectedLabelOpacity);
        map.setPaintProperty('stops-label-selected', 'text-color', labelColor);
        map.setPaintProperty('stops-label-selected', 'text-halo-color', haloColor);
    }

}

export function addMetroHoverLogic(map, filterManager) {
    if (!map.getLayer('metro-layer-circle')) return;

    let hoveredStateId = null;
    const targets = ['metro-layer-circle', 'metro-layer-overlay', 'metro-layer-glow', 'metro-layer-label', 'metro-transfer-layer'];

    // Helper to update glow layer opacity
    const updateMetroGlow = (hoveredId) => {
        if (!map.getLayer('metro-layer-glow')) return;

        if (hoveredId !== null) {
            // Show glow only for the hovered station
            map.setPaintProperty('metro-layer-glow', 'circle-opacity', [
                'case',
                ['==', ['get', 'id'], hoveredId],
                0.6, // Glow opacity for hovered station
                0    // Hidden for others
            ]);
        } else {
            // Reset to no glow
            map.setPaintProperty('metro-layer-glow', 'circle-opacity', 0);
        }
    };

    map.on('mouseenter', targets, (e) => {
        // Disable Metro Hover if Filter is Active (Metro is not "reachable")
        if (filterManager && (filterManager.state.active || filterManager.state.picking)) return;

        map.getCanvas().style.cursor = 'pointer';
        if (e.features.length > 0) {
            const hoveredFeature = e.features[0];
            const hoveredId = hoveredFeature.properties?.id || hoveredFeature.id;

            if (hoveredStateId !== null && hoveredStateId !== hoveredId) {
                map.setFeatureState(
                    { source: 'metro-stops', id: hoveredStateId },
                    { hover: false }
                );
            }
            hoveredStateId = hoveredFeature.id; // Use implicit ID for feature-state
            map.setFeatureState(
                { source: 'metro-stops', id: hoveredStateId },
                { hover: true }
            );

            // Update glow using properties.id for paint expression matching
            updateMetroGlow(hoveredId);
        }
    });

    map.on('mouseleave', targets, () => {
        map.getCanvas().style.cursor = '';
        if (hoveredStateId !== null) {
            map.setFeatureState(
                { source: 'metro-stops', id: hoveredStateId },
                { hover: false }
            );
        }
        hoveredStateId = null;
        updateMetroGlow(null);
    });
}

function proximitySort(features, point) {
    if (!features || features.length === 0) return null;

    // Use geographic distance instead of screen distance to avoid 3D terrain projection offset
    // Unproject the cursor point to get geographic coordinates
    const cursorLngLat = map.unproject(point);

    return features.sort((a, b) => {
        const coordsA = a.geometry.coordinates;
        const coordsB = b.geometry.coordinates;

        // Calculate squared geographic distance (faster than sqrt for comparison)
        const distA = Math.pow(coordsA[0] - cursorLngLat.lng, 2) + Math.pow(coordsA[1] - cursorLngLat.lat, 2);
        const distB = Math.pow(coordsB[0] - cursorLngLat.lng, 2) + Math.pow(coordsB[1] - cursorLngLat.lat, 2);

        return distA - distB;
    });
}

export function setupHoverHandlers(context) {
    const { ALL_STOP_LAYERS, setFilterOpacity, filterManager, updateConnectionLine } = context;

    // Unified Hover Target: Stops + Segments
    const HOVER_TARGETS = [...ALL_STOP_LAYERS, 'minibus-segments-layer'];
    let hoveredSegmentId = null; // Local state for segment hover

    map.on('mousemove', HOVER_TARGETS, (e) => {
        if (window.isPickModeActive) return;

        // 1. Check for Stops First (Priority)
        // We query broadly to catch stops near the cursor even if we technically hovered the segment line first

        // SAFEGUARD: Only query layers that actually exist to prevent Mapbox errors
        const validStopLayers = ALL_STOP_LAYERS.filter(id => map.getLayer(id));
        const stopFeatures = validStopLayers.length > 0
            ? map.queryRenderedFeatures(e.point, { layers: validStopLayers })
            : [];

        let bestStopFeature = null;

        if (stopFeatures.length > 0) {
            // Filter locally for relevant stops if using specific logic
            // But generally, any stop means we should unhover segment
            bestStopFeature = stopFeatures[0]; // Simplest priority
        }

        // 2. Handle Stop Hover Logic
        if (bestStopFeature) {
            // Force Clear Segment Hover if active
            if (hoveredSegmentId !== null) {
                map.setFeatureState({ source: 'minibus-segments', id: hoveredSegmentId }, { hover: false });
                hoveredSegmentId = null;
                window.hoveredMinibusSegmentId = null;
            }

            // ... Existing Stop Hover Logic ...
            // Filter out unreachable stops if Filter is Active
            let features = stopFeatures; // Use the stop features we found
            if (filterManager && (filterManager.state.active || filterManager.state.picking)) {
                // ... (logic from before) ...
                const reachable = filterManager.state.reachableStopIds;
                features = features.filter(f => {
                    const id = f.properties.id;
                    return id === filterManager.state.originId || reachable.has(id);
                });

                // Dedupe
                const seenIds = new Set();
                features = features.filter(f => {
                    if (seenIds.has(f.properties.id)) return false;
                    seenIds.add(f.properties.id);
                    return true;
                });

                if (features.length === 0) {
                    // Nothing purely clickable found in stop land
                    // But we still don't want to highlight segments if we are "near" an excluded stop?
                    // Or maybe we do? Let's say if we are near ANY stop, we block segment.
                    // So we fall through here.
                    map.getCanvas().style.cursor = '';
                    if (hoverTimeout) clearTimeout(hoverTimeout);
                    hoverTimeout = setTimeout(() => {
                        if (updateConnectionLine && filterManager.state.picking) {
                            updateConnectionLine(filterManager.state.originId, filterManager.state.targetIds, false);
                        }
                        if (setFilterOpacity) setFilterOpacity(false);
                        lastHoveredStopId = null;
                    }, 100);
                    return;
                }
            }

            // Normal Stop Hover Processing
            map.getCanvas().style.cursor = 'pointer';

            // Prioritize Metro Features
            const metroFeature = features.find(f => f.layer.id.startsWith('metro-'));
            let bestFeature;
            if (metroFeature) {
                bestFeature = metroFeature;
            } else {
                const sorted = proximitySort(features, e.point);
                bestFeature = sorted ? sorted[0] : null;
            }

            if (!bestFeature) return;

            const currentId = bestFeature.properties.id;

            if (lastHoveredStopId !== currentId) {
                lastHoveredStopId = currentId;
                updateStopHoverEffects(currentId);
                if (setFilterOpacity) setFilterOpacity(true);
            }

            if (hoverTimeout) {
                clearTimeout(hoverTimeout);
                hoverTimeout = null;
            }

            if (updateConnectionLine && filterManager && filterManager.state.picking) {
                updateConnectionLine(filterManager.state.originId, filterManager.state.targetIds, true, currentId);
            }
            return; // Stop processing (don't do segment logic)
        }

        // 3. If No Stop Found, Check Segment
        // Clear Stop Hover effects if we left a stop
        if (lastHoveredStopId !== null) {
            lastHoveredStopId = null;
            updateStopHoverEffects(null);
            if (setFilterOpacity) setFilterOpacity(false);
        }

        // Segment Logic
        const segmentFeatures = e.features.filter(f => f.layer.id === 'minibus-segments-layer');
        if (segmentFeatures.length > 0) {
            map.getCanvas().style.cursor = 'pointer';
            const feature = segmentFeatures[0];
            if (feature.id === undefined || feature.id === null) {
                return;
            }

            // If strictly hovering segment and NOT stop
            if (hoveredSegmentId !== feature.id) {
                if (hoveredSegmentId !== null) {
                    map.setFeatureState({ source: 'minibus-segments', id: hoveredSegmentId }, { hover: false });
                }
                hoveredSegmentId = feature.id;

                // EXPOSE GLOBAL FOR CLICK HANDLER
                window.hoveredMinibusSegmentId = hoveredSegmentId;

                map.setFeatureState({ source: 'minibus-segments', id: hoveredSegmentId }, { hover: true });
            }
        } else {
            // We fired on HOVER_TARGETS but nothing matched?
            // Could happen if we left one and entered another?
            // Reset Segment
            if (hoveredSegmentId !== null) {
                map.setFeatureState({ source: 'minibus-segments', id: hoveredSegmentId }, { hover: false });
                hoveredSegmentId = null;
                window.hoveredMinibusSegmentId = null;
            }
            map.getCanvas().style.cursor = '';
        }

    });

    map.on('mouseleave', HOVER_TARGETS, () => {
        // We need to be careful here. Mouseleave fires when leaving layer A to enter layer B.
        // So we might leave Segment to enter Stop.
        // queryRenderedFeatures is the source of truth.
        const point = map.project(map.getCenter()); // Dummy point? No we can't trust point here.

        // Just rely on the fact that if we really left everything, the next mousemove (on map) 
        // OR this event should clear things.
        // Ideally we check if we are still over any target.

        map.getCanvas().style.cursor = '';

        // Clear Stop Hover
        if (hoverTimeout) clearTimeout(hoverTimeout);
        hoverTimeout = setTimeout(() => {
            if (updateConnectionLine && filterManager && filterManager.state.picking) {
                updateConnectionLine(filterManager.state.originId, filterManager.state.targetIds, false);
            }
            lastHoveredStopId = null;
            updateStopHoverEffects(null);
            if (setFilterOpacity) setFilterOpacity(false);
        }, 50);

        // Clear Segment Hover
        if (hoveredSegmentId !== null) {
            map.setFeatureState({ source: 'minibus-segments', id: hoveredSegmentId }, { hover: false });
            hoveredSegmentId = null;
            window.hoveredMinibusSegmentId = null;
        }
    });

    // Broad Pointer cursor for POIs
    map.on('mousemove', (e) => {
        if (window.isPickModeActive) return;

        let features = [];
        try {
            features = map.queryRenderedFeatures(e.point);
        } catch (err) {
            // Ignore style mismatch errors during loading
        }
        const hasClickableFeature = features.some(f => {
            const layerId = f.layer ? f.layer.id : '';
            const isTransport = ALL_STOP_LAYERS.includes(layerId) ||
                (layerId.startsWith('metro-') && layerId !== 'metro-lines-layer') ||
                layerId.startsWith('stops-');
            if (isTransport) return true;

            const props = f.properties;
            const hasName = props.name || props.name_en;
            const isMapboxNative = layerId.includes('label') || layerId.includes('symbol');
            return hasName && isMapboxNative;
        });

        if (hasClickableFeature) {
            map.getCanvas().style.cursor = 'pointer';
        } else {
            map.getCanvas().style.cursor = '';
        }
    });
}

export function clearStopHoverState() {
    if (hoverTimeout) {
        clearTimeout(hoverTimeout);
        hoverTimeout = null;
    }
    lastHoveredStopId = null;
    updateStopHoverEffects(null);
}

export async function fetchReverseGeocode(lng, lat) {
    const token = mapboxgl.accessToken || window.mapboxgl?.accessToken;
    if (!token) return null;
    const mapLang = (typeof getCurrentMapLanguage === 'function') ? getCurrentMapLanguage() : 'en';
    const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${lng},${lat}.json?access_token=${token}&limit=1&language=${mapLang}&types=address,poi,neighborhood,place`;

    try {
        const response = await fetch(url);
        if (!response.ok) throw new Error('Geocoding fail');
        const data = await response.json();
        const feature = data.features?.[0];
        if (feature) {
            let address = feature.place_name || feature.text || '';
            address = address
                .replace(/, Tbilisi, Georgia$/i, '')
                .replace(/, Georgia$/i, '')
                .replace(/, Tbilisi$/i, '')
                .trim();
            return {
                address,
                text: feature.text || '',
                place_type: feature.place_type || [],
                properties: feature.properties || {}
            };
        }
    } catch (err) {
        console.error('Error reverse geocoding:', err);
    }
    return null;
}

const GENERIC_CATEGORY_VALUES = new Set([
    '',
    'poi',
    'point of interest',
    'points of interest',
    'location',
    'place',
    'generic'
]);

function normalizeCategoryValue(value) {
    if (value === null || value === undefined) return '';
    return String(value).trim();
}

export function extractCategory(props) {
    if (!props) return null;

    // Prioritize specific fields over generic ones.
    let rawCat = props.type || props.subclass;

    if (!rawCat && props.category) {
        // Handle comma-separated geocoder categories.
        rawCat = props.category.split(',')[0].trim();
    }

    rawCat = rawCat || props.category_en || props.group || props.maki;

    // Only use class if it's not generic 'poi'.
    if (!rawCat && props.class && props.class !== 'poi') {
        rawCat = props.class;
    }

    rawCat = normalizeCategoryValue(rawCat);
    if (!rawCat) return null;

    const lower = rawCat.toLowerCase();
    if (GENERIC_CATEGORY_VALUES.has(lower)) return null;

    // Format: capitalize first letters, replace hyphens and underscores with spaces.
    return rawCat
        .split(/[_-]/)
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
}

function isPoiFeature(feature) {
    if (!feature) return false;
    const layerId = feature.layer ? feature.layer.id : '';
    const sourceLayer = feature.sourceLayer || (feature.layer && feature.layer['source-layer']) || '';
    const props = feature.properties || {};
    const hasName = props.name || props.name_en || props.name_primary;
    const isSymbol = feature.layer && feature.layer.type === 'symbol';
    const isPoiLayer = layerId.includes('poi') || sourceLayer.includes('poi');
    return !!hasName && (isSymbol || isPoiLayer);
}

function isBuildingFeature(feature) {
    if (!feature) return false;
    const layerId = feature.layer ? feature.layer.id : '';
    const sourceLayer = feature.sourceLayer || (feature.layer && feature.layer['source-layer']) || '';
    const isFillExtrusion = feature.layer && feature.layer.type === 'fill-extrusion';
    return layerId.includes('building') || sourceLayer.includes('building') || isFillExtrusion;
}

export async function resolvePlaceClickDetails({ feature = null, features = [], center, name, assumePoi = false, reverseGeocode = fetchReverseGeocode } = {}) {
    const resolvedCenter = Array.isArray(center) ? center : [0, 0];
    const hasRealName = !!(name && name !== 'Point of Interest' || feature?.properties?.name || feature?.properties?.name_en || feature?.properties?.name_primary);
    const fallbackName = hasRealName
        ? (name && name !== 'Point of Interest' ? name : (feature?.properties?.name || feature?.properties?.name_en || feature?.properties?.name_primary))
        : 'Point of Interest';

    const poiFeature = feature && (assumePoi || isPoiFeature(feature))
        ? feature
        : features.find(isPoiFeature);
    const buildingFeature = feature && isBuildingFeature(feature)
        ? feature
        : features.find(isBuildingFeature);

    let category = poiFeature ? extractCategory(poiFeature.properties) : null;
    let geocodeResult = null;

    if ((!category && poiFeature) || (!poiFeature && !buildingFeature && reverseGeocode) || (!hasRealName && reverseGeocode)) {
        geocodeResult = await reverseGeocode(resolvedCenter[0], resolvedCenter[1]);
    }

    if (poiFeature) {
        if (!category && geocodeResult?.place_type?.includes('poi')) {
            category = extractCategory(geocodeResult.properties);
        }
    } else if (buildingFeature) {
        category = 'Building';
    }

    const address = geocodeResult?.address || `${resolvedCenter[0].toFixed(5)}, ${resolvedCenter[1].toFixed(5)}`;
    const resolvedCategory = category || (poiFeature ? 'Point of Interest' : 'Location');
    const description = resolvedCategory
        ? `${resolvedCategory}, ${resolvedCenter[1].toFixed(5)}, ${resolvedCenter[0].toFixed(5)}`
        : `Location, ${resolvedCenter[1].toFixed(5)}, ${resolvedCenter[0].toFixed(5)}`;

    return {
        text: fallbackName,
        address,
        category: resolvedCategory,
        description,
        center: resolvedCenter,
        placeType: poiFeature ? 'poi' : (buildingFeature ? 'building' : 'location'),
        hasRealName
    };
}

export function setupClickHandlers(context) {
    const { ALL_STOP_LAYERS, filterManager, showStopInfo, applyFilter, getStopById } = context;

    map.on('movestart', cancelPendingTouchMapAction);
    map.on('zoomstart', cancelPendingTouchMapAction);
    map.on('rotatestart', cancelPendingTouchMapAction);
    map.on('pitchstart', cancelPendingTouchMapAction);
    map.getCanvas().addEventListener('touchstart', () => {
        lastMapTouchTs = Date.now();
        if (pendingTouchMapActionTimeout !== null) {
            cancelPendingTouchMapAction();
        }
    }, { passive: true });
    map.getCanvas().addEventListener('touchend', () => {
        lastMapTouchTs = Date.now();
    }, { passive: true });

    map.on('click', ALL_STOP_LAYERS, (e) => {
        if (window.ignoreMapClicks) return;
        stopTracking();
        if (e.originalEvent) e.originalEvent._clickHandled = true;

        // Filter out unreachable stops if Filter is Active
        let features = e.features;
        if (filterManager && (filterManager.state.active || filterManager.state.picking)) {
            const reachable = filterManager.state.reachableStopIds;
            features = features.filter(f => {
                const id = f.properties.id;
                // Keep Origin, Reachable, or Target
                return id === filterManager.state.originId || reachable.has(id);
            });
            if (features.length === 0) return;
        }

        const sorted = proximitySort(features, e.point);
        const bestFeature = sorted ? sorted[0] : null;

        if (!bestFeature) return;

        // Check if this is an exit marker - need to find parent station
        if (bestFeature.layer && bestFeature.layer.id === 'metro-exits-layer') {
            const stationId = bestFeature.properties.stationId;
            if (stationId && getStopById) {
                const station = getStopById(stationId);
                if (station) {
                    console.log('[Map] Clicked exit for station:', stationId, station.name);
                    runMapAction(e, () => showStopInfo(station, true, true));
                    return;
                }
            }
            // Fallback: use stationName and stationId
            const coords = bestFeature.geometry.coordinates;
            const stop = {
                id: stationId,
                name: bestFeature.properties.stationName,
                lon: coords[0],
                lat: coords[1],
                vehicleMode: 'SUBWAY'
            };
            console.log('[Map] Clicked exit (fallback):', stop.id, stop.name);
            runMapAction(e, () => showStopInfo(stop, true, true));
            return;
        }

        // Check if this is a segment line or segment center label - find parent station
        if (bestFeature.layer && (bestFeature.layer.id === 'metro-lines-layer' || bestFeature.layer.id === 'metro-segment-center-label')) {
            const stationId = bestFeature.properties.stationId;
            const stationName = bestFeature.properties.name;
            // Only handle segment or segment-center type (not connection lines)
            if ((bestFeature.properties.type === 'segment' || bestFeature.properties.type === 'segment-center') && stationId) {
                if (getStopById) {
                    const station = getStopById(stationId);
                    if (station) {
                        console.log('[Map] Clicked segment/label for station:', stationId, station.name);
                        runMapAction(e, () => showStopInfo(station, true, true));
                        return;
                    }
                }
                // Fallback: construct station object from properties
                const coords = bestFeature.geometry.coordinates;
                const stop = {
                    id: stationId,
                    name: stationName,
                    lon: Array.isArray(coords[0]) ? coords[0][0] : coords[0],
                    lat: Array.isArray(coords[0]) ? coords[0][1] : coords[1],
                    vehicleMode: 'SUBWAY'
                };
                console.log('[Map] Clicked segment (fallback):', stop.id, stop.name);
                runMapAction(e, () => showStopInfo(stop, true, true));
                return;
            }
        }

        // Build stop object with coordinates from geometry (not in properties)
        const coords = bestFeature.geometry.coordinates;
        const stop = {
            ...bestFeature.properties,
            lon: coords[0],
            lat: coords[1]
        };
        console.log('[Map] Clicked:', stop.id, stop.name);

        if (filterManager && filterManager.state.picking) {
            // In pick mode, toggle as destination
            runMapAction(e, () => applyFilter(stop.id));
        } else {
            // Normal selection
            clearStopHoverState();
            runMapAction(e, () => showStopInfo(stop, true, true));
        }
    });

    // Global click handler (anywhere on map, prioritizing stops -> pois -> buildings -> anywhere else)
    map.on('click', (e) => {
        if (window.ignoreMapClicks) return;
        if (e.originalEvent && e.originalEvent._clickHandled) return;
        stopTracking();
        if (window.hoveredMinibusSegmentId !== null && window.hoveredMinibusSegmentId !== undefined) return;
        if (window.minibusSegmentsEditor && window.minibusSegmentsEditor.isActive()) return;

        // Query features at clicked point
        let features = [];
        try {
            features = map.queryRenderedFeatures(e.point);
        } catch (err) {
            // Ignore potential style errors during load
        }

        // 1. Stops check (highest priority - should already be handled, but as a safeguard)
        const isStop = features.some(f => {
            const layerId = f.layer ? f.layer.id : '';
            return ALL_STOP_LAYERS.includes(layerId) ||
                layerId.startsWith('metro-') ||
                layerId.startsWith('stops-');
        });
        if (isStop) return;

        // Click anywhere logic (falls through to reverse geocoding)
        let cameraIntentId = invalidateMapCameraIntent();
        runMapAction(e, async () => {
            const clickCenter = (features[0]?.geometry?.type === 'Point' && Array.isArray(features[0].geometry.coordinates))
                ? [features[0].geometry.coordinates[0], features[0].geometry.coordinates[1]]
                : [e.lngLat.lng, e.lngLat.lat];

            cameraIntentId = flyToPointInView(clickCenter, {
                zoom: 17,
                bottomAnchorSelector: '#info-panel',
                duration: 900,
                radiusMeters: 10
            });

            if (window._searchPlaceMarker) {
                window._searchPlaceMarker.remove();
            }
            window._searchPlaceMarker = new mapboxgl.Marker({ color: '#e74c3c' })
                .setLngLat(clickCenter)
                .addTo(map);

            const place = await resolvePlaceClickDetails({
                features,
                center: clickCenter
            });
            if (!isCurrentMapCameraIntent(cameraIntentId)) return;

            showPlaceInfoSheet({
                text: place.address,
                place_name: place.description,
                center: place.center,
                extent: null,
                placeType: place.placeType
            });
        });
    });
}
