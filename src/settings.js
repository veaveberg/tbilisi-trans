import { onApiStatusChange, getApiStatusColor } from './api.js';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { favoritesManager } from './favorites.js';

export const settings = {
    simplifyNumbers: false,
    showMinibuses: true,
    showRustaviBuses: true,
    showPoiLabels: false,
    pageScale: 1.0
};

let onUpdateCallback = null;
let nativeSettingsInitialized = false;
let privacyPolicySheetInitialized = false;
let lastFocusedBeforePrivacySheet = null;
let privacyPolicyPreviousUrl = null;

const NativeSettingsPlugin = registerPlugin('NativeSettings');

function isNativeSettingsAvailable() {
    if (typeof Capacitor === 'undefined') return false;
    if (typeof Capacitor.isNativePlatform === 'function' && !Capacitor.isNativePlatform()) return false;
    if (typeof Capacitor.isPluginAvailable === 'function') {
        return Capacitor.isPluginAvailable('NativeSettings');
    }
    return typeof window !== 'undefined' &&
        window.Capacitor &&
        window.Capacitor.Plugins &&
        window.Capacitor.Plugins.NativeSettings;
}

function getNativeSettingsPlugin() {
    if (!isNativeSettingsAvailable()) return null;
    return NativeSettingsPlugin;
}

function getStoredBoolean(key, defaultValue) {
    const stored = localStorage.getItem(key);
    if (stored === null) return defaultValue;
    return stored === 'true';
}

function isIOSAppOnMac() {
    if (typeof navigator === 'undefined') return false;
    return navigator.userAgent.includes('Macintosh') && navigator.maxTouchPoints > 1;
}

function syncCheckbox(id, value) {
    const el = document.getElementById(id);
    if (el && typeof el.checked !== 'undefined') {
        el.checked = !!value;
    }
}

