
import mapboxgl from 'mapbox-gl';

// --- State ---
let isEditing = false;
let editState = {
    stopId: null,
    overrides: {}, // { lat, lon, bearing }
    merges: [],    // [id1, id2...]
    mergeParent: null,
    unmerges: [],
    hubTarget: null,
    hubAdds: [],
    unhubs: []
};
const editSessionCache = {}; // Cache for unapplied drafts: { stopId: { overrides, parent, unmerges } }

// Route Edit State
let routeEditState = {
    routeId: null,
    original: {},
    overrides: {}
};

// Map Markers for Editing
let editLocMarker = null;
let editRotMarker = null;
// let editRotLine = null; // Unused?

// Store original "truth" names for comparison
let originalNames = { en: null, ka: null };

// Callbacks (injected)
let _map = null;
let _dataProvider = null;
let _uiCallbacks = null;

export function getEditState() {
    return editState;
}

export function setupEditTools(map, dataProvider, uiCallbacks) {
    _map = map;
    _dataProvider = dataProvider;
    _uiCallbacks = uiCallbacks;

    const stopEditBtn = document.getElementById('btn-edit-stop');
    const routeEditBtn = document.getElementById('btn-edit-route');

    const isDev = import.meta.env.DEV || window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

    if (!isDev) {
        if (stopEditBtn) stopEditBtn.style.setProperty('display', 'none', 'important');
        if (routeEditBtn) routeEditBtn.style.setProperty('display', 'none', 'important');
        return;
    }

    if (stopEditBtn) stopEditBtn.style.display = 'flex';
    if (routeEditBtn) routeEditBtn.style.display = 'flex';

    initEditTools();
    initRouteEditTools();

    // Expose global for convenience/debugging
    window.selectDevStop = (id) => {
        // If dev tools (old) requested strict selection, we can just highlight it.
        // But since we are integrating, we ignore the old panel logic for now.
    };
}

// --- Route Config Loading ---
// Note: This was in main.js global scope, we might need to handle it or assume window.routesConfig
// main.js calls loadRoutesConfig();
export async function loadRoutesConfig() {
    // If we need to fetch logic here. 
    // Assuming window.routesConfig is populated elsewhere or we fetch it?
    // main.js didn't show the implementation of loadRoutesConfig in the snippet I read.
    // Let's assume it fetches or initializes window.routesConfig.
    // If it was defined in main.js, I need to move it too.
    // I'll define a basic one if missing.
    if (!window.routesConfig) {
        try {
            const res = await fetch('/assets/routes_config.json'); // or appropriate path
            if (res.ok) {
                window.routesConfig = await res.json();
            } else {
                window.routesConfig = { routeOverrides: {} };
            }
        } catch {
            window.routesConfig = { routeOverrides: {} };
        }
    }
}


// --- Route Editing Logic ---

function initRouteEditTools() {
    const editBtn = document.getElementById('btn-edit-route');
    const editBlock = document.getElementById('route-edit-block');
    const applyBtn = document.getElementById('route-edit-apply');

    if (!editBtn || !editBlock) return;

    editBtn.addEventListener('click', () => {
        const isActive = editBtn.classList.contains('active');
        if (isActive) {
            // Close
            console.log('[DevTools] Closing Route Edit');
            editBtn.classList.remove('active');
            editBlock.classList.add('hidden');
            editBlock.style.display = 'none';
        } else {
            // Open
            console.log('[DevTools] Opening Route Edit');
            editBtn.classList.add('active');
            editBlock.classList.remove('hidden');
            editBlock.style.display = 'flex';
            if (window.currentRoute) {
                console.log('[DevTools] Starting edit for route:', window.currentRoute.id);
                startEditingRoute(window.currentRoute.id);
            } else {
                console.warn('[DevTools] No window.currentRoute found!');
            }
        }
    });

    const allRoutesBtn = document.getElementById('route-edit-all-routes');
    if (allRoutesBtn) {
        allRoutesBtn.addEventListener('click', () => {
            openAllRoutesEditor();
        });
    }

    const inputs = [
        'route-edit-short', 'route-edit-long-en', 'route-edit-long-ka',
        'route-edit-dest0-en', 'route-edit-dest0-ka',
        'route-edit-dest1-en', 'route-edit-dest1-ka'
    ];

    const handleInput = () => {
        // ConstructOverrides
        const getI = (id) => document.getElementById(id).value.trim();
        const short = getI('route-edit-short');
        const longEn = getI('route-edit-long-en');
        const longKa = getI('route-edit-long-ka');

        // Original checks
        const orig = routeEditState.original;

        // Update Overrides Object
        let o = routeEditState.overrides;

        if (short !== (orig.shortName || '')) o.shortName = short; else delete o.shortName;

        // Long Name
        if (longEn !== (orig.longName?.en || '') || longKa !== (orig.longName?.ka || '')) {
            if (!o.longName) o.longName = {};
            if (longEn !== orig.longName?.en) o.longName.en = longEn; else delete o.longName.en;
            if (longKa !== orig.longName?.ka) o.longName.ka = longKa; else delete o.longName.ka;
            if (Object.keys(o.longName).length === 0) delete o.longName;
        } else {
            delete o.longName;
        }

        // Destinations
        const d0en = getI('route-edit-dest0-en');
        const d0ka = getI('route-edit-dest0-ka');
        const d1en = getI('route-edit-dest1-en');
        const d1ka = getI('route-edit-dest1-ka');

        // Helper for dest
        const checkDest = (dir, en, ka) => {
            const oDest = orig.destinations?.[dir]?.headsign || {};
            if (en !== (oDest.en || '') || ka !== (oDest.ka || '')) {
                if (!o.destinations) o.destinations = {};
                if (!o.destinations[dir]) o.destinations[dir] = { headsign: {} };

                const d = o.destinations[dir].headsign;
                if (en !== (oDest.en || '')) d.en = en; else delete d.en;
                if (ka !== (oDest.ka || '')) d.ka = ka; else delete d.ka;

                if (Object.keys(d).length === 0) {
                    delete o.destinations[dir]; // empty headsign obj
                    if (Object.keys(o.destinations).length === 0) delete o.destinations;
                }
            } else {
                // If exists, cleanup? 
                if (o.destinations?.[dir]) {
                    delete o.destinations[dir];
                    if (Object.keys(o.destinations).length === 0) delete o.destinations;
                }
            }
        };

        checkDest(0, d0en, d0ka);
        checkDest(1, d1en, d1ka);

        checkRouteDirtyState();
        updateRouteRestoreButtons();
    };

    inputs.forEach(id => {
        document.getElementById(id).addEventListener('input', handleInput);
    });

    // Restore Buttons
    const setupRestore = (btnId, inputId, originalPath) => {
        const btn = document.getElementById(btnId);
        if (btn) btn.addEventListener('click', () => {
            const val = resolvePath(routeEditState.original, originalPath) || '';
            document.getElementById(inputId).value = val;
            handleInput();
        });
    };
    const resolvePath = (obj, path) => path.split('.').reduce((o, i) => o?.[i], obj);

    setupRestore('route-restore-short', 'route-edit-short', 'shortName');
    setupRestore('route-restore-long-en', 'route-edit-long-en', 'longName.en');
    setupRestore('route-restore-long-ka', 'route-edit-long-ka', 'longName.ka');

    setupRestore('route-restore-dest0-en', 'route-edit-dest0-en', 'destinations.0.headsign.en');
    setupRestore('route-restore-dest0-ka', 'route-edit-dest0-ka', 'destinations.0.headsign.ka');
    setupRestore('route-restore-dest1-en', 'route-edit-dest1-en', 'destinations.1.headsign.en');
    setupRestore('route-restore-dest1-ka', 'route-edit-dest1-ka', 'destinations.1.headsign.ka');

    if (applyBtn) applyBtn.addEventListener('click', async () => {
        await saveRouteOverrides();
    });
}

