import mapboxgl from 'mapbox-gl';
import { map } from './map-setup.js';
import { historyManager } from './history.js';
import { setMapFocus } from './map-interactions.js';

import { getCurrentMapLanguage, onLanguageChange, t } from './i18n.ts';
import { setSheetState, setPanelState } from './panel-manager.js';
import { setPoint, openDirections, toggleDirections, clearPoint } from './directions.js';
import { getLastUserCoords } from './geolocation.js';
import { flyToPointInView, getBandPadding, invalidateMapCameraIntent } from './map-camera.js';
import { arrivalsController } from './arrivals-controller.js';

let suggestionMarkers = [];


let appCallbacks = {
    onRouteSelect: null,
    onStopSelect: null,
    onClickPlace: null
};

let appData = {
    getAllStops: () => [],
    getAllRoutes: () => []
};

export function isSearchActive() {
    const input = document.getElementById('search-input');
    const suggestions = document.getElementById('search-suggestions');
    return document.activeElement === input || !suggestions?.classList.contains('hidden');
}

export function dismissSearch() {
    const input = document.getElementById('search-input');
    const suggestions = document.getElementById('search-suggestions');
    const closeBtn = document.getElementById('search-close');

    suggestions?.classList.add('hidden');
    closeBtn?.classList.add('hidden');
    input?.blur();
    clearSearchSuggestionMarkers();
}

