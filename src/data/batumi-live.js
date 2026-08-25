/**
 * Batumi's own client treats a missing or zero upstream minute as no live
 * prediction. Positive values are shown one minute lower than the API value.
 */
export function normalizeBatumiArrivalMinutes(rawMinute) {
    if (rawMinute === null || rawMinute === undefined || rawMinute === '') return null;

    const minute = Number(rawMinute);
    if (!Number.isFinite(minute) || minute <= 0) return null;

    return Math.max(0, minute - 1);
}