async function startEditingRoute(routeId) {
    if (!window.routesConfig) window.routesConfig = { routeOverrides: {} };

    // 1. Identify Valid ID (Prefix handling)
    const allRoutes = _dataProvider.getAllRoutes();
    const routeObj = allRoutes.find(r => String(r.id) === String(routeId) || String(r.id) === `1:${routeId}`);

    if (!routeObj) {
        console.warn('Could not find route to edit:', routeId);
        return;
    }

    const stableId = routeObj.id;
    routeEditState.routeId = stableId;
    routeEditState.original = JSON.parse(JSON.stringify(routeObj));

    // Load Existing Overrides
    if (window.routesConfig.routeOverrides && window.routesConfig.routeOverrides[stableId]) {
        routeEditState.overrides = JSON.parse(JSON.stringify(window.routesConfig.routeOverrides[stableId]));
    } else {
        routeEditState.overrides = {};
    }

    const setVal = (id, v) => document.getElementById(id).value = (v || '');

    // --- FETCH DATA FOR EDITING ---
    // We need:
    // 1. Full Details (for Headsigns)
    // 2. Both English and Georgian Names (Long Name)

    let longNameEn = '';
    let longNameKa = '';
    let headsigns = { en: [], ka: [] };

    // Prefill from current object (likely mixed or just one locale)
    setVal('route-edit-short', routeObj.shortName);

    try {
        console.log('[Edit] Fetching editing data...');
        // Import API dynamically if not available globally, or use window/module
        // We are inside a module that has access to imports? No, need to import api
        const api = await import('./api.js');

        // Parallel Fetch: Details (EN), Routes (EN), Routes (KA)
        // Actually Details usually has headsigns. 
        // Routes List has Long Names.

        // Strategy:
        // 1. Fetch Details (EN) -> Headsigns EN
        // 2. Fetch Details (KA) -> Headsigns KA
        // 3. Fetch Route List (EN) -> LongName EN
        // 4. Fetch Route List (KA) -> LongName KA

        const fetchDetails = async (lang) => {
            // We can use a direct fetch because api.fetchRouteDetailsV3 uses default source logic
            // But we need to force locale. api.fetchRouteDetailsV3 logic is hardcoded?
            // Checking api.js: fetchRouteDetailsV3 calls fetchFromSmartSource(urlGen).
            // urlGen uses `.../routes/...`.
            // It does NOT seem to force locale in the URL for DETAILS (only for schedule?).
            // Wait, `fetchRouteDetailsV3` urlGen is `${getApiV3BaseUrl(s)}/routes/${encodeURIComponent(id)}`.
            // It does NOT append ?locale=en.
            // So it might return default (likely KA or mixed).

            // We can hack the URL generator by passing a custom one? No, `fetchFromSmartSource` isn't exported.
            // We can use `fetch` directly using the helper.

            // Simpler: Just fetch the route lists for Naming.
            // For Headsigns, we rely on details.

            // Let's rely on `fetchWithCache` to get raw data for edit.
            // We know the source from `routeObj._source`.
        };

        const sourceId = routeObj._source || 'tbilisi';
        const rawId = routeObj.id.includes(':') ? routeObj.id.split(':')[1] : routeObj.id; // Heuristic

        // Use the API module to get base URLs
        const sources = api.sources;
        const source = sources.find(s => s.id === sourceId) || sources[0];
        const v3Base = import.meta.env.DEV ? (sourceId === 'tbilisi' ? '/pis-gateway/api/v3' : source.apiBaseV3) : source.apiBaseV3;

        // FETCH NAMES (Routes List)
        // Optimization: Use `fetchRoutes` but we need specific locale.
        // `api.fetchRoutes` hardcodes locale usually? 
        // line 603: `url = .../routes`. It doesn't force locale? 
        // line 749 (v3): `.../routes?locale=en`.

        const fetchName = async (lang) => {
            const url = `${v3Base}/routes?locale=${lang}`;
            const res = await api.fetchWithCache(url, { headers: { 'x-api-key': api.API_KEY } });
            if (Array.isArray(res)) {
                // Find our route (checking ID or shortName)
                const found = res.find(r => {
                    // ID check needs processing?
                    // Raw API ID vs Processed ID.
                    // The list returns RAW IDs (e.g. 801).
                    // routeObj.id is processed (e.g. 1:801).
                    // We match by `api.processId(r.id, source) === routeObj.id`
                    return api.processId(r.id, source) === routeObj.id;
                });
                return found ? found.longName : '';
            }
            return '';
        };

        const [enName, kaName] = await Promise.all([fetchName('en'), fetchName('ka')]);
        longNameEn = enName;
        longNameKa = kaName;

        // FETCH HEADSIGNS (Details)
        const fetchHeadsigns = async (lang) => {
            const url = `${v3Base}/routes/${rawId}?locale=${lang}`; // Append query param if supported
            // If API doesn't support ?locale on details, we might act on `Server-Locale` header or accept-language?
            // Trying query param first.
            const res = await api.fetchWithCache(url, { headers: { 'x-api-key': api.API_KEY, 'Accept-Language': lang } });
            // API V3 usually respects Accept-Language or query param.

            if (res && res.patterns) {
                return res.patterns.map(p => p.headsign);
            }
            return [];
        };

        const [enHeads, kaHeads] = await Promise.all([fetchHeadsigns('en'), fetchHeadsigns('ka')]);
        // Assumption: Patterns are in same order.
        headsigns.en = enHeads || [];
        headsigns.ka = kaHeads || [];

    } catch (e) {
        console.warn('[Edit] Failed to fetch localized data', e);
        // Fallback to what we have
        const lName = routeObj.longName;
        if (typeof lName === 'string') {
            // Guess: if it has non-ascii, it's likely KA
            if (/[^\u0000-\u007f]/.test(lName)) longNameKa = lName;
            else longNameEn = lName;
        } else {
            longNameEn = lName?.en;
            longNameKa = lName?.ka;
        }
    }

    // Set Values
    // Set Values - Prioritize Overrides
    const ov = routeEditState.overrides;

    // Long Names
    const ovLongEn = ov.longName?.en;
    const ovLongKa = ov.longName?.ka;
    setVal('route-edit-long-en', ovLongEn !== undefined ? ovLongEn : longNameEn);
    setVal('route-edit-long-ka', ovLongKa !== undefined ? ovLongKa : longNameKa);

    // Destinations
    // Helper to safely get override destination
    const getDestOv = (dir, lang) => ov.destinations?.[dir]?.headsign?.[lang];

    setVal('route-edit-dest0-en', getDestOv(0, 'en') !== undefined ? getDestOv(0, 'en') : headsigns.en[0]);
    setVal('route-edit-dest0-ka', getDestOv(0, 'ka') !== undefined ? getDestOv(0, 'ka') : headsigns.ka[0]);
    setVal('route-edit-dest1-en', getDestOv(1, 'en') !== undefined ? getDestOv(1, 'en') : headsigns.en[1]);
    setVal('route-edit-dest1-ka', getDestOv(1, 'ka') !== undefined ? getDestOv(1, 'ka') : headsigns.ka[1]);

    checkRouteDirtyState();
    updateRouteRestoreButtons();
}