export function setupSearch(callbacks, dataProviders) {
    appCallbacks = { ...appCallbacks, ...callbacks };
    appData = { ...appData, ...dataProviders };

    const input = document.getElementById('search-input');
    const suggestions = document.getElementById('search-suggestions');
    const clearBtn = document.getElementById('search-clear');
    const closeBtn = document.getElementById('search-close');
    let debounceTimeout;

    // DEBUG: Log clicks in suggestions to diagnose blocking
    // suggestions.addEventListener('click', (e) => {
    //     console.log('[UI Debug] Suggestions Container Click:', e.target.tagName, e.target.className);
    // });

    // Event Delegation for Delete Buttons (Capture Phase to stop propagation)
    suggestions.addEventListener('click', (e) => {
        const deleteBtn = e.target.closest('.suggestion-delete-btn');
        if (deleteBtn) {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();

            const item = deleteBtn._item;
            const historyType = deleteBtn._historyType;

            // console.log('[UI] Delegated Delete Click:', historyType, item);

            // Check expansion state
            const showMoreExists = !!document.querySelector('.show-more-btn');
            const wasExpanded = !showMoreExists;

            if (historyType === 'search') {
                historyManager.removeSearch(item);
            } else if (historyType === 'card') {
                historyManager.removeCard(item);
            }

            renderFullHistory(wasExpanded);
        }
    }, true); // CAPTURE PHASE

    function updateClearBtn() {
        if (input.value.length > 0) {
            clearBtn.classList.remove('hidden');
        } else {
            clearBtn.classList.add('hidden');
        }
    }

    clearBtn.addEventListener('click', () => {
        input.value = '';
        if (!(window.Capacitor?.isNativePlatform?.() && window.Capacitor?.getPlatform?.() === 'ios')) {
            input.focus();
        }
        updateClearBtn();
        renderFullHistory();
        clearSearchSuggestionMarkers();
    });

    // Show history on focus if empty, or restore search suggestions if there's already query text
    const showSuggestionsOnFocus = () => {
        const query = input.value.trim();
        if (query === '') {
            renderFullHistory();
        } else if (query.length >= 2) {
            suggestions.classList.remove('hidden');
            // Re-trigger input event to refresh results
            input.dispatchEvent(new Event('input'));
        }
    };

    input.addEventListener('focus', () => {
        closeBtn.classList.remove('hidden');
        document.dispatchEvent(new Event('search-opened'));
        showSuggestionsOnFocus();
    });
    input.addEventListener('click', () => {
        closeBtn.classList.remove('hidden');
        document.dispatchEvent(new Event('search-opened'));
        showSuggestionsOnFocus();
    });
    input.addEventListener('blur', () => {
        setTimeout(() => {
            suggestions.classList.add('hidden');
            closeBtn.classList.add('hidden');
            clearSearchSuggestionMarkers();
        }, 200);
    });

    closeBtn.addEventListener('click', dismissSearch);

    input.addEventListener('input', (e) => {
        const query = e.target.value.toLowerCase();
        updateClearBtn();

        clearTimeout(debounceTimeout);
        debounceTimeout = setTimeout(async () => {

            if (query.length < 2) {
                if (query.length === 0) {
                    renderFullHistory();
                    clearSearchSuggestionMarkers();
                    return;
                }
                suggestions.classList.add('hidden');
                clearSearchSuggestionMarkers();
                return;
            }

            // 1. Local Search (Stops & Routes) - Render IMMEDIATELY
            const allStops = appData.getAllStops();
            const allRoutes = appData.getAllRoutes();

            const matchedStops = allStops.filter(stop =>
                (stop.name && stop.name.toLowerCase().includes(query)) ||
                (stop.code && stop.code.includes(query))
            ).slice(0, 5);

            const matchedRoutes = allRoutes.filter(route =>
                (route.shortName && route.shortName.toLowerCase().includes(query)) ||
                (route.longName && route.longName.toLowerCase().includes(query))
            ).slice(0, 5);

            // Render local first to be responsive (no places yet)
            renderSuggestions(matchedStops, matchedRoutes, [], query);

            // Show a loading spinner while waiting for Photon
            showGeocodingSpinner();

            // 2. Remote Search (Photon/OSM Geocoding) - Addresses in Georgia
            let matchedPlaces = [];
            try {
                // Bias towards map center if available, otherwise Tbilisi city center
                const center = map.getCenter ? map.getCenter() : { lng: 44.78, lat: 41.72 };
                const lang = getCurrentMapLanguage() === 'ka' ? 'ka' : 'en';

                // Tbilisi + Rustavi bounding box: minLng, minLat, maxLng, maxLat
                const tbilisiBbox = '44.5,41.5,45.1,42.0';
                const photonUrl = `https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&limit=10&lat=${center.lat}&lon=${center.lng}&lang=${lang}&bbox=${tbilisiBbox}`;
                const res = await fetch(photonUrl);
                if (res.ok) {
                    const data = await res.json();
                    // Normalize Photon features and filter to Georgia
                    matchedPlaces = (data.features || [])
                        .filter(f => f.properties?.countrycode === 'GE')
                        .map(normalizePhotonFeature)
                        .filter(Boolean)
                        .slice(0, 7);

                    // Re-render with ALL results (spinner is cleared inside)
                    renderSuggestions(matchedStops, matchedRoutes, matchedPlaces, query);
                } else {
                    console.warn('[Search] Photon geocoding error:', res.status, res.statusText);
                    removeGeocodingSpinner();
                }
            } catch (err) {
                console.warn('[Search] Photon geocoding exception', err);
                removeGeocodingSpinner();
            }
        }, 300); // 300ms debounce
    });

    // Hide suggestions on click outside (unless clicking a map marker, which we handle)
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.search-container') &&
            !e.target.closest('#search-suggestions') &&
            !e.target.closest('.mapboxgl-marker')) {
            suggestions.classList.add('hidden');
            clearSearchSuggestionMarkers();
        }
        if (!e.target.closest('.directions-field') &&
            !e.target.closest('#directions-from-suggestions') &&
            !e.target.closest('#directions-to-suggestions')) {
            document.getElementById('directions-from-suggestions')?.classList.add('hidden');
            document.getElementById('directions-to-suggestions')?.classList.add('hidden');
        }
    });

    onLanguageChange((change) => {
        if (change.target !== 'stops' && change.target !== 'ui') return;
        if (!suggestions.classList.contains('hidden') && input.value.trim() === '') {
            renderFullHistory(!!document.querySelector('.show-more-btn') === false);
        }
    });

    const directionsBtn = document.getElementById('search-directions');
    if (directionsBtn) {
        directionsBtn.addEventListener('click', () => {
            suggestions.classList.add('hidden');
            clearSearchSuggestionMarkers();
            input.blur();
            toggleDirections();
        });
    }

    // Autocomplete for directions inputs
    const fromInput = document.getElementById('directions-from-input');
    const toInput = document.getElementById('directions-to-input');
    const fromSuggestions = document.getElementById('directions-from-suggestions');
    const toSuggestions = document.getElementById('directions-to-suggestions');

    if (fromInput && toInput && fromSuggestions && toSuggestions) {
        let dirDebounceTimeout;

        const positionSuggestions = (inputEl, suggestionsEl) => {
            const rect = inputEl.getBoundingClientRect();
            const maxH = 220;
            // Always show below the input field
            suggestionsEl.style.left = rect.left + 'px';
            suggestionsEl.style.width = rect.width + 'px';
            suggestionsEl.style.top = (rect.bottom + 4) + 'px';
            suggestionsEl.style.maxHeight = maxH + 'px';
        };

        const showDirSuggestions = async (inputEl, fieldType) => {
            const activeSuggestions = fieldType === 'from' ? fromSuggestions : toSuggestions;
            const inactiveSuggestions = fieldType === 'from' ? toSuggestions : fromSuggestions;

            // On touch devices (mobile), expand to full so the keyboard doesn't push inputs behind it
            const isTouchDevice = window.matchMedia('(hover: none) and (pointer: coarse)').matches;
            if (isTouchDevice) {
                const panel = document.getElementById('directions-panel');
                if (panel) {
                    if (panel.dataset.transitioning === 'true') {
                        return;
                    }
                    if (!panel.classList.contains('sheet-full')) {
                        panel.dataset.transitioning = 'true';
                        setSheetState(panel, 'full');
                        await new Promise((resolve) => {
                            const onTransitionEnd = (e) => {
                                if (e.target === panel && (e.propertyName === 'transform' || e.propertyName === 'top')) {
                                    panel.removeEventListener('transitionend', onTransitionEnd);
                                    resolve();
                                }
                            };
                            panel.addEventListener('transitionend', onTransitionEnd);
                            setTimeout(resolve, 350); // Fallback
                        });
                        delete panel.dataset.transitioning;
                    }
                }
            }

            inactiveSuggestions.classList.add('hidden');
            activeSuggestions.innerHTML = '';

            // Position portal above the input field
            positionSuggestions(inputEl, activeSuggestions);

            const query = inputEl.value.trim().toLowerCase();


            // 1. If empty, show "My Location" (if available) + recent searches/history
            if (query === '') {
                activeSuggestions.style.minHeight = '';
                const userCoords = getLastUserCoords();
                if (userCoords) {
                    activeSuggestions.appendChild(createMyLocationSuggestionElement(fieldType));
                }
                
                const recentSearches = historyManager.getRecentSearches(15) || [];
                const recentCards = historyManager.getRecentCards(15) || [];
                
                const combined = [];
                const seenIds = new Set();
                
                const addUnique = (item) => {
                    if (!item) return;
                    const type = item.type || (item.geometry ? 'place' : (item.stops ? 'route' : 'stop'));
                    if (type === 'route') return; // skip routes
                    
                    const data = item.data || item;
                    let id = data.id || data.stopId || data.code;
                    if (type === 'place') id = data.id || data.text || `${data.center?.[0]},${data.center?.[1]}`;
                    
                    if (id && !seenIds.has(id)) {
                        seenIds.add(id);
                        combined.push({ type, id, data, originalItem: item });
                    }
                };
                
                recentSearches.forEach(addUnique);
                recentCards.forEach(addUnique);
                
                combined.slice(0, 8).forEach(({ type, data, originalItem }) => {
                    // Build a fresh item without cloneNode — cloneNode drops JS-property-based event data
                    const el = createDirHistoryItem(type, data, fieldType, activeSuggestions, originalItem);
                    activeSuggestions.appendChild(el);
                });

                if (activeSuggestions.children.length > 0) {
                    activeSuggestions.classList.remove('hidden');
                } else {
                    activeSuggestions.classList.add('hidden');
                }
                return;
            }

            if (query.length < 2) {
                activeSuggestions.classList.add('hidden');
                return;
            }

            // 2. Query stops matching text
            const allStops = appData.getAllStops();
            const matchedStops = allStops.filter(stop =>
                (stop.name && stop.name.toLowerCase().includes(query)) ||
                (stop.code && stop.code.includes(query))
            ).slice(0, 5);

            // Prevent jumping by maintaining current height while loading
            const currentHeight = activeSuggestions.offsetHeight;
            if (currentHeight > 0) {
                activeSuggestions.style.minHeight = currentHeight + 'px';
            }

            // Render stops first
            renderDirSuggestionsList(matchedStops, [], query, fieldType);

            // Show geocoding spinner
            showDirGeocodingSpinner(fieldType);

            clearTimeout(dirDebounceTimeout);
            dirDebounceTimeout = setTimeout(async () => {
                let matchedPlaces = [];
                try {
                    const center = map.getCenter ? map.getCenter() : { lng: 44.78, lat: 41.72 };
                    const lang = getCurrentMapLanguage() === 'ka' ? 'ka' : 'en';
                    const tbilisiBbox = '44.5,41.5,45.1,42.0';
                    const photonUrl = `https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&limit=10&lat=${center.lat}&lon=${center.lng}&lang=${lang}&bbox=${tbilisiBbox}`;
                    const res = await fetch(photonUrl);
                    if (res.ok) {
                        const data = await res.json();
                        matchedPlaces = (data.features || [])
                            .filter(f => f.properties?.countrycode === 'GE')
                            .map(normalizePhotonFeature)
                            .filter(Boolean)
                            .slice(0, 7);
                        activeSuggestions.style.minHeight = '';
                        renderDirSuggestionsList(matchedStops, matchedPlaces, query, fieldType);
                    } else {
                        activeSuggestions.style.minHeight = '';
                        removeDirGeocodingSpinner(fieldType);
                    }
                } catch (err) {
                    activeSuggestions.style.minHeight = '';
                    removeDirGeocodingSpinner(fieldType);
                }
            }, 300);
        };

        const onFocus = (e, fieldType) => {
            showDirSuggestions(e.target, fieldType);
        };

        fromInput.addEventListener('focus', (e) => onFocus(e, 'from'));
        fromInput.addEventListener('click', (e) => onFocus(e, 'from'));
        fromInput.addEventListener('blur', () => {
            setTimeout(() => {
                fromSuggestions.classList.add('hidden');
            }, 200);
        });
        fromInput.addEventListener('input', (e) => {
            const val = e.target.value.trim();
            if (val === '') {
                clearPoint('from');
                showDirSuggestions(e.target, 'from');
            } else {
                showDirSuggestions(e.target, 'from');
            }
        });

        toInput.addEventListener('focus', (e) => onFocus(e, 'to'));
        toInput.addEventListener('click', (e) => onFocus(e, 'to'));
        toInput.addEventListener('blur', () => {
            setTimeout(() => {
                toSuggestions.classList.add('hidden');
            }, 200);
        });
        toInput.addEventListener('input', (e) => {
            const val = e.target.value.trim();
            if (val === '') {
                clearPoint('to');
                showDirSuggestions(e.target, 'to');
            } else {
                showDirSuggestions(e.target, 'to');
            }
        });
    }
}

