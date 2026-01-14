import mapboxgl from 'mapbox-gl';
import { map } from './map-setup.js';
import { updateStopHoverEffects } from './map-visuals.js';

let lastHoveredStopId = null;
let hoverTimeout = null;

export function setMapFocus(active) {
    const isDark = document.body.classList.contains('dark-mode');
    const baseOpacity = isDark ? 0.3 : 0.4;
    const selectedId = window.currentStopId || "";

    const opacityExpr = active ? [
        'case',
        ['==', ['get', 'id'], selectedId], 1.0,
        baseOpacity
    ] : 1.0;

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
        // Opacity: Highlight selected, dim others if active
        const metroOpacity = active ? [
            'case',
            ['==', ['get', 'id'], selectedId], 1.0,
            0.4
        ] : 1.0;

        map.setPaintProperty('metro-layer-circle', 'circle-opacity', metroOpacity);
        map.setPaintProperty('metro-layer-circle', 'circle-stroke-opacity', metroOpacity);

        // Radius: Enlarge selected
        const radiusExpr = [
            'interpolate',
            ['linear'],
            ['zoom'],
            10, ['case', ['==', ['get', 'id'], selectedId], 6, 3],
            14, ['case', ['==', ['get', 'id'], selectedId], 13, 8],
            16, ['case', ['==', ['get', 'id'], selectedId], 17, 12]
        ];
        map.setPaintProperty('metro-layer-circle', 'circle-radius', radiusExpr);

        // Sync Overlay Layer for Hover Effect (30% white tint)
        if (map.getLayer('metro-layer-overlay')) {
            map.setPaintProperty('metro-layer-overlay', 'circle-radius', radiusExpr);
        }
    }
    if (map.getLayer('metro-lines-layer')) {
        map.setPaintProperty('metro-lines-layer', 'line-opacity', active ? 0.3 : 0.8);
    }
    if (map.getLayer('metro-layer-label')) {
        map.setPaintProperty('metro-layer-label', 'text-color', labelColor);
        map.setPaintProperty('metro-layer-label', 'text-halo-color', haloColor);
        map.setPaintProperty('metro-layer-label', 'text-opacity', opacityExpr);
    }

    if (map.getLayer('metro-transfer-layer')) {
        map.setPaintProperty('metro-transfer-layer', 'icon-opacity', opacityExpr);
        map.setPaintProperty('metro-transfer-layer', 'text-opacity', opacityExpr);
        map.setPaintProperty('metro-transfer-layer', 'text-color', labelColor);
        map.setPaintProperty('metro-transfer-layer', 'text-halo-color', haloColor);
    }

    if (map.getLayer('stops-label-selected')) {
        map.setPaintProperty('stops-label-selected', 'text-opacity', opacityExpr);
        map.setPaintProperty('stops-label-selected', 'text-color', labelColor);
        map.setPaintProperty('stops-label-selected', 'text-halo-color', haloColor);
    }

    if (map.getLayer('stops-highlight')) {
        map.setPaintProperty('stops-highlight', 'icon-opacity', 1.0);
    }
}