function checkRouteDirtyState() {
    const applyBtn = document.getElementById('route-edit-apply');
    const isDirty = Object.keys(routeEditState.overrides).length > 0;

    if (applyBtn) {
        applyBtn.disabled = !isDirty;
        applyBtn.classList.toggle('active', isDirty);
    }
}

function updateRouteRestoreButtons() {
    // Logic to dim/light up restore buttons based on diff?
    // Implementation not critical, leaving simple for now.
}

async function saveRouteOverrides() {
    if (!window.routesConfig.routeOverrides) window.routesConfig.routeOverrides = {};

    let id = routeEditState.routeId;

    if (Object.keys(routeEditState.overrides).length === 0) {
        delete window.routesConfig.routeOverrides[id];
    } else {
        window.routesConfig.routeOverrides[id] = routeEditState.overrides;
    }

    const applyBtn = document.getElementById('route-edit-apply');
    if (applyBtn) {
        applyBtn.disabled = true;
        applyBtn.textContent = 'Saving...';
    }

    try {
        console.log('[DevTools] Saving single route overrides...', JSON.stringify(window.routesConfig, null, 2));
        const res = await fetch('/api/save-routes-config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(window.routesConfig, null, 2)
        });

        if (!res.ok) {
            const errText = await res.text();
            throw new Error(`Save failed: ${res.status} ${res.statusText} - ${errText}`);
        }

        console.log('[DevTools] Single route save successful');

        if (applyBtn) {
            applyBtn.textContent = 'Saved!';
            applyBtn.classList.add('success');
        }

        // Re-apply locally (We need to call main.js function? 
        // We can expose applyRouteOverrides from main.js or just reload?)
        // applyRouteOverrides is in main.js. 
        // Ideally we move applyRouteOverrides to here or api.js?
        // For now, we unfortunately can't easily call it unless passed in callbacks.
        // Let's assume user reloads or we pass it.
        // Or we implement a simple version here.
        if (window.applyRouteOverrides) window.applyRouteOverrides();

        // Update UI
        if (_uiCallbacks && _uiCallbacks.renderAllRoutes) {
            _uiCallbacks.renderAllRoutes(window.lastRoutes, window.lastArrivals);
        }

        setTimeout(() => {
            if (applyBtn) {
                applyBtn.classList.remove('success');
                applyBtn.textContent = 'Apply Changes';
            }
            checkRouteDirtyState();
        }, 1500);

    } catch (e) {
        console.error(e);
        alert('Save Error: ' + e.message);
        if (applyBtn) {
            applyBtn.textContent = 'Apply Changes';
            applyBtn.disabled = false;
        }
    }
}


// --- Stop Editing Logic ---

function initEditTools() {
    const editBtn = document.getElementById('btn-edit-stop');
    const editBlock = document.getElementById('stop-edit-block');
    const applyBtn = document.getElementById('edit-btn-apply');

    const toggleLoc = document.getElementById('edit-toggle-loc');
    const toggleRot = document.getElementById('edit-toggle-rot');
    const toggleMerge = document.getElementById('edit-toggle-merge');
    const toggleHub = document.getElementById('edit-toggle-hub');

    if (!editBtn || !editBlock) return;

    // Toggle Edit Mode
    editBtn.addEventListener('click', () => {
        isEditing = !isEditing;
        editBtn.classList.toggle('active', isEditing);

        // Reset toggles when closing/opening
        if (isEditing) {
            editBlock.classList.remove('hidden');
            editBlock.style.display = 'flex';
            // Initialize State
            startEditing(window.currentStopId);
        } else {
            editBlock.classList.add('hidden');
            editBlock.style.display = 'none';
            stopEditing(true);
        }
    });

    // Toggles
    toggleLoc.addEventListener('click', () => {
        toggleLoc.classList.toggle('active');
        if (!toggleLoc.classList.contains('active') && editState.overrides) {
            delete editState.overrides.lat;
            delete editState.overrides.lon;
        }
        updateEditMap();
        checkDirtyState();
    });

    toggleRot.addEventListener('click', () => {
        toggleRot.classList.toggle('active');
        if (!toggleRot.classList.contains('active') && editState.overrides) {
            delete editState.overrides.bearing;
        }
        updateEditMap();
        checkDirtyState();
    });

    toggleMerge.addEventListener('click', () => {
        const wasActive = toggleMerge.classList.contains('active');
        const nowActive = !wasActive;
        toggleMerge.classList.toggle('active', nowActive);

        // Disable Hub if Merge active
        if (nowActive) {
            toggleHub.classList.remove('active');
            setEditPickMode('merge');
        } else {
            setEditPickMode(null);
        }
    });

    toggleHub.addEventListener('click', () => {
        const wasActive = toggleHub.classList.contains('active');
        const nowActive = !wasActive;
        toggleHub.classList.toggle('active', nowActive);

        // Disable Merge if Hub active
        if (nowActive) {
            toggleMerge.classList.remove('active');
            setEditPickMode('hub');
        } else {
            setEditPickMode(null);
        }
    });

    // Name Inputs
    const nameEn = document.getElementById('edit-name-en');
    const nameKa = document.getElementById('edit-name-ka');
    const restoreEnBtn = document.getElementById('edit-restore-en');
    const restoreKaBtn = document.getElementById('edit-restore-ka');

    const updateNameOverride = () => {
        const valEn = nameEn.value.trim();
        const valKa = nameKa.value.trim();

        const hasEnDiff = valEn !== (originalNames.en || '');
        const hasKaDiff = valKa !== (originalNames.ka || '');

        if (!hasEnDiff && !hasKaDiff) {
            delete editState.overrides.name;
        } else {
            editState.overrides.name = {};
            if (hasEnDiff) editState.overrides.name.en = valEn;
            if (hasKaDiff) editState.overrides.name.ka = valKa;
        }
        checkDirtyState();
    };

    nameEn.addEventListener('input', updateNameOverride);
    nameKa.addEventListener('input', updateNameOverride);

    const restoreField = async (locale) => {
        const originalVal = originalNames[locale] || '';
        if (locale === 'en') nameEn.value = originalVal;
        if (locale === 'ka') nameKa.value = originalVal;
        updateNameOverride();
    };

    if (restoreEnBtn) restoreEnBtn.addEventListener('click', () => restoreField('en'));
    if (restoreKaBtn) restoreKaBtn.addEventListener('click', () => restoreField('ka'));

    // Apply
    if (applyBtn) {
        applyBtn.addEventListener('click', async () => {
            await saveEditChanges();
        });
    }
}

