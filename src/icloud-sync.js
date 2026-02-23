import { Capacitor, registerPlugin } from '@capacitor/core';
import { historyManager } from './history.js';
import { favoritesManager } from './favorites.js';

const NativeSettingsPlugin = registerPlugin('NativeSettings');

const SEARCH_LIMIT = 30;
const CARD_LIMIT = 30;
const FAVORITES_RECORD_LIMIT = 2000;
const PUSH_DEBOUNCE_MS = 600;

let initialized = false;
let isEnabled = true;
let isApplyingRemote = false;
let pushTimer = null;
let lastPushedSignature = '';
let pendingEnableMode = null;

function isNativeSettingsAvailable() {
    if (typeof Capacitor === 'undefined') return false;
    if (typeof Capacitor.isNativePlatform === 'function' && !Capacitor.isNativePlatform()) return false;
    if (typeof Capacitor.isPluginAvailable === 'function') {
        return Capacitor.isPluginAvailable('NativeSettings');
    }
    return typeof window !== 'undefined' &&
        window.Capacitor &&
        window.Capacitor.Plugins &&
        window.Capacitor.Plugins.NativeSettings;
}

function getNativeSettingsPlugin() {
    if (!isNativeSettingsAvailable()) return null;
    return NativeSettingsPlugin;
}

function normalizeList(list, limit) {
    if (!Array.isArray(list)) return [];
    return list
        .filter(item => item && item.type && (item.id !== undefined && item.id !== null))
        .map(item => ({
            ...item,
            id: String(item.id),
            ts: Number.isFinite(item.ts) ? Number(item.ts) : 0
        }))
        .slice(0, limit);
}

function mergeLists(localList, remoteList, limit) {
    const mergedMap = new Map();

    const mergeOne = (item, source) => {
        const key = `${item.type}:${String(item.id)}`;
        const existing = mergedMap.get(key);
        if (!existing) {
            mergedMap.set(key, { ...item, _sourcePriority: source === 'remote' ? 2 : 1 });
            return;
        }

        const existingTs = Number.isFinite(existing.ts) ? Number(existing.ts) : 0;
        const nextTs = Number.isFinite(item.ts) ? Number(item.ts) : 0;

        if (nextTs > existingTs) {
            mergedMap.set(key, { ...item, _sourcePriority: source === 'remote' ? 2 : 1 });
            return;
        }

        if (nextTs === existingTs) {
            const existingPriority = existing._sourcePriority || 0;
            const nextPriority = source === 'remote' ? 2 : 1;
            if (nextPriority > existingPriority) {
                mergedMap.set(key, { ...item, _sourcePriority: nextPriority });
            }
        }
    };

    normalizeList(localList, limit).forEach(item => mergeOne(item, 'local'));
    normalizeList(remoteList, limit).forEach(item => mergeOne(item, 'remote'));

    return Array.from(mergedMap.values())
        .sort((a, b) => {
            const ta = Number.isFinite(a.ts) ? Number(a.ts) : 0;
            const tb = Number.isFinite(b.ts) ? Number(b.ts) : 0;
            return tb - ta;
        })
        .slice(0, limit)
        .map(({ _sourcePriority, ...item }) => item);
}