export function addMetroHoverLogic(map, filterManager) {
    if (!map.getLayer('metro-layer-circle')) return;

    let hoveredStateId = null;
    const targets = ['metro-layer-circle', 'metro-layer-overlay', 'metro-layer-label', 'metro-transfer-layer'];

    map.on('mouseenter', targets, (e) => {
        // Disable Metro Hover if Filter is Active (Metro is not "reachable")
        if (filterManager && (filterManager.state.active || filterManager.state.picking)) return;

        map.getCanvas().style.cursor = 'pointer';
        if (e.features.length > 0) {

            if (hoveredStateId !== null) {
                map.setFeatureState(
                    { source: 'metro-stops', id: hoveredStateId },
                    { hover: false }
                );
            }
            hoveredStateId = e.features[0].id; // Use implicit ID for consistency
            map.setFeatureState(
                { source: 'metro-stops', id: hoveredStateId },
                { hover: true }
            );
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
    const { ALL_STOP_LAYERS, setFilterOpacity, filterManager } = context;

    map.on('mousemove', ALL_STOP_LAYERS, (e) => {
        if (window.ignoreMapClicks || window.isPickModeActive) return;

        // Filter out unreachable stops if Filter is Active
        let features = e.features;
        if (filterManager && (filterManager.state.active || filterManager.state.picking)) {
            const reachable = filterManager.state.reachableStopIds;
            // Filter features to what's relevant
            features = features.filter(f => {
                const id = f.properties.id;
                // Keep Origin, Reachable, or Target (though targets are usually reachable)
                return id === filterManager.state.originId || reachable.has(id);
            });

            // Dedupe by stop ID (same stop can appear in multiple layers)
            const seenIds = new Set();
            features = features.filter(f => {
                if (seenIds.has(f.properties.id)) return false;
                seenIds.add(f.properties.id);
                return true;
            });

            if (features.length === 0) {
                map.getCanvas().style.cursor = '';
                // Clear any pending leave timeout
                if (hoverTimeout) clearTimeout(hoverTimeout);
                // Delay clearing to avoid flicker when moving between stops
                hoverTimeout = setTimeout(() => {
                    const { updateConnectionLine } = context;
                    if (updateConnectionLine && filterManager.state.picking) {
                        updateConnectionLine(filterManager.state.originId, filterManager.state.targetIds, false);
                    }
                    if (setFilterOpacity) setFilterOpacity(false);
                    lastHoveredStopId = null;
                }, 100);
                return;
            }

            // Sort by proximity
            const sorted = proximitySort(features, e.point);
            const selectedFeature = sorted ? sorted[0] : null;

            if (selectedFeature) {
                const { updateConnectionLine } = context;
                if (updateConnectionLine && filterManager.state.picking) {
                    // Show preview line to this stop
                    updateConnectionLine(filterManager.state.originId, filterManager.state.targetIds, true, selectedFeature.properties.id);
                }
            }

            // Continue to standard hover effects...
        }

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
    });

    map.on('mouseleave', ALL_STOP_LAYERS, () => {
        map.getCanvas().style.cursor = '';
        if (hoverTimeout) clearTimeout(hoverTimeout);
        hoverTimeout = setTimeout(() => {
            lastHoveredStopId = null;
            updateStopHoverEffects(null);
            if (setFilterOpacity) setFilterOpacity(false);
        }, 50);
    });

    // Broad Pointer cursor for POIs
    map.on('mousemove', (e) => {
        if (window.ignoreMapClicks || window.isPickModeActive) return;

        const features = map.queryRenderedFeatures(e.point);
        const hasClickableFeature = features.some(f => {
            const layerId = f.layer ? f.layer.id : '';
            const isTransport = ALL_STOP_LAYERS.includes(layerId) ||
                layerId.startsWith('metro-') ||
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

export function setupClickHandlers(context) {
    const { ALL_STOP_LAYERS, filterManager, showStopInfo, applyFilter } = context;

    map.on('click', ALL_STOP_LAYERS, (e) => {
        if (window.ignoreMapClicks) return;

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
            applyFilter(stop.id);
        } else {
            // Normal selection
            showStopInfo(stop, true, true);
        }
    });

    // Broad POI Interactivity
    map.on('click', (e) => {
        if (window.ignoreMapClicks) return;

        const features = map.queryRenderedFeatures(e.point);
        if (!features || features.length === 0) return;

        const isTransport = features.some(f => {
            const layerId = f.layer ? f.layer.id : '';
            return ALL_STOP_LAYERS.includes(layerId) ||
                layerId.startsWith('metro-') ||
                layerId.startsWith('stops-');
        });
        if (isTransport) return;

        const poi = features.find(f => {
            const layerId = f.layer ? f.layer.id : '';
            const props = f.properties;
            const hasName = props.name || props.name_en;
            const isMapboxNative = layerId.includes('label') || layerId.includes('symbol');
            return hasName && isMapboxNative;
        });

        if (poi) {
            const name = poi.properties.name || poi.properties.name_en;
            const category = poi.properties.category || poi.properties.class || 'Location';
            const displayCat = category.charAt(0).toUpperCase() + category.slice(1).replace(/_/g, ' ');

            new mapboxgl.Popup({ closeButton: false, offset: 10, maxWidth: '200px' })
                .setLngLat(e.lngLat)
                .setHTML(`
                    <div style="padding: 2px 4px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
                        <div style="font-weight: 700; font-size: 14px; margin-bottom: 2px; color: #111; line-height: 1.2;">${name}</div>
                        <div style="font-size: 11px; color: #666; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 500;">${displayCat}</div>
                    </div>
                `)
                .addTo(map);
        }
    });
}