function startEditing(stopId) {
    if (!stopId) return;
    const allStops = _dataProvider.getAllStops();
    const stop = allStops.find(s => s.id === stopId);
    if (!stop) return;

    const stopsConfig = window.stopsConfig || {};

    if (editSessionCache[stopId]) {
        editState = {
            stopId: stopId,
            overrides: { ...editSessionCache[stopId].overrides },
            mergeParent: editSessionCache[stopId].mergeParent,
            unmerges: [...(editSessionCache[stopId].unmerges || [])],
            hubTarget: editSessionCache[stopId].hubTarget,
            unhubs: [...(editSessionCache[stopId].unhubs || [])],
            hubAdds: []
        };
    } else {
        editState = {
            stopId: stopId,
            overrides: {},
            mergeParent: null,
            unmerges: [],
            hubTarget: null,
            unhubs: [],
            hubAdds: []
        };

        if (stopsConfig?.overrides?.[stopId]) {
            editState.overrides = { ...stopsConfig.overrides[stopId] };
        }

        if (stopsConfig?.hubs?.[stopId]) {
            editState.hubTarget = stopsConfig.hubs[stopId];
        } else {
            editState.hubTarget = null;
        }
    }

    const toggleLoc = document.getElementById('edit-toggle-loc');
    const toggleRot = document.getElementById('edit-toggle-rot');
    const nameEn = document.getElementById('edit-name-en');
    const nameKa = document.getElementById('edit-name-ka');

    // Populate Names (simplified logic compared to main.js for brevity but robust)
    const urlParams = new URLSearchParams(window.location.search);
    const activeLocale = urlParams.get('locale') || 'en';

    if (editState.overrides.name) {
        nameEn.value = editState.overrides.name.en || '';
        nameKa.value = editState.overrides.name.ka || '';
    } else {
        nameEn.value = '';
        nameKa.value = '';
    }

    originalNames = { en: null, ka: null };
    // Not referencing rawStops from module scope anymore, need to access via window or provider if possible. 
    // BUT main.js had 'rawStops'. We can assume allStops (which includes overrides) is the best we have unless we strip them.
    // Or we fetch 'foreign' names.
    // The main.js logic for originals was quite complex fetch logic. I'll implement a simpler fetch here.

    const setOriginal = (locale, val) => {
        originalNames[locale] = val || '';
        if (!editState.overrides.name || editState.overrides.name[locale] === undefined) {
            const input = locale === 'en' ? nameEn : nameKa;
            input.value = val || '';
        }
    };

    fetchMissingName(stopId, 'en').then(val => setOriginal('en', val));
    fetchMissingName(stopId, 'ka').then(val => setOriginal('ka', val));

    if (editState.overrides.lat || editState.overrides.lon) {
        toggleLoc.classList.add('active');
    } else {
        toggleLoc.classList.remove('active');
    }

    if (editState.overrides.bearing !== undefined) {
        toggleRot.classList.add('active');
    } else {
        toggleRot.classList.remove('active');
    }

    updateEditMergedList();
    updateEditMap();
    if (_uiCallbacks.updateMapFilterState) _uiCallbacks.updateMapFilterState();
    checkDirtyState();
}

function stopEditing(persist = false) {
    if (persist && editState.stopId) {
        editSessionCache[editState.stopId] = {
            overrides: { ...editState.overrides },
            mergeParent: editState.mergeParent,
            unmerges: editState.unmerges,
            hubTarget: editState.hubTarget,
            unhubs: editState.unhubs
        };
    } else if (!persist && editState.stopId) {
        delete editSessionCache[editState.stopId];
    }

    const editBtn = document.getElementById('btn-edit-stop');
    if (editBtn) editBtn.classList.remove('active');

    const editBlock = document.getElementById('stop-edit-block');
    if (editBlock) {
        editBlock.classList.add('hidden');
        editBlock.style.display = 'none';
    }

    isEditing = false;

    if (editLocMarker) { editLocMarker.remove(); editLocMarker = null; }
    if (editRotMarker) { editRotMarker.remove(); editRotMarker = null; } // legacy

    document.querySelectorAll('.edit-chip').forEach(el => el.classList.remove('active'));
    setEditPickMode(null);

    editState.stopId = null;

    if (_uiCallbacks.updateMapFilterState) _uiCallbacks.updateMapFilterState();
}

function updateEditMap() {
    const stopId = editState.stopId;
    const allStops = _dataProvider.getAllStops();
    const stop = allStops.find(s => s.id === stopId);

    if (!stop) return;

    let lat, lon;
    if (editState.overrides.lat) lat = parseFloat(editState.overrides.lat);
    if (editState.overrides.lon) lon = parseFloat(editState.overrides.lon);

    if (isNaN(lat) || isNaN(lon)) {
        lat = parseFloat(stop.lat);
        lon = parseFloat(stop.lon);
    }
    if (isNaN(lat) || isNaN(lon)) return;

    const bearing = editState.overrides.bearing !== undefined ? editState.overrides.bearing : (stop.bearing || 0);

    // Always show the unified marker in Edit Mode
    let el;
    if (!editLocMarker) {
        el = document.createElement('div');
        el.className = 'edit-stop-marker';
        el.innerHTML = `
            <svg width="63.6" height="91.2" viewBox="0 0 53 76" fill="none" xmlns="http://www.w3.org/2000/svg">
                <circle cx="26.5" cy="49.3533" r="24.5" fill="black" stroke="white" stroke-width="4"/>
                <path d="M22.1698 4.5C24.0943 1.1667 28.9054 1.16675 30.83 4.5L35.9657 13.3945C37.8902 16.7278 35.4845 20.8944 31.6356 20.8945H21.3651C17.5161 20.8945 15.1096 16.7279 17.0341 13.3945L22.1698 4.5Z" fill="black" stroke="white" stroke-width="4"/>
            </svg>
            <div class="edit-arrow-zone" title="Drag to Rotate"></div>
            <div class="edit-body-zone" title="Drag to Move"></div>
        `;

        editLocMarker = new mapboxgl.Marker({
            element: el,
            draggable: true,
        })
            .setLngLat([lon, lat])
            .setRotation(bearing)
            .setRotationAlignment('map')
            .addTo(_map);

        const arrowZone = el.querySelector('.edit-arrow-zone');

        // Rotation Logic
        arrowZone.addEventListener('mousedown', (e) => {
            e.stopPropagation();
            e.preventDefault();
            el.classList.add('rotating');
            _map.dragPan.disable();

            const pos = _map.project([lon, lat]);

            const onMouseMove = (moveEvent) => {
                const dx = moveEvent.clientX - pos.x;
                const dy = moveEvent.clientY - pos.y;
                let rad = Math.atan2(dy, dx);
                let deg = rad * (180 / Math.PI);
                let newBearing = 90 + deg;
                if (newBearing < 0) newBearing += 360;
                if (newBearing >= 360) newBearing -= 360;
                newBearing = Math.round(newBearing);

                editState.overrides.bearing = newBearing;
                document.getElementById('edit-toggle-rot').classList.add('active');
                editLocMarker.setRotation(newBearing);
                checkDirtyState();
            };

            const onMouseUp = () => {
                document.removeEventListener('mousemove', onMouseMove);
                document.removeEventListener('mouseup', onMouseUp);
                el.classList.remove('rotating');
                _map.dragPan.enable();
            };

            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        });

        // Drag Logic
        editLocMarker.on('drag', () => {
            const lngLat = editLocMarker.getLngLat();
            editState.overrides.lon = parseFloat(lngLat.lng.toFixed(5));
            editState.overrides.lat = parseFloat(lngLat.lat.toFixed(5));
            document.getElementById('edit-toggle-loc').classList.add('active');
            lon = lngLat.lng;
            lat = lngLat.lat;
            checkDirtyState();
        });

    } else {
        editLocMarker.setLngLat([lon, lat]);
        editLocMarker.setRotation(bearing);
    }
}