/**
 * Converts a Photon (komoot) GeoJSON feature into the normalized place object
 * that the rest of search.js uses:
 *   { text, place_name, center: [lng, lat], extent: [[w,s],[e,n]] | null, placeType }
 */
function normalizePhotonFeature(feature) {
    try {
        const p = feature.properties;
        const [lng, lat] = feature.geometry.coordinates;

        // Build the primary display name
        let text = p.name || '';
        if (!text && p.housenumber && p.street) {
            text = `${p.street} ${p.housenumber}`;
        }
        if (!text) return null; // Skip nameless results

        // Build the secondary subtitle line (breadcrumb style)
        const parts = [];
        if (p.housenumber && p.street && p.name) parts.push(`${p.street} ${p.housenumber}`);
        if (p.locality && p.locality !== p.name) parts.push(p.locality);
        if (p.district && p.district !== p.name && p.district !== p.locality) parts.push(p.district);
        if (p.city && p.city !== p.name) parts.push(p.city);
        const place_name = parts.join(', ') || p.city || p.country || '';

        // Parse extent: Photon provides [minLng, minLat, maxLng, maxLat]
        let extent = null;
        if (p.extent && p.extent.length === 4) {
            // MapboxGL fitBounds expects [[sw_lng, sw_lat], [ne_lng, ne_lat]]
            extent = [[p.extent[0], p.extent[1]], [p.extent[2], p.extent[3]]];
        }

        // Map Photon type to our internal placeType
        const placeType = p.type || 'place'; // 'street', 'house', 'city', 'locality', etc.

        return { text, place_name, center: [lng, lat], extent, placeType };
    } catch (e) {
        return null;
    }
}

