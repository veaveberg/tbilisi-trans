
import mapboxgl from 'mapbox-gl';

// --- State ---
let isEditing = false;
let editState = {
    stopId: null,
    overrides: {}, // { lat, lon, rotation }
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

    // All text inputs
    const inputs = [
        'route-edit-long-en', 'route-edit-long-ka', 'route-edit-long-ru',
        'route-edit-dest0-en', 'route-edit-dest0-ka', 'route-edit-dest0-ru',
        'route-edit-dest1-en', 'route-edit-dest1-ka', 'route-edit-dest1-ru',
        'route-edit-terminus'
    ];

    inputs.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('input', updateEditedOverrides);
    });

    if (applyBtn) applyBtn.addEventListener('click', async () => {
        await saveRouteOverrides();
    });
}

function updateEditedOverrides() {
    const getVal = (id) => {
        const el = document.getElementById(id);
        return el ? el.value.trim() : '';
    };

    const isLoopBtn = document.getElementById('route-edit-isloop');
    const isLoop = isLoopBtn ? isLoopBtn.classList.contains('active') : false;

    // Build the edited overrides object to match CSV column names
    const edited = routeEditState.editedOverrides || {};

    // isLoop & invertDirection
    edited.isLoop = isLoop;
    const invertBtn = document.getElementById('route-edit-invert');
    edited.invertDirection = invertBtn ? invertBtn.classList.contains('active') : false;

    // Terminus
    const terminus = getVal('route-edit-terminus');
    if (terminus) {
        edited.terminusStopIdOverride = terminus;
    } else {
        delete edited.terminusStopIdOverride;
    }



    // Long name overrides (these are always overrides, stored separately from base)
    const longEn = getVal('route-edit-long-en');
    const longKa = getVal('route-edit-long-ka');
    const longRu = getVal('route-edit-long-ru');

    if (longEn) edited.longNameEnOverride = longEn; else delete edited.longNameEnOverride;
    if (longKa) edited.longNameKaOverride = longKa; else delete edited.longNameKaOverride;
    if (longRu) edited.longNameRuOverride = longRu; else delete edited.longNameRuOverride;

    // Destination overrides
    const dest0En = getVal('route-edit-dest0-en');
    const dest0Ka = getVal('route-edit-dest0-ka');
    const dest0Ru = getVal('route-edit-dest0-ru');
    const dest1En = getVal('route-edit-dest1-en');
    const dest1Ka = getVal('route-edit-dest1-ka');
    const dest1Ru = getVal('route-edit-dest1-ru');

    const origDest0En = routeEditState.csvOverrides?.dest0En || '';
    const origDest0Ka = routeEditState.csvOverrides?.dest0Ka || '';
    const origDest1En = routeEditState.csvOverrides?.dest1En || '';
    const origDest1Ka = routeEditState.csvOverrides?.dest1Ka || '';

    // Only store as override if different from base
    if (dest0En && dest0En !== origDest0En) edited.dest0EnOverride = dest0En; else delete edited.dest0EnOverride;
    if (dest0Ka && dest0Ka !== origDest0Ka) edited.dest0KaOverride = dest0Ka; else delete edited.dest0KaOverride;
    if (dest0Ru) edited.dest0RuOverride = dest0Ru; else delete edited.dest0RuOverride;
    if (dest1En && dest1En !== origDest1En) edited.dest1EnOverride = dest1En; else delete edited.dest1EnOverride;
    if (dest1Ka && dest1Ka !== origDest1Ka) edited.dest1KaOverride = dest1Ka; else delete edited.dest1KaOverride;
    if (dest1Ru) edited.dest1RuOverride = dest1Ru; else delete edited.dest1RuOverride;

    routeEditState.editedOverrides = edited;
    checkRouteDirtyState();
}