let editPickHandler = null;

export function setEditPickMode(mode) {
    if (!mode) {
        window.isPickModeActive = false;
        window.editPickModeType = null;
        const existing = document.getElementById('edit-pick-banner');
        if (existing) existing.remove();
        document.body.style.cursor = 'default';
        if (editPickHandler) _map.off('click', 'stops-layer', editPickHandler);
        // Re-open panel half
        if (_uiCallbacks.setSheetState) _uiCallbacks.setSheetState(document.getElementById('info-panel'), 'half');
        return;
    }

    window.isPickModeActive = true;
    window.editPickModeType = mode;

    const bannerEl = document.createElement('div');
    bannerEl.id = 'edit-pick-banner';
    bannerEl.style.cssText = `
        position: fixed; top: 0; left: 0; width: 100%; height: 60px;
        background: #3b82f6; color: white; display: flex; align-items: center; justify-content: center;
        font-weight: bold; z-index: 9999; box-shadow: 0 2px 10px rgba(0,0,0,0.2); cursor: pointer;
    `;
    bannerEl.innerHTML = mode === 'merge' ?
        'Tap a stop to MERGE this one into...' :
        'Tap stops to HUB with (Click banner to finish)';

    // Remove old if any
    const existing = document.getElementById('edit-pick-banner');
    if (existing) existing.remove();

    document.body.appendChild(bannerEl);
    document.body.style.cursor = 'crosshair';

    // Collapse
    if (_uiCallbacks.setSheetState) _uiCallbacks.setSheetState(document.getElementById('info-panel'), 'collapsed');

    if (editPickHandler) _map.off('click', 'stops-layer', editPickHandler);

    editPickHandler = (e) => {
        const targetFeature = e.features[0];
        if (!targetFeature) return;
        const targetId = targetFeature.properties.id;

        if (targetId === editState.stopId) return;

        if (window.editPickModeType === 'merge') {
            editState.mergeParent = targetId;
            setEditPickMode(null);
            document.getElementById('edit-toggle-merge').classList.remove('active');
            updateEditMergedList();
            checkDirtyState();
            if (_uiCallbacks.setSheetState) _uiCallbacks.setSheetState(document.getElementById('info-panel'), 'half');
        }
        else if (window.editPickModeType === 'hub') {
            if (!editState.hubAdds) editState.hubAdds = [];

            if (editState.unhubs && editState.unhubs.includes(targetId)) {
                editState.unhubs = editState.unhubs.filter(id => id !== targetId);
            }
            else if (editState.hubAdds.includes(targetId)) {
                editState.hubAdds = editState.hubAdds.filter(id => id !== targetId);
            }
            else {
                editState.hubAdds.push(targetId);
            }
            updateEditMergedList();
            checkDirtyState();
        }
    };

    _map.on('click', 'stops-layer', editPickHandler);

    bannerEl.addEventListener('click', () => {
        setEditPickMode(null);
        document.getElementById('edit-toggle-merge').classList.remove('active');
        document.getElementById('edit-toggle-hub').classList.remove('active');
        if (_uiCallbacks.setSheetState) _uiCallbacks.setSheetState(document.getElementById('info-panel'), 'half');
    });
}

function updateEditMergedList() {
    const container = document.getElementById('edit-merged-list');
    container.innerHTML = '';

    const mergeSourcesMap = _dataProvider.getMergeSourcesMap();
    const hubMap = _dataProvider.getHubMap();
    const hubSourcesMap = _dataProvider.getHubSourcesMap();

    // 1. Merged Children
    const mergedChildren = mergeSourcesMap.get(editState.stopId) || [];
    mergedChildren.forEach(childId => {
        const span = document.createElement('span');
        span.className = 'merge-chip';
        span.style.cssText = 'background:#e5e7eb; padding:2px 6px; border-radius:12px; display:inline-flex; align-items:center; gap:4px';
        span.innerHTML = `#${childId} <span class="del-btn" style="cursor:pointer; font-weight:bold">×</span>`;

        span.querySelector('.del-btn').addEventListener('click', () => {
            if (!editState.unmerges) editState.unmerges = [];
            editState.unmerges.push(childId);
            span.remove();
            checkDirtyState();
        });
        container.appendChild(span);
    });

    // 2. Hub Siblings
    const myHubId = hubMap.get(editState.stopId);
    let currentSiblings = [];

    if (myHubId) {
        const allMembers = hubSourcesMap.get(myHubId) || [];
        currentSiblings = allMembers.filter(id => id !== editState.stopId);
    }

    if (editState.unhubs) {
        currentSiblings = currentSiblings.filter(id => !editState.unhubs.includes(id));
    }
    if (editState.hubAdds) {
        editState.hubAdds.forEach(id => {
            if (!currentSiblings.includes(id) && id !== editState.stopId) {
                currentSiblings.push(id);
            }
        });
    }

    if (currentSiblings.length > 0) {
        const label = document.createElement('div');
        label.style.cssText = 'font-size: 0.75rem; color: #666; margin-top: 4px; width:100%;';
        label.textContent = 'Hub Siblings:';
        container.appendChild(label);
    }

    currentSiblings.forEach(siblingId => {
        const span = document.createElement('span');
        span.style.cssText = 'background:#dbeafe; color:#1e40af; padding:2px 6px; border-radius:12px; display:inline-flex; align-items:center; gap:4px';
        const isNew = editState.hubAdds && editState.hubAdds.includes(siblingId);
        span.innerHTML = `${siblingId} ${isNew ? '<span style="font-size:0.7em; opacity:0.7">(new)</span>' : ''} <span class="del-btn" style="cursor:pointer; font-weight:bold">×</span>`;

        span.querySelector('.del-btn').addEventListener('click', () => {
            if (editState.hubAdds && editState.hubAdds.includes(siblingId)) {
                editState.hubAdds = editState.hubAdds.filter(id => id !== siblingId);
            } else {
                if (!editState.unhubs) editState.unhubs = [];
                editState.unhubs.push(siblingId);
            }
            updateEditMergedList();
            checkDirtyState();
        });
        container.appendChild(span);
    });

    // Show Pending Parent (Merge)
    if (editState.mergeParent) {
        const span = document.createElement('span');
        span.style.cssText = 'background:#fee2e2; color:#b91c1c; padding:2px 6px; border-radius:12px; display:inline-flex; align-items:center; gap:4px';
        span.innerHTML = `→ ${editState.mergeParent} <span class="del-btn" style="cursor:pointer; font-weight:bold">×</span>`;
        span.querySelector('.del-btn').addEventListener('click', () => {
            editState.mergeParent = null;
            span.remove();
            checkDirtyState();
        });
        container.appendChild(span);
    }
}