function applyNativeSetting(key, value) {
    switch (key) {
        case 'simplifyNumbers':
            settings.simplifyNumbers = !!value;
            localStorage.setItem('simplifyNumbers', settings.simplifyNumbers);
            syncCheckbox('simplify-switch', settings.simplifyNumbers);
            if (onUpdateCallback) onUpdateCallback();
            break;
        case 'showMinibuses':
            settings.showMinibuses = !!value;
            localStorage.setItem('showMinibuses', settings.showMinibuses);
            syncCheckbox('minibus-switch', settings.showMinibuses);
            if (onUpdateCallback) onUpdateCallback();
            break;
        case 'showRustaviBuses':
            settings.showRustaviBuses = !!value;
            localStorage.setItem('showRustaviBuses', settings.showRustaviBuses);
            syncCheckbox('rustavi-switch', settings.showRustaviBuses);
            if (onUpdateCallback) onUpdateCallback();
            break;
        case 'show3DBuildings':
            localStorage.setItem('show3DBuildings', !!value);
            syncCheckbox('buildings-3d-switch', !!value);
            window.dispatchEvent(new CustomEvent('map3DBuildingsChange', { detail: !!value }));
            break;
        case 'show3DTerrain':
            localStorage.setItem('show3DTerrain', !!value);
            syncCheckbox('terrain-3d-switch', !!value);
            window.dispatchEvent(new CustomEvent('map3DTerrainChange', { detail: !!value }));
            break;
        case 'exaggerateTerrain':
            localStorage.setItem('exaggerateTerrain', !!value);
            syncCheckbox('exaggerate-switch', !!value);
            window.dispatchEvent(new CustomEvent('mapExaggerateChange', { detail: !!value }));
            break;
        case 'showPoiLabels':
            settings.showPoiLabels = !!value;
            localStorage.setItem('showPoiLabels', settings.showPoiLabels);
            syncCheckbox('poi-switch', settings.showPoiLabels);
            window.dispatchEvent(new CustomEvent('mapPoiLabelsChange', { detail: settings.showPoiLabels }));
            break;
        case 'theme':
            if (typeof value === 'string' && ['system', 'light', 'dark'].includes(value)) {
                localStorage.setItem('theme', value);
                window.dispatchEvent(new CustomEvent('manualThemeChange', { detail: value }));
            }
            break;
        case 'pageScale':
            const scaleVal = parseFloat(value);
            if (!isNaN(scaleVal) && scaleVal >= 0.8 && scaleVal <= 1.5) {
                settings.pageScale = scaleVal;
                localStorage.setItem('pageScale', scaleVal);
                // On iOS, the native side handles zoom via WKWebView.pageZoom
                // Only dispatch for non-native (web) scaling
                if (!isNativeSettingsAvailable()) {
                    window.dispatchEvent(new CustomEvent('pageScaleChange', { detail: scaleVal }));
                }
            }
            break;
        case 'icloudSyncEnabled':
            localStorage.setItem('icloudSyncEnabled', !!value);
            window.dispatchEvent(new CustomEvent('iCloudSyncToggleChange', { detail: !!value }));
            break;
        case 'icloudSyncMode':
            if (value === 'merge' || value === 'replace' || value === 'pushLocal') {
                localStorage.setItem('icloudSyncMode', value);
                window.dispatchEvent(new CustomEvent('iCloudSyncModeChange', { detail: value }));
            }
            break;
        case 'favoritesAction':
            if (value === 'clearAll') {
                window.dispatchEvent(new CustomEvent('favoritesClearAllRequest'));
            } else if (typeof value === 'string' && value.startsWith('remove:')) {
                const key = value.slice('remove:'.length);
                if (key) {
                    window.dispatchEvent(new CustomEvent('favoritesRemoveKeyRequest', { detail: key }));
                }
            } else if (typeof value === 'string' && value.startsWith('open:')) {
                const key = value.slice('open:'.length);
                if (key) {
                    window.dispatchEvent(new CustomEvent('favoritesOpenKeyRequest', { detail: key }));
                }
            } else if (typeof value === 'string' && value.startsWith('reorderStops:')) {
                const payload = value.slice('reorderStops:'.length);
                const keys = payload ? payload.split('|').filter(Boolean) : [];
                window.dispatchEvent(new CustomEvent('favoritesReorderRequest', { detail: { type: 'stop', keys } }));
            } else if (typeof value === 'string' && value.startsWith('reorderRoutes:')) {
                const payload = value.slice('reorderRoutes:'.length);
                const keys = payload ? payload.split('|').filter(Boolean) : [];
                window.dispatchEvent(new CustomEvent('favoritesReorderRequest', { detail: { type: 'route', keys } }));
            } else if (value && typeof value === 'object' && value.action === 'editSubtitle') {
                const key = typeof value.key === 'string' ? value.key : '';
                const subtitle = typeof value.subtitle === 'string' ? value.subtitle : '';
                if (key) {
                    window.dispatchEvent(new CustomEvent('favoritesUpdateSubtitleRequest', { detail: { key, subtitle } }));
                }
            } else if (value && typeof value === 'object' && value.action === 'editIcon') {
                const key = typeof value.key === 'string' ? value.key : '';
                const icon = typeof value.icon === 'string' ? value.icon : '';
                if (key) {
                    window.dispatchEvent(new CustomEvent('favoritesUpdateIconRequest', { detail: { key, icon } }));
                }
            }
            break;
        default:
            break;
    }
}

function initNativeSettingsBridge() {
    if (!isNativeSettingsAvailable() || nativeSettingsInitialized) return;
    nativeSettingsInitialized = true;

    const plugin = getNativeSettingsPlugin();
    if (!plugin) return;
    plugin.addListener('settingsChanged', ({ key, value }) => {
        applyNativeSetting(key, value);
    });
    plugin.addListener('settingsClosed', ({ settings: newSettings }) => {
        if (!newSettings) return;
        Object.entries(newSettings).forEach(([key, value]) => {
            applyNativeSetting(key, value);
        });
    });

    // Apply initial zoom on iOS
    applyInitialNativeZoom();
}

