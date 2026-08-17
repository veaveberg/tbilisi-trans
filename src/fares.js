import { parseCSV } from './csv-parser.js';
import { getOtaDataFileText } from './ota-data.js';

let fareRules = null;
let fareLoadPromise = null;

function normalize(value) {
    return String(value ?? '').trim().toLowerCase();
}

function getBasePath() {
    const basePath = (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.BASE_URL)
        ? import.meta.env.BASE_URL
        : './';
    return basePath.endsWith('/') ? basePath : `${basePath}/`;
}

function parseFareRules(csvText) {
    return parseCSV(csvText).map((row) => ({
        source: normalize(row.source),
        mode: normalize(row.mode).toUpperCase(),
        routeId: normalize(row.route_id),
        routeShortName: normalize(row.route_short_name),
        // Keep this as text instead of a number: fare notation such as 0.50
        // and 1.5 is intentional presentation data in the CSV.
        priceGel: String(row.price_gel || '').trim(),
        currency: String(row.currency || 'GEL').trim().toUpperCase()
    })).filter((rule) => rule.priceGel && /^[0-9]+(?:[.,][0-9]+)?$/.test(rule.priceGel));
}

/** Load fare rules from OTA on native apps, or from the bundled CSV on web. */
export function loadFareData() {
    if (fareRules) return Promise.resolve(fareRules);
    if (fareLoadPromise) return fareLoadPromise;

    fareLoadPromise = (async () => {
        try {
            const otaText = await getOtaDataFileText('fares.csv');
            const csvText = otaText || await (await fetch(`${getBasePath()}data/fares.csv`)).text();
            fareRules = parseFareRules(csvText);
            console.log(`[Fares] Loaded ${fareRules.length} fare rule(s)`);
        } catch (error) {
            console.warn('[Fares] Could not load fare data:', error);
            fareRules = [];
        } finally {
            fareLoadPromise = null;
        }
        return fareRules;
    })();

    return fareLoadPromise;
}

export function invalidateFareDataCache() {
    fareRules = null;
    fareLoadPromise = null;
}

/**
 * Returns the most specific matching fare rule for a route.
 * Empty source/mode/route columns in fares.csv are wildcards, allowing a
 * single default to cover an entire network or mode.
 */
export function getFareForRoute(route) {
    if (!route || !fareRules) return null;

    const identity = {
        source: normalize(route._source || route._sourceId),
        mode: normalize(route.mode).toUpperCase(),
        routeId: normalize(route.id),
        routeShortName: normalize(route.shortName || route.customShortName)
    };

    let match = null;
    let matchScore = -1;
    for (const rule of fareRules) {
        if ((rule.source && rule.source !== identity.source) ||
            (rule.mode && rule.mode !== identity.mode) ||
            (rule.routeId && rule.routeId !== identity.routeId) ||
            (rule.routeShortName && rule.routeShortName !== identity.routeShortName)) {
            continue;
        }

        const score = Number(Boolean(rule.source)) + Number(Boolean(rule.mode)) +
            Number(Boolean(rule.routeId)) + Number(Boolean(rule.routeShortName));
        if (score > matchScore) {
            match = rule;
            matchScore = score;
        }
    }

    return match;
}

/** Formats a fare for the compact arrivals metadata row. */
export function formatRouteFare(route) {
    const fare = getFareForRoute(route);
    if (!fare) return null;

    const currency = fare.currency === 'GEL' ? '₾' : fare.currency;
    const [whole, fraction = ''] = fare.priceGel.replace(',', '.').split('.');
    const significantFraction = fraction.replace(/0+$/, '');
    const price = significantFraction ? `${whole},${significantFraction}` : whole;
    return `${price} ${currency}`;
}