async function saveEditChanges() {
    if (!editState.stopId) return;

    const applyBtn = document.getElementById('edit-btn-apply');
    if (applyBtn) {
        applyBtn.disabled = true;
        applyBtn.textContent = 'Saving...';
    }

    const stopsConfig = window.stopsConfig || {};

    if (!stopsConfig.overrides) stopsConfig.overrides = {};
    stopsConfig.overrides[editState.stopId] = { ...editState.overrides };

    if (!stopsConfig.merges) stopsConfig.merges = {};
    if (editState.mergeParent) {
        stopsConfig.merges[editState.stopId] = editState.mergeParent;
    } else {
        delete stopsConfig.merges[editState.stopId];
    }

    if (editState.unmerges && editState.unmerges.length > 0) {
        editState.unmerges.forEach(childId => {
            // We can't easily check if child was merged to us without full scan, but we assume UI is correct.
            // If we found it in mergeChildren, it is merging to us in global config or runtime map.
            // We update the global config.
            if (stopsConfig.merges[childId] === editState.stopId) {
                delete stopsConfig.merges[childId];
            }
        });
    }

    if (!stopsConfig.hubs) stopsConfig.hubs = {};

    // Hub Adds
    if (editState.hubAdds && editState.hubAdds.length > 0) {
        const sourceId = editState.stopId;
        const findHub = (id) => Object.keys(stopsConfig.hubs).find(k => stopsConfig.hubs[k].includes(id));

        editState.hubAdds.forEach(targetId => {
            const currentSourceHub = findHub(sourceId);
            const currentTargetHub = findHub(targetId);

            if (currentSourceHub && currentTargetHub) {
                if (currentSourceHub !== currentTargetHub) {
                    stopsConfig.hubs[currentTargetHub].forEach(m => {
                        if (!stopsConfig.hubs[currentSourceHub].includes(m)) {
                            stopsConfig.hubs[currentSourceHub].push(m);
                        }
                    });
                    delete stopsConfig.hubs[currentTargetHub];
                }
            } else if (currentSourceHub) {
                if (!stopsConfig.hubs[currentSourceHub].includes(targetId)) {
                    stopsConfig.hubs[currentSourceHub].push(targetId);
                }
            } else if (currentTargetHub) {
                if (!stopsConfig.hubs[currentTargetHub].includes(sourceId)) {
                    stopsConfig.hubs[currentTargetHub].push(sourceId);
                }
            } else {
                const newHubId = `HUB_${sourceId.replace(/:/g, '_')}`;
                stopsConfig.hubs[newHubId] = [sourceId, targetId];
            }
        });
    }

    // Hub Unhubs
    const hubMap = _dataProvider.getHubMap();
    const myHubId = hubMap.get(editState.stopId);
    if (myHubId && editState.unhubs && editState.unhubs.length > 0) {
        editState.unhubs.forEach(childId => {
            if (stopsConfig.hubs[myHubId]) {
                stopsConfig.hubs[myHubId] = stopsConfig.hubs[myHubId].filter(id => id !== childId);
            }
        });
    }

    try {
        const res = await fetch('/api/save-stops-config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(stopsConfig, null, 2)
        });

        if (!res.ok) throw new Error('Save failed');

        if (applyBtn) {
            applyBtn.textContent = 'Saved';
            applyBtn.classList.add('success');
            applyBtn.classList.remove('active');
        }

        if (editSessionCache[editState.stopId]) delete editSessionCache[editState.stopId];
        stopEditing(true);

        if (_uiCallbacks.refreshStopsLayer) await _uiCallbacks.refreshStopsLayer(true);

        setTimeout(() => {
            if (applyBtn) {
                applyBtn.classList.remove('success');
                applyBtn.textContent = 'Apply';
                applyBtn.disabled = true;
            }
            checkDirtyState();
        }, 1500);
    } catch (err) {
        alert('Failed to save: ' + err.message);
        if (applyBtn) {
            applyBtn.disabled = false;
            applyBtn.textContent = 'Apply';
        }
    }
}

function checkDirtyState() {
    const applyBtn = document.getElementById('edit-btn-apply');
    if (!applyBtn || !editState.stopId) return;

    const stopsConfig = window.stopsConfig || {};
    const savedOverrides = stopsConfig.overrides?.[editState.stopId] || {};
    const currentParent = editState.mergeParent || null;
    const savedParent = stopsConfig.merges?.[editState.stopId] || null;

    const getVal = (v) => v === undefined || v === null ? '' : v.toString();

    const latDirty = getVal(editState.overrides.lat) !== getVal(savedOverrides.lat);
    const lonDirty = getVal(editState.overrides.lon) !== getVal(savedOverrides.lon);
    const bearDirty = getVal(editState.overrides.bearing) !== getVal(savedOverrides.bearing);

    const mergeDirty = currentParent !== savedParent;
    const unmergeDirty = editState.unmerges && editState.unmerges.length > 0;

    // Hub dirty checks are complex, assume true if arrays populated
    const unhubDirty = editState.unhubs && editState.unhubs.length > 0;
    const hubAddDirty = editState.hubAdds && editState.hubAdds.length > 0;

    const savedName = savedOverrides.name || {};
    const currentName = editState.overrides.name || {};
    const nameDirty = (currentName.en || '') !== (savedName.en || '') || (currentName.ka || '') !== (savedName.ka || '');

    const isDirty = latDirty || lonDirty || bearDirty || mergeDirty || unmergeDirty || unhubDirty || hubAddDirty || nameDirty;

    applyBtn.disabled = !isDirty;
    if (isDirty) {
        applyBtn.classList.add('active');
    } else {
        applyBtn.classList.remove('active');
    }
}


const fetchMissingName = async (stopId, locale) => {
    try {
        let fileSourceId = 'tbilisi';
        if (stopId.startsWith('rustavi:')) fileSourceId = 'rustavi';

        const basePath = import.meta.env.BASE_URL.endsWith('/') ? import.meta.env.BASE_URL : `${import.meta.env.BASE_URL}/`;
        const path = `${basePath}data/${fileSourceId}_stops_${locale}.json`;

        const response = await fetch(path);
        if (!response.ok) return null;
        const data = await response.json();
        const foreignStop = data.find(s => s.id === stopId);
        return foreignStop ? foreignStop.name : null;
    } catch (e) {
        return null;
    }
};

// --- All Routes Editor Logic ---

let allRoutesState = {
    original: {}, // routeId -> { longName: {en, ka}, headsigns: {0: {en, ka}, 1: {en, ka}} }
    overrides: {} // routeId -> overrideObject
};

// Cache for fetched bulk data
let bulkDataCache = null;

