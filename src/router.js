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

        // Default State
        const state = {
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

            // Normalize: If numeric (e.g. 803), assume "1:803". 
            // If already "1:..." or other prefix, keep it.
            if (rawId && !rawId.includes(':')) {
                state.stopId = `1:${rawId}`;
            } else {
                state.stopId = rawId;
            }
        }

        if (parts.length > 2 && parts[1] === 'filtered') {
            state.filterActive = true;
            // Part 2: Destinations (e.g. "destinations405-1324" or just "405-1324")
            let p2 = parts[2];
            if (p2.startsWith('destinations')) {
                p2 = p2.substring(12);
            }
            // Normalize Targets too
            state.targetIds = p2.split('-').filter(id => id.length > 0).map(id => {
                if (!id.includes(':')) return `1:${id}`;
                return id;
            });
        }

        return state;
    },

    /**
     * Update URL based on state
     */
    update(stopId, filterActive, targetIds) {
        if (!stopId) {
            // Reset to Home
            const url = this.base;
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

        console.log('[Router] Push State:', url);
        history.pushState({ stopId, filterActive, targetIds }, '', url);
    }
};