async function startEditingRoute(routeId) {
    // 1. Identify Valid ID (Prefix handling)
    const allRoutes = _dataProvider.getAllRoutes();
    const routeObj = allRoutes.find(r => String(r.id) === String(routeId) || String(r.id) === `1:${routeId}`);

    if (!routeObj) {
        console.warn('Could not find route to edit:', routeId);
        return;
    }

    const stableId = routeObj.id;
    routeEditState.routeId = stableId;
    routeEditState.routeObj = routeObj;

    // Fetch overrides from Convex
    let convexOverrides = {};
    try {
        // Use route's _source if available, or infer from ID prefix
        let sourceId = routeObj._source || 'tbilisi';
        if (stableId.startsWith('r') && stableId.length > 1 && stableId[1] === 'R') {
            sourceId = 'rustavi';
        }

        const { convex, restoreApiId, sources } = await import('./api.js');
        const source = sources.find(s => s.id === sourceId) || sources[0];
        const dbRouteId = restoreApiId(stableId, source);

        const override = await convex.query("transit:getOverride", { routeId: dbRouteId });

        if (override) {
            console.log('[Edit] Found override in Convex:', override);
            // Map Convex field names to internal field names
            // Convex has both base values (longName_en) and override values (longName_en_override)
            convexOverrides = {
                isLoop: override.isLoop,
                invertDirection: override.invertDirection,
                // Base values (from CSV import)
                longNameEn: override.longName_en,
                longNameKa: override.longName_ka,
                longNameRu: override.longName_ru,
                dest0En: override.dest0_en,
                dest0Ka: override.dest0_ka,
                dest0Ru: override.dest0_ru,
                dest1En: override.dest1_en,
                dest1Ka: override.dest1_ka,
                dest1Ru: override.dest1_ru,
                terminusStopId: override.terminusStopId,
                terminusStopName: override.terminusStopName,
                // Override values (user edits)
                terminusStopIdOverride: override.terminusStopId_override,
                longNameEnOverride: override.longName_en_override,
                longNameKaOverride: override.longName_ka_override,
                longNameRuOverride: override.longName_ru_override,
                dest0EnOverride: override.dest0_en_override,
                dest0KaOverride: override.dest0_ka_override,
                dest0RuOverride: override.dest0_ru_override,
                dest1EnOverride: override.dest1_en_override,
                dest1KaOverride: override.dest1_ka_override,
                dest1RuOverride: override.dest1_ru_override,
            };
            // Clean undefined values
            Object.keys(convexOverrides).forEach(k => {
                if (convexOverrides[k] === undefined) delete convexOverrides[k];
            });
        } else {
            console.log('[Edit] No override found in Convex for', dbRouteId);
        }
    } catch (e) {
        console.warn('[Edit] Failed to fetch override from Convex:', e);
    }

    routeEditState.csvRouteId = stableId;
    routeEditState.csvOverrides = JSON.parse(JSON.stringify(convexOverrides));
    routeEditState.editedOverrides = JSON.parse(JSON.stringify(convexOverrides));

    const setVal = (id, v) => {
        const el = document.getElementById(id);
        if (el) el.value = (v || '');
    };

    const setOriginal = (id, v) => {
        const el = document.getElementById(id);
        if (el) {
            el.textContent = v || '';
        }
    };

    console.log('[Edit] Loading route data from Convex overrides:', convexOverrides);

    // --- Debug Info ---
    const debugId = document.getElementById('route-edit-debug-id');
    const debugShort = document.getElementById('route-edit-debug-short');
    if (debugId) debugId.textContent = routeId;
    if (debugShort) debugShort.textContent = routeObj.shortName || '-';

    // --- Inline Original Values ---
    const getOrig = (csvKey, routeVal) => {
        // Prefer explicit base value from Convex if available, else use current route object value
        return convexOverrides[csvKey] || routeVal || '';
    };

    // Helper to get base destinations from various possible sources
    const getBaseDest = (dirIndex, lang) => {
        // 1. Try Convex Override
        const csvKey = `dest${dirIndex}${lang.charAt(0).toUpperCase()}${lang.slice(1)}`;
        if (convexOverrides[csvKey]) return convexOverrides[csvKey];

        // 2. Try window.currentRoute (most likely to have patterns if active on map)
        const curRoute = window.currentRoute;
        if (curRoute && (String(curRoute.id) === String(routeId) || curRoute.shortName === routeObj.shortName)) {
            // Check patterns/destinations
            const patterns = curRoute.patterns || curRoute.destinations;
            if (patterns && patterns[dirIndex]) {
                const headsign = patterns[dirIndex].headsign;
                if (typeof headsign === 'object' && headsign[lang]) return headsign[lang];
                if (typeof headsign === 'string' && lang === (new URLSearchParams(window.location.search).get('locale') || 'en')) return headsign;
            }
        }

        // 3. Try routeObj (from allRoutes)
        const patterns = routeObj.patterns || routeObj.destinations;
        if (patterns && patterns[dirIndex]) {
            const headsign = patterns[dirIndex].headsign;
            if (typeof headsign === 'object' && headsign[lang]) return headsign[lang];
        }

        // 4. Fallback: Parse longName (only for en/ka, not ru since API doesn't provide ru)
        if (lang === 'ru') return '';  // No Russian data from API
        const longName = routeObj.longName?.[lang] || (typeof routeObj.longName === 'string' && lang === 'en' ? routeObj.longName : '');
        if (longName && longName.includes(' - ')) {
            const parts = longName.split(' - ');
            if (dirIndex === 0) return parts[0];
            if (dirIndex === 1) return parts[1] || parts[0]; // For loop/circular
        }

        return '';
    };

    setOriginal('route-orig-long-en', getOrig('longNameEn', routeObj.longName?.en));
    setOriginal('route-orig-long-ka', getOrig('longNameKa', routeObj.longName?.ka));
    setOriginal('route-orig-long-ru', getOrig('longNameRu', routeObj.longName?.ru));

    setOriginal('route-orig-dest0-en', getBaseDest(0, 'en'));
    setOriginal('route-orig-dest0-ka', getBaseDest(0, 'ka'));
    setOriginal('route-orig-dest0-ru', getBaseDest(0, 'ru'));
    setOriginal('route-orig-dest1-en', getBaseDest(1, 'en'));
    setOriginal('route-orig-dest1-ka', getBaseDest(1, 'ka'));
    setOriginal('route-orig-dest1-ru', getBaseDest(1, 'ru'));

    // --- Populate UI from Convex Overrides ---

    // Loop settings
    const isLoopBtn = document.getElementById('route-edit-isloop');
    const terminusGroup = document.getElementById('route-edit-terminus-group');
    if (isLoopBtn) {
        const isLoop = convexOverrides.isLoop === true || convexOverrides.isLoop === 'true';
        isLoopBtn.classList.toggle('active', isLoop);
        if (terminusGroup) terminusGroup.style.display = isLoop ? 'flex' : 'none';

        // Add one-time listener for the toggle if not already added
        if (!isLoopBtn._hasToggleListener) {
            isLoopBtn.addEventListener('click', () => {
                isLoopBtn.classList.toggle('active');
                const active = isLoopBtn.classList.contains('active');
                if (terminusGroup) terminusGroup.style.display = active ? 'flex' : 'none';
                updateEditedOverrides();
            });
            isLoopBtn._hasToggleListener = true;
        }
    }

    // Invert Direction
    const invertBtn = document.getElementById('route-edit-invert');
    if (invertBtn) {
        const invert = convexOverrides.invertDirection === true || convexOverrides.invertDirection === 'true';
        invertBtn.classList.toggle('active', invert);

        if (!invertBtn._hasToggleListener) {
            invertBtn.addEventListener('click', () => {
                invertBtn.classList.toggle('active');
                updateEditedOverrides();
            });
            invertBtn._hasToggleListener = true;
        }
    }


    setVal('route-edit-terminus', convexOverrides.terminusStopIdOverride || convexOverrides.terminusStopId || '');

    const terminusNameEl = document.getElementById('route-edit-terminus-name');
    if (terminusNameEl) {
        terminusNameEl.textContent = convexOverrides.terminusStopName || '';
    }

    // Long name overrides (only overrides, not base values)
    setVal('route-edit-long-en', convexOverrides.longNameEnOverride || '');
    setVal('route-edit-long-ka', convexOverrides.longNameKaOverride || '');
    setVal('route-edit-long-ru', convexOverrides.longNameRuOverride || '');

    // Destinations (only show override values, not base values - those are in the "original" display)
    setVal('route-edit-dest0-en', convexOverrides.dest0EnOverride || '');
    setVal('route-edit-dest0-ka', convexOverrides.dest0KaOverride || '');
    setVal('route-edit-dest0-ru', convexOverrides.dest0RuOverride || '');
    setVal('route-edit-dest1-en', convexOverrides.dest1EnOverride || '');
    setVal('route-edit-dest1-ka', convexOverrides.dest1KaOverride || '');
    setVal('route-edit-dest1-ru', convexOverrides.dest1RuOverride || '');

    checkRouteDirtyState();
}