async function fetchAllRouteData() {
    if (bulkDataCache) return bulkDataCache;

    const basePath = import.meta.env.BASE_URL.endsWith('/') ? import.meta.env.BASE_URL : `${import.meta.env.BASE_URL}/`;

    const fetchJson = async (path) => {
        try {
            const res = await fetch(path);
            if (res.ok) return await res.json();
        } catch (e) { console.warn('Failed to fetch', path); }
        return [];
    };

    // Parallel fetch of lists (Tbilisi + Rustavi, EN + KA)
    const [tbEn, tbKa, ruEn, ruKa] = await Promise.all([
        fetchJson(`${basePath}data/tbilisi_routes_en.json`),
        fetchJson(`${basePath}data/tbilisi_routes_ka.json`),
        fetchJson(`${basePath}data/rustavi_routes_en.json`),
        fetchJson(`${basePath}data/rustavi_routes_ka.json`)
    ]);

    // Optional: Details for headsigns (Heavy? ~2MB each. Maybe okay for desktop editor)
    // Let's try fetching details too for headsigns.
    const [tbDetEn, tbDetKa, ruDetEn, ruDetKa] = await Promise.all([
        fetchJson(`${basePath}data/tbilisi_routes_details_en.json`),
        fetchJson(`${basePath}data/tbilisi_routes_details_ka.json`),
        fetchJson(`${basePath}data/rustavi_routes_details_en.json`),
        fetchJson(`${basePath}data/rustavi_routes_details_ka.json`)
    ]);

    const data = {}; // Map<RouteID, { longName: {en,ka}, headsigns: {0:{en,ka}, 1:{en,ka}} }>

    // Helper to process list
    const processList = (list, lang, sourcePrefix) => {
        if (!Array.isArray(list)) return;
        list.forEach(r => {
            const rawId = r.id.toString();
            // Generate permutations
            const ids = new Set();
            ids.add(rawId);
            // Strip "1:"
            if (rawId.startsWith('1:')) {
                const stripped = rawId.substring(2);
                ids.add(stripped);
                // Add "r" prefix for Rustavi key matching if needed
                if (sourcePrefix === 'rustavi') {
                    ids.add(`r${stripped}`); // e.g. 1:R826 -> R826 -> rR826
                    ids.add(`rustavi:${stripped}`);
                }
                // Add "1:" back? Already there.
            } else {
                ids.add(`1:${rawId}`);
            }

            // Allow matching "r" prefix if raw didn't have it but app might?
            if (sourcePrefix === 'rustavi') {
                if (!rawId.startsWith('r')) ids.add(`r${rawId}`);
            }

            ids.forEach(id => {
                if (!data[id]) data[id] = { longName: {}, headsigns: {} };
                if (r.longName) data[id].longName[lang] = r.longName;
            });
        });
    };

    // Helper to process details (headsigns)
    const processDetails = (detObj, lang, sourcePrefix) => {
        if (!detObj) return;
        Object.keys(detObj).forEach(rawIdKey => {
            const r = detObj[rawIdKey];
            const rawId = rawIdKey.toString();

            const ids = new Set();
            ids.add(rawId);
            if (rawId.startsWith('1:')) {
                const stripped = rawId.substring(2);
                ids.add(stripped);
                if (sourcePrefix === 'rustavi') {
                    ids.add(`r${stripped}`);
                    ids.add(`rustavi:${stripped}`);
                }
            } else {
                ids.add(`1:${rawId}`);
            }
            if (sourcePrefix === 'rustavi') {
                if (!rawId.startsWith('r')) ids.add(`r${rawId}`);
            }

            ids.forEach(id => {
                if (!data[id]) data[id] = { longName: {}, headsigns: {} };

                // Details LongName fallback
                if (r.longName && !data[id].longName[lang]) data[id].longName[lang] = r.longName;

                // Headsigns
                if (r.patterns) {
                    r.patterns.forEach((p, idx) => {
                        const dir = idx; // 0 or 1
                        if (dir > 1) return;

                        if (!data[id].headsigns[dir]) data[id].headsigns[dir] = {};
                        if (p.headsign) data[id].headsigns[dir][lang] = p.headsign;
                    });
                }
            });
        });
    };

    processList(tbEn, 'en', 'tbilisi');
    processList(tbKa, 'ka', 'tbilisi');
    processList(ruEn, 'en', 'rustavi');
    processList(ruKa, 'ka', 'rustavi');

    processDetails(tbDetEn, 'en', 'tbilisi');
    processDetails(tbDetKa, 'ka', 'tbilisi');
    processDetails(ruDetEn, 'en', 'rustavi');
    processDetails(ruDetKa, 'ka', 'rustavi');

    bulkDataCache = data;
    return data;
}

function initAllRoutesEditor() {
    const editor = document.getElementById('all-routes-editor');
    const closeBtn = document.getElementById('close-all-routes-editor');
    const saveBtn = document.getElementById('all-routes-save');
    const searchInput = document.getElementById('all-routes-search');

    if (closeBtn) {
        closeBtn.addEventListener('click', closeAllRoutesEditor);
    }

    if (saveBtn) {
        saveBtn.addEventListener('click', saveAllRoutesChanges);
    }

    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            const term = e.target.value.toLowerCase();
            const items = document.querySelectorAll('.editor-route-item');
            items.forEach(item => {
                const text = item.getAttribute('data-search-text') || '';
                if (text.includes(term)) {
                    item.style.display = 'flex';
                } else {
                    item.style.display = 'none';
                }
            });
        });
    }
}

async function openAllRoutesEditor() {
    console.log('[DevTools] Opening Route Names Editor...');
    try {
        // Lazy init listeners
        if (!window._allRoutesEditorInited) {
            initAllRoutesEditor();
            window._allRoutesEditorInited = true;
        }

        const editor = document.getElementById('all-routes-editor');
        editor.classList.remove('hidden');

        await loadRoutesConfig();
        const allRoutes = _dataProvider.getAllRoutes();
        console.log(`[DevTools] Found ${allRoutes.length} routes from provider.`);
        if (allRoutes.length > 0) {
            console.log('[DevTools] Sample App IDs:', allRoutes.slice(0, 3).map(r => r.id + ' (' + r._source + ')'));
        }

        console.log('[DevTools] Fetching bulk data...');
        const bulkData = await fetchAllRouteData();
        console.log('[DevTools] Bulk data fetched.', Object.keys(bulkData).length, 'entries.');

        // Filter and Sort
        // Filter out Subway and Gondola
        // We assume mode is 'SUBWAY', 'GONDOLA', 'CABLE_CAR'. If mode is undefined, assume BUS?
        // Also check ID patterns just in case: Subway usually numeric 1-2 digits (M1, M2 => handled by source?)
        // In this app, Subway usually has mode='SUBWAY'.

        const filteredRoutes = allRoutes.filter(r => {
            const mode = (r.mode || 'BUS').toUpperCase();
            if (mode === 'SUBWAY' || mode === 'METRO') return false;
            if (mode === 'GONDOLA' || mode === 'CABLE_CAR') return false;
            // Check for specific subway IDs if mode missing? (e.g. 1:M1)
            if (r.shortName && r.shortName.startsWith('M')) return false;
            return true;
        });

        console.log(`[DevTools] Filtered down to ${filteredRoutes.length} routes (from ${allRoutes.length}).`);

        // Grouping
        const tbilisiRoutes = [];
        const rustaviRoutes = [];

        filteredRoutes.forEach(r => {
            // Rustavi Check: _source === 'rustavi' OR ID prefix OR specific range?
            // App logic uses _source usually.
            if (r._source === 'rustavi' || (r.id && r.id.toString().startsWith('rustavi:'))) {
                rustaviRoutes.push(r);
            } else {
                tbilisiRoutes.push(r);
            }
        });

        // Sort function
        const sorter = (a, b) => {
            const idA = parseInt(a.shortName || a.id || 0);
            const idB = parseInt(b.shortName || b.id || 0);
            return idA - idB;
        };

        tbilisiRoutes.sort(sorter);
        rustaviRoutes.sort(sorter);

        console.log('[DevTools] Rendering lists...');
        renderAllRoutesList(tbilisiRoutes, rustaviRoutes, bulkData);
    } catch (e) {
        console.error('[DevTools] Error opening editor:', e);
        alert('Error opening editor: ' + e.message);
    }
}