async function applyInitialNativeZoom() {
    if (!isNativeSettingsAvailable()) return;

    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    const defaultScale = isMobile ? 1.25 : 1.0;
    const storedScale = localStorage.getItem('pageScale');
    let currentScale = storedScale ? parseFloat(storedScale) : defaultScale;
    if (isIOSAppOnMac()) {
        currentScale = 1.0;
        if (storedScale !== '1') {
            localStorage.setItem('pageScale', '1');
        }
    }

    try {
        const plugin = getNativeSettingsPlugin();
        if (!plugin) return;
        await plugin.setPageZoom({ zoom: currentScale });
    } catch (err) {
        console.warn('[NativeSettings] Failed to apply initial zoom via native, using CSS fallback', err);
        // CSS fallback
        applyZoomCSS(currentScale);
    }
}

function applyZoomCSS(scale) {
    const html = document.documentElement;
    const body = document.body;
    if (scale === 1) {
        html.style.transform = '';
        html.style.transformOrigin = '';
        html.style.width = '';
        html.style.height = '';
        html.style.overflow = '';
        html.style.removeProperty('--page-scale');
        html.style.removeProperty('--inv-page-scale');
        if (body) {
            body.style.width = '';
            body.style.height = '';
            body.style.overflow = '';
        }
    } else {
        const inverseScale = 1.0 / scale;
        html.style.transform = `scale(${scale})`;
        html.style.transformOrigin = 'top left';
        html.style.width = `${inverseScale * 100}%`;
        html.style.height = `${inverseScale * 100}%`;
        html.style.overflow = 'hidden';
        html.style.setProperty('--page-scale', String(scale));
        html.style.setProperty('--inv-page-scale', String(inverseScale));
        if (body) {
            body.style.width = '100%';
            body.style.height = '100%';
            body.style.overflow = 'hidden';
        }
    }
    // Trigger Mapbox resize after transform
    if (window.map && typeof window.map.resize === 'function') {
        setTimeout(() => window.map.resize(), 50);
    }
}

function getPrivacyPolicyUrl() {
    const base = import.meta.env.BASE_URL || '/';
    const normalizedBase = base.endsWith('/') ? base : `${base}/`;
    return `${normalizedBase}privacy-policy.html`;
}

function openPrivacyPolicySheet() {
    const backdrop = document.getElementById('privacy-policy-backdrop');
    const sheet = document.getElementById('privacy-policy-sheet');
    const frame = document.getElementById('privacy-policy-frame');
    const closeBtn = document.getElementById('privacy-policy-close');
    if (!backdrop || !sheet || !frame) return;

    lastFocusedBeforePrivacySheet = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    if (frame.dataset.loaded !== 'true') {
        frame.src = getPrivacyPolicyUrl();
        frame.dataset.loaded = 'true';
    }

    if (!privacyPolicyPreviousUrl) {
        privacyPolicyPreviousUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    }
    const privacyPath = getPrivacyPolicyUrl();
    if (window.location.pathname !== privacyPath) {
        history.pushState({ privacySheet: true }, '', privacyPath);
    }

    backdrop.classList.remove('hidden');
    sheet.classList.remove('hidden');
    document.body.classList.add('privacy-sheet-open');

    setTimeout(() => {
        closeBtn?.focus();
    }, 0);
}

function closePrivacyPolicySheet() {
    const backdrop = document.getElementById('privacy-policy-backdrop');
    const sheet = document.getElementById('privacy-policy-sheet');
    if (!backdrop || !sheet) return;

    backdrop.classList.add('hidden');
    sheet.classList.add('hidden');
    document.body.classList.remove('privacy-sheet-open');

    if (privacyPolicyPreviousUrl) {
        history.replaceState(null, '', privacyPolicyPreviousUrl);
        privacyPolicyPreviousUrl = null;
    }

    if (lastFocusedBeforePrivacySheet && typeof lastFocusedBeforePrivacySheet.focus === 'function') {
        lastFocusedBeforePrivacySheet.focus();
    }
}

