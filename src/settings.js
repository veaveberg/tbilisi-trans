import { onApiStatusChange, getApiStatusColor } from './api.js';

export const settings = {
    simplifyNumbers: false,
    showMinibuses: true,
    showRustaviBuses: true
};

// Start logic
export function shouldShowRoute(routeShortName, route = null) {
    const s = String(routeShortName);

    // 1. Minibus Filter
    if (!settings.showMinibuses) {
        if (s.startsWith('4') || s.startsWith('5')) {
            if (s.length === 3) return false;
        }
        // Also check if ID starts with minibusR
        if (route && route.id && route.id.startsWith('minibusR')) return false;
    }

    // 2. Rustavi Filter
    if (!settings.showRustaviBuses) {
        // Rustavi identification: _source is 'rustavi' or id starts with 'r'
        if (route) {
            if (route._source === 'rustavi' || (route.id && route.id.startsWith('r'))) return false;
        }
    }

    return true;
}

// Stateless helper functions
export function simplifyNumber(numStr) {
    if (!numStr) return numStr;
    const s = String(numStr);

    // Check state from the exported object (which acts as singleton state)
    if (!settings.simplifyNumbers) return s;

    // RULE 1: Do not touch 300
    if (s === '300') return s;

    // RULE 2: Only simplify 3xx series (implied by "keep 4xx/5xx suffixes" meaning prefixes)

    // Remove 30 prefix if length > 2 (e.g. 301 -> 1)
    if (s.length > 2 && s.startsWith('30')) {
        return s.slice(2);
    }
    // Remove 3 prefix if length > 1 (e.g. 315 -> 15)
    else if (s.length > 1 && s.startsWith('3')) {
        return s.slice(1);
    }

    return s;
}

export function initSettings({ onUpdate }) {
    const menuBtn = document.getElementById('menu-btn');
    const menuPopup = document.getElementById('map-menu-popup');
    const simplifySwitch = document.getElementById('simplify-switch');

    // Toggle Menu
    if (menuBtn && menuPopup) {
        menuBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            menuPopup.classList.toggle('hidden');
        });

        // Close when clicking outside
        document.addEventListener('click', (e) => {
            if (!menuPopup.classList.contains('hidden')) {
                // If click is NOT inside menu and NOT inside button
                if (!menuPopup.contains(e.target) && !menuBtn.contains(e.target)) {
                    menuPopup.classList.add('hidden');
                }
            }
        });
    }

    // Simplify Numbers Switch
    if (simplifySwitch) {
        // Load State
        if (localStorage.getItem('simplifyNumbers') === 'true') {
            settings.simplifyNumbers = true;
            simplifySwitch.checked = true;
        }

        simplifySwitch.addEventListener('change', (e) => {
            settings.simplifyNumbers = e.target.checked;
            localStorage.setItem('simplifyNumbers', settings.simplifyNumbers);

            // Trigger Callback
            if (onUpdate) onUpdate();
        });

        // Row Click Handler (Better UX)
        const row = document.getElementById('menu-simplify-toggle-row');
        if (row) {
            row.addEventListener('click', (e) => {
                // If click originated from the switch/label itself, let native behavior handle it
                if (e.target.closest('.toggle-switch')) return;

                // Otherwise, toggle it manually (e.g. clicking the text)
                simplifySwitch.checked = !simplifySwitch.checked;
                simplifySwitch.dispatchEvent(new Event('change'));
            });
        }
    }

    // Show Minibuses Switch
    const minibusesSwitch = document.getElementById('minibus-switch');
    if (minibusesSwitch) {
        // Load State (Default True if not set)
        const stored = localStorage.getItem('showMinibuses');
        // If null, default to true. If 'false', set false.
        if (stored === 'false') {
            settings.showMinibuses = false;
            minibusesSwitch.checked = false;
        } else {
            settings.showMinibuses = true;
            minibusesSwitch.checked = true;
        }

        minibusesSwitch.addEventListener('change', (e) => {
            settings.showMinibuses = e.target.checked;
            localStorage.setItem('showMinibuses', settings.showMinibuses);
            if (onUpdate) onUpdate();
        });

        const row = document.getElementById('menu-minibus-toggle-row');
        if (row) {
            row.addEventListener('click', (e) => {
                if (e.target.closest('.toggle-switch')) return;
                minibusesSwitch.checked = !minibusesSwitch.checked;
                minibusesSwitch.dispatchEvent(new Event('change'));
            });
        }
    }

    // Show Rustavi Buses Switch
    const rustaviSwitch = document.getElementById('rustavi-switch');
    if (rustaviSwitch) {
        const stored = localStorage.getItem('showRustaviBuses');
        if (stored === 'false') {
            settings.showRustaviBuses = false;
            rustaviSwitch.checked = false;
        } else {
            settings.showRustaviBuses = true;
            rustaviSwitch.checked = true;
        }

        rustaviSwitch.addEventListener('change', (e) => {
            settings.showRustaviBuses = e.target.checked;
            localStorage.setItem('showRustaviBuses', settings.showRustaviBuses);
            if (onUpdate) onUpdate();
        });

        const row = document.getElementById('menu-rustavi-toggle-row');
        if (row) {
            row.addEventListener('click', (e) => {
                if (e.target.closest('.toggle-switch')) return;
                rustaviSwitch.checked = !rustaviSwitch.checked;
                rustaviSwitch.dispatchEvent(new Event('change'));
            });
        }
    }

    // --- Dark Mode Switch ---
    // Inject or bind existing markup. Since we need to update HTML likely,
    // I will dynamically append it if not present, OR assume user manually added it?
    // Better to inject it for this task, as I can't see index.html easily to edit it reliably without full read.
    // Let's create the element dynamically in initSettings to be safe.

    // Actually, I should probably check if index.html has it. 
    // Given the constraints, I'll append a new row to the menu programmatically.

    addDarkModeToggle();

    // Online Status Indicator
    initOnlineStatus();
}