function getCurrentStopForHistory(data) {

    if (!data) return null;
    const stopId = data.id || data.stopId || data.code;
    if (!stopId) return null;
    const allStops = appData.getAllStops();
    const rawId = String(stopId);
    const cleanId = rawId.replace(/^1:/, '');
    const prefixedId = rawId.includes(':') ? rawId : `1:${cleanId}`;
    return allStops.find((stop) => {
        const id = String(stop.id);
        return id === rawId || id === cleanId || id === prefixedId;
    }) || null;
}

function renderFullHistory(expanded = false) {
    const container = document.getElementById('search-suggestions');

    // Get Data
    const searchLimit = expanded ? 15 : 5;
    const recentSearches = historyManager.getRecentSearches(searchLimit);
    const recentCards = historyManager.getRecentCards(10); // Always 10

    // --- 1. Recently Searched ---

    container.innerHTML = '';

    // --- 1. Recently Searched ---
    if (recentSearches.length > 0) {
        // Create Header with Clear Button
        const header = document.createElement('div');
        header.className = 'suggestion-header';
        header.style.cssText = 'padding: 12px 16px 4px; font-size: 0.75rem; color: var(--text-secondary); font-weight: 600; background: var(--bg-panel); display: flex; justify-content: space-between; align-items: center;';

        const title = document.createElement('span');
        title.innerText = t('recentlySearched');
        header.appendChild(title);

        const clearBtn = document.createElement('span');
        clearBtn.innerText = t('clearAll');
        clearBtn.style.cssText = 'font-size: 0.65rem; color: var(--text-secondary); cursor: pointer; letter-spacing: 0.5px;';
        clearBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (confirm(t('clearSearchHistoryPrompt'))) {
                historyManager.clearSearchHistory();
                renderFullHistory();
            }
        });
        header.appendChild(clearBtn);

        container.appendChild(header);

        recentSearches.forEach(item => {
            const div = createSuggestionElement(item, 'search');
            container.appendChild(div);
        });

        // "Show More" Button
        if (!expanded && historyManager.getRecentSearches(15).length > 5) {
            const moreBtn = document.createElement('div');
            moreBtn.className = 'suggestion-item show-more-btn'; // Added class
            moreBtn.style.color = 'var(--primary)';
            moreBtn.style.fontWeight = '600';
            moreBtn.style.justifyContent = 'center';
            moreBtn.innerHTML = t('showMore');
            moreBtn.addEventListener('click', (e) => {
                e.stopPropagation(); // Prevent closing
                renderFullHistory(true); // Re-render expanded
            });
            container.appendChild(moreBtn);
        }
    }

    // --- 2. Recent Cards ---
    // Only show if not expanded? User said "after this first section show 10 recent cards, dont put a show more button there"
    // I assume show it always.
    if (recentCards.length > 0) {
        const cardHeader = document.createElement('div');
        cardHeader.className = 'suggestion-header';
        cardHeader.style.cssText = 'padding: 12px 16px 4px; font-size: 0.75rem; color: var(--text-secondary); font-weight: 600; background: var(--bg-panel); border-top: 1px solid var(--border-light); margin-top: 4px;';
        cardHeader.innerText = t('recentCards');
        container.appendChild(cardHeader);

        recentCards.forEach(item => {
            // Deduplicate? If it's in Recent Searches, maybe don't show here?
            // "recent cards" might overlap. I'll just show them raw as requested.
            const div = createSuggestionElement(item, 'card');
            container.appendChild(div);
        });
    }

    // Empty State
    if (recentSearches.length === 0 && recentCards.length === 0) {
        container.innerHTML = `
            <div style="padding: 20px; text-align: center; color: var(--text-secondary); font-size: 0.9rem;">
                <div style="font-size: 1.5rem; margin-bottom: 8px;">🔍</div>
                <div>${t('searchEmptyState')}</div>
            </div>
        `;
    }

    container.classList.remove('hidden');
}

