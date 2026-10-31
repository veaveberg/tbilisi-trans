import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import { getBasemapOptions } from '../src/map-basemap.js';
export function createChangeMap(container, message, language, center) {
    const token = (import.meta.env.VITE_MAPBOX_TOKEN || '').trim();
    if (!token) throw new Error('The map is unavailable because the map access token is not configured.');
    mapboxgl.accessToken = token;
    if (typeof mapboxgl.setTelemetryEnabled === 'function') mapboxgl.setTelemetryEnabled(false);
    let theme = 'system', showPoi = true;
    try { theme = localStorage.getItem('theme') || 'system'; showPoi = localStorage.getItem('showPoiLabels') !== 'false'; } catch { /* Use map defaults. */ }
    const dark = theme === 'dark' || theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches;
    const map = new mapboxgl.Map({ container, ...getBasemapOptions({ language: language === 'ka' ? ['ka', 'en'] : 'en', lightPreset: dark ? 'night' : 'day', showPointOfInterestLabels: showPoi }), center, zoom: 12, attributionControl: true });
    let popup;
    let lightPreset = dark ? 'night' : 'day';
    const applyAppearance = () => map.setConfigProperty('basemap', 'lightPreset', lightPreset);
    const appearanceChanged = event => {
        lightPreset = event.detail.lightPreset;
        if (map.isStyleLoaded()) applyAppearance();
    };
    window.addEventListener('themeChanged', appearanceChanged);
    map.on('load', applyAppearance);
    const resize = new ResizeObserver(() => map.resize()); resize.observe(container);
    map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), 'top-right');
    map.on('error', event => {
        if (event.error?.status === 401 || event.error?.status === 403) message.textContent = 'The map could not load. Check the map access token or its allowed origins.';
    });
    return {
        map,
        fit(coordinates, maxZoom = 16) {
            if (!coordinates.length) return;
            const bounds = new mapboxgl.LngLatBounds();
            for (const point of coordinates) bounds.extend(point);
            map.fitBounds(bounds, { padding: 45, maxZoom, duration: 0 });
        },
        showPopup(coordinates, content) { popup?.remove(); popup = new mapboxgl.Popup({ maxWidth: '300px' }).setLngLat(coordinates).setDOMContent(content).addTo(map); },
        destroy() { window.removeEventListener('themeChanged', appearanceChanged); resize.disconnect(); popup?.remove(); map.remove(); }
    };
}
