const FAVORITES_KEY = 'favorites_records_v1';
const MAX_RECORDS = 2000;

function isValidKey(key) {
    if (typeof key !== 'string') return false;
    return key.startsWith('stop:') || key.startsWith('route:');
}

function normalizeText(value) {
    if (typeof value !== 'string') return '';
    return value.trim();
}

function normalizeRouteColor(value) {
    const color = normalizeText(value);
    if (!color) return '';
    if (/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(color)) return color;
    return '';
}

function normalizeStopIcon(value) {
    const icon = normalizeText(value);
    if (!icon) return '';
    if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
        const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
        for (const seg of segmenter.segment(icon)) {
            return seg.segment || '';
        }
    }
    const chars = Array.from(icon);
    return chars.length ? chars[0] : '';
}

function normalizeRecords(records, limit = MAX_RECORDS) {
    if (!Array.isArray(records)) return [];

    const byKey = new Map();
    for (const item of records) {
        if (!item || !isValidKey(item.key)) continue;
        const key = String(item.key);
        const ts = Number.isFinite(item.ts) ? Number(item.ts) : 0;
        const value = !!item.value;
        const title = normalizeText(item.title);
        const subtitle = normalizeText(item.subtitle);
        const routeNumber = normalizeText(item.routeNumber);
        const routeColor = normalizeRouteColor(item.routeColor);
        const stopIcon = normalizeStopIcon(item.stopIcon);

        const existing = byKey.get(key);
        if (!existing) {
            byKey.set(key, { key, value, ts, title, subtitle, routeNumber, routeColor, stopIcon });
            continue;
        }
        if (ts > existing.ts) {
            byKey.set(key, { key, value, ts, title, subtitle, routeNumber, routeColor, stopIcon });
            continue;
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
    }

    return Array.from(byKey.values())
        .sort((a, b) => b.ts - a.ts)
        .slice(0, limit);
}

export class FavoritesManager {
    constructor() {
        this._listeners = new Set();
    }

    has(key) {
        if (!isValidKey(key)) return false;
        const record = this._getRecordMap().get(String(key));
        return !!(record && record.value === true);
    }

    toggle(key, meta = {}) {
        if (!isValidKey(key)) return false;

        const recordMap = this._getRecordMap();
        const now = Date.now();
        const keyStr = String(key);
        const current = recordMap.get(keyStr);
        const nextValue = !(current && current.value === true);
        return this._setWithMap(recordMap, keyStr, nextValue, meta, now, 'toggle');
    }

    set(key, value, meta = {}) {
        if (!isValidKey(key)) return false;
        const recordMap = this._getRecordMap();
        const now = Date.now();
        const keyStr = String(key);
        const nextValue = !!value;
        return this._setWithMap(recordMap, keyStr, nextValue, meta, now, 'set');
    }

    _setWithMap(recordMap, keyStr, nextValue, meta, ts, reason) {
        const current = recordMap.get(keyStr);
        const nextTitle = normalizeText(meta.title) || current?.title || '';
        const nextSubtitle = normalizeText(meta.subtitle) || current?.subtitle || '';
        const nextRouteNumber = normalizeText(meta.routeNumber) || current?.routeNumber || '';
        const nextRouteColor = normalizeRouteColor(meta.routeColor) || current?.routeColor || '';
        const nextStopIcon = normalizeStopIcon(meta.stopIcon) || current?.stopIcon || '';

        recordMap.set(keyStr, {
            key: keyStr,
            value: nextValue,
            ts,
            title: nextTitle,
            subtitle: nextSubtitle,
            routeNumber: nextRouteNumber,
            routeColor: nextRouteColor,
            stopIcon: nextStopIcon
        });

        this._saveFromMap(recordMap);
        this._emitChange(reason);
        return true;
    }

    clearAll() {
        localStorage.setItem(FAVORITES_KEY, '[]');
        this._emitChange('clear');
    }

    remove(key) {
        if (!isValidKey(key)) return false;
        const recordMap = this._getRecordMap();
        const keyStr = String(key);
        const current = recordMap.get(keyStr);
        recordMap.set(keyStr, {
            key: keyStr,
            value: false,
            ts: Date.now(),
            title: current?.title || '',
            subtitle: current?.subtitle || '',
            routeNumber: current?.routeNumber || '',
            routeColor: current?.routeColor || '',
            stopIcon: current?.stopIcon || ''
        });
        this._saveFromMap(recordMap);
        this._emitChange('remove');
        return true;
    }

    updateStopIcon(key, stopIcon) {
        if (!isValidKey(key) || !String(key).startsWith('stop:')) return false;
        const recordMap = this._getRecordMap();
        const keyStr = String(key);
        const current = recordMap.get(keyStr);
        if (!current) return false;

        recordMap.set(keyStr, {
            ...current,
            stopIcon: normalizeStopIcon(stopIcon),
            ts: Date.now()
        });
        this._saveFromMap(recordMap);
        this._emitChange('icon:update');
        return true;
    }

    updateSubtitle(key, subtitle) {
        if (!isValidKey(key)) return false;
        const recordMap = this._getRecordMap();
        const keyStr = String(key);
        const current = recordMap.get(keyStr);
        if (!current) return false;

        recordMap.set(keyStr, {
            ...current,
            subtitle: normalizeText(subtitle),
            ts: Date.now()
        });
        this._saveFromMap(recordMap);
        this._emitChange('subtitle:update');
        return true;
    }

    reorderType(type, orderedKeys) {
        if (type !== 'stop' && type !== 'route') return false;
        if (!Array.isArray(orderedKeys) || orderedKeys.length === 0) return false;

        const prefix = `${type}:`;
        const sanitized = orderedKeys
            .map((key) => String(key))
            .filter((key) => key.startsWith(prefix));
        if (!sanitized.length) return false;

        const recordMap = this._getRecordMap();
        const now = Date.now();

        sanitized.forEach((key, index) => {
            const existing = recordMap.get(key);
            if (!existing) return;
            recordMap.set(key, {
                ...existing,
                ts: now - index
            });
        });

        this._saveFromMap(recordMap);
        this._emitChange('reorder');
        return true;
    }

    getSnapshot() {
        const records = this.getRecords();
        const stops = [];
        const routes = [];

        records.forEach((record) => {
            if (!record.value) return;
            if (record.key.startsWith('stop:')) stops.push(record.key);
            if (record.key.startsWith('route:')) routes.push(record.key);
        });

        return { records, stops, routes };
    }

    getFavoritesList(limit = 300) {
        const records = this.getRecords()
            .filter(record => record.value)
            .slice(0, limit);

        return records.map((record) => ({
            key: record.key,
            type: record.key.startsWith('stop:') ? 'stop' : 'route',
            title: normalizeText(record.title),
            subtitle: normalizeText(record.subtitle),
            routeNumber: normalizeText(record.routeNumber),
            routeColor: normalizeRouteColor(record.routeColor),
            stopIcon: normalizeStopIcon(record.stopIcon),
            ts: Number.isFinite(record.ts) ? Number(record.ts) : 0
        }));
    }

    getRecords(limit = MAX_RECORDS) {
        return normalizeRecords(this._readRecords(), limit);
    }

    replaceRecords(records, strategy = 'replace') {
        const normalizedIncoming = normalizeRecords(records, MAX_RECORDS);
        if (strategy === 'merge') {
            const localMap = this._getRecordMap();
            for (const item of normalizedIncoming) {
                const existing = localMap.get(item.key);
                if (!existing || item.ts >= existing.ts) {
                    localMap.set(item.key, item);
                }
            }
            this._saveFromMap(localMap);
        } else {
            localStorage.setItem(FAVORITES_KEY, JSON.stringify(normalizedIncoming));
        }
        this._emitChange('replace');
    }

    subscribe(listener) {
        if (typeof listener !== 'function') return () => {};
        this._listeners.add(listener);
        return () => this._listeners.delete(listener);
    }

    _emitChange(reason) {
        const snapshot = this.getSnapshot();
        this._listeners.forEach((listener) => {
            try {
                listener({ reason, ...snapshot });
            } catch (e) {
                console.error('[Favorites] Change listener failed', e);
            }
        });
    }

    _readRecords() {
        try {
            return JSON.parse(localStorage.getItem(FAVORITES_KEY) || '[]');
        } catch (e) {
            console.error('[Favorites] Failed to parse stored records', e);
            return [];
        }
    }

    _getRecordMap() {
        return new Map(this.getRecords().map(record => [record.key, record]));
    }

    _saveFromMap(recordMap) {
        const nextRecords = normalizeRecords(Array.from(recordMap.values()), MAX_RECORDS);
        localStorage.setItem(FAVORITES_KEY, JSON.stringify(nextRecords));
    }
}

export const favoritesManager = new FavoritesManager();