function createSuggestionElement(item, historyType = null) {
    const div = document.createElement('div');
    div.className = 'suggestion-item';

    // HistoryManager stores { type, id, data: fullObject }
    const type = item.type || (item.geometry ? 'place' : (item.stops ? 'route' : 'stop')); // Fallback inference
    const data = item.data || item;
    const isHistory = !!historyType;

    let iconHTML = '';
    let textHTML = '';

    if (type === 'route') {
        const route = data;
        iconHTML = `<div class="suggestion-icon route" style="background: ${isHistory ? 'var(--bg-secondary)' : 'var(--primary-light)'}; color: ${isHistory ? 'var(--text-secondary)' : 'var(--primary-dark)'};">${isHistory ? '🕒' : '🚌'}</div>`;
        textHTML = `
            <div style="font-weight:600;">Route ${route.shortName}</div>
            <div class="suggestion-subtext">${route.longName}</div>
        `;
    } else if (type === 'stop') {
        const stop = getCurrentStopForHistory(data) || data;
        iconHTML = `<div class="suggestion-icon stop" style="background: ${isHistory ? 'var(--bg-secondary)' : 'var(--primary-light)'}; color: ${isHistory ? 'var(--text-secondary)' : 'var(--primary)'};">${isHistory ? '🕒' : '🚏'}</div>`;
        textHTML = `
            <div style="font-weight:600;">${stop.name}</div>
            <div class="suggestion-subtext">${t('codeLabel', stop.code || 'N/A')}</div>
        `;
    } else if (type === 'place') {
        const placeIcon = data.placeType === 'house' ? '🏠' : data.placeType === 'street' ? '🛣️' : '📍';
        iconHTML = `<div class="suggestion-icon place" style="background: ${isHistory ? 'var(--bg-secondary)' : 'var(--primary-light)'}; color: ${isHistory ? 'var(--text-secondary)' : 'var(--primary)'};">` + (isHistory ? '🕒' : placeIcon) + `</div>`;
        textHTML = `
            <div style="font-weight:600;">${data.text}</div>
            <div class="suggestion-subtext">${data.place_name}</div>
        `;
    }

    div.innerHTML = `
        ${iconHTML}
        <div class="suggestion-text">
            ${textHTML}
        </div>
    `;

    // Click Action
    div.addEventListener('click', () => {
        if (!isHistory) {
            // Ensure ID is captured correctly based on type
            let id = data.id;
            if (type === 'stop') id = data.id || data.stopId || data.code;
            if (type === 'route') id = data.id || data.routeId || data.shortName; // Fallback to shortName if needed

            historyManager.addSearch({ type, id, data });
        }

        if (type === 'route') appCallbacks.onRouteSelect(data);
        else if (type === 'stop') {
            // map.flyTo is handled by onStopSelect (showStopInfo) with proper offset
            appCallbacks.onStopSelect(data);
        } else if (type === 'place') {
            selectPlace(data);
        }
        document.getElementById('search-suggestions').classList.add('hidden');
    });

    // Delete Button (if history)
    if (isHistory) {
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'suggestion-delete-btn';
        // Position relative to ensure z-index works. 
        // pointer-events: none on SVG ensures the BUTTON is the target.
        deleteBtn.style.zIndex = '10';
        deleteBtn.innerHTML = `
            <svg style="pointer-events: none;" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
        `;
        deleteBtn.title = t('clear');
        // Attach data for Delegation
        deleteBtn._item = item;
        deleteBtn._historyType = historyType;
        div.appendChild(deleteBtn);
    }

    return div;
}

