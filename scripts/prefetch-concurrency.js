// Each worker handles one route at a time; requests within that route remain
// sequential, so the number of simultaneous upstream requests stays bounded.
export function routeConcurrency(value = process.env.TRANSIT_PREFETCH_CONCURRENCY || '3') {
    const limit = Number(value);
    if (!Number.isInteger(limit) || limit < 1 || limit > 8) throw new Error('TRANSIT_PREFETCH_CONCURRENCY must be an integer from 1 to 8');
    return limit;
}
export async function forEachConcurrent(items, worker, limit = routeConcurrency()) {
    let cursor = 0;
    const failures = [];
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (cursor < items.length) {
            const index = cursor++;
            try { await worker(items[index], index); }
            catch (error) { failures.push(error); }
        }
    }));
    // Drain all workers before returning or throwing; callers never write while
    // a route worker is still modifying the aggregate data.
    if (failures.length) throw new AggregateError(failures, 'Route refresh failed');
}
export const orderedRecords = value => Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true })));

// A provider can list a route while its details endpoint is broken. Preserve
// the entire previous route rather than publishing a partial replacement.
export function preserveFailedRoutes(failedIds, previous, current) {
    for (const id of failedIds) {
        for (const locale of Object.keys(current.locales)) {
            const old = previous.locales[locale];
            if (!old?.routes?.some(route => String(route.id) === id)) throw new Error(`No cached route ${id} [${locale}]`);
        }
    }
    for (const id of failedIds) {
        for (const locale of Object.keys(current.locales)) {
            const old = previous.locales[locale], next = current.locales[locale];
            if (Object.hasOwn(old.details, id)) next.details[id] = structuredClone(old.details[id]);
            else delete next.details[id]; // Preserve a provider's already-unavailable details.
            const index = next.routes.findIndex(route => String(route.id) === id);
            if (index >= 0) next.routes[index] = structuredClone(old.routes.find(route => String(route.id) === id));
        }
        for (const key of ['schedules', 'polylines']) {
            for (const recordId of Object.keys(current[key])) if (recordId === id || recordId.startsWith(`${id}_`)) delete current[key][recordId];
            for (const [recordId, value] of Object.entries(previous[key])) if (recordId === id || recordId.startsWith(`${id}_`)) current[key][recordId] = structuredClone(value);
        }
    }
}