function normalizeFavoriteRecords(list, limit) {
    if (!Array.isArray(list)) return [];
    const byKey = new Map();
    list.forEach((item) => {
        if (!item || typeof item.key !== 'string') return;
        if (!item.key.startsWith('stop:') && !item.key.startsWith('route:')) return;
        const key = String(item.key);
        const ts = Number.isFinite(item.ts) ? Number(item.ts) : 0;
        const value = !!item.value;
        const title = typeof item.title === 'string' ? item.title.trim() : '';
        const subtitle = typeof item.subtitle === 'string' ? item.subtitle.trim() : '';
        const routeNumber = typeof item.routeNumber === 'string' ? item.routeNumber.trim() : '';
        const routeColorRaw = typeof item.routeColor === 'string' ? item.routeColor.trim() : '';
        const routeColor = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(routeColorRaw) ? routeColorRaw : '';
        const stopIcon = typeof item.stopIcon === 'string' ? item.stopIcon.trim() : '';
        const existing = byKey.get(key);
        if (!existing) {
            byKey.set(key, { key, value, ts, title, subtitle, routeNumber, routeColor, stopIcon });
            return;
        }
        if (ts > existing.ts) {
            byKey.set(key, { key, value, ts, title, subtitle, routeNumber, routeColor, stopIcon });
            return;
        }
        if (ts === existing.ts) {
            byKey.set(key, {
                key,
                value,
                ts,
                title: title || existing.title || '',
                subtitle: subtitle || existing.subtitle || '',
                routeNumber: routeNumber || existing.routeNumber || '',
                routeColor: routeColor || existing.routeColor || '',
                stopIcon: stopIcon || existing.stopIcon || ''
            });
        }
    });

    return Array.from(byKey.values())
        .sort((a, b) => b.ts - a.ts)
        .slice(0, limit);
}

function mergeFavoriteRecords(localRecords, remoteRecords, limit) {
    const mergedMap = new Map();
    const mergeOne = (item, source) => {
        const key = String(item.key);
        const title = typeof item.title === 'string' ? item.title.trim() : '';
        const subtitle = typeof item.subtitle === 'string' ? item.subtitle.trim() : '';
        const routeNumber = typeof item.routeNumber === 'string' ? item.routeNumber.trim() : '';
        const routeColorRaw = typeof item.routeColor === 'string' ? item.routeColor.trim() : '';
        const routeColor = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(routeColorRaw) ? routeColorRaw : '';
        const stopIcon = typeof item.stopIcon === 'string' ? item.stopIcon.trim() : '';
        const existing = mergedMap.get(key);
        if (!existing) {
            mergedMap.set(key, { ...item, title, subtitle, routeNumber, routeColor, stopIcon, _sourcePriority: source === 'remote' ? 2 : 1 });
            return;
        }
        const existingTs = Number.isFinite(existing.ts) ? Number(existing.ts) : 0;
        const nextTs = Number.isFinite(item.ts) ? Number(item.ts) : 0;
        if (nextTs > existingTs) {
            mergedMap.set(key, { ...item, title, subtitle, routeNumber, routeColor, stopIcon, _sourcePriority: source === 'remote' ? 2 : 1 });
            return;
        }
        if (nextTs === existingTs) {
            const existingPriority = existing._sourcePriority || 0;
            const nextPriority = source === 'remote' ? 2 : 1;
            if (nextPriority > existingPriority) {
                mergedMap.set(key, { ...item, title, subtitle, routeNumber, routeColor, stopIcon, _sourcePriority: nextPriority });
            } else if (!existing.title && title) {
                mergedMap.set(key, {
                    ...existing,
                    title,
                    subtitle: existing.subtitle || subtitle,
                    routeNumber: existing.routeNumber || routeNumber,
                    routeColor: existing.routeColor || routeColor,
                    stopIcon: existing.stopIcon || stopIcon
                });
            }
        }
    };

    normalizeFavoriteRecords(localRecords, limit).forEach(item => mergeOne(item, 'local'));
    normalizeFavoriteRecords(remoteRecords, limit).forEach(item => mergeOne(item, 'remote'));

    return Array.from(mergedMap.values())
        .sort((a, b) => {
            const ta = Number.isFinite(a.ts) ? Number(a.ts) : 0;
            const tb = Number.isFinite(b.ts) ? Number(b.ts) : 0;
            return tb - ta;
        })
        .slice(0, limit)
        .map(({ _sourcePriority, ...item }) => item);
}

function getSignature(searches, cards, favoriteRecords) {
    return JSON.stringify({ searches, cards, favoriteRecords });
}