function initPrivacyPolicySheetControls(menuPopup) {
    if (privacyPolicySheetInitialized) return;
    privacyPolicySheetInitialized = true;

    const backdrop = document.getElementById('privacy-policy-backdrop');
    const closeBtn = document.getElementById('privacy-policy-close');

    menuPopup?.addEventListener('click', (e) => {
        const trigger = e.target.closest('#menu-privacy-policy-row');
        if (!trigger) return;
        e.preventDefault();
        e.stopPropagation();
        menuPopup.classList.add('hidden');
        openPrivacyPolicySheet();
    });

    backdrop?.addEventListener('click', closePrivacyPolicySheet);
    closeBtn?.addEventListener('click', closePrivacyPolicySheet);

    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        const sheet = document.getElementById('privacy-policy-sheet');
        if (sheet && !sheet.classList.contains('hidden')) {
            closePrivacyPolicySheet();
        }
    });
}

function addPrivacyPolicyMenuItem(menuPopup) {
    if (!menuPopup || document.getElementById('menu-privacy-policy-row')) return;

    const button = document.createElement('button');
    button.id = 'menu-privacy-policy-row';
    button.type = 'button';
    button.className = 'menu-item menu-item-button menu-footer-link';
    button.textContent = 'Privacy Policy';
    menuPopup.appendChild(button);
}

async function openNativeSettings(options = {}) {
    const plugin = getNativeSettingsPlugin();
    if (!plugin) return false;
    // Load scale with mobile defaults
    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    const defaultScale = isMobile ? 1.25 : 1.0;
    const storedScale = localStorage.getItem('pageScale');
    let currentScale = storedScale ? parseFloat(storedScale) : defaultScale;
    if (isIOSAppOnMac()) {
        currentScale = 1.0;
    }

    const favoritesList = favoritesManager.getFavoritesList(300).map((item) => ({
        key: item.key,
        type: item.type,
        title: item.title || item.key,
        subtitle: item.subtitle || '',
        routeNumber: item.routeNumber || '',
        routeColor: item.routeColor || '',
        stopIcon: item.stopIcon || ''
    }));

    const payload = {
        simplifyNumbers: getStoredBoolean('simplifyNumbers', false),
        showMinibuses: getStoredBoolean('showMinibuses', true),
        showRustaviBuses: getStoredBoolean('showRustaviBuses', true),
        show3DBuildings: getStoredBoolean('show3DBuildings', false),
        show3DTerrain: getStoredBoolean('show3DTerrain', false),
        exaggerateTerrain: getStoredBoolean('exaggerateTerrain', false),
        showPoiLabels: getStoredBoolean('showPoiLabels', false),
        theme: localStorage.getItem('theme') || 'system',
        pageScale: currentScale,
        icloudSyncEnabled: getStoredBoolean('icloudSyncEnabled', true),
        favoritesList
    };

    try {
        if (options.openFavoritesMenu && typeof plugin.openFavoritesMenu === 'function') {
            await plugin.openFavoritesMenu({ settings: payload });
        } else {
            await plugin.open({ settings: payload });
        }
        return true;
    } catch (err) {
        console.warn('[NativeSettings] Failed to open', err);
        return false;
    }
}

export async function openNativeFavoritesMenu() {
    return openNativeSettings({ openFavoritesMenu: true });
}

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
    onUpdateCallback = onUpdate;
    initNativeSettingsBridge();
    const menuBtn = document.getElementById('menu-btn');
    const menuPopup = document.getElementById('map-menu-popup');
    const simplifySwitch = document.getElementById('simplify-switch');
    initPrivacyPolicySheetControls(menuPopup);

    // Toggle Menu
    if (menuBtn && menuPopup) {
        menuBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (isNativeSettingsAvailable()) {
                menuPopup.classList.add('hidden');
                openNativeSettings();
                return;
            }
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

    addMapSection();
    addInterfaceSection();
    init3DToggleButton();

    // Online Status Indicator
    initOnlineStatus();

    // Dev Tools Section (Local Only)
    initDevSettings();

    // Keep policy link as the final, low-emphasis row.
    addPrivacyPolicyMenuItem(menuPopup);
}

