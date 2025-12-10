/**
 * Manages LocalStorage history for Search results and Card visits.
 */
export class HistoryManager {
    constructor() {
        this.SEARCH_KEY = 'search_history_v2';
        this.CARD_KEY = 'card_history_v2';
        this.SEARCH_LIMIT = 30;
        this.CARD_LIMIT = 30;

        this._migrateLegacy();
    }

    _migrateLegacy() {
        if (!localStorage.getItem(this.SEARCH_KEY)) {
            const legacy = localStorage.getItem('search_history');
            if (legacy) {
                try {
                    const parsed = JSON.parse(legacy);
                    // Legacy format was likely same/similar enough or we can map it
                    // Legacy: { type, data }
                    // New: { type, id: data.id, data } (but addSearch handles normalized)
                    // We'll just save it raw and hope? 
                    // Actually, let's normalize.
                    const normalized = parsed.map(item => ({
                        type: item.type,
                        id: item.data?.id || item.id, // Fallback
                        data: item.data
                    }));

                    localStorage.setItem(this.SEARCH_KEY, JSON.stringify(normalized));
                    console.log('Migrated legacy search history', normalized);
                } catch (e) {
                    console.warn('Failed to migrate legacy history', e);
                }
            }
        }
    }

    // --- Search History ---
    // Saved when user CLICKS a result in the search dropdown
    addSearch(item) {
        // item: { type: 'stop'|'route', id: string, name: string, ... }
        this._add(this.SEARCH_KEY, item, this.SEARCH_LIMIT);
    }

    getRecentSearches(limit = 5) {
        return this._get(this.SEARCH_KEY).slice(0, limit);
    }

    // --- Card History ---
    // Saved when user OPENS a card (map click or search result)
    addCard(item) {
        this._add(this.CARD_KEY, item, this.CARD_LIMIT);
    }

    getRecentCards(limit = 10) {
        return this._get(this.CARD_KEY).slice(0, limit);
    }

    // --- Removal ---
    removeSearch(item) {
        this._remove(this.SEARCH_KEY, item);
    }

    removeCard(item) {
        this._remove(this.CARD_KEY, item);
    }

    clearSearchHistory() {
        console.log('[History] Clearing all search history.');
        localStorage.setItem(this.SEARCH_KEY, '[]');
    }

    // --- Private Helpers ---
    _get(key) {
        try {
            return JSON.parse(localStorage.getItem(key) || '[]');
        } catch (e) {
            console.error('History parse error', e);
            return [];
        }
    }

    _add(key, item, limit) {
        let list = this._get(key);

        // Remove existing (move to top)
        list = list.filter(i => {
            // Compare unique ID
            if (i.type !== item.type) return true;
            if (i.id !== item.id) return true;
            return false;
        });

        // Add to top
        list.unshift(item);

        // Limit
        if (list.length > limit) {
            list = list.slice(0, limit);
        }

        try {
            localStorage.setItem(key, JSON.stringify(list));
        } catch (e) {
            console.error('[History] Storage quota exceeded. Clearing old items.', e);
            if (e.name === 'QuotaExceededError' || e.code === 22) {
                // Emergency Cleanup: Halve the list and try again
                list = list.slice(0, Math.ceil(limit / 2));
                try {
                    localStorage.setItem(key, JSON.stringify(list));
                } catch (retryErr) {
                    console.error('[History] Failed to save history even after cleanup.', retryErr);
                }
            }
        }
    }

    _remove(key, item) {
        let list = this._get(key);
        const initialLength = list.length;

        list = list.filter(i => {
            // Keep if types differ
            if (i.type !== item.type) return true;

            // Strict String Comparison for IDs (handles 123 vs "123")
            // Check if BOTH have IDs (allow 0 or empty string)
            const iId = i.id;
            const tId = item.id;

            if (iId !== undefined && iId !== null && tId !== undefined && tId !== null) {
                return String(iId) !== String(tId);
            }

            // Fallback: Deep comparison
            try {
                // exclude wrapper properties if needed, but usually full object match is safe for same-session removal
                return JSON.stringify(i) !== JSON.stringify(item);
            } catch (e) {
                console.warn('History remove comparison error', e);
                return true;
            }
        });

        console.log(`[History] Removing ${item.type}:${item.id} from ${key}. Count: ${initialLength} -> ${list.length}`);
        localStorage.setItem(key, JSON.stringify(list));
    }
}

export const historyManager = new HistoryManager();