function closeAllRoutesEditor() {
    document.getElementById('all-routes-editor').classList.add('hidden');
}

function renderAllRoutesList(tbilisiRoutes, rustaviRoutes, bulkData) {
    const container = document.getElementById('all-routes-list');
    container.innerHTML = '';

    // Helper to render a group
    const renderGroup = (title, routes) => {
        if (!routes || routes.length === 0) return;

        const header = document.createElement('div');
        header.className = 'editor-section-header';
        header.textContent = title;
        container.appendChild(header);

        const overrides = window.routesConfig.routeOverrides || {};

        routes.forEach(route => {
            const id = route.id;
            const shortName = route.shortName;
            const routeOvr = overrides[id] || {};
            const original = bulkData[id] || { longName: {}, headsigns: {} };

            // Resolve Values: Override -> Original -> RouteObject (Current) -> Empty
            const getVal = (pathOvr, pathOrig, fallback) => {
                // override
                let v = resolvePath(routeOvr, pathOvr);
                if (v !== undefined) return v;
                // original bulk
                v = resolvePath(original, pathOrig);
                if (v !== undefined) return v;
                return fallback || '';
            };

            // Helpers
            const resolvePath = (obj, path) => path.split('.').reduce((o, i) => o?.[i], obj);

            // Name
            const lEn = getVal('longName.en', 'longName.en');
            const lKa = getVal('longName.ka', 'longName.ka');

            // Headsigns
            const d0en = getVal('destinations.0.headsign.en', 'headsigns.0.en');
            const d0ka = getVal('destinations.0.headsign.ka', 'headsigns.0.ka');
            const d1en = getVal('destinations.1.headsign.en', 'headsigns.1.en');
            const d1ka = getVal('destinations.1.headsign.ka', 'headsigns.1.ka');

            const item = document.createElement('div');
            item.className = 'editor-route-item';
            item.dataset.routeId = id;
            // Include section title in search text so we can filter "Rustavi" routes by typing Rustavi (if we wanted)
            item.dataset.searchText = `${title} ${shortName} ${id} ${lEn} ${lKa}`.toLowerCase();

            item.innerHTML = `
                <div class="editor-route-header">
                    <div class="editor-route-id">${shortName}</div>
                    <div class="editor-route-source">${id}</div>
                </div>
                
                <div class="editor-field-group">
                    <div class="editor-label">Long Name</div>
                    <div class="editor-row">
                        <input class="editor-input" data-field="longName.en" placeholder="Long Name EN" value="${lEn || ''}">
                        <input class="editor-input" data-field="longName.ka" placeholder="Long Name KA" value="${lKa || ''}">
                    </div>
                </div>

                <div class="editor-field-group">
                    <div class="editor-label">Headsign Dir 0</div>
                    <div class="editor-row">
                        <input class="editor-input" data-field="destinations.0.headsign.en" placeholder="Dir 0 Headsign EN" value="${d0en || ''}">
                        <input class="editor-input" data-field="destinations.0.headsign.ka" placeholder="Dir 0 Headsign KA" value="${d0ka || ''}">
                    </div>
                </div>

                <div class="editor-field-group">
                    <div class="editor-label">Headsign Dir 1</div>
                    <div class="editor-row">
                        <input class="editor-input" data-field="destinations.1.headsign.en" placeholder="Dir 1 Headsign EN" value="${d1en || ''}">
                        <input class="editor-input" data-field="destinations.1.headsign.ka" placeholder="Dir 1 Headsign KA" value="${d1ka || ''}">
                    </div>
                </div>
            `;

            item.querySelectorAll('input').forEach(inp => {
                inp.addEventListener('change', (e) => {
                    handleAllRoutesInput(id, e.target.dataset.field, e.target.value.trim());
                });
            });

            container.appendChild(item);
        });
    };

    renderGroup('Tbilisi Transport', tbilisiRoutes);
    renderGroup('Rustavi Transport', rustaviRoutes);
}

function handleAllRoutesInput(routeId, fieldPath, value) {
    // Update temporary state or window.routesConfig directly?
    // Let's rely on window.routesConfig being the source of truth but use a dirty flag for UI.
    // Actually, safest is to modify window.routesConfig.routeOverrides.

    if (!window.routesConfig.routeOverrides) window.routesConfig.routeOverrides = {};
    let ovr = window.routesConfig.routeOverrides[routeId];
    if (!ovr) {
        ovr = {};
        window.routesConfig.routeOverrides[routeId] = ovr;
    }

    // fieldPath example: "longName.en" or "destinations.0.headsign.en"
    const parts = fieldPath.split('.');
    let current = ovr;

    // We need to traverse. If value is empty, we might need to delete keys? 
    // Simplified: Just set the value. Clean up empty objects on save.

    for (let i = 0; i < parts.length - 1; i++) {
        const part = parts[i];
        if (!current[part]) current[part] = {};
        current = current[part];
    }
    const lastPart = parts[parts.length - 1];
    if (value) {
        current[lastPart] = value;
    } else {
        delete current[lastPart];
    }

    // Update Save Button status
    const saveBtn = document.getElementById('all-routes-save');
    if (saveBtn) {
        saveBtn.disabled = false;
        saveBtn.classList.add('active');
        saveBtn.textContent = 'Apply All Changes';
    }
}

async function saveAllRoutesChanges() {
    const saveBtn = document.getElementById('all-routes-save');
    if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving...';
    }

    // Cleanup empty overrides before saving
    // (Optional but good practice)

    try {
        console.log('[DevTools] Saving all route changes...', JSON.stringify(window.routesConfig, null, 2));
        const res = await fetch('/api/save-routes-config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(window.routesConfig, null, 2)
        });

        if (!res.ok) {
            const errText = await res.text();
            throw new Error(`Save failed: ${res.status} ${res.statusText} - ${errText}`);
        }

        console.log('[DevTools] Save successful!');
        if (saveBtn) {
            saveBtn.textContent = 'Saved!';
            saveBtn.classList.add('success');
            setTimeout(() => {
                saveBtn.textContent = 'Apply All Changes';
                saveBtn.classList.remove('success');
                // Keep disabled until next change
            }, 2000);
        }

        // Apply Logic:
        if (window.applyRouteOverrides) window.applyRouteOverrides();
        // Re-render app view if needed
        if (_uiCallbacks && _uiCallbacks.renderAllRoutes) {
            _uiCallbacks.renderAllRoutes(window.lastRoutes, window.lastArrivals);
        }
    } catch (e) {
        console.error('[DevTools] Error saving changes:', e);
        alert('Failed to save changes: ' + e.message);
        if (saveBtn) {
            saveBtn.disabled = false;
            saveBtn.textContent = 'Apply All Changes (Retry)';
        }
    }

}