function showGeocodingSpinner() {
    // Only add if not already present and suggestions panel is visible
    const container = document.getElementById('search-suggestions');
    if (!container || container.classList.contains('hidden')) return;
    if (container.querySelector('.search-geocoding-spinner')) return;

    const spinner = document.createElement('div');
    spinner.className = 'search-geocoding-spinner';
    spinner.style.cssText = [
        'display: flex',
        'align-items: center',
        'justify-content: center',
        'gap: 8px',
        'padding: 10px 16px',
        'color: var(--text-secondary)',
        'font-size: 0.78rem',
    ].join(';');
    spinner.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"
             style="animation: spin 0.8s linear infinite; flex-shrink: 0;">
            <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
        </svg>
        <span style="opacity: 0.7">Searching places…</span>
    `;
    container.appendChild(spinner);
}

function removeGeocodingSpinner() {
    const spinner = document.querySelector('.search-geocoding-spinner');
    if (spinner) spinner.remove();
}

function clearSearchSuggestionMarkers() {
    suggestionMarkers.forEach(m => m.remove());
    suggestionMarkers = [];
}

function selectPlace(place) {
    invalidateMapCameraIntent();
    const coords = place.center;
    // Remove any previous place marker
    if (window._searchPlaceMarker) {
        window._searchPlaceMarker.remove();
        window._searchPlaceMarker = null;
    }

    // Use fitBounds for streets (extent available), flyTo for point results
    if (place.extent) {
        map.fitBounds(place.extent, {
            padding: getBandPadding({ bottomAnchorSelector: '#info-panel' }),
            maxZoom: 17,
            duration: 900,
            retainPadding: false
        });
    } else {
        flyToPointInView(coords, {
            zoom: 17,
            bottomAnchorSelector: '#info-panel',
            duration: 900,
            radiusMeters: 10
        });
    }
    window._searchPlaceMarker = new mapboxgl.Marker({ color: '#e74c3c' })
        .setLngLat(coords)
        .addTo(map);

    // Hide suggestions dropdown
    document.getElementById('search-suggestions').classList.add('hidden');

    // Clear all temporary suggestion pins
    clearSearchSuggestionMarkers();

    // Show panel with info & directions buttons
    showPlaceInfoSheet(place);
}

export function showPlaceInfoSheet(place) {
    // Clear any selected stop markers/states
    window.currentStopId = null;
    window.currentStopMode = null;
    if (arrivalsController) {
        arrivalsController.clear();
    }
    if (map && map.getSource('selected-stop')) {
        map.getSource('selected-stop').setData({ type: 'FeatureCollection', features: [] });
    }
    try {
        setMapFocus(false);
    } catch (err) {
        console.error('Failed to reset map focus:', err);
    }

    const panel = document.getElementById('info-panel');
    if (!panel) return;

    const existingMetroHeader = panel.querySelector('.metro-header');
    if (existingMetroHeader) existingMetroHeader.remove();

    // Hide stop-specific UI elements inside info-panel
    const arrivalsList = document.getElementById('arrivals-list');
    const filterBtn = document.getElementById('filter-routes-toggle');
    const editBtn = document.getElementById('btn-edit-stop');
    const stopMoreBtn = document.getElementById('stop-more-btn');
    const headerExtension = document.getElementById('header-extension');

    const stopDirsContainer = document.getElementById('stop-directions-container');
    if (stopDirsContainer) stopDirsContainer.classList.add('hidden');
    if (arrivalsList) arrivalsList.classList.add('hidden');
    if (filterBtn) filterBtn.classList.add('hidden');
    if (editBtn) editBtn.classList.add('hidden');
    if (stopMoreBtn) stopMoreBtn.classList.add('hidden');
    if (headerExtension) headerExtension.classList.add('hidden');

    // Show place details
    const placeDetails = document.getElementById('place-details');
    if (placeDetails) {
        placeDetails.classList.remove('hidden');
        const addrEl = document.getElementById('place-address');
        if (addrEl) {
            addrEl.textContent = place.place_name || '';
        }

        // Setup directions buttons
        const dirToBtn = document.getElementById('place-dir-to');
        const dirFromBtn = document.getElementById('place-dir-from');

        // Remove old listeners to avoid multiple click registrations
        const newDirToBtn = dirToBtn.cloneNode(true);
        const newDirFromBtn = dirFromBtn.cloneNode(true);
        dirToBtn.parentNode.replaceChild(newDirToBtn, dirToBtn);
        dirFromBtn.parentNode.replaceChild(newDirFromBtn, dirFromBtn);

        newDirToBtn.addEventListener('click', () => {
            setPoint('to', {
                lat: place.center[1],
                lng: place.center[0],
                label: place.text
            });
            // Hide the place info panel
            setSheetState(panel, 'hidden');
            clearSearchSuggestionMarkers();
        });

        newDirFromBtn.addEventListener('click', () => {
            setPoint('from', {
                lat: place.center[1],
                lng: place.center[0],
                label: place.text
            });
            // Hide the place info panel
            setSheetState(panel, 'hidden');
            clearSearchSuggestionMarkers();
        });
    }

    // Set header name to place name
    const nameEl = document.getElementById('stop-name');
    if (nameEl) {
        nameEl.textContent = place.text;
    }

    // Open panel
    setSheetState(panel, 'half');
    setPanelState(true);
}

/**
 * Renders search suggestions with smart ordering:
 *  - Routes matched by number/shortName → top (user clearly wants a route)
 *  - Places (Photon/OSM) → next
 *  - Stops → next (deprioritized vs places)
 *  - Routes matched only by longName/terminal → bottom
 * When places haven't loaded yet (loading=true) a spinner is shown.
 */
function renderSuggestions(stops, routes, places = [], query = '') {
    const container = document.getElementById('search-suggestions');
    container.innerHTML = '';

    // Clear previous suggestion markers
    clearSearchSuggestionMarkers();

    if (stops.length === 0 && routes.length === 0 && places.length === 0) {
        container.classList.add('hidden');
        return;
    }

    // Split routes: shortName (number) match vs longName-only match
    const q = query.trim().toLowerCase();
    const routesByNumber = routes.filter(r =>
        r.shortName && r.shortName.toLowerCase().includes(q)
    );
    const routesByName = routes.filter(r =>
        !(r.shortName && r.shortName.toLowerCase().includes(q))
    );

    // 1. Routes matched by number — user is looking for a specific route
    routesByNumber.forEach(route => {
        container.appendChild(createSuggestionElement({ type: 'route', data: route }, null));
    });

    // 2. Places (streets, buildings, POIs) — most useful for navigation
    places.forEach(place => {
        container.appendChild(createSuggestionElement({ type: 'place', data: place }, null));

        // Create gray map pin marker for the place
        const marker = new mapboxgl.Marker({ color: '#7f8c8d' })
            .setLngLat(place.center)
            .addTo(map);

        // Make marker clickable
        marker.getElement().addEventListener('click', (e) => {
            e.stopPropagation();
            selectPlace(place);
        });

        // Set cursor styling
        marker.getElement().style.cursor = 'pointer';

        suggestionMarkers.push(marker);
    });

    // 3. Bus stops — deprioritized below real places
    stops.forEach(stop => {
        container.appendChild(createSuggestionElement({ type: 'stop', data: stop }, null));
    });

    // 4. Routes matched only by long name/terminals — lowest priority
    routesByName.forEach(route => {
        container.appendChild(createSuggestionElement({ type: 'route', data: route }, null));
    });

    container.classList.remove('hidden');
}

function createMyLocationSuggestionElement(fieldType) {
    const div = document.createElement('div');
    div.className = 'suggestion-item my-location-suggestion';
    div.innerHTML = `
        <div class="suggestion-icon my-location" style="background: var(--primary-light); color: var(--primary); display: flex; align-items: center; justify-content: center; width: 24px; height: 24px; border-radius: 50%;">
            <span class="blue-circle-icon-dot" style="width: 10px; height: 10px; background-color: var(--primary); border-radius: 50%;"></span>
        </div>
        <div class="suggestion-text">
            <div style="font-weight:600;">${t('myLocation')}</div>
        </div>
    `;
    div.addEventListener('click', () => {
        const userCoords = getLastUserCoords();
        if (userCoords) {
            setPoint(fieldType, {
                lng: userCoords.lng,
                lat: userCoords.lat,
                label: t('myLocation')
            });
        }
        const containerId = fieldType === 'from' ? 'directions-from-suggestions' : 'directions-to-suggestions';
        const container = document.getElementById(containerId);
        if (container) container.classList.add('hidden');
    });
    return div;
}

function renderDirSuggestionsList(stops, places, query, fieldType) {
    const containerId = fieldType === 'from' ? 'directions-from-suggestions' : 'directions-to-suggestions';
    const container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = '';

    if (stops.length === 0 && places.length === 0) {
        container.classList.add('hidden');
        return;
    }

    // Render places first
    places.forEach(place => {
        const div = document.createElement('div');
        div.className = 'suggestion-item';
        const placeIcon = place.placeType === 'house' ? '🏠' : place.placeType === 'street' ? '🛣️' : '📍';
        div.innerHTML = `
            <div class="suggestion-icon place" style="background: var(--primary-light); color: var(--primary);">
                ${placeIcon}
            </div>
            <div class="suggestion-text">
                <div style="font-weight:600;">${place.text}</div>
                <div class="suggestion-subtext">${place.place_name}</div>
            </div>
        `;
        div.addEventListener('click', () => {
            setPoint(fieldType, {
                lng: place.center[0],
                lat: place.center[1],
                label: place.text,
                featureId: place.id,
                featureType: 'place'
            });
            container.classList.add('hidden');
        });
        container.appendChild(div);
    });

    // Render stops
    stops.forEach(stop => {
        const div = document.createElement('div');
        div.className = 'suggestion-item';
        div.innerHTML = `
            <div class="suggestion-icon stop" style="background: var(--primary-light); color: var(--primary);">
                🚏
            </div>
            <div class="suggestion-text">
                <div style="font-weight:600;">${stop.name}</div>
                <div class="suggestion-subtext">${t('codeLabel', stop.code || 'N/A')}</div>
            </div>
        `;
        div.addEventListener('click', () => {
            setPoint(fieldType, {
                lng: stop.lng || stop.lon,
                lat: stop.lat,
                label: stop.name,
                featureId: stop.id,
                featureType: 'stop'
            });
            container.classList.add('hidden');
        });
        container.appendChild(div);
    });

    container.classList.remove('hidden');
}

function showDirGeocodingSpinner(fieldType) {
    const containerId = fieldType === 'from' ? 'directions-from-suggestions' : 'directions-to-suggestions';
    const container = document.getElementById(containerId);
    if (!container || container.classList.contains('hidden')) return;
    if (container.querySelector('.dir-geocoding-spinner')) return;

    const spinner = document.createElement('div');
    spinner.className = 'dir-geocoding-spinner';
    spinner.style.cssText = [
        'display: flex',
        'align-items: center',
        'justify-content: center',
        'gap: 8px',
        'padding: 10px 16px',
        'color: var(--text-secondary)',
        'font-size: 0.78rem',
    ].join(';');
    spinner.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"
             style="animation: spin 0.8s linear infinite; flex-shrink: 0;">
            <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
        </svg>
        <span style="opacity: 0.7">Searching places…</span>
    `;
    container.appendChild(spinner);
}