function addDarkModeToggle() {
    const menuPopup = document.getElementById('map-menu-popup');
    if (!menuPopup) return;

    // Check if already exists
    if (document.getElementById('theme-switch-row')) return;

    const row = document.createElement('div');
    row.id = 'theme-switch-row';
    row.className = 'menu-row';
    row.style.cssText = 'padding: 6px 8px; display: flex; align-items: center; justify-content: space-between; cursor: pointer;';

    // Use stored theme or system default logic
    const currentTheme = localStorage.getItem('theme') || 'system';

    row.innerHTML = `
        <div style="display:flex; align-items:center; gap:12px;">
            <span style="font-weight:500; font-size:14px; color:var(--text-main);">Theme</span>
        </div>
        <div class="theme-segmented-control">
            <div class="theme-option" data-value="system">Auto</div>
            <div class="theme-option" data-value="light">Light</div>
            <div class="theme-option" data-value="dark">Dark</div>
        </div>
    `;

    menuPopup.appendChild(row);

    // Logic for Segmented Control
    const options = row.querySelectorAll('.theme-option');

    function updateActiveState(theme) {
        options.forEach(opt => {
            if (opt.dataset.value === theme) {
                opt.classList.add('active');
            } else {
                opt.classList.remove('active');
            }
        });
    }

    // Initial State
    updateActiveState(currentTheme);

    // Event Listeners
    options.forEach(opt => {
        opt.addEventListener('click', (e) => {
            e.stopPropagation(); // Prevent menu close? Or row click? Row has generic handler?
            // Row has no click handler in addDarkModeToggle currently, but we attached one for other rows.
            // Wait, this function creates the row.

            const newTheme = opt.dataset.value;
            updateActiveState(newTheme);

            localStorage.setItem('theme', newTheme);
            window.dispatchEvent(new CustomEvent('manualThemeChange', { detail: newTheme }));
        });
    });
}

function initOnlineStatus() {
    const statusRow = document.createElement('div');
    statusRow.className = 'menu-row';
    statusRow.style.display = 'flex';
    statusRow.style.alignItems = 'center'; // Vertical Center
    statusRow.style.justifyContent = 'space-between';
    statusRow.style.padding = '12px 16px';
    statusRow.style.borderTop = '1px solid var(--border-light)';
    const label = import.meta.env.VITE_BUILD_DATE || 'Status';

    statusRow.innerHTML = `
        <span style="font-size:11px; font-weight:600; color:#9ca3af; text-transform:uppercase; letter-spacing:0.5px;">${label}</span>
        
        <div style="font-family:ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size:13px; color:#374151; display:flex; align-items:center; gap:16px;">
            <span style="display:flex; align-items:center; gap:6px;">
                APP <span id="status-app-dot" style="width:10px; height:10px; border-radius:50%; background-color:#ccc; display:inline-block;"></span>
            </span>
            <span style="display:flex; align-items:center; gap:6px;">
                API <span id="status-api-dot" style="width:10px; height:10px; border-radius:50%; background-color:#ccc; display:inline-block;"></span>
            </span>
        </div>
    `;

    // Insert as last item in menu
    const menuPopup = document.getElementById('map-menu-popup');
    if (menuPopup) {
        menuPopup.appendChild(statusRow);
    }

    // Status Logic
    const appDot = statusRow.querySelector('#status-app-dot');
    const apiDot = statusRow.querySelector('#status-api-dot');

    function updateAppStatus() {
        const isOnline = navigator.onLine;
        // Saturated Colors (Green-600 / Red-600)
        appDot.style.backgroundColor = isOnline ? '#16a34a' : '#dc2626';
        appDot.title = isOnline ? 'App Online' : 'App Offline';
    }

    function updateApiStatus(status) {
        const colorMap = {
            'green': '#16a34a', // Saturated Green
            'yellow': '#ca8a04',
            'red': '#dc2626'
        };
        const colorName = getApiStatusColor(status.code || 0);
        apiDot.style.backgroundColor = colorMap[colorName] || '#ca8a04';
        apiDot.title = `API: ${status.text || 'Unknown'} (${status.code})`;
    }

    window.addEventListener('online', updateAppStatus);
    window.addEventListener('offline', updateAppStatus);

    // Subscribe to API updates
    onApiStatusChange(updateApiStatus);

    updateAppStatus();
}

