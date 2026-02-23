/**
 * Manages LocalStorage history for Search results and Card visits.
 */
export class HistoryManager {
    constructor() {
        this.SEARCH_KEY = 'search_history_v2';
        this.CARD_KEY = 'card_history_v2';
        this.SEARCH_LIMIT = 30;
        this.CARD_LIMIT = 30;
        this._listeners = new Set();

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
        const didChange = this._add(this.SEARCH_KEY, item, this.SEARCH_LIMIT);
        if (didChange) this._emitChange('search:add');
    }

    getRecentSearches(limit = 5) {
        return this._get(this.SEARCH_KEY).slice(0, limit);
    }

    // --- Card History ---
    // Saved when user OPENS a card (map click or search result)
    addCard(item) {
        const didChange = this._add(this.CARD_KEY, item, this.CARD_LIMIT);
        if (didChange) this._emitChange('card:add');
    }

    getRecentCards(limit = 10) {
        return this._get(this.CARD_KEY).slice(0, limit);
    }

    // --- Removal ---
    removeSearch(item) {
        const didChange = this._remove(this.SEARCH_KEY, item);
        if (didChange) this._emitChange('search:remove');
    }

    removeCard(item) {
        const didChange = this._remove(this.CARD_KEY, item);
        if (didChange) this._emitChange('card:remove');
    }

    clearSearchHistory() {
        console.log('[History] Clearing all search history.');
        localStorage.setItem(this.SEARCH_KEY, '[]');
        this._emitChange('search:clear');
    }

    getSnapshot() {
        return {
            searches: this._get(this.SEARCH_KEY),
            cards: this._get(this.CARD_KEY)
        };
    }

    replaceHistory({ searches, cards }) {
        if (Array.isArray(searches)) {
            localStorage.setItem(this.SEARCH_KEY, JSON.stringify(searches.slice(0, this.SEARCH_LIMIT)));
        }
        if (Array.isArray(cards)) {
            localStorage.setItem(this.CARD_KEY, JSON.stringify(cards.slice(0, this.CARD_LIMIT)));
        }
        this._emitChange('replace');
    }

    subscribe(listener) {
        if (typeof listener !== 'function') {
            return () => {};
        }
        this._listeners.add(listener);
        return () => this._listeners.delete(listener);
    }

    _emitChange(reason) {
        const snapshot = this.getSnapshot();
        this._listeners.forEach(listener => {
            try {
                listener({ reason, ...snapshot });
            } catch (e) {
                console.error('[History] Change listener failed', e);
            }
        });
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
        const normalizedItem = {
            ...item,
            ts: Number.isFinite(item?.ts) ? Number(item.ts) : Date.now()
        };
        let list = this._get(key);

        // Remove existing (move to top)
        list = list.filter(i => {
            // Compare unique ID
            if (i.type !== normalizedItem.type) return true;
            if (String(i.id) !== String(normalizedItem.id)) return true;
            return false;
        });

        // Add to top
        list.unshift(normalizedItem);

        // Limit
        if (list.length > limit) {
            list = list.slice(0, limit);
        }

        try {
            localStorage.setItem(key, JSON.stringify(list));
            return true;
        } catch (e) {
            console.error('[History] Storage quota exceeded. Clearing old items.', e);
            if (e.name === 'QuotaExceededError' || e.code === 22) {
                // Emergency Cleanup: Halve the list and try again
                list = list.slice(0, Math.ceil(limit / 2));
                try {
                    localStorage.setItem(key, JSON.stringify(list));
                    return true;
                } catch (retryErr) {
                    console.error('[History] Failed to save history even after cleanup.', retryErr);
                }
            }
        }
        return false;
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
        return list.length !== initialLength;
    }
}

export const historyManager = new HistoryManager();

// --- Navigation History (Moved from main.js) ---
const historyStack = [];

export function addToHistory(type, data) {
    // Don't add if it's the same as the current top
    const top = historyStack[historyStack.length - 1];
    if (top && top.type === type && top.data.id === data.id) {
        top.data = data;
        updateBackButtons();
        return;
    }

    historyStack.push({ type, data });
    updateBackButtons();
    // Save to Recent Cards history (separately from Search History)
    historyManager.addCard({ type, id: data.id, data });
}

export function popHistory() {
    if (historyStack.length <= 1) return null;
    historyStack.pop(); // Remove current
    return historyStack[historyStack.length - 1]; // Return previous
}

export function peekHistory() {
    if (historyStack.length === 0) return null;
    return historyStack[historyStack.length - 1];
}

export function clearHistory() {
    historyStack.length = 0;
    updateBackButtons();
}

export function updateBackButtons() {
    const hasHistory = historyStack.length > 1;
    const backPanel = document.getElementById('back-panel');
    const backRoute = document.getElementById('back-route-info');

    if (backPanel) backPanel.classList.toggle('hidden', !hasHistory);
    if (backRoute) backRoute.classList.toggle('hidden', !hasHistory);
}