function checkRouteDirtyState() {
    const applyBtn = document.getElementById('route-edit-apply');

    // Compare editedOverrides with csvOverrides to detect changes
    const original = routeEditState.csvOverrides || {};
    const edited = routeEditState.editedOverrides || {};

    const isDirty = JSON.stringify(original) !== JSON.stringify(edited);

    if (applyBtn) {
        applyBtn.disabled = !isDirty;
        applyBtn.classList.toggle('active', isDirty);
    }
}

function updateRouteRestoreButtons() {
    // Could highlight restore buttons when field differs from original
    // Implementation not critical for now
}

async function saveRouteOverrides() {
    const routeId = routeEditState.csvRouteId || routeEditState.routeId;
    const editedOverrides = routeEditState.editedOverrides || {};

    const applyBtn = document.getElementById('route-edit-apply');
    if (applyBtn) {
        applyBtn.disabled = true;
        applyBtn.textContent = 'Saving...';
    }

    try {
        // Build the update payload for Convex
        const updates = {};

        if (editedOverrides.isLoop !== undefined) {
            updates.isLoop = editedOverrides.isLoop;
        }
        if (editedOverrides.invertDirection !== undefined) {
            updates.invertDirection = editedOverrides.invertDirection;
        }
        if (editedOverrides.terminusStopIdOverride !== undefined) {
            updates.terminusStopId_override = editedOverrides.terminusStopIdOverride;
        }
        if (editedOverrides.longNameEnOverride !== undefined) {
            updates.longName_en_override = editedOverrides.longNameEnOverride;
        }
        if (editedOverrides.longNameKaOverride !== undefined) {
            updates.longName_ka_override = editedOverrides.longNameKaOverride;
        }
        if (editedOverrides.longNameRuOverride !== undefined) {
            updates.longName_ru_override = editedOverrides.longNameRuOverride;
        }
        if (editedOverrides.dest0EnOverride !== undefined) {
            updates.dest0_en_override = editedOverrides.dest0EnOverride;
        }
        if (editedOverrides.dest0KaOverride !== undefined) {
            updates.dest0_ka_override = editedOverrides.dest0KaOverride;
        }
        if (editedOverrides.dest0RuOverride !== undefined) {
            updates.dest0_ru_override = editedOverrides.dest0RuOverride;
        }
        if (editedOverrides.dest1EnOverride !== undefined) {
            updates.dest1_en_override = editedOverrides.dest1EnOverride;
        }
        if (editedOverrides.dest1KaOverride !== undefined) {
            updates.dest1_ka_override = editedOverrides.dest1KaOverride;
        }
        if (editedOverrides.dest1RuOverride !== undefined) {
            updates.dest1_ru_override = editedOverrides.dest1RuOverride;
        }

        // Use route's _source if available, or infer from ID prefix
        let sourceId = routeEditState.routeObj?._source || 'tbilisi';
        if (String(routeId).startsWith('r') && String(routeId).length > 1 && String(routeId)[1] === 'R') {
            sourceId = 'rustavi';
        }

        const { convex, restoreApiId, sources } = await import('./api.js');
        const source = sources.find(s => s.id === sourceId) || sources[0];
        const dbRouteId = restoreApiId(String(routeId), source);

        console.log('[DevTools] Saving route overrides to Convex:', { routeId: dbRouteId, updates });

        // Call Convex mutation
        const result = await convex.mutation("transit:updateOverride", {
            routeId: dbRouteId,
            updates
        });

        console.log('[DevTools] Route override saved successfully:', result);

        if (applyBtn) {
            applyBtn.textContent = 'Saved!';
            applyBtn.classList.add('success');
        }

        // Update the local route object's _overrides to reflect the change
        if (routeEditState.routeObj) {
            routeEditState.routeObj._overrides = { ...editedOverrides };
        }

        // Update csvOverrides to match edited (so dirty state is cleared)
        routeEditState.csvOverrides = JSON.parse(JSON.stringify(editedOverrides));

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
            delete editState.overrides.rotation;
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

    if (editState.overrides.rotation !== undefined) {
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

    const rotation = editState.overrides.rotation !== undefined ? editState.overrides.rotation : (stop.rotation || 0);

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
            .setRotation(rotation)
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

                editState.overrides.rotation = newBearing;
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
        editLocMarker.setRotation(rotation);
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

    const api = await import('./api.js');

    // Create a cleaned version for saving with fully qualified API IDs
    const saveStopsConfig = {
        overrides: {},
        merges: {},
        hubs: {}
    };

    Object.keys(stopsConfig.overrides || {}).forEach(id => {
        saveStopsConfig.overrides[api.getApiId(id)] = stopsConfig.overrides[id];
    });

    Object.keys(stopsConfig.merges || {}).forEach(id => {
        saveStopsConfig.merges[api.getApiId(id)] = api.getApiId(stopsConfig.merges[id]);
    });

    Object.keys(stopsConfig.hubs || {}).forEach(hubId => {
        // Hub IDs are internal (e.g. HUB_1_811), no need to getApiId for the key
        saveStopsConfig.hubs[hubId] = (stopsConfig.hubs[hubId] || []).map(id => api.getApiId(id));
    });

    try {
        console.log('[DevTools] Sending save request with config:', {
            overrides: Object.keys(saveStopsConfig.overrides).length,
            merges: Object.keys(saveStopsConfig.merges).length,
            hubs: Object.keys(saveStopsConfig.hubs).length,
            sampleOverride: Object.keys(saveStopsConfig.overrides)[0]
        });

        const res = await fetch('/api/save-stops-config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(saveStopsConfig, null, 2)
        });

        console.log('[DevTools] Save response:', res.status, res.statusText);

        if (!res.ok) {
            const errorText = await res.text();
            console.error('[DevTools] Save failed with error:', errorText);
            throw new Error('Save failed: ' + errorText);
        }

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
    const bearDirty = getVal(editState.overrides.rotation) !== getVal(savedOverrides.rotation);

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

