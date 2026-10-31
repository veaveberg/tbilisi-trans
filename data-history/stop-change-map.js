import { createChangeMap } from './change-map.js';
import { CHANGE_COLORS, stopChangeFeatures } from './stop-change-features.js';

export function mountStopChangeMap(container, message, changes, language, selectStop) {
    const features = stopChangeFeatures(changes);
    if (!features.points.features.length) { container.hidden = true; message.textContent = 'Locations are not available for these changes.'; return { destroy() {} }; }
    const view = createChangeMap(container, message, language, features.points.features[0].geometry.coordinates);
    const { map } = view;
    view.fit(features.points.features.map(feature => feature.geometry.coordinates));
    message.textContent = `Showing ${changes.length - features.unavailable} changed stops${features.unavailable ? `; ${features.unavailable} without recorded locations` : ''}. Black markers show previous locations.`;
    const color = ['match', ['get', 'status'], 'added', CHANGE_COLORS.added, 'removed', CHANGE_COLORS.removed, CHANGE_COLORS.modified];
    map.on('load', () => {
        map.addSource('stop-changes', { type: 'geojson', data: features.points });
        map.addSource('stop-moves', { type: 'geojson', data: features.moves });
        map.addLayer({ id: 'stop-moves', type: 'line', source: 'stop-moves', slot: 'top', paint: { 'line-color': CHANGE_COLORS.modified, 'line-emissive-strength': 1, 'line-width': 2, 'line-dasharray': [2, 2] } });
        map.addLayer({ id: 'changed-stops', type: 'circle', source: 'stop-changes', slot: 'top', paint: {
            'circle-radius': ['case', ['get', 'previous'], 5, 8],
            'circle-color': ['case', ['get', 'previous'], '#000000', color],
            'circle-stroke-color': ['case', ['get', 'previous'], CHANGE_COLORS.modified, '#ffffff'], 'circle-stroke-width': 2, 'circle-emissive-strength': 1
        } });
        map.on('mouseenter', 'changed-stops', () => { map.getCanvas().style.cursor = 'pointer'; });
        map.on('mouseleave', 'changed-stops', () => { map.getCanvas().style.cursor = ''; });
        map.on('click', 'changed-stops', event => {
            const feature = event.features[0], change = changes.find(change => change.id === feature.properties.id);
            if (!change) return;
            const content = document.createElement('div');
            const previousLocation = feature.properties.previous === true || feature.properties.previous === 'true';
            const title = document.createElement('strong'); title.textContent = feature.properties.name || change.label; content.append(title);
            const detail = document.createElement('p'); detail.textContent = `${change.status[0].toUpperCase()}${change.status.slice(1)}${previousLocation ? ' · Previous location' : ''}`; content.append(detail);
            const routes = change.status === 'removed' || previousLocation ? change.context?.routesBefore : change.context?.routesAfter;
            if (routes?.length) { const row = document.createElement('p'); row.textContent = `Served by ${routes.map(route => route.shortName).join(', ')}`; content.append(row); }
            const button = document.createElement('button'); button.type = 'button'; button.textContent = 'Show change in list'; button.onclick = () => selectStop(change.id); content.append(button);
            view.showPopup(feature.geometry.coordinates, content);
        });
    });
    return { destroy() { view.destroy(); } };
}