function removeDirGeocodingSpinner(fieldType) {
    const containerId = fieldType === 'from' ? 'directions-from-suggestions' : 'directions-to-suggestions';
    const container = document.getElementById(containerId);
    const spinner = container?.querySelector('.dir-geocoding-spinner');
    if (spinner) spinner.remove();
}

function createDirHistoryItem(type, data, fieldType, container, originalItem) {
    const div = document.createElement('div');
    div.className = 'suggestion-item';

    let iconHTML = '';
    let textHTML = '';

    if (type === 'route') {
        const route = data;
        iconHTML = `<div class="suggestion-icon route" style="background: var(--bg-secondary); color: var(--text-secondary);">🕒</div>`;
        textHTML = `
            <div style="font-weight:600;">Route ${route.shortName}</div>
            <div class="suggestion-subtext">${route.longName}</div>
        `;
    } else if (type === 'stop') {
        iconHTML = `<div class="suggestion-icon stop" style="background: var(--bg-secondary); color: var(--text-secondary);">🕒</div>`;
        textHTML = `
            <div style="font-weight:600;">${data.name}</div>
            <div class="suggestion-subtext">${t('codeLabel', data.code || 'N/A')}</div>
        `;
    } else if (type === 'place') {
        iconHTML = `<div class="suggestion-icon place" style="background: var(--bg-secondary); color: var(--text-secondary);">🕒</div>`;
        textHTML = `
            <div style="font-weight:600;">${data.text}</div>
            <div class="suggestion-subtext">${data.place_name}</div>
        `;
    }

    div.innerHTML = `
        ${iconHTML}
        <div class="suggestion-text">
            ${textHTML}
        </div>
    `;

    // Click Action
    div.addEventListener('click', () => {
        if (type === 'stop') {
            setPoint(fieldType, {
                lat: data.lat,
                lng: data.lng || data.lon,
                label: data.name,
                featureId: data.id,
                featureType: 'stop'
            });
        } else if (type === 'place') {
            setPoint(fieldType, {
                lat: data.center[1],
                lng: data.center[0],
                label: data.text,
                featureId: data.id,
                featureType: 'place'
            });
        }
        container.classList.add('hidden');
    });

    // Delete Button
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'suggestion-delete-btn';
    deleteBtn.style.zIndex = '10';
    deleteBtn.innerHTML = `
        <svg style="pointer-events: none;" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>
    `;
    deleteBtn.title = t('clear');
    
    // We attach the click directly instead of relying on the global delegate
    // because this popup is outside the #search-suggestions where the delegate is.
    deleteBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        
        // Remove from history
        if (originalItem && originalItem.type) {
            historyManager.removeSearch(originalItem);
            historyManager.removeCard(originalItem);
        } else {
            // fallback if originalItem structure varies
            historyManager.removeSearch({ type, id: data.id || data.text, data });
        }
        
        // Remove this element from the list
        div.remove();
        
        // Re-check empty state if needed
        if (container.children.length === 0) {
            container.classList.add('hidden');
        }
    });

    div.appendChild(deleteBtn);

    return div;
}