function initDevSettings() {
    const isDev = import.meta.env.DEV || window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
    if (!isDev) return;

    const menuPopup = document.getElementById('map-menu-popup');
    if (!menuPopup) return;

    // Check if already exists
    if (document.getElementById('dev-section')) return;

    const section = document.createElement('div');
    section.id = 'dev-section';
    section.className = 'menu-section';
    section.style.cssText = 'padding: 10px 0 0 0; border-top: 1px solid var(--border-light);';

    const showSegments = localStorage.getItem('showMinibusSegments') === 'true';

    section.innerHTML = `
        <div style="font-weight:600; font-size:11px; color:var(--text-secondary); text-transform:uppercase; letter-spacing:0.5px; margin-bottom:10px; padding: 0 12px;">Dev Tools</div>
        
        <div class="menu-item" id="menu-minibus-segments-row">
            <div class="menu-icon">
                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline>
                </svg>
            </div>
            <span class="menu-label">Show Minibus Segments</span>
            <label class="toggle-switch">
                <input type="checkbox" id="minibus-segments-switch" ${showSegments ? 'checked' : ''}>
                <span class="slider round"></span>
            </label>
        </div>
    `;

    menuPopup.appendChild(section);

    // Switch Logic
    const segmentsSwitch = document.getElementById('minibus-segments-switch');
    if (segmentsSwitch) {
        segmentsSwitch.addEventListener('change', (e) => {
            const enabled = e.target.checked;
            localStorage.setItem('showMinibusSegments', enabled);
            window.dispatchEvent(new CustomEvent('minibusSegmentsChange', { detail: enabled }));
        });

        const row = document.getElementById('menu-minibus-segments-row');
        if (row) {
            row.addEventListener('click', (e) => {
                if (e.target.closest('.toggle-switch')) return;
                segmentsSwitch.checked = !segmentsSwitch.checked;
                segmentsSwitch.dispatchEvent(new Event('change'));
            });
        }
    }
}

