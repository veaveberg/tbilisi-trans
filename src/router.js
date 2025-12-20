export const Router = {
    // Detect base path from vite.config/document base or default
    base: '/tbilisi-trans/',

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
     * URL Format: /base/stopID/filtered/destID-destID-destID
     */
    parse() {
        // Strip base path
        let path = location.pathname;
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
                return {
                    type: 'nested',
                    stopId: stopId,
                    shortName: shortName,
                    direction: direction
                };
            } else {
                return {
                    type: 'route',
                    shortName: shortName,
                    direction: direction
                };
            }
        }

        const state = {
            type: 'stop',
            stopId: null,
            filterActive: false,
            targetIds: []
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

        if (parts.length > 2 && parts[1] === 'filtered') {
            state.filterActive = true;
            // Part 2: Destinations (e.g. "destinations405-1324" or just "405-1324")
            let p2 = parts[2];
            if (p2.startsWith('destinations')) {
                p2 = p2.substring(12);
            }
            // Normalize Targets
            state.targetIds = p2.split('-').filter(id => id.length > 0);
        }

        return state;
    },

    /**
     * Update URL based on state
     */
    update(stopId, filterActive, targetIds, mapHash = '') {
        // Legacy Support for update(stopId...) calls
        // We really should use dedicated methods, but keeping this for backward compat if needed.
        // Or better: Redirect to updateStop logic.
        this.updateStop(stopId, filterActive, targetIds, mapHash);
    },

    updateStop(stopId, filterActive, targetIds, mapHash = '') {
        if (!stopId) {
            // Reset to Home (with optional hash)
            const url = this.base + mapHash;
            history.pushState(null, '', url);
            return;
        }

        // Clean ID for URL: Remove "1:" prefix
        const cleanId = (id) => String(id).replace(/^1:/, '');

        let url = `${this.base}stop${cleanId(stopId)}`;

        if (filterActive && targetIds && targetIds.length > 0) {
            // Sort for consistency
            const sortedIds = [...targetIds].map(cleanId).sort();
            url += `/filtered/destinations${sortedIds.join('-')}`;
        }

        console.log('[Router] Push State (Stop):', url);
        history.pushState({ type: 'stop', stopId, filterActive, targetIds }, '', url);
    },

    updateRoute(shortName, direction = 0) {
        if (!shortName) return;
        const suffix = direction === 1 ? 'b' : 'a';
        let url = `${this.base}bus${shortName}${suffix}`;
        console.log('[Router] Push State (Route):', url);
        history.pushState({ type: 'route', shortName, direction }, '', url);
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
        // Only update if we are at base (no stop selected)
        // Check if current path matches base (ignoring trailing slash differences if any)
        const currentPath = location.pathname.endsWith('/') ? location.pathname : location.pathname + '/';
        const basePath = this.base.endsWith('/') ? this.base : this.base + '/';

        if (currentPath === basePath) {
            history.replaceState(null, '', this.base + hash);
        }
    }
};
