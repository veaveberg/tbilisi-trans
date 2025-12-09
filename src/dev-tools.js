
import mapboxgl from 'mapbox-gl';

export function initDevTools(map) {
    console.log('Initializing Advanced Dev Tools (Event Listener Fix)...');

    // --- Cleanup (Always remove by Selector to catch everything) ---
    document.querySelectorAll('#dev-tools-fab').forEach(el => el.remove());
    document.querySelectorAll('#dev-tools-panel').forEach(el => el.remove());
    document.querySelectorAll('.picking-mode-banner').forEach(el => el.remove());
    document.querySelectorAll('#dev-tools-style').forEach(el => el.remove());

    // --- Global Handlers ---
    window.toggleDevToolsPanel = function () {
        const p = document.getElementById('dev-tools-panel');
        if (p) {
            p.classList.toggle('visible');
            // Trigger UI update to show/hide marker based on visibility
            updateUI();
        }
    };

    // --- Styles ---
    const style = document.createElement('style');
    style.id = 'dev-tools-style';
    style.textContent = `
        #dev-tools-fab {
            position: fixed; bottom: 20px; left: 20px; width: 50px; height: 50px;
            background: #2563eb; color: white; border-radius: 50%;
            display: flex; align-items: center; justify-content: center;
            font-size: 24px; cursor: pointer; pointer-events: auto;
            box-shadow: 0 4px 12px rgba(0,0,0,0.3); z-index: 999999;
            transition: transform 0.2s; user-select: none;
        }
        #dev-tools-fab:hover { transform: scale(1.1); }
        
        #dev-tools-panel {
            position: fixed; bottom: 80px; left: 20px; width: 340px;
            background: white; border-radius: 12px; padding: 0;
            box-shadow: 0 4px 20px rgba(0,0,0,0.2); z-index: 999999;
            display: none; max-height: 80vh; overflow-y: auto;
            font-family: 'Inter', sans-serif; border: 1px solid #e5e7eb;
        }
        #dev-tools-panel.visible { display: block; }

        .dev-header { padding: 16px; background: #f9fafb; border-radius: 12px 12px 0 0; }
        .dev-header h3 { margin: 0; font-size: 16px; color: #111827; display: flex; justify-content: space-between; align-items: center; }
        .stop-id-badge { font-family: monospace; background: #e0e7ff; color: #3730a3; padding: 2px 6px; border-radius: 4px; font-size: 12px; cursor: pointer; transition: background 0.2s; }
        .stop-id-badge:hover { background: #c7d2fe; }
        .stop-id-badge:active { background: #a5b4fc; }

        .dev-body { padding: 16px; }
        .dev-section { margin-bottom: 20px; }
        .dev-section-title { font-size: 13px; font-weight: 600; color: #6b7280; text-transform: uppercase; margin-bottom: 8px; letter-spacing: 0.05em; }

        .control-row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
        .control-label { font-size: 14px; color: #374151; }
        
        .toggle-switch { position: relative; display: inline-block; width: 36px; height: 20px; }
        .toggle-switch input { opacity: 0; width: 0; height: 0; }
        .slider { position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background-color: #e5e7eb; transition: .4s; border-radius: 20px; }
        .slider:before { position: absolute; content: ""; height: 16px; width: 16px; left: 2px; bottom: 2px; background-color: white; transition: .4s; border-radius: 50%; box-shadow: 0 1px 2px rgba(0,0,0,0.2); }
        input:checked + .slider { background-color: #2563eb; }
        input:checked + .slider:before { transform: translateX(16px); }

        .input-group { display: flex; gap: 8px; margin-top: 8px; }
        .dev-input { flex: 1; padding: 6px 10px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 13px; width: 100%; transition: border-color 0.2s; }
        .dev-input:focus { outline: none; border-color: #2563eb; ring: 2px solid #bfdbfe; }
        .dev-input:disabled { background: #f3f4f6; color: #9ca3af; cursor: not-allowed; }

        .merge-list { list-style: none; padding: 0; margin: 0; display: flex; flex-wrap: wrap; gap: 8px; border: none; }
        .merge-item { padding: 4px 10px; border: 1px solid #e5e7eb; border-radius: 20px; display: inline-flex; align-items: center; font-size: 12px; background: #f3f4f6; color: #374151; gap: 6px; }
        .merge-item:hover { background: #e5e7eb; }
        .unmerge-btn { background: none; border: none; color: #9ca3af; cursor: pointer; padding: 0; font-size: 14px; line-height: 1; display: flex; align-items: center; }
        .unmerge-btn:hover { color: #ef4444; }

        .action-btn { width: 100%; padding: 10px; border: 1px solid transparent; border-radius: 8px; font-weight: 500; cursor: pointer; font-size: 14px; transition: all 0.2s; display: flex; align-items: center; justify-content: center; gap: 8px; box-sizing: border-box; }
        .btn-primary { background: #2563eb; color: white; }
        .btn-primary:hover { background: #1d4ed8; }
        .btn-outline { background: white; border-color: #d1d5db; color: #374151; }
        .btn-outline:hover { background: #f3f4f6; border-color: #9ca3af; }
        .btn-save { background: #16a34a; color: white; }
        .btn-save:hover { background: #15803d; }
        
        .picking-mode-banner {
            position: fixed; top: 20px; left: 50%; transform: translateX(-50%);
            background: #ef4444; color: white; padding: 12px 24px; border-radius: 50px;
            font-weight: 600; box-shadow: 0 4px 12px rgba(239,68,68,0.4);
            z-index: 999999; display: none; cursor: pointer;
        }
    `;
    document.head.appendChild(style);

    // --- DOM Elements ---
    const fab = document.createElement('div');
    fab.id = 'dev-tools-fab';
    fab.innerHTML = '🛠️';
    fab.setAttribute('onclick', 'window.toggleDevToolsPanel()');
    document.body.appendChild(fab);

    const banner = document.createElement('div');
    banner.id = 'picking-mode-banner';
    banner.className = 'picking-mode-banner';
    banner.innerHTML = '🎯 Targeting Mode: Click a stop to merge INTO selected';
    document.body.appendChild(banner);

    const panel = document.createElement('div');
    panel.id = 'dev-tools-panel';
    panel.innerHTML = `
        <div class="dev-header">
            <h3>Edit Stop <span id="dev-stop-id" class="stop-id-badge" title="Click to copy">None</span></h3>
            <div style="display:flex; gap:8px; margin-top:8px">
                <input type="text" id="manual-stop-id" class="dev-input" placeholder="Enter Stop ID" style="padding:4px 8px; font-size:12px">
                <button id="btn-load-stop" class="action-btn btn-outline" style="width:auto; padding:4px 12px; font-size:12px">Load</button>
            </div>
        </div>
        <div class="dev-body">
            <div id="dev-content" style="display:none">
                <!-- Location Section -->
                <div class="dev-section">
                    <div class="control-row">
                        <span class="control-label">Location Override</span>
                        <label class="toggle-switch">
                            <input type="checkbox" id="toggle-loc">
                            <span class="slider"></span>
                        </label>
                    </div>
                    <div class="input-group">
                        <input type="number" step="0.000001" id="inp-lat" class="dev-input" placeholder="Lat" disabled>
                        <input type="number" step="0.000001" id="inp-lon" class="dev-input" placeholder="Lon" disabled>
                    </div>
                    <div style="font-size:11px; color:#6b7280; margin-top:4px">
                        Enable to show drag handle on map.
                    </div>
                </div>

                <!-- Bearing Section -->
                <div class="dev-section">
                    <div class="control-row">
                        <span class="control-label">Bearing Override</span>
                        <label class="toggle-switch">
                            <input type="checkbox" id="toggle-bear">
                            <span class="slider"></span>
                        </label>
                    </div>
                    <div class="input-group">
                        <input type="number" step="1" id="inp-bear" class="dev-input" placeholder="0-360" disabled>
                    </div>
                    <input type="range" min="0" max="360" id="slider-bear" style="width:100%; margin-top:8px; cursor:pointer" disabled>
                </div>

                <!-- Merge Section -->
                <div class="dev-section">
                    <button id="btn-merge-into" class="action-btn btn-outline" style="margin-bottom:8px">
                         <div style="-webkit-mask: url('${import.meta.env.BASE_URL}link.svg') no-repeat center / contain; mask: url('${import.meta.env.BASE_URL}link.svg') no-repeat center / contain; background-color: currentColor; width: 16px; height: 16px; opacity: 0.6; margin-right: 6px;"></div> Merge into...
                    </button>
                    <div id="merge-wrapper" style="display:none; font-size:13px; margin-top:6px; color:#374151; align-items: center; gap: 8px;">
                        <span style="font-weight:500; color:#6b7280; font-size:12px">Merged stops:</span>
                        <div id="merge-list" class="merge-list"></div>
                    </div>
                </div>

                <div style="margin-top:16px; padding-top:16px; display:flex; gap:8px">
                     <button id="btn-reset" class="action-btn btn-outline" style="flex:1; color:#ef4444; border-color:#ef4444;">Reset edits</button>
                     <button id="btn-save" class="action-btn btn-save" style="flex:1">Save</button>
                </div>
                <div id="save-status" style="text-align:center; font-size:12px; margin-top:8px; color:#6b7280; height:16px"></div>
            </div>
            <div id="dev-empty" style="text-align:center; color:#9ca3af; padding:20px">
                Select a stop on the map to edit.
            </div>
        </div>
    `;
    document.body.appendChild(panel);

    // --- State & Markers ---
    let currentStop = null;
    let isPicking = false;
    let mergeSourceId = null; // Store the ID we are merging FROM (the current stop)
    let overrides = window.stopsConfig?.overrides || {};
    let merges = window.stopsConfig?.merges || {};

    const dragMarker = new mapboxgl.Marker({ color: '#f97316', draggable: true });

    // Copy ID Listener
    document.getElementById('dev-stop-id')?.addEventListener('click', (e) => {
        const text = e.target.textContent;
        if (text && text !== 'None') {
            navigator.clipboard.writeText(text).then(() => {
                showStatus('ID Copied!');
                // Visual feedback
                const originalBg = e.target.style.background;
                e.target.style.background = '#86efac'; // Greenish
                setTimeout(() => {
                    e.target.style.background = originalBg;
                    showStatus('');
                }, 1000);
            }).catch(err => {
                console.error('Failed to copy API key: ', err);
            });
        }
    });

    // Toggle Pick Mode
    function setPickMode(active) {
        isPicking = active;
        if (active) {
            if (!currentStop) return;
            mergeSourceId = currentStop.id; // The current stop is the SOURCE
            banner.innerHTML = `
                <div style="display:flex; align-items:center; gap:12px">
                    <span>Select a stop to merge into...</span>
                    <span style="font-size:18px; line-height:1; background:rgba(255,255,255,0.25); width:24px; height:24px; display:flex; align-items:center; justify-content:center; border-radius:50%; flex-shrink:0">×</span>
                </div>
            `;
            banner.style.display = 'block';
            panel.style.display = 'none';
            document.body.style.cursor = 'crosshair';
        } else {
            isPicking = false;
            mergeSourceId = null;
            banner.style.display = 'none';
            panel.style.display = 'block';
            document.body.style.cursor = 'default';
        }
    }
    banner.addEventListener('click', () => setPickMode(false));

    // Update UI
    function updateUI() {
        const idEl = document.getElementById('dev-stop-id');
        const contentEl = document.getElementById('dev-content');
        const emptyEl = document.getElementById('dev-empty');
        const panelEl = document.getElementById('dev-tools-panel');

        if (!idEl || !contentEl || !emptyEl) return;

        if (window.currentStopId !== undefined && window.currentStopId !== null) {
            // ROBUST LOOKUP: Handle string/number mismatch & Partial Matches
            const targetId = String(window.currentStopId).trim();
            console.log('[DevTools] Updating UI for ID:', targetId);

            // 1. Exact Match
            currentStop = window.allStops?.find(s => String(s.id) === targetId);

            // 2. Fuzzy Match (if not found)
            if (!currentStop && window.allStops) {
                console.log('[DevTools] Exact match not found. Trying fuzzy search...');
                // Try endsWith (e.g. user typed "810", real ID "1:810")
                let candidates = window.allStops.filter(s => String(s.id).endsWith(targetId));

                if (candidates.length === 0) {
                    // Try includes
                    candidates = window.allStops.filter(s => String(s.id).includes(targetId));
                }

                if (candidates.length > 0) {
                    console.log(`[DevTools] Found ${candidates.length} fuzzy matches. Using first:`, candidates[0].id);
                    currentStop = candidates[0];
                    // Update the global ID to the real one so other things stay consistent
                    window.currentStopId = currentStop.id;
                }
            }

            if (!currentStop) {
                console.warn('[DevTools] Stop not found in window.allStops for ID:', targetId);
                console.log('window.allStops length:', window.allStops?.length);
                alert(`Stop ID "${targetId}" not found in ${window.allStops?.length || 0} loaded stops.`);
            }
        } else {
            // console.log('[DevTools] No currentStopId set'); // Too verbose for loop
            currentStop = null;
        }

        if (!currentStop) {
            idEl.textContent = 'None';
            contentEl.style.display = 'none';
            emptyEl.style.display = 'block';
            dragMarker.remove();
            return;
        }

        idEl.textContent = currentStop.id;
        contentEl.style.display = 'block';
        emptyEl.style.display = 'none';

        const stopOverride = overrides[currentStop.id];

        // Location
        const hasLocOverride = stopOverride && (stopOverride.lat !== undefined);
        const togLoc = document.getElementById('toggle-loc');
        const inpLat = document.getElementById('inp-lat');
        const inpLon = document.getElementById('inp-lon');

        if (togLoc) togLoc.checked = hasLocOverride;
        if (inpLat) { inpLat.value = currentStop.lat; inpLat.disabled = !hasLocOverride; }
        if (inpLon) { inpLon.value = currentStop.lon; inpLon.disabled = !hasLocOverride; }

        const isPanelVisible = panelEl && panelEl.classList.contains('visible');

        if (hasLocOverride && isPanelVisible) {
            dragMarker.setLngLat([currentStop.lon, currentStop.lat]).addTo(map);
        } else {
            dragMarker.remove();
        }

        // Bearing
        const hasBearOverride = stopOverride && (stopOverride.bearing !== undefined);
        const togBear = document.getElementById('toggle-bear');
        const inpBear = document.getElementById('inp-bear');
        const sliderBear = document.getElementById('slider-bear');

        if (togBear) togBear.checked = hasBearOverride;
        const bearVal = currentStop.bearing || 0;
        if (inpBear) { inpBear.value = bearVal; inpBear.disabled = !hasBearOverride; }
        if (sliderBear) { sliderBear.value = bearVal; sliderBear.disabled = !hasBearOverride; }

        // Merges
        const sources = Object.keys(merges).filter(k => merges[k] === currentStop.id);
        const listEl = document.getElementById('merge-list');
        const wrapperEl = document.getElementById('merge-wrapper');

        if (listEl && wrapperEl) {
            listEl.innerHTML = '';
            if (sources.length > 0) {
                wrapperEl.style.display = 'flex';
                // listEl is likely flex-wrap from CSS
                sources.forEach(sourceId => {
                    const chip = document.createElement('div');
                    chip.className = 'merge-item';
                    chip.innerHTML = `<span>${sourceId}</span><button class="unmerge-btn" data-id="${sourceId}">×</button>`;
                    listEl.appendChild(chip);
                });
                listEl.querySelectorAll('.unmerge-btn').forEach(btn => {
                    btn.addEventListener('click', (e) => {
                        const idToRemove = e.target.dataset.id;
                        delete merges[idToRemove];
                        window.stopsConfig.merges = merges;
                        updateUI();
                        showStatus('Unmerged. Click Save.');
                    });
                });
            } else {
                wrapperEl.style.display = 'none';
            }
        }

        // Reset Button State
        const btnReset = document.getElementById('btn-reset');
        if (btnReset) {
            const hasOverrides = overrides[currentStop.id] && Object.keys(overrides[currentStop.id]).length > 0;
            if (hasOverrides) {
                btnReset.style.opacity = '1';
                btnReset.style.pointerEvents = 'auto';
                btnReset.style.borderColor = '#ef4444';
                btnReset.style.color = '#ef4444';
            } else {
                btnReset.style.opacity = '0.5';
                btnReset.style.pointerEvents = 'none';
                btnReset.style.borderColor = '#d1d5db';
                btnReset.style.color = '#9ca3af';
            }
        }
    }

    // --- Listeners ---
    dragMarker.on('dragend', () => {
        if (!currentStop) return;
        const ll = dragMarker.getLngLat();
        if (!overrides[currentStop.id]) overrides[currentStop.id] = {};

        overrides[currentStop.id].lat = Number(ll.lat.toFixed(6));
        overrides[currentStop.id].lon = Number(ll.lng.toFixed(6));

        // Sync to object
        currentStop.lat = ll.lat;
        currentStop.lon = ll.lng;

        // Push to global config
        window.stopsConfig.overrides = overrides;

        updateUI();
        showStatus('Moved! Click Save.');
    });

    document.getElementById('toggle-loc')?.addEventListener('change', (e) => {
        if (!currentStop) return;
        if (e.target.checked) {
            if (!overrides[currentStop.id]) overrides[currentStop.id] = {};
            overrides[currentStop.id].lat = currentStop.lat; // seed with current
            overrides[currentStop.id].lon = currentStop.lon;
        } else {
            if (overrides[currentStop.id]) {
                delete overrides[currentStop.id].lat;
                delete overrides[currentStop.id].lon;
                // Clean up empty objects
                if (Object.keys(overrides[currentStop.id]).length === 0) delete overrides[currentStop.id];
            }
            // Revert state (needs generic reload, but for now we trust)
            // Ideally we reload 'currentStop' from master source, but that's hard.
            // We just update UI to disable fields.
        }
        window.stopsConfig.overrides = overrides;
        updateUI();
    });

    // Manual Lat/Lon Inputs
    ['inp-lat', 'inp-lon'].forEach(id => {
        document.getElementById(id)?.addEventListener('change', (e) => {
            if (!currentStop) return;
            const val = parseFloat(e.target.value);
            if (isNaN(val)) return;

            if (!overrides[currentStop.id]) overrides[currentStop.id] = {};
            if (id === 'inp-lat') {
                overrides[currentStop.id].lat = val;
                currentStop.lat = val;
            } else {
                overrides[currentStop.id].lon = val;
                currentStop.lon = val;
            }
            window.stopsConfig.overrides = overrides;
            updateUI();
            showStatus('Updated! Click Save.');
        });
    });

    document.getElementById('toggle-bear')?.addEventListener('change', (e) => {
        if (!currentStop) return;
        if (e.target.checked) {
            if (!overrides[currentStop.id]) overrides[currentStop.id] = {};
            overrides[currentStop.id].bearing = currentStop.bearing || 0;
        } else {
            if (overrides[currentStop.id]) {
                delete overrides[currentStop.id].bearing;
                if (Object.keys(overrides[currentStop.id]).length === 0) delete overrides[currentStop.id];
            }
            currentStop.bearing = 0; // simplistic revert
        }
        window.stopsConfig.overrides = overrides;
        updateUI();
    });

    const updateBearing = (val) => {
        if (!currentStop) return;
        if (overrides[currentStop.id]) overrides[currentStop.id].bearing = val;
        currentStop.bearing = val;

        // Update Selection Highlight
        const source = map.getSource('selected-stop');
        if (source) {
            source.setData({
                type: 'FeatureCollection',
                features: [{
                    type: 'Feature',
                    geometry: { type: 'Point', coordinates: [currentStop.lon, currentStop.lat] },
                    properties: {
                        ...currentStop,
                        bearing: Number(currentStop.bearing || 0) // Ensure Number
                    }
                }]
            });
        }
        window.stopsConfig.overrides = overrides;

        // Local UI Sync (avoid full updateUI to prevent focus loss if possible, but harmless here)
        const inp = document.getElementById('inp-bear');
        const slide = document.getElementById('slider-bear');
        if (inp && inp.value != val) inp.value = val;
        if (slide && slide.value != val) slide.value = val;
    };

    document.getElementById('inp-bear')?.addEventListener('input', (e) => {
        const val = parseInt(e.target.value) || 0;
        updateBearing(val);
    });

    document.getElementById('slider-bear')?.addEventListener('input', (e) => {
        const val = parseInt(e.target.value) || 0;
        showStatus(`Bearing: ${val}°`);
        updateBearing(val);
    });

    document.getElementById('btn-merge-into')?.addEventListener('click', () => {
        if (!currentStop) return;
        setPickMode(true);
    });


    // --- Merge Picker Listener (Robust) ---
    const targetLayers = ['stops-layer', 'metro-layer-circle', 'metro-layer-label', 'metro-transfer-layer'];

    map.on('click', (e) => {
        console.log('[DevTools] Global Map Click. PickMode:', isPicking, 'Source:', mergeSourceId);

        if (!isPicking || !mergeSourceId) return;

        // Query all relevant layers at the click point
        // This works even if layers are added later, as long as they exist NOW
        const features = map.queryRenderedFeatures(e.point, { layers: targetLayers });
        console.log('[DevTools] Clicked features:', features.map(f => `${f.layer.id}:${f.properties.id}`));

        if (!features.length) {
            console.log('[DevTools] No features found in target layers at this point.');
            return;
        }

        const feature = features[0];
        const pickedTargetId = feature.properties.id; // Handled as TARGET
        console.log('[DevTools] Picked Target ID:', pickedTargetId);

        if (String(pickedTargetId) === String(mergeSourceId)) {
            alert("Cannot merge stop into itself.");
            return;
        }

        // Custom Confirmation UI instead of window.confirm
        const banner = document.getElementById('picking-mode-banner');
        if (banner) {
            banner.innerHTML = `
                <div style="pointer-events: auto; display:flex; align-items:center; justify-content:center; gap:10px">
                     <span>Merge <b>${mergeSourceId}</b> INTO <b>${pickedTargetId}</b>?</span>
                     <button id="btn-confirm-yes" class="action-btn" style="padding:4px 12px; height:auto; font-size:12px;">Yes</button>
                     <button id="btn-confirm-no" class="action-btn btn-outline" style="padding:4px 12px; height:auto; font-size:12px; background:white; color:black;">Cancel</button>
                </div>
             `;
            banner.style.display = 'block'; // Ensure it's visible

            // Prevent map clicks from triggering again immediately
            isPicking = false;

            document.getElementById('btn-confirm-yes').onclick = (ev) => {
                ev.stopPropagation();
                merges[mergeSourceId] = pickedTargetId; // SOURCE -> TARGET
                window.stopsConfig.merges = merges;

                // Reset
                banner.style.display = 'none';
                panel.style.display = 'block';
                document.body.style.cursor = 'default';

                // Switch focus to the TARGET stop, because the source is now technically "gone" (merged)
                window.selectDevStop(pickedTargetId);
                mergeSourceId = null;

                showStatus('Merged! Click Save.');
            };

            document.getElementById('btn-confirm-no').onclick = (ev) => {
                ev.stopPropagation();
                // Cancelled
                banner.style.display = 'none';
                panel.style.display = 'block';
                document.body.style.cursor = 'default';
                mergeSourceId = null;
            };
        }
    });

    document.getElementById('btn-save')?.addEventListener('click', () => {
        if (window.configLoaded === false) {
            alert("CRITICAL: Configuration failed to load. Saving now would overwrite your data with empty fields. Please fix the loading error first.");
            return;
        }

        const btn = document.getElementById('btn-save');
        const originalText = btn.textContent;
        btn.textContent = 'Saving...';
        btn.disabled = true;

        fetch('/api/save-stops-config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(window.stopsConfig, null, 2)
        })
            .then(res => {
                if (res.ok) {
                    showStatus('Saved successfully! Reload (Cmd+R) to apply.');
                    // setTimeout(() => showStatus('Reload (Cmd+R) to apply.'), 2000);
                } else {
                    return res.text().then(text => { throw new Error(text); });
                }
            })
            .catch(e => {
                alert('Save failed: ' + e.message + '. Ensure dev server is running.');
                showStatus('Save failed!');
            })
            .finally(() => {
                btn.textContent = originalText;
                btn.disabled = false;
            });
    });

    function showStatus(msg) {
        const el = document.getElementById('save-status');
        if (el) el.textContent = msg;
    }

    // --- Expose Global API for Main App ---
    window.selectDevStop = function (id) {
        console.log('[DevTools] Window requested select stop:', id);
        window.currentStopId = id;
        updateUI();
    };

    // Polling Loop for ID changes (Backup - in case main.js sets currentStopId but doesn't call selectDevStop)
    let lastId = null;
    setInterval(() => {
        if (window.currentStopId !== lastId) {
            console.log('[DevTools] Poller detected ID change:', window.currentStopId);
            lastId = window.currentStopId;
            updateUI();
        }
    }, 500);

    // Initial Trigger
    if (window.currentStopId) {
        updateUI();
    }

    // Download JSON Listener
    document.getElementById('btn-download')?.addEventListener('click', () => {
        const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(window.stopsConfig, null, 2));
        const downloadAnchorNode = document.createElement('a');
        downloadAnchorNode.setAttribute("href", dataStr);
        downloadAnchorNode.setAttribute("download", "stops_config.json");
        document.body.appendChild(downloadAnchorNode); // required for firefox
        downloadAnchorNode.click();
        downloadAnchorNode.remove();
        showStatus('Downloaded!');
    });

    // Manual Load Listener
    const loadBtn = document.getElementById('btn-load-stop');
    if (loadBtn) {
        console.log('[DevTools] Attaching listener to Load Button');
        loadBtn.addEventListener('click', () => {
            console.log('[DevTools] Load Button Clicked');
            const val = document.getElementById('manual-stop-id').value.trim();
            console.log('[DevTools] Input value:', val);
            if (val) {
                window.selectDevStop(val);
            } else {
                console.warn('[DevTools] Empty input');
            }
        });
    } else {
        console.error('[DevTools] Load Button NOT found in DOM during init');
    }
}