function addInterfaceSection() {
    const menuPopup = document.getElementById('map-menu-popup');
    if (!menuPopup) return;

    // Check if already exists
    if (document.getElementById('interface-section')) return;

    const section = document.createElement('div');
    section.id = 'interface-section';
    section.className = 'menu-section';
    section.style.cssText = 'padding: 10px 16px; border-top: 1px solid var(--border-light);';

    // Load initial scale
    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    const defaultScale = isMobile ? 1.25 : 1.0;
    const storedScale = localStorage.getItem('pageScale');
    settings.pageScale = storedScale ? parseFloat(storedScale) : defaultScale;

    // Use stored theme or system default
    const currentTheme = localStorage.getItem('theme') || 'system';

    section.innerHTML = `
        <div style="font-weight:600; font-size:11px; color:var(--text-secondary); text-transform:uppercase; letter-spacing:0.5px; margin-bottom:10px;">Interface</div>
        
        <div class="theme-segmented-control" style="margin-bottom: 12px;">
            <div class="theme-option" data-value="system">Auto</div>
            <div class="theme-option" data-value="light">Light</div>
            <div class="theme-option" data-value="dark">Dark</div>
        </div>
        
        <div class="custom-slider-container">
            <div class="custom-slider-track"></div>
            <div class="custom-slider-thumb" id="page-scale-thumb"></div>
        </div>
        <div id="page-scale-value" class="custom-slider-value"></div>
    `;

    // Insert at the end of settings rows but before status
    const statusRow = Array.from(menuPopup.children).find(c => c.innerHTML && c.innerHTML.includes('APP'));
    if (statusRow) {
        menuPopup.insertBefore(section, statusRow);
    } else {
        menuPopup.appendChild(section);
    }

    // Theme Segmented Control Logic
    const options = section.querySelectorAll('.theme-option');

    function updateActiveState(theme) {
        options.forEach(opt => {
            opt.classList.toggle('active', opt.dataset.value === theme);
        });
    }

    updateActiveState(currentTheme);

    options.forEach(opt => {
        opt.addEventListener('click', (e) => {
            e.stopPropagation();
            const newTheme = opt.dataset.value;
            updateActiveState(newTheme);
            localStorage.setItem('theme', newTheme);
            window.dispatchEvent(new CustomEvent('manualThemeChange', { detail: newTheme }));
        });
    });

    // Custom Slider Logic
    const sliderContainer = section.querySelector('.custom-slider-container');
    const track = section.querySelector('.custom-slider-track');
    const thumb = section.querySelector('#page-scale-thumb');
    const valueDisplay = section.querySelector('#page-scale-value');

    const minVal = 0.8;
    const maxVal = 1.5;
    let currentValue = settings.pageScale;
    let isDragging = false;

    function valueToPercent(val) {
        return (val - minVal) / (maxVal - minVal);
    }

    function percentToValue(pct) {
        return minVal + pct * (maxVal - minVal);
    }

    function updateSliderUI() {
        const percent = valueToPercent(currentValue);
        // Position thumb
        thumb.style.left = `${percent * 100}%`;
        // Position label - use a span inside for transform centering
        valueDisplay.innerHTML = `<span style="left: ${percent * 100}%">${Math.round(currentValue * 100)}%</span>`;
    }

    function handlePointerDown(e) {
        isDragging = true;
        thumb.classList.add('active');
        document.body.style.userSelect = 'none';
        handlePointerMove(e);
    }

    function handlePointerMove(e) {
        if (!isDragging) return;

        const rect = sliderContainer.getBoundingClientRect();
        let x = (e.clientX || e.touches?.[0]?.clientX) - rect.left;
        let percent = x / rect.width;
        percent = Math.max(0, Math.min(1, percent));

        // Snap to steps
        const step = 0.05;
        let newValue = percentToValue(percent);
        newValue = Math.round(newValue / step) * step;
        newValue = Math.max(minVal, Math.min(maxVal, newValue));

        currentValue = newValue;
        updateSliderUI();
    }

    function handlePointerUp() {
        if (!isDragging) return;
        isDragging = false;
        thumb.classList.remove('active');
        document.body.style.userSelect = '';

        settings.pageScale = currentValue;
        localStorage.setItem('pageScale', currentValue);
        window.dispatchEvent(new CustomEvent('pageScaleChange', { detail: currentValue }));
    }

    // Event listeners
    sliderContainer.addEventListener('mousedown', handlePointerDown);
    sliderContainer.addEventListener('touchstart', handlePointerDown, { passive: true });
    document.addEventListener('mousemove', handlePointerMove);
    document.addEventListener('touchmove', handlePointerMove, { passive: true });
    document.addEventListener('mouseup', handlePointerUp);
    document.addEventListener('touchend', handlePointerUp);

    // Initial UI
    updateSliderUI();

    // Initial trigger
    setTimeout(() => {
        window.dispatchEvent(new CustomEvent('pageScaleChange', { detail: settings.pageScale }));
    }, 100);
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

function addMapSection() {
    const menuPopup = document.getElementById('map-menu-popup');
    if (!menuPopup) return;

    // Check if already exists
    if (document.getElementById('map-section')) return;

    // Load stored values
    const show3DBuildings = localStorage.getItem('show3DBuildings') === 'true'; // Default false
    const show3DTerrain = localStorage.getItem('show3DTerrain') === 'true'; // Default false
    const showPoiLabels = localStorage.getItem('showPoiLabels') === 'true'; // Default false

    const section = document.createElement('div');
    section.id = 'map-section';
    section.className = 'menu-section';
    section.style.cssText = 'padding: 10px 0 0 0; border-top: 1px solid var(--border-light);';

    section.innerHTML = `
        <div style="font-weight:600; font-size:11px; color:var(--text-secondary); text-transform:uppercase; letter-spacing:0.5px; margin-bottom:10px; padding: 0 12px;">Map</div>
        
        <div class="menu-item" id="menu-3d-buildings-row">
            <div class="menu-icon">
                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <rect x="4" y="2" width="16" height="20" rx="2" ry="2"></rect>
                    <path d="M9 22v-4h6v4"></path>
                    <path d="M8 6h.01"></path>
                    <path d="M16 6h.01"></path>
                    <path d="M12 6h.01"></path>
                    <path d="M12 10h.01"></path>
                    <path d="M12 14h.01"></path>
                    <path d="M16 10h.01"></path>
                    <path d="M16 14h.01"></path>
                    <path d="M8 10h.01"></path>
                    <path d="M8 14h.01"></path>
                </svg>
            </div>
            <span class="menu-label">3D Buildings</span>
            <label class="toggle-switch">
                <input type="checkbox" id="buildings-3d-switch" ${show3DBuildings ? 'checked' : ''}>
                <span class="slider round"></span>
            </label>
        </div>
        
        <div class="menu-item" id="menu-3d-terrain-row">
            <div class="menu-icon">
                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M8 3l4 8 5-5 5 15H2L8 3z"></path>
                </svg>
            </div>
            <span class="menu-label">3D Terrain</span>
            <label class="toggle-switch">
                <input type="checkbox" id="terrain-3d-switch" ${show3DTerrain ? 'checked' : ''}>
                <span class="slider round"></span>
            </label>
        </div>
        
        <div class="menu-item" id="menu-exaggerate-row" style="display: ${show3DTerrain ? 'flex' : 'none'}; padding-left: 48px;">
            <span class="menu-label">Exaggerate elevation</span>
            <label class="toggle-switch">
                <input type="checkbox" id="exaggerate-switch" ${localStorage.getItem('exaggerateTerrain') === 'true' ? 'checked' : ''}>
                <span class="slider round"></span>
            </label>
        </div>

        <div id="terrain-safari-warning" style="display: none; padding: 6px 12px 6px 48px; font-size: 11px; color: var(--warning-yellow, #b45309); line-height: 1.4;">
            To see 3D terrain in Safari please ${/iPhone|iPad|iPod/.test(navigator.userAgent)
            ? 'tap icon in the left part of address bar and select <b>Reduce Privacy Protections</b>'
            : 'select <b>View → Reload Reducing Privacy Protections</b>'}
        </div>

        <div class="menu-item" id="menu-poi-row">
            <div class="menu-icon">
                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <circle cx="12" cy="12" r="10"></circle>
                    <line x1="12" y1="16" x2="12" y2="12"></line>
                    <line x1="12" y1="8" x2="12.01" y2="8"></line>
                </svg>
            </div>
            <span class="menu-label">Points of Interest</span>
            <label class="toggle-switch">
                <input type="checkbox" id="poi-switch" ${showPoiLabels ? 'checked' : ''}>
                <span class="slider round"></span>
            </label>
        </div>
    `;

    // Insert before Interface section if it exists, otherwise before status
    const interfaceSection = document.getElementById('interface-section');
    if (interfaceSection) {
        menuPopup.insertBefore(section, interfaceSection);
    } else {
        const statusRow = Array.from(menuPopup.children).find(c => c.innerHTML && c.innerHTML.includes('APP'));
        if (statusRow) {
            menuPopup.insertBefore(section, statusRow);
        } else {
            menuPopup.appendChild(section);
        }
    }

    // 3D Buildings Switch Logic
    const buildingsSwitch = document.getElementById('buildings-3d-switch');
    if (buildingsSwitch) {
        buildingsSwitch.addEventListener('change', (e) => {
            const enabled = e.target.checked;
            localStorage.setItem('show3DBuildings', enabled);
            window.dispatchEvent(new CustomEvent('map3DBuildingsChange', { detail: enabled }));
        });

        const row = document.getElementById('menu-3d-buildings-row');
        if (row) {
            row.addEventListener('click', (e) => {
                if (e.target.closest('.toggle-switch')) return;
                buildingsSwitch.checked = !buildingsSwitch.checked;
                buildingsSwitch.dispatchEvent(new Event('change'));
            });
        }
    }

    // Exaggeration Row reference
    const exaggerateRow = document.getElementById('menu-exaggerate-row');
    const exaggerateSwitch = document.getElementById('exaggerate-switch');

    // 3D Terrain Switch Logic
    const terrainSwitch = document.getElementById('terrain-3d-switch');
    const safariWarning = document.getElementById('terrain-safari-warning');
    if (terrainSwitch) {
        terrainSwitch.addEventListener('change', (e) => {
            const enabled = e.target.checked;
            localStorage.setItem('show3DTerrain', enabled);
            window.dispatchEvent(new CustomEvent('map3DTerrainChange', { detail: enabled }));

            // Show/hide exaggeration toggle and Safari warning
            if (exaggerateRow) {
                exaggerateRow.style.display = enabled ? 'flex' : 'none';
            }
            if (safariWarning) {
                safariWarning.style.display = enabled ? 'block' : 'none';
            }
        });

        const row = document.getElementById('menu-3d-terrain-row');
        if (row) {
            row.addEventListener('click', (e) => {
                if (e.target.closest('.toggle-switch')) return;
                terrainSwitch.checked = !terrainSwitch.checked;
                terrainSwitch.dispatchEvent(new Event('change'));
            });
        }
    }

    // Exaggeration Switch Logic
    if (exaggerateSwitch) {
        exaggerateSwitch.addEventListener('change', (e) => {
            const enabled = e.target.checked;
            localStorage.setItem('exaggerateTerrain', enabled);
            window.dispatchEvent(new CustomEvent('mapExaggerateChange', { detail: enabled }));
        });

        if (exaggerateRow) {
            exaggerateRow.addEventListener('click', (e) => {
                if (e.target.closest('.toggle-switch')) return;
                exaggerateSwitch.checked = !exaggerateSwitch.checked;
                exaggerateSwitch.dispatchEvent(new Event('change'));
            });
        }
    }

    // POI Switch Logic
    const poiSwitch = document.getElementById('poi-switch');
    if (poiSwitch) {
        poiSwitch.addEventListener('change', (e) => {
            const enabled = e.target.checked;
            settings.showPoiLabels = enabled;
            localStorage.setItem('showPoiLabels', enabled);
            window.dispatchEvent(new CustomEvent('mapPoiLabelsChange', { detail: enabled }));
        });

        const row = document.getElementById('menu-poi-row');
        if (row) {
            row.addEventListener('click', (e) => {
                if (e.target.closest('.toggle-switch')) return;
                poiSwitch.checked = !poiSwitch.checked;
                poiSwitch.dispatchEvent(new Event('change'));
            });
        }
    }

    // Dispatch initial state and set initial warning visibility
    setTimeout(() => {
        window.dispatchEvent(new CustomEvent('map3DBuildingsChange', { detail: show3DBuildings }));
        window.dispatchEvent(new CustomEvent('map3DTerrainChange', { detail: show3DTerrain }));
        window.dispatchEvent(new CustomEvent('mapPoiLabelsChange', { detail: showPoiLabels }));

        // Show Safari warning if terrain is already enabled initially
        const warning = document.getElementById('terrain-safari-warning');
        if (warning && show3DTerrain) {
            warning.style.display = 'block';
        }
    }, 100);

    // Listen for terrain status to auto-hide warning if terrain works fine
    window.addEventListener('terrainStatusChange', (e) => {
        const warning = document.getElementById('terrain-safari-warning');
        if (!warning) return;

        if (e.detail.active) {
            // Terrain loaded successfully - hide the warning
            warning.style.display = 'none';
        }
        // If terrain failed, keep the warning visible (already shown by toggle handler)
    });
}

function init3DToggleButton() {
    const toggleBtn = document.getElementById('toggle-3d');
    const label = toggleBtn?.querySelector('.toggle-3d-label');
    if (!toggleBtn || !label) return;

    // Update label based on pitch
    function updateLabel() {
        if (!window.map) return;
        const pitch = window.map.getPitch();
        label.textContent = pitch > 5 ? '2D' : '3D';
    }

    // Initial state
    if (window.map) {
        updateLabel();
        window.map.on('pitch', updateLabel);
    } else {
        // Wait for map to be available
        const checkMap = setInterval(() => {
            if (window.map) {
                clearInterval(checkMap);
                updateLabel();
                window.map.on('pitch', updateLabel);
            }
        }, 100);
    }

    toggleBtn.addEventListener('click', () => {
        if (!window.map) return;
        const currentPitch = window.map.getPitch();
        const newPitch = currentPitch > 5 ? 0 : 60; // Increased to 60 for more dramatic 3D view

        // Dispatch event to signal we're programmatically pitching
        window.dispatchEvent(new CustomEvent('programmaticPitch', { detail: true }));

        window.map.easeTo({ pitch: newPitch, duration: 500 });

        // Clear the signal after animation
        window.map.once('moveend', () => {
            window.dispatchEvent(new CustomEvent('programmaticPitch', { detail: false }));
        });
    });
}
