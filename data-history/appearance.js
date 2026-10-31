import { ThemeManager } from '../src/theme.js';

const appearance = new ThemeManager(null);
appearance.init();
// Match appearance changes made in another app tab, including returning here
// through browser navigation after changing Settings.
function syncAppearance() {
    appearance.theme = localStorage.getItem('theme') || 'system';
    appearance.systemPrefersDark = matchMedia('(prefers-color-scheme: dark)').matches;
    appearance.applyTheme();
}
window.addEventListener('storage', event => { if (event.key === 'theme' || event.key === null) syncAppearance(); });
window.addEventListener('pageshow', syncAppearance);
