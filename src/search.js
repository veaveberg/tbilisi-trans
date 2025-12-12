import mapboxgl from 'mapbox-gl';
import { map } from './map-setup.js';
import { historyManager } from './history.js';
import * as api from './api.js';

let appCallbacks = {
    onRouteSelect: null,
    onStopSelect: null,
    onClickPlace: null
};

let appData = {
    getAllStops: () => [],
    getAllRoutes: () => []
};

export function setupSearch(callbacks, dataProviders) {
    appCallbacks = { ...appCallbacks, ...callbacks };
    appData = { ...appData, ...dataProviders };

    const input = document.getElementById('search-input');
    const suggestions = document.getElementById('search-suggestions');
    const clearBtn = document.getElementById('search-clear');
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
        input.focus();
        updateClearBtn();
        renderFullHistory();
    });

    // Show history on focus if empty
    const showHistoryIfEmpty = () => {
        if (input.value.trim() === '') {
            renderFullHistory();
        }
    };

    input.addEventListener('focus', showHistoryIfEmpty);
    input.addEventListener('click', showHistoryIfEmpty);

    input.addEventListener('input', (e) => {
        const query = e.target.value.toLowerCase();
        updateClearBtn();

        clearTimeout(debounceTimeout);
        debounceTimeout = setTimeout(async () => {

            if (query.length < 2) {
                if (query.length === 0) {
                    renderFullHistory();
                    return;
                }
                suggestions.classList.add('hidden');
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

            // Render local first to be responsive
            renderSuggestions(matchedStops, matchedRoutes, []);

            // 2. Remote Search (Mapbox Geocoding) - Addresses in Georgia
            let matchedPlaces = [];
            try {
                // Restrict to Tbilisi Bounding Box (approx)
                const bbox = '44.5,41.6,45.1,42.0';
                // Bias towards map center if available, otherwise city center
                const center = map.getCenter ? map.getCenter() : { lng: 44.78, lat: 41.72 };
                const proximity = `${center.lng},${center.lat}`;

                const geocodingUrl = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json?access_token=${api.MAPBOX_TOKEN}&country=ge&language=en&types=place,address,poi&limit=10&proximity=${proximity}&bbox=${bbox}`;
                const res = await fetch(geocodingUrl);
                if (res.ok) {
                    const data = await res.json();
                    matchedPlaces = data.features || [];

                    // Re-render with ALL results
                    renderSuggestions(matchedStops, matchedRoutes, matchedPlaces);
                } else {
                    console.warn('[Search] Geocoding error:', res.status, res.statusText);
                }
            } catch (err) {
                console.warn('[Search] Geocoding exception', err);
            }
        }, 300); // 300ms debounce
    });

    // Hide suggestions on click outside
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.search-container')) {
            suggestions.classList.add('hidden');
        }
    });
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
        header.style.cssText = 'padding: 12px 16px 4px; font-size: 0.75rem; color: var(--text-light); font-weight: 600; background: #fff; display: flex; justify-content: space-between; align-items: center;';

        const title = document.createElement('span');
        title.innerText = 'RECENTLY SEARCHED';
        header.appendChild(title);

        const clearBtn = document.createElement('span');
        clearBtn.innerText = 'CLEAR ALL';
        clearBtn.style.cssText = 'font-size: 0.65rem; color: #9ca3af; cursor: pointer; letter-spacing: 0.5px;';
        clearBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (confirm('Clear search history?')) {
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
            moreBtn.innerHTML = 'Show more...';
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
        cardHeader.style.cssText = 'padding: 12px 16px 4px; font-size: 0.75rem; color: var(--text-light); font-weight: 600; background: #fff; border-top: 1px solid #f3f4f6; margin-top: 4px;';
        cardHeader.innerText = 'RECENT CARDS';
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
            <div style="padding: 20px; text-align: center; color: var(--text-light); font-size: 0.9rem;">
                <div style="font-size: 1.5rem; margin-bottom: 8px;">🔍</div>
                <div>Type to search for stops,<br>routes, or addresses</div>
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
        iconHTML = `<div class="suggestion-icon route" style="background: ${isHistory ? '#f3f4f6' : '#dcfce7'}; color: ${isHistory ? '#6b7280' : '#16a34a'};">${isHistory ? '🕒' : '🚌'}</div>`;
        textHTML = `
            <div style="font-weight:600;">Route ${route.shortName}</div>
            <div class="suggestion-subtext">${route.longName}</div>
        `;
    } else if (type === 'stop') {
        const stop = data;
        iconHTML = `<div class="suggestion-icon stop" style="background: ${isHistory ? '#f3f4f6' : '#e0f2fe'}; color: ${isHistory ? '#6b7280' : '#0284c7'};">${isHistory ? '🕒' : '🚏'}</div>`;
        textHTML = `
            <div style="font-weight:600;">${stop.name}</div>
            <div class="suggestion-subtext">Code: ${stop.code || 'N/A'}</div>
        `;
    } else if (type === 'place') {
        iconHTML = `<div class="suggestion-icon place" style="background: ${isHistory ? '#f3f4f6' : '#eef2ff'}; color: ${isHistory ? '#6b7280' : '#4f46e5'};">${isHistory ? '🕒' : '📍'}</div>`;
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
            const coords = data.center;
            map.flyTo({ center: coords, zoom: 16 });
            new mapboxgl.Marker().setLngLat(coords).addTo(map);
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
        deleteBtn.title = "Remove from history";
        // Attach data for Delegation
        deleteBtn._item = item;
        deleteBtn._historyType = historyType;
        div.appendChild(deleteBtn);
    }

    return div;
}

function renderSuggestions(stops, routes, places = []) {
    const container = document.getElementById('search-suggestions');
    container.innerHTML = '';

    if (stops.length === 0 && routes.length === 0 && places.length === 0) {
        container.classList.add('hidden');
        return;
    }

    // Render Routes
    routes.forEach(route => {
        const div = createSuggestionElement({ type: 'route', data: route }, null);
        container.appendChild(div);
    });

    // Render Stops
    stops.forEach(stop => {
        const div = createSuggestionElement({ type: 'stop', data: stop }, null);
        container.appendChild(div);
    });

    // Render Places
    places.forEach(place => {
        const div = createSuggestionElement({ type: 'place', data: place }, null);
        container.appendChild(div);
    });

    container.classList.remove('hidden');
}
