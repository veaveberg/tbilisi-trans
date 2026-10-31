const days = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'];
const names = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const metrics = service => service ? { departures: service.firstStop?.departures ?? null, times: service.firstStop?.departureTimes ?? null, first: service.firstStop?.firstDeparture ?? null, last: service.firstStop?.lastDeparture ?? null, stops: service.stopCount ?? null, fingerprint: service.timetableFingerprint ?? null } : null;
export function summarizeSchedule(field) {
    if (![field.before, field.after].every(side => side === null || Array.isArray(side))) return null;
    const expand = services => {
        const result = new Map();
        for (const service of services || []) {
            const first = days.indexOf(service.fromDay), last = days.indexOf(service.toDay);
            if (first < 0 || last < first) return null;
            for (let day = first; day <= last; day++) {
                // Overlapping service ranges cannot be summarized as one timetable.
                if (result.has(day)) return null;
                result.set(day, service);
            }
        }
        return result;
    };
    const before = expand(field.before), after = expand(field.after);
    if (!before || !after) return null;
    const groups = new Map();
    for (let day = 0; day < 7; day++) {
        const old = metrics(before.get(day)), next = metrics(after.get(day));
        if (JSON.stringify(old) === JSON.stringify(next)) continue;
        const key = JSON.stringify([old, next]);
        if (!groups.has(key)) groups.set(key, { days: [], before: old, after: next });
        groups.get(key).days.push(day);
    }
    const dayLabel = selected => selected.length === 7 ? 'Every day' : selected.join() === '0,1,2,3,4' ? 'Weekdays' : selected.join() === '5,6' ? 'Weekends' : selected.map(day => names[day]).join(', ');
    return { origin: field.after?.find(service => service.firstStop?.name)?.firstStop.name || field.before?.find(service => service.firstStop?.name)?.firstStop.name || null,
        groups: [...groups.values()].map(group => ({ ...group, label: dayLabel(group.days) })) };
}

export function scheduleTimeRows(before, after) {
    if (!Array.isArray(before) || !Array.isArray(after)) return null;
    const counts = values => {
        const result = new Map();
        for (const value of values) {
            const match = /^(\d+):(\d{2})$/.exec(String(value).trim());
            if (!match || Number(match[2]) > 59) continue;
            const minute = (Number(match[1]) % 24) * 60 + Number(match[2]);
            result.set(minute, (result.get(minute) || 0) + 1);
        }
        return result;
    };
    const old = counts(before), next = counts(after), rows = new Map();
    const serviceOrder = minute => minute < 4 * 60 ? minute + 24 * 60 : minute;
    for (const minute of [...new Set([...old.keys(), ...next.keys()])].sort((a, b) => serviceOrder(a) - serviceOrder(b))) {
        const hour = Math.floor(minute / 60);
        if (!rows.has(hour)) rows.set(hour, { hour, departures: [] });
        const shared = Math.min(old.get(minute) || 0, next.get(minute) || 0);
        for (const [status, count] of [['unchanged', shared], ['removed', (old.get(minute) || 0) - shared], ['added', (next.get(minute) || 0) - shared]]) for (let i = 0; i < count; i++) rows.get(hour).departures.push({ minute: String(minute % 60).padStart(2, '0'), status });
    }
    return [...rows.values()];
}
