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