async function fetchRemoteSyncData() {
    const plugin = getNativeSettingsPlugin();
    if (!plugin) return { searches: [], cards: [], favoriteRecords: [] };

    const res = await plugin.getSyncedHistory();
    if (!res || res.available === false) return { searches: [], cards: [], favoriteRecords: [] };

    let remoteSearches = [];
    let remoteCards = [];
    let remoteFavoriteRecords = [];

    try {
        remoteSearches = JSON.parse(res.searchHistoryJson || '[]');
    } catch (e) {
        console.warn('[iCloudSync] Failed parsing remote search history', e);
    }
    try {
        remoteCards = JSON.parse(res.cardHistoryJson || '[]');
    } catch (e) {
        console.warn('[iCloudSync] Failed parsing remote card history', e);
    }

    if (typeof plugin.getSyncedFavorites === 'function') {
        try {
            const favoritesRes = await plugin.getSyncedFavorites();
            if (favoritesRes && favoritesRes.available !== false) {
                remoteFavoriteRecords = JSON.parse(favoritesRes.favoritesJson || '[]');
            }
        } catch (e) {
            console.warn('[iCloudSync] Failed parsing remote favorites', e);
        }
    }

    return {
        searches: normalizeList(remoteSearches, SEARCH_LIMIT),
        cards: normalizeList(remoteCards, CARD_LIMIT),
        favoriteRecords: normalizeFavoriteRecords(remoteFavoriteRecords, FAVORITES_RECORD_LIMIT)
    };
}

async function pushNow() {
    if (!isEnabled) return;
    const plugin = getNativeSettingsPlugin();
    if (!plugin) return;

    const historySnapshot = historyManager.getSnapshot();
    const favoriteSnapshot = favoritesManager.getSnapshot();
    const searches = normalizeList(historySnapshot.searches, SEARCH_LIMIT);
    const cards = normalizeList(historySnapshot.cards, CARD_LIMIT);
    const favoriteRecords = normalizeFavoriteRecords(favoriteSnapshot.records, FAVORITES_RECORD_LIMIT);
    const signature = getSignature(searches, cards, favoriteRecords);
    if (signature === lastPushedSignature) return;

    try {
        const syncTasks = [
            plugin.syncHistory({
                searchHistoryJson: JSON.stringify(searches),
                cardHistoryJson: JSON.stringify(cards)
            })
        ];
        if (typeof plugin.syncFavorites === 'function') {
            syncTasks.push(plugin.syncFavorites({
                favoritesJson: JSON.stringify(favoriteRecords)
            }));
        }
        await Promise.all(syncTasks);
        lastPushedSignature = signature;
    } catch (e) {
        console.warn('[iCloudSync] Failed pushing data to iCloud', e);
    }
}

function schedulePush() {
    if (!isEnabled || isApplyingRemote) return;
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(() => {
        pushTimer = null;
        pushNow();
    }, PUSH_DEBOUNCE_MS);
}

