import * as api from './api.js';

const FILTER_TRAVEL_TIME_TTL_MS = 2 * 60 * 1000;

export function createFilterTravelTimeHelper({
    getEquivalentStops,
    mergeSourcesMap,
    redirectMap,
    onUpdate,
    filterManager
}) {
    const travelTimeCache = new Map(); // key -> { minutes, ts }
    const travelTimePending = new Map(); // key -> Promise

    const getTbilisiMinutesNow = () => {
        const now = new Date();
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone: "Asia/Tbilisi",
            hour: 'numeric',
            minute: 'numeric',
            hour12: false
        }).formatToParts(now);
        const h = parseInt(parts.find(p => p.type === 'hour').value);
        const m = parseInt(parts.find(p => p.type === 'minute').value);
        return h * 60 + m;
    };

    const normalizeStopId = (id) => String(id).replace(/^\d+:/, '').replace(/^[rR]/, '');

    const collectEquivalentStopIds = (stopId) => {
        const ids = new Set(getEquivalentStops(stopId));
        if (mergeSourcesMap.has(stopId)) {
            mergeSourcesMap.get(stopId).forEach(s => ids.add(s));
        }
        if (redirectMap.has(stopId)) {
            ids.add(redirectMap.get(stopId));
        }
        return Array.from(ids);
    };

    const findScheduleStop = (stops, ids) => {
        if (!Array.isArray(stops) || stops.length === 0) return null;
        const idSet = new Set(ids.map(String));
        const normSet = new Set(ids.map(normalizeStopId));
        return stops.find(s => {
            const sId = String(s.id);
            const sCode = String(s.code || '');
            const sNorm = normalizeStopId(sId);
            if (idSet.has(sId)) return true;
            if (normSet.has(sNorm)) return true;
            if (sCode && normSet.has(normalizeStopId(sCode))) return true;
            return false;
        }) || null;
    };

    const parseArrivalTimes = (timesStr) => {
        if (!timesStr || typeof timesStr !== 'string') return [];
        return timesStr.split(',').map(t => {
            const [h, m] = t.split(':').map(Number);
            if (Number.isNaN(h) || Number.isNaN(m)) return null;
            return (h % 24) * 60 + m;
        });
    };

    const computeScheduledTravelRange = (schedule, originIds, targetIds) => {
        if (!schedule || !Array.isArray(schedule)) return null;
        const tbilisiNow = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Tbilisi' });
        let daySchedule = schedule.find(s => s.serviceDates && s.serviceDates.includes(tbilisiNow));
        if (!daySchedule) daySchedule = schedule[0];
        if (!daySchedule || !Array.isArray(daySchedule.stops)) return null;

        const originStop = findScheduleStop(daySchedule.stops, originIds);
        const targetStop = findScheduleStop(daySchedule.stops, targetIds);
        if (!originStop || !targetStop || !originStop.arrivalTimes || !targetStop.arrivalTimes) return null;

        const originTimes = parseArrivalTimes(originStop.arrivalTimes);
        const targetTimes = parseArrivalTimes(targetStop.arrivalTimes);
        const count = Math.min(originTimes.length, targetTimes.length);
        if (count === 0) return null;

        let min = null;
        let max = null;
        for (let i = 0; i < count; i++) {
            let o = originTimes[i];
            let t = targetTimes[i];
            if (o === null || t === null) continue;
            if (t < o) t += 1440;
            const delta = t - o;
            if (delta > 0) {
                if (min === null || delta < min) min = delta;
                if (max === null || delta > max) max = delta;
            }
        }

        if (min === null || max === null) return null;
        return { min: Math.round(min), max: Math.round(max) };
    };

    const getCachedTravelMinutes = (cacheKey) => {
        const entry = travelTimeCache.get(cacheKey);
        if (!entry) return { hit: false };
        const ttl = entry.minutes === null ? 60 * 1000 : FILTER_TRAVEL_TIME_TTL_MS;
        if (Date.now() - entry.ts > ttl) {
            travelTimeCache.delete(cacheKey);
            return { hit: false };
        }
        return { hit: true, minutes: entry.minutes };
    };

    const requestScheduledTravelMinutes = ({ signature, routeId, patternSuffix, originId, targetId }) => {
        const cacheKey = `${signature}|${routeId}|${patternSuffix || ''}|${originId}|${targetId}`;
        const cached = getCachedTravelMinutes(cacheKey);
        if (cached.hit) return cached.minutes;
        if (travelTimePending.has(cacheKey)) return null;

        const originIds = collectEquivalentStopIds(originId);
        const targetIds = collectEquivalentStopIds(targetId);
        const stopIds = Array.from(new Set([...originIds, ...targetIds]));

        const promise = (async () => {
            try {
                const scheduleResult = await api.fetchScheduleForStop(routeId, stopIds, patternSuffix, {});
                const schedule = scheduleResult ? scheduleResult.schedule : null;
                const range = computeScheduledTravelRange(schedule, originIds, targetIds);
                travelTimeCache.set(cacheKey, { minutes: range, ts: Date.now() });
            } catch (e) {
                travelTimeCache.set(cacheKey, { minutes: null, ts: Date.now() });
            } finally {
                travelTimePending.delete(cacheKey);
                if (filterManager && filterManager.state.active) {
                    onUpdate();
                }
            }
        })();

        travelTimePending.set(cacheKey, promise);
        return null;
    };

    return {
        getTbilisiMinutesNow,
        requestScheduledTravelMinutes
    };
}
