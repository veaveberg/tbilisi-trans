import { metroRoutePaths } from './metro-route-paths.js';
import { ROUTE_LINE_LAYOUT, ROUTE_LINE_PAINT, ROUTE_STOP_PAINT } from '../src/route-map-style.js';
import { createChangeMap } from './change-map.js';
import { CHANGE_COLORS } from './stop-change-features.js';
import { routeChangeFeatures } from './route-change-features.js';
import { GEOMETRY_TOLERANCE_METERS } from './route-geometry-diff.js';
const cache = new Map();
export async function mountRouteChangeMap(container, message, changes, language, selectRoute, filename, signal) {
    if (!filename) { container.hidden = true; message.textContent = 'Route paths are not available for this saved update.'; return { destroy() {} }; }
    const paths = {};
    for (const file of Array.isArray(filename) ? filename : [filename]) {
        let saved = cache.get(file);
        if (!saved) {
            const response = await fetch(file, { signal, cache: 'no-store' });
            if (!response.ok) throw new Error('Saved route paths could not be loaded. Reload the page to try again.');
            saved = await response.json(); cache.set(file, saved);
        }
        for (const [id, route] of Object.entries(saved)) {
            if (!paths[id]) paths[id] = structuredClone(route);
            else {
                paths[id].after = route.after;
                paths[id].routeStops = route.routeStops;
                for (const language of ['en', 'ka']) {
                    paths[id].stops ||= {};
                    const stops = paths[id].stops[language] ||= { added: [], removed: [] };
                    stops.moved ||= [];
                    for (const move of route.stops?.[language]?.moved || []) {
                        const earlier = stops.moved.find(stop => stop.id === move.id);
                        if (earlier) earlier.after = move.after;
                        else stops.moved.push(structuredClone(move));
                    }
                    for (const status of ['added', 'removed']) for (const stop of route.stops?.[language]?.[status] || []) {
                        const opposite = status === 'added' ? 'removed' : 'added';
                        const index = stops[opposite].findIndex(item => item.id === stop.id);
                        if (index >= 0) stops[opposite].splice(index, 1);
                        else if (!stops[status].some(item => item.id === stop.id)) stops[status].push(stop);
                    }
                }
            }
        }
    }
    if (signal.aborted || !container.isConnected) throw new DOMException('Map closed', 'AbortError');
    const collection = routeChangeFeatures(changes, paths, language);
    const metroChanges = changes.filter(change => ['SUBWAY', 'METRO'].includes(change.context?.route?.mode));
    if (metroChanges.length) {
        const base = import.meta.env.BASE_URL;
        const [segments, midpoints] = await Promise.all(['metro_segments.json', 'metro_midpoints.json'].map(async file => {
            const response = await fetch(`${base}data/${file}`, { signal });
            if (!response.ok) throw new Error('The app’s metro paths could not be loaded.');
            return response.json();
        }));
        const metroIds = new Set(metroChanges.map(change => change.id));
        const schematic = metroChanges.map(change => metroRoutePaths(change, segments, midpoints));
        collection.features = [...collection.features.filter(feature => !metroIds.has(feature.properties.id)), ...schematic.flatMap(line => line.features)];
        collection.routeStops.features = [...collection.routeStops.features.filter(feature => !metroIds.has(feature.properties.id)), ...schematic.flatMap(line => line.stops)];
        collection.unavailable = collection.unavailable.filter(id => !schematic.some(line => line.features.some(feature => feature.properties.id === id)));
    }
    if (signal.aborted || !container.isConnected) throw new DOMException('Map closed', 'AbortError');
    const first = collection.features[0]?.geometry.coordinates[0] || collection.stops.features[0]?.geometry.coordinates;
    if (!first) { container.hidden = true; message.textContent = 'No recorded route paths or changed stop locations are available.'; return { destroy() {} }; }
    const view = createChangeMap(container, message, language, first), { map } = view;
    let selected = '', ready = false, includeStopBounds = false;
    const color = ['match', ['get', 'status'], 'added', CHANGE_COLORS.added, 'removed', CHANGE_COLORS.removed, CHANGE_COLORS.modified];
    function focus(id = '', includeAllStops = false) {
        selected = id;
        includeStopBounds = includeAllStops;
        const filter = features => features.filter(feature => !id || feature.properties.id === id);
        const features = filter(collection.features), highlights = filter(collection.highlights.features), stops = filter(collection.stops.features);
        if (ready) for (const [source, data] of [['route-changes', features], ['geometry-changes', highlights], ['route-stop-changes', stops], ['route-stop-moves', filter(collection.moves.features)], ['route-all-stops', filter(collection.routeStops.features)]]) map.getSource(source).setData({ type: 'FeatureCollection', features: data });
        const lineCoordinates = features.flatMap(feature => feature.geometry.coordinates);
        view.fit(lineCoordinates.length && !includeAllStops ? lineCoordinates : [...lineCoordinates, ...stops.map(feature => feature.geometry.coordinates)], 15);
        const extent = lineCoordinates.reduce((bounds, point) => [Math.min(bounds[0], point[0]), Math.min(bounds[1], point[1]), Math.max(bounds[2], point[0]), Math.max(bounds[3], point[1])], [Infinity, Infinity, -Infinity, -Infinity]);
        const outside = !includeAllStops && lineCoordinates.length && stops.some(({ geometry: { coordinates: [lon, lat] } }) => lon < extent[0] || lat < extent[1] || lon > extent[2] || lat > extent[3]);
        const count = new Set([...features, ...stops].map(feature => feature.properties.id)).size;
        message.textContent = count ? `Showing ${count} changed ${count === 1 ? 'route' : 'routes'}. Green/red highlight added/removed stops and path sections. Blue stop markers joined by dashed lines show previous and updated stop locations; black markers show the previous location. Red dashes show removed path sections; route colors show retained alignment. Geometry shifts under ${GEOMETRY_TOLERANCE_METERS} m are not highlighted.${outside ? ' Some changed stops lie beyond the route paths; Fit all changes includes them.' : ''}${!id && collection.unavailable.length ? ` ${collection.unavailable.length} routes have no recorded geometry.` : ''}` : 'The selected route has no recorded geometry or changed stop locations.';
    }
    function interaction(layer, kind) {
        map.on('mouseenter', layer, () => { map.getCanvas().style.cursor = 'pointer'; });
        map.on('mouseleave', layer, () => { map.getCanvas().style.cursor = ''; });
        map.on('click', layer, event => {
            const feature = event.features[0], change = changes.find(change => change.id === feature.properties.id);
            if (!change) return;
            const content = document.createElement('div'), title = document.createElement('strong'); title.textContent = change.label; content.append(title);
            const text = document.createElement('p');
            text.textContent = kind === 'stop' ? `${feature.properties.status === 'modified' ? (feature.properties.previous ? 'Previous stop location' : 'Updated stop location') : feature.properties.status === 'added' ? 'Added stop' : 'Removed stop'}: ${feature.properties.stopName}` : kind === 'highlight' ? `${feature.properties.status === 'added' ? 'Added' : 'Removed'} path section` : `${feature.properties.previous ? 'Previous path' : change.status === 'removed' ? 'Removed route' : 'Updated path'} · ${feature.properties.pattern}`;
            content.append(text);
            const description = document.createElement('p'); description.textContent = change.context.description; content.append(description);
            const button = document.createElement('button'); button.textContent = 'Show change in list'; button.type = 'button'; button.onclick = () => selectRoute(change.id); content.append(button);
            view.showPopup(kind === 'stop' ? feature.geometry.coordinates : event.lngLat, content);
        });
    }
    map.on('load', () => {
        for (const source of ['route-changes', 'geometry-changes', 'route-stop-changes', 'route-stop-moves', 'route-all-stops']) map.addSource(source, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
        // The diff already draws removed path sections. Drawing the entire
        // previous path as well produces a second color underneath its dashes.
        map.addLayer({ id: 'updated-routes', type: 'line', source: 'route-changes', slot: 'top', filter: ['==', ['get', 'previous'], false], layout: { ...ROUTE_LINE_LAYOUT }, paint: { ...ROUTE_LINE_PAINT, 'line-color': ['match', ['get', 'status'], 'added', CHANGE_COLORS.added, 'removed', CHANGE_COLORS.removed, ['coalesce', ['get', 'routeColor'], '#2563eb']] } });
        interaction('updated-routes', 'path');
        for (const status of ['removed', 'added']) {
            const layer = `geometry-${status}`;
            map.addLayer({ id: layer, type: 'line', source: 'geometry-changes', slot: 'top', filter: ['==', ['get', 'status'], status], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { ...ROUTE_LINE_PAINT, 'line-color': CHANGE_COLORS[status], ...(status === 'removed' ? { 'line-dasharray': [2, 2] } : {}) } });
            interaction(layer, 'highlight');
        }
        map.addLayer({ id: 'route-stop-dots', type: 'circle', source: 'route-all-stops', slot: 'top', paint: { ...ROUTE_STOP_PAINT } });
        map.addLayer({ id: 'moved-route-stop-links', type: 'line', source: 'route-stop-moves', slot: 'top', paint: { 'line-color': CHANGE_COLORS.modified, 'line-width': 3, 'line-dasharray': [2, 2], 'line-emissive-strength': 1 } });
        map.addLayer({ id: 'changed-route-stops', type: 'circle', source: 'route-stop-changes', slot: 'top', paint: { 'circle-radius': ['case', ['==', ['get', 'previous'], true], 5, 7], 'circle-opacity': 1, 'circle-color': ['case', ['==', ['get', 'previous'], true], '#000000', color], 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2, 'circle-emissive-strength': 1 } });
        interaction('changed-route-stops', 'stop');
        ready = true; focus(selected, includeStopBounds);
    });
    focus();
    return { focus, hasMovedStops: collection.moves.features.length > 0, fitMoves() { const moves = collection.moves.features.filter(feature => !selected || feature.properties.id === selected); if (moves.length) view.fit(moves.flatMap(feature => feature.geometry.coordinates), 18); }, fitAll() { focus(selected, true); }, fitRoute() { focus(selected); }, destroy() { view.destroy(); } };
}