async function pullAndApply(strategy = 'merge') {
    const localHistorySnapshot = historyManager.getSnapshot();
    const localFavoriteSnapshot = favoritesManager.getSnapshot();
    const remoteSnapshot = await fetchRemoteSyncData();

    const nextSearches = strategy === 'replace'
        ? normalizeList(remoteSnapshot.searches, SEARCH_LIMIT)
        : mergeLists(localHistorySnapshot.searches, remoteSnapshot.searches, SEARCH_LIMIT);
    const nextCards = strategy === 'replace'
        ? normalizeList(remoteSnapshot.cards, CARD_LIMIT)
        : mergeLists(localHistorySnapshot.cards, remoteSnapshot.cards, CARD_LIMIT);
    const nextFavoriteRecords = strategy === 'replace'
        ? normalizeFavoriteRecords(remoteSnapshot.favoriteRecords, FAVORITES_RECORD_LIMIT)
        : mergeFavoriteRecords(localFavoriteSnapshot.records, remoteSnapshot.favoriteRecords, FAVORITES_RECORD_LIMIT);

    const mergedSignature = getSignature(nextSearches, nextCards, nextFavoriteRecords);
    const localSignature = getSignature(
        normalizeList(localHistorySnapshot.searches, SEARCH_LIMIT),
        normalizeList(localHistorySnapshot.cards, CARD_LIMIT),
        normalizeFavoriteRecords(localFavoriteSnapshot.records, FAVORITES_RECORD_LIMIT)
    );

    if (mergedSignature !== localSignature) {
        isApplyingRemote = true;
        try {
            historyManager.replaceHistory({ searches: nextSearches, cards: nextCards });
            favoritesManager.replaceRecords(nextFavoriteRecords, 'replace');
        } finally {
            isApplyingRemote = false;
        }
    }

    await pushNow();
}

function getEnableStrategy() {
    if (pendingEnableMode === 'replace') return 'replace';
    if (pendingEnableMode === 'merge') return 'merge';
    if (pendingEnableMode === 'pushLocal') return 'pushLocal';
    const storedMode = localStorage.getItem('icloudSyncMode');
    if (storedMode === 'pushLocal') return 'pushLocal';
    return storedMode === 'replace' ? 'replace' : 'merge';
}

async function applyToggle(enabled) {
    isEnabled = !!enabled;
    localStorage.setItem('icloudSyncEnabled', isEnabled);

    const plugin = getNativeSettingsPlugin();
    if (!plugin) return;

    try {
        await plugin.setICloudSyncEnabled({ enabled: isEnabled });
    } catch (e) {
        console.warn('[iCloudSync] Failed to update native iCloud sync state', e);
    }

    if (isEnabled) {
        const strategy = getEnableStrategy();
        if (strategy === 'pushLocal') {
            await pushNow();
            // Treat as one-shot to avoid repeatedly forcing local -> iCloud on later startups.
            localStorage.setItem('icloudSyncMode', 'merge');
        } else if (strategy === 'replace') {
            await pullAndApply('replace');
            // Treat replace as one-shot too. Keep future launches on merge unless user picks replace again.
            localStorage.setItem('icloudSyncMode', 'merge');
        } else {
            await pullAndApply(strategy);
        }
        pendingEnableMode = null;
    }
}

export async function initICloudHistorySync() {
    if (initialized) return;
    initialized = true;

    const plugin = getNativeSettingsPlugin();
    if (!plugin) return;

    try {
        const state = await plugin.getICloudSyncState();
        if (!state || state.available === false) return;

        const hasLocalPreference = localStorage.getItem('icloudSyncEnabled') !== null;
        const localEnabled = hasLocalPreference
            ? localStorage.getItem('icloudSyncEnabled') === 'true'
            : (state.enabled !== false);

        if (!localEnabled) {
            pendingEnableMode = null;
        }
        await applyToggle(localEnabled);

        plugin.addListener('iCloudHistoryUpdated', async () => {
            if (!isEnabled) return;
            await pullAndApply('merge');
        });

        historyManager.subscribe(() => {
            schedulePush();
        });
        favoritesManager.subscribe(() => {
            schedulePush();
        });

        window.addEventListener('iCloudSyncModeChange', (event) => {
            const mode = event.detail;
            if (mode === 'merge' || mode === 'replace' || mode === 'pushLocal') {
                pendingEnableMode = mode;
            }
        });

        window.addEventListener('iCloudSyncToggleChange', async (event) => {
            const enabled = !!event.detail;
            if (!enabled) {
                pendingEnableMode = null;
            }
            await applyToggle(enabled);
        });

        if (isEnabled) {
            await pullAndApply('merge');
        }
    } catch (e) {
        console.warn('[iCloudSync] Initialization failed', e);
    }
}
