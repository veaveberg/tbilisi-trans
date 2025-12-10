export const settings = {
    simplifyNumbers: false,
    showMinibuses: true
};

// Start logic
export function shouldShowRoute(routeShortName) {
    if (settings.showMinibuses) return true;
    if (!routeShortName) return true;
    const s = String(routeShortName);
    // Hide 4xx and 5xx if setting is false
    if (s.startsWith('4') || s.startsWith('5')) {
        // Confirm length? 400-599. Usually 3 digits.
        if (s.length === 3) return false;
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

        // Row Click Handler
        const row = document.getElementById('menu-minibus-toggle-row');
        if (row) {
            row.addEventListener('click', (e) => {
                if (e.target.closest('.toggle-switch')) return;
                minibusesSwitch.checked = !minibusesSwitch.checked;
                minibusesSwitch.dispatchEvent(new Event('change'));
            });
        }
    }
}
