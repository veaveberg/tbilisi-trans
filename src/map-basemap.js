// Shared by the transit map and the data-history map. Transit overlays are
// owned by each caller, so the history map never loads regular stop markers.
export const BASEMAP_STYLE = 'mapbox://styles/mapbox/standard';
export function getBasemapOptions({ language = 'en', lightPreset = 'day', showPointOfInterestLabels = true } = {}) {
    return {
        style: BASEMAP_STYLE,
        language,
        localFontFamily: 'Roboto, Inter, Arial, "Helvetica Neue", Helvetica, sans-serif',
        config: { basemap: {
            font: 'Open Sans', lightPreset, show3dObjects: false,
            showPointOfInterestLabels, showTransitLabels: false
        } }
    };
}
