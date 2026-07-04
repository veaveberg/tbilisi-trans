import { buildDirectionsPath, parseDirectionsPath } from './directions-url.js';

export const Router = {
    // Detect base path from vite.config/document base or default
    base: import.meta.env.BASE_URL,
    _lastParsedPath: null,
    _lastParsedState: null,

    init() {
        console.log('[Router] Initializing...');
        // Handle Back/Forward buttons
        window.addEventListener('popstate', (e) => {
            console.log('[Router] PopState:', e.state, location.pathname);
            if (this.onPopState) {
                this.onPopState(this.parse());
            }
        });
    },

    // Callback for external handler
    onPopState: null,

    /**
     * Parse current URL into state object
     * URL Format:
     * /base/stopID/filtered/destinationsID-ID/routesSHORT-SHORT
     * /base/stopID/filtered/routesSHORT-SHORT
     */
    parse() {
        // Strip base path
        let path = location.pathname;
        if (path === this._lastParsedPath && this._lastParsedState) {
            return this._lastParsedState;
        }
        console.log(`[Router] Parsing path: "${path}" (Base: "${this.base}")`);
        if (path.startsWith(this.base)) {
            path = path.substring(this.base.length);
        } else if (path.startsWith('/')) {
            // Localhost handling where base might be root or different
            // If we are developing locally on root, base is '/'
            path = path.substring(1);
        }

        // Clean trailing slash
        if (path.endsWith('/')) path = path.slice(0, -1);

        const parts = path.split('/');

        if (parts[0] === 'directions') {
            const state = parseDirectionsPath(path);
            if (state) {
                this._lastParsedPath = location.pathname;
                this._lastParsedState = state;
                return state;
            }
        }

        if (parts[0] === 'privacy-policy' || parts[0] === 'support') {
            const state = {
                type: 'special',
                page: parts[0]
            };
            this._lastParsedPath = location.pathname;
            this._lastParsedState = state;
            return state;
        }

        // Segment Deep Link: /segment/ID-ID
        if (parts[0] === 'segment' || parts[0].startsWith('segment')) {
            let raw = '';
            if (parts[0] === 'segment') {
                raw = parts[1] || '';
            } else {
                raw = parts[0].substring('segment'.length);
            }
            const ids = raw.split('-').filter(Boolean);
            const state = {
                type: 'segment',
                segmentIds: ids
            };
            this._lastParsedPath = location.pathname;
            this._lastParsedState = state;
            return state;
        }

        // Route Parsing (Simplified /bus306a)
        // Check for Nested: /stopXXX/busXXXa or /busXXXa

        let busPart = null;
        let busIndex = -1;

        // Find "busXXX" part
        parts.forEach((p, i) => {
            if (p.startsWith('bus')) {
                busPart = p;
                busIndex = i;
            }
        });

        if (busPart) {
            const rawShortName = busPart.substring(3); // remove 'bus'
            // Check suffix
            let direction = 0;
            let shortName = rawShortName;

            if (rawShortName.endsWith('a')) {
                direction = 0;
                shortName = rawShortName.slice(0, -1);
            } else if (rawShortName.endsWith('b')) {
                direction = 1;
                shortName = rawShortName.slice(0, -1);
            }

            // Check if nested (preceded by stop)
            let stopId = null;
            if (busIndex > 0) {
                // Try to find stop part before it
                const stopPart = parts[0]; // Assuming structure /stopXXX/busXXX
                if (stopPart && stopPart.startsWith('stop')) {
                    stopId = stopPart.substring(4);
                } else if (stopPart && !stopPart.includes('filtered')) {
                    stopId = stopPart;
                }
                if (stopId && !stopId.includes(':')) stopId = `1:${stopId}`;
            }

            if (stopId) {
                const state = {
                    type: 'nested',
                    stopId: stopId,
                    shortName: shortName,
                    direction: direction
                };
                this._lastParsedPath = location.pathname;
                this._lastParsedState = state;
                return state;
            } else {
                const state = {
                    type: 'route',
                    shortName: shortName,
                    direction: direction
                };
                this._lastParsedPath = location.pathname;
                this._lastParsedState = state;
                return state;
            }
        }

        const state = {
            type: 'stop',
            stopId: null,
            board: false,
            filterActive: false,
            targetIds: [],
            routeFilterShortNames: []
        };

        if (parts.length > 0) {
            // Part 0: Stop ID (e.g. "stop801" or just "801")
            // We'll support flexible "stop" prefix or raw ID
            let p0 = parts[0];
            let rawId = null;
            if (p0.startsWith('stop')) {
                rawId = p0.substring(4);
            } else if (p0) {
                rawId = p0;
            }

            // Normalize: Just use the ID. The application now expects stripped IDs for standard sources.
            // If the ID comes with a prefix from URL (e.g. r43), keep it.
            // If it's numeric (801), keep it.
            state.stopId = rawId;
        }

        state.board = parts.includes('board');

        if (parts.length > 1 && parts[1] === 'filtered') {
            for (let i = 2; i < parts.length; i++) {
                const segment = parts[i];
                if (!segment) continue;
                if (segment === 'board') continue;

                if (segment.startsWith('destinations')) {
                    let rawTargets = segment.substring(12);
                    state.targetIds = rawTargets.split('-').filter(id => id.length > 0);
                    continue;
                }

                if (segment.startsWith('routes')) {
                    let rawRoutes = segment.substring(6);
                    state.routeFilterShortNames = rawRoutes.split('-').filter(id => id.length > 0);
                    continue;
                }

                // Backward compatibility for older /filtered/405-1324 style links.
                if (i === 2) {
                    state.targetIds = segment.split('-').filter(id => id.length > 0);
                }
            }
            state.filterActive = state.targetIds.length > 0;
        }

        this._lastParsedPath = location.pathname;
        this._lastParsedState = state;
        return state;
    },

    /**
     * Update URL based on state
     */
    update(stopId, filterActive, targetIds, mapHash = '', routeFilterShortNames = [], options = {}) {
        // Legacy Support for update(stopId...) calls
        // We really should use dedicated methods, but keeping this for backward compat if needed.
        // Or better: Redirect to updateStop logic.
        this.updateStop(stopId, filterActive, targetIds, mapHash, routeFilterShortNames, options);
    },

    updateStop(stopId, filterActive, targetIds, mapHash = '', routeFilterShortNames = [], options = {}) {
        if (!stopId) {
            // Reset to Home (with optional hash)
            const url = this.base + mapHash;
            history.pushState(null, '', url);
            return;
        }

        // Clean ID for URL: Remove "1:" prefix
        const cleanId = (id) => String(id).replace(/^1:/, '');

        // Don't include mapHash for stop URLs - the stop ID leads to the correct location
        let url = `${this.base}stop${cleanId(stopId)}`;

        const sortedTargetIds = filterActive && targetIds && targetIds.length > 0
            ? [...targetIds].map(cleanId).sort()
            : [];
        const sortedRouteShortNames = Array.isArray(routeFilterShortNames) && routeFilterShortNames.length > 0
            ? [...routeFilterShortNames].map(v => String(v).trim()).filter(Boolean).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
            : [];

        if (sortedTargetIds.length > 0 || sortedRouteShortNames.length > 0) {
            url += `/filtered`;
            if (sortedTargetIds.length > 0) {
                url += `/destinations${sortedTargetIds.join('-')}`;
            }
            if (sortedRouteShortNames.length > 0) {
                url += `/routes${sortedRouteShortNames.join('-')}`;
            }
        }

        if (options.board) {
            url += '/board';
        }

        console.log('[Router] Push State (Stop):', url);
        history.pushState({ type: 'stop', stopId, filterActive, targetIds, routeFilterShortNames: sortedRouteShortNames, board: !!options.board }, '', url);
    },

    updateRoute(shortName, direction = 0) {
        if (!shortName) return;
        const suffix = direction === 1 ? 'b' : 'a';
        let url = `${this.base}bus${shortName}${suffix}`;
        console.log('[Router] Push State (Route):', url);
        history.pushState({ type: 'route', shortName, direction }, '', url);
    },

    updateSegment(segmentIds = [], mapHash = '') {
        const cleanIds = (segmentIds || []).map(id => String(id)).filter(Boolean);
        if (cleanIds.length === 0) {
            const url = this.base + mapHash;
            history.pushState(null, '', url);
            return;
        }
        const slug = cleanIds.join('-');
        const url = `${this.base}segment/${slug}`;
        console.log('[Router] Push State (Segment):', url);
        history.pushState({ type: 'segment', segmentIds: cleanIds }, '', url);
    },

    updateDirections(state = {}) {
        const path = buildDirectionsPath(state);
        if (!path) return false;

        const url = `${this.base}${path}`;
        console.log('[Router] Replace State (Directions):', url);
        history.replaceState({ type: 'directions', ...state }, '', url);
        return true;
    },

    updateNested(stopId, shortName, direction = 0) {
        if (!stopId || !shortName) return;
        // Clean ID
        const cleanStopId = String(stopId).replace(/^1:/, '');
        const suffix = direction === 1 ? 'b' : 'a';

        let url = `${this.base}stop${cleanStopId}/bus${shortName}${suffix}`;
        console.log('[Router] Push State (Nested):', url);
        // We push state that looks like a route state but implies background stop
        history.pushState({ type: 'nested', stopId, shortName, direction }, '', url);
    },

    /**
     * Update only the map location hash (used during panning)
     * Uses replaceState to avoid history pollution
     */
    updateMapLocation(hash) {
        if (this.isDirectionsPath()) {
            return;
        }
        // Use replaceState to update hash without triggering popstate or adding history entries
        history.replaceState(null, '', location.pathname + hash);
    },

    isDirectionsPath(pathname = location.pathname) {
        const path = String(pathname || '');
        const normalized = path.startsWith(this.base) ? path.substring(this.base.length) : path.replace(/^\//, '');
        return normalized.startsWith('directions/');
    }
};
