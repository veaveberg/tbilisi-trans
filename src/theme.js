export class ThemeManager {
    constructor(map) {
        this.map = map;
        this.theme = localStorage.getItem('theme') || 'system';
        this.systemPrefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;

        // Listen for system changes
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', e => {
            this.systemPrefersDark = e.matches;
            if (this.theme === 'system') {
                this.applyTheme();
            }
        });
    }

    setTheme(theme) {
        this.theme = theme;
        localStorage.setItem('theme', theme);
        this.applyTheme();
    }

    getEffectiveTheme() {
        if (this.theme === 'system') {
            return this.systemPrefersDark ? 'dark' : 'light';
        }
        return this.theme;
    }

    applyTheme() {
        const effectiveTheme = this.getEffectiveTheme();
        const root = document.documentElement; // Now targeting HTML for consistency with head script

        // 1. Apply CSS Class & Meta
        if (effectiveTheme === 'dark') {
            root.classList.add('dark-mode');
            root.style.backgroundColor = '#000000';
            document.body.classList.add('dark-mode'); // Keep body class just in case of legacy usage
        } else {
            root.classList.remove('dark-mode');
            root.style.backgroundColor = '#ffffff';
            document.body.classList.remove('dark-mode');
        }

        // 2. Update Mapbox Style - Using Mapbox Standard
        // We now always use 'standard' but change the configuration (lightPreset)
        const targetStyle = 'mapbox://styles/mapbox/standard';
        const lightPreset = effectiveTheme === 'dark' ? 'night' : 'day';

        // Check if map is ready and style differs
        // Note: map.getStyle().sprite can give a hint, or we just track it.
        // We'll assume the main.js logic will handle the "is it already loaded" check 
        // if we dispatch an event, OR we can do it here if we have map access.

        // Dispatch Event for Main.js to handle Map Logic (Decoupling)
        const event = new CustomEvent('themeChanged', {
            detail: { theme: effectiveTheme, style: targetStyle, lightPreset: lightPreset }
        });
        window.dispatchEvent(event);
    }

    init() {
        this.applyTheme();
    }
}
