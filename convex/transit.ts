import { action, mutation, query, internalMutation, internalQuery, internalAction } from "./_generated/server";
import { v } from "convex/values";
import { internal, api } from "./_generated/api";

// --- Configuration ---
const API_KEY = 'c0a2f304-551a-4d08-b8df-2c53ecd57f9f';
const HEADERS = {
    'x-api-key': API_KEY,
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Origin': 'https://transit.ttc.com.ge',
    'Referer': 'https://transit.ttc.com.ge/',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
};

const SOURCES = {
    tbilisi: {
        id: 'tbilisi',
        apiBase: 'https://transit.ttc.com.ge/pis-gateway/api/v2',
        v3Base: 'https://transit.ttc.com.ge/pis-gateway/api/v3',
    },
    rustavi: {
        id: 'rustavi',
        apiBase: 'https://rustavi-transit.azrycloud.com/pis-gateway/api/v2',
        v3Base: 'https://rustavi-transit.azrycloud.com/pis-gateway/api/v3',
    }
};

const LOCALES = ['en', 'ka'];

// --- Helpers ---
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function fetchWithRetry(url: string, options: any, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            const res = await fetch(url, options);
            if (res.ok) return res;
            if (res.status >= 500 && i < retries - 1) {
                await sleep(500 * (i + 1));
                continue;
            }
            return res; // Return the error response if not 500 or out of retries
        } catch (e) {
            if (i === retries - 1) throw e;
            await sleep(500 * (i + 1));
        }
    }
    throw new Error(`Failed to fetch ${url} after retries`);
}

// --- Mutations ---

// Clear and replace stops for a source/locale
export const saveStops = mutation({
    args: {
        sourceId: v.string(),
        locale: v.string(),
        stops: v.array(v.any())
    },
    handler: async (ctx, { sourceId, locale, stops }): Promise<void> => {
        for (const stop of stops) {
            const stopId = stop.id.toString();

            const existing = await ctx.db
                .query("stops")
                .withIndex("by_source_locale_stopId", q => q.eq("source", sourceId).eq("locale", locale).eq("stopId", stopId))
                .first();

            if (existing) {
                await ctx.db.patch(existing._id, { data: stop });
            } else {
                await ctx.db.insert("stops", {
                    source: sourceId,
                    locale,
                    stopId,
                    data: stop
                });
            }
        }
    }
});

export const saveRoutes = mutation({
    args: {
        sourceId: v.string(),
        locale: v.string(),
        routes: v.array(v.any())
    },
    handler: async (ctx, { sourceId, locale, routes }): Promise<void> => {
        for (const route of routes) {
            const routeId = route.id.toString();
            const existing = await ctx.db
                .query("routes")
                .withIndex("by_source_locale_routeId", q => q.eq("source", sourceId).eq("locale", locale).eq("routeId", routeId))
                .first();

            if (existing) {
                await ctx.db.patch(existing._id, { data: route });
            } else {
                await ctx.db.insert("routes", {
                    source: sourceId,
                    locale,
                    routeId,
                    data: route
                });
            }
        }
    }
});

export const saveRouteDetails = mutation({
    args: {
        sourceId: v.string(),
        locale: v.string(),
        routeId: v.string(),
        details: v.any(),
        schedules: v.array(v.object({ key: v.string(), suffix: v.string(), data: v.any() })),
        polylines: v.array(v.object({ key: v.string(), suffix: v.string(), data: v.any() }))
    },
    handler: async (ctx, { sourceId, locale, routeId, details, schedules, polylines }): Promise<void> => {
        const NOW = Date.now();

        // 1. Details
        const existingDetails = await ctx.db
            .query("routeDetails")
            .withIndex("by_routeId_locale", q => q.eq("routeId", routeId).eq("locale", locale))
            .first();

        if (existingDetails) {
            await ctx.db.patch(existingDetails._id, { data: details, lastUpdated: NOW });
        } else {
            await ctx.db.insert("routeDetails", {
                routeId,
                source: sourceId,
                locale,
                data: details,
                lastUpdated: NOW
            });
        }

        // 2. Schedules
        for (const item of schedules) {
            const existing = await ctx.db.query("schedules").withIndex("by_key", q => q.eq("key", item.key)).first();
            if (existing) {
                await ctx.db.patch(existing._id, { data: item.data, lastUpdated: NOW });
            } else {
                await ctx.db.insert("schedules", {
                    key: item.key,
                    routeId,
                    suffix: item.suffix,
                    data: item.data,
                    lastUpdated: NOW
                });
            }
        }

        // 3. Polylines
        for (const item of polylines) {
            const existing = await ctx.db.query("polylines").withIndex("by_key", q => q.eq("key", item.key)).first();
            if (existing) {
                await ctx.db.patch(existing._id, { data: item.data, lastUpdated: NOW });
            } else {
                await ctx.db.insert("polylines", {
                    key: item.key,
                    routeId,
                    suffix: item.suffix,
                    data: item.data,
                    lastUpdated: NOW
                });
            }
        }
    }
});

export const saveOverrides = mutation({
    args: { overrides: v.array(v.any()) },
    handler: async (ctx, { overrides }): Promise<void> => {
        for (const ov of overrides) {
            const routeId = ov.id; // CSV uses 'id'
            if (!routeId) continue;

            const existing = await ctx.db
                .query("overrides")
                .withIndex("by_routeId", q => q.eq("routeId", routeId))
                .first();

            const data = { ...ov };
            delete data.id; // Remove raw 'id' to avoid confusion, we use routeId
            data.routeId = routeId;

            if (existing) {
                await ctx.db.patch(existing._id, data);
            } else {
                await ctx.db.insert("overrides", data);
            }
        }
    }
});


// --- Actions ---

export const fetchMasterData = internalAction({
    args: { sourceId: v.string() },
    handler: async (ctx, { sourceId }): Promise<void> => {
        const config = SOURCES[sourceId as keyof typeof SOURCES];
        if (!config) throw new Error("Invalid source");

        console.log(`Fetching Master Data for ${sourceId}...`);

        for (const locale of LOCALES) {
            // Stops
            const stopsUrl = `${config.apiBase}/stops?locale=${locale}`;
            const sRes = await fetchWithRetry(stopsUrl, { headers: HEADERS });
            if (sRes.ok) {
                const stops = await sRes.json();
                console.log(`Fetched ${stops.length} stops (${locale})`);
                await ctx.runMutation(api.transit.saveStops, { sourceId, locale, stops });
            } else {
                console.log(`Failed to fetch stops ${stopsUrl}: ${sRes.status}`);
            }

            // Routes
            const routesUrl = `${config.apiBase}/routes?locale=${locale}`;
            const rRes = await fetchWithRetry(routesUrl, { headers: HEADERS });
            if (rRes.ok) {
                const routes = await rRes.json();
                console.log(`Fetched ${routes.length} routes (${locale})`);
                await ctx.runMutation(api.transit.saveRoutes, { sourceId, locale, routes });
            } else {
                console.log(`Failed to fetch routes ${routesUrl}: ${rRes.status}`);
            }
        }
    }
});

// Used to fetch details for a Specific List of routes (batching handled by caller)
export const fetchRouteDetailsBatch = internalAction({
    args: {
        sourceId: v.string(),
        routeIds: v.array(v.string())
    },
    handler: async (ctx, { sourceId, routeIds }): Promise<void> => {
        const config = SOURCES[sourceId as keyof typeof SOURCES];
        if (!config) throw new Error("Invalid source");

        console.log(`Processing batch of ${routeIds.length} routes...`);

        for (const routeId of routeIds) {
            try {
                const schedules: any[] = [];
                const polylines: any[] = [];

                // Loop Locales for Details
                for (const locale of LOCALES) {
                    const detailsUrl = `${config.v3Base}/routes/${routeId}?locale=${locale}`;
                    const dRes = await fetchWithRetry(detailsUrl, { headers: HEADERS });
                    if (!dRes.ok) continue;

                    const details = await dRes.json();

                    // Stops of Patterns (Augment Details)
                    if (details.patterns && details.patterns.length > 0) {
                        const uniqueSuffixes: any[] = [...new Set(details.patterns.map((p: any) => p.patternSuffix))];
                        const suffixesStr = uniqueSuffixes.join(',');

                        const patternsUrl = `${config.v3Base}/routes/${routeId}/stops-of-patterns?patternSuffixes=${suffixesStr}&locale=${locale}`;
                        const pRes = await fetchWithRetry(patternsUrl, { headers: HEADERS });
                        if (pRes.ok) {
                            details._stopsOfPatterns = await pRes.json();
                        }

                        // Schedules & Polylines (Only need once, usually En)
                        if (locale === 'en') {
                            for (const suffix of uniqueSuffixes) {
                                const safeSuffix = suffix.replace(/:/g, '_').replace(/,/g, '-');
                                const key = `${routeId}_${safeSuffix}`;

                                // Schedule
                                const schedUrl = `${config.v3Base}/routes/${routeId}/schedule?patternSuffix=${suffix}&locale=en`;
                                try {
                                    const sRes = await fetchWithRetry(schedUrl, { headers: HEADERS });
                                    if (sRes.ok) {
                                        const sData = await sRes.json();
                                        schedules.push({ key, suffix, data: sData });
                                    }
                                } catch (e) { }

                                // Polyline
                                const polyUrl = `${config.v3Base}/routes/${routeId}/polylines?patternSuffixes=${suffix}`;
                                try {
                                    const plRes = await fetchWithRetry(polyUrl, { headers: HEADERS });
                                    if (plRes.ok) {
                                        const plData = await plRes.json();
                                        polylines.push({ key, suffix, data: plData });
                                    }
                                } catch (e) { }

                                await sleep(50); // Ratelimit nice
                            }
                        }
                    }

                    // Save Details (and side-loaded schedules/polylines)
                    await ctx.runMutation(api.transit.saveRouteDetails, {
                        sourceId,
                        locale,
                        routeId,
                        details,
                        schedules, // These will be redundantly passed for 'ka' loop but that's fine or we clear them
                        polylines
                    });
                }
            } catch (e: any) {
                console.error(`Failed to process route ${routeId}: ${e.message}`);
            }
        }
    }
});

export const getRouteIds = internalQuery({
    args: { sourceId: v.string(), locale: v.string() },
    handler: async (ctx, { sourceId, locale }) => {
        // Only need IDs
        const routes = await ctx.db
            .query("routes")
            .withIndex("by_source_locale", q => q.eq("source", sourceId).eq("locale", locale))
            .collect();
        return routes.map(r => r.routeId);
    }
});

export const syncSource = action({
    args: { sourceId: v.string() },
    handler: async (ctx, { sourceId }): Promise<{ status: string, totalRoutes: number, batches: number }> => {
        // 1. Fetch Lists
        console.log(`Fetch master with ${sourceId}`)
        await ctx.runAction(internal.transit.fetchMasterData, { sourceId });

        // 2. Get Route IDs
        const routeIds: string[] = await ctx.runQuery(internal.transit.getRouteIds, { sourceId, locale: 'en' });
        console.log(`Syncing details for ${routeIds.length} routes...`);

        // 3. Batch and Schedule
        const BATCH_SIZE = 5;
        for (let i = 0; i < routeIds.length; i += BATCH_SIZE) {
            const batch = routeIds.slice(i, i + BATCH_SIZE);
            await ctx.scheduler.runAfter(0, internal.transit.fetchRouteDetailsBatch, {
                sourceId,
                routeIds: batch
            });
        }

        return { status: "started", totalRoutes: routeIds.length, batches: Math.ceil(routeIds.length / BATCH_SIZE) };
    }
});


// --- Public Queries for App ---

export const getRoutes = query({
    args: {
        sourceId: v.string(),
        locale: v.string(),
        onlyWithOverrides: v.optional(v.boolean())
    },
    handler: async (ctx, { sourceId, locale, onlyWithOverrides }): Promise<any> => {
        const routes = await ctx.db
            .query("routes")
            .withIndex("by_source_locale", q => q.eq("source", sourceId).eq("locale", locale))
            .collect();

        // Fetch all overrides efficiently? 
        // Or just fetch all overrides since the table is small (290 rows)?
        // Fetching 300 rows is instant.
        const overrides = await ctx.db.query("overrides").collect();
        const overrideMap = new Map(overrides.map(o => [o.routeId, o]));
        const convexTimestamp = Date.now();
        console.log(`[getRoutes] Time: ${convexTimestamp}, Overrides: ${overrides.length}`);

        let results = routes.map(r => {
            const routeData = { ...r.data };

            // Robust lookup: try with and without '1:'/'2:' prefixes
            const lookupIds = [r.routeId];
            const strippedId = r.routeId.replace(/^[12]:/, '');

            lookupIds.push(strippedId);
            lookupIds.push(`1:${strippedId}`);
            lookupIds.push(`2:${strippedId}`);

            // Handle Rustavi 'r' prefix variants (might be r123 or just 123 in override)
            if (strippedId.startsWith('r')) {
                const noR = strippedId.slice(1);
                lookupIds.push(noR);
                lookupIds.push(`1:${noR}`);
                lookupIds.push(`2:${noR}`);
            }

            let ov = null;
            const uniqueLookups = [...new Set(lookupIds)];
            for (const id of uniqueLookups) {
                const found = overrideMap.get(id);
                if (found) {
                    ov = found;
                    break;
                }
            }

            if (ov) {
                // Apply immediate top-level overrides
                if (ov.shortName_override) routeData.shortName = ov.shortName_override;
                if (ov.isLoop !== undefined) routeData.isLoop = ov.isLoop;
                if (ov.invertDirection !== undefined) routeData.invertDirection = ov.invertDirection;

                // Locale-specific longName overrides
                if (locale === 'en' && ov.longName_en_override) routeData.longName = ov.longName_en_override;
                if (locale === 'ka' && ov.longName_ka_override) routeData.longName = ov.longName_ka_override;

                // Format the _overrides object for the frontend (specifically getPatternHeadsign)
                routeData._overrides = {
                    isLoop: ov.isLoop,
                    invertDirection: ov.invertDirection,
                    destinations: [
                        {
                            headsign: {
                                en: ov.dest0_en_override || ov.dest0_en,
                                ka: ov.dest0_ka_override || ov.dest0_ka,
                                ru: ov.dest0_ru_override || ov.dest0_ru
                            }
                        },
                        {
                            headsign: {
                                en: ov.dest1_en_override || ov.dest1_en,
                                ka: ov.dest1_ka_override || ov.dest1_ka,
                                ru: ov.dest1_ru_override || ov.dest1_ru
                            }
                        }
                    ],
                    terminusStopId: ov.terminusStopId,
                    terminusStopId_override: ov.terminusStopId_override,
                    virtualTerminusStopId: ov.virtualTerminusStopId
                };
            } else {
                routeData._debug = {
                    lookupIds: uniqueLookups,
                    totalOverridesFetched: overrides.length
                };
            }
            return routeData;
        });

        if (onlyWithOverrides) {
            results = results.filter(r => r._overrides);
        }

        return {
            routes: results,
            _convex_meta: {
                timestamp: convexTimestamp,
                totalOverrides: overrides.length,
                sourceId,
                locale
            }
        };
    }
});

// ... (existing getRoutes)

export const getRouteDetails = query({
    args: {
        sourceId: v.string(),
        locale: v.string(),
        routeId: v.string()
    },
    handler: async (ctx, { sourceId, locale, routeId }): Promise<any> => {
        // Robust lookup: try multiple ID variations
        const lookupIds = [routeId];
        const strippedId = routeId.replace(/^[12]:/, '');
        lookupIds.push(strippedId);
        lookupIds.push(`1:${strippedId}`);
        lookupIds.push(`2:${strippedId}`);

        if (strippedId.startsWith('r')) {
            const noR = strippedId.slice(1);
            lookupIds.push(noR);
            lookupIds.push(`1:${noR}`);
            lookupIds.push(`2:${noR}`);
        }

        let detailsDoc = null;
        for (const id of [...new Set(lookupIds)]) {
            detailsDoc = await ctx.db
                .query("routeDetails")
                .withIndex("by_source_routeId_locale", q => q.eq("source", sourceId).eq("routeId", id).eq("locale", locale))
                .first();
            if (detailsDoc) break;
        }

        if (!detailsDoc) return null;

        const details = detailsDoc.data;

        // Attach Schedules & Polylines?
        // The frontend hydrateRouteDetails primarily wants patterns/stops.
        // But other parts might want schedules.
        // Let's attach them if found.
        // Schedules are stored by key `routeId_suffix`.
        // We need to know suffixes.
        // patterns inside details have patternSuffix.

        // We can fetch all schedules for this routeId?
        const schedules = await ctx.db
            .query("schedules")
            .withIndex("by_routeId", q => q.eq("routeId", routeId))
            .collect();

        const polylines = await ctx.db
            .query("polylines")
            .withIndex("by_key", q => q.gte("key", routeId + "_").lt("key", routeId + "_\uffff")) // or just by_routeId if indexed?
        // Check schema: polylines has by_key only. NOT by_routeId ???
        // Schema:
        // polylines: defineTable({...}).index("by_key", ["key"])
        // Wait, I didn't add by_routeId to polylines in schema!
        // I added it to `schedules`.
        // Let's check schema again.

        // If polylines missing index, we can't efficiently fetch by routeId unless we use key prefix scan.
        // key = routeId_suffix.
        // routeId might contain `_`? "1:330" -> key "1:330_..."
        // Yes, key prefix scan works.

        const polylineDocs = await ctx.db
            .query("polylines")
            .withIndex("by_key", q => q.gte("key", routeId + "_").lt("key", routeId + "_\uffff"))
            .collect();

        // Map them back to structure expecting?
        // Frontend usually fetches them lazily?
        // `hydrateRouteDetails` doesn't seem to fetch schedules/polylines.
        // It fetches `stops-of-patterns`.

        // Fetch override
        const overrideLookupIds = [routeId];
        overrideLookupIds.push(strippedId);
        overrideLookupIds.push(`1:${strippedId}`);
        overrideLookupIds.push(`2:${strippedId}`);

        if (strippedId.startsWith('r')) {
            const innerNoR = strippedId.slice(1);
            overrideLookupIds.push(innerNoR);
            overrideLookupIds.push(`1:${innerNoR}`);
            overrideLookupIds.push(`2:${innerNoR}`);
        }

        let override = null;
        for (const id of [...new Set(overrideLookupIds)]) {
            override = await ctx.db
                .query("overrides")
                .withIndex("by_routeId", q => q.eq("routeId", id))
                .first();
            if (override) break;
        }

        const formattedOverrides = override ? {
            isLoop: override.isLoop,
            invertDirection: override.invertDirection,
            destinations: [
                {
                    headsign: {
                        en: override.dest0_en_override || override.dest0_en,
                        ka: override.dest0_ka_override || override.dest0_ka,
                        ru: override.dest0_ru_override || override.dest0_ru
                    }
                },
                {
                    headsign: {
                        en: override.dest1_en_override || override.dest1_en,
                        ka: override.dest1_ka_override || override.dest1_ka,
                        ru: override.dest1_ru_override || override.dest1_ru
                    }
                }
            ],
            terminusStopId: override.terminusStopId,
            terminusStopId_override: override.terminusStopId_override,
            virtualTerminusStopId: override.virtualTerminusStopId
        } : null;

        return {
            ...details,
            _overrides: formattedOverrides,
            _schedules: schedules.map(s => ({ suffix: s.suffix, data: s.data })),
            _polylines: polylineDocs.map(p => ({ suffix: p.suffix, data: p.data })),
            _convex_meta: {
                timestamp: Date.now(),
                overrideIdMatched: override ? override.routeId : null,
                lookupIdsTried: [...new Set(overrideLookupIds)]
            }
        };
    }
});

export const getStops = query({
    // ...
    args: {
        sourceId: v.string(),
        locale: v.string()
    },
    handler: async (ctx, { sourceId, locale }) => {
        const stops = await ctx.db
            .query("stops")
            .withIndex("by_source_locale", q => q.eq("source", sourceId).eq("locale", locale))
            .collect();
        return stops.map(s => s.data);
    }
});

// --- Mutation: Update a single route override ---
export const updateOverride = mutation({
    args: {
        routeId: v.string(),
        updates: v.object({
            isLoop: v.optional(v.boolean()),
            invertDirection: v.optional(v.boolean()),
            shortName_override: v.optional(v.string()),
            longName_en_override: v.optional(v.string()),
            longName_ka_override: v.optional(v.string()),
            longName_ru_override: v.optional(v.string()),
            dest0_en_override: v.optional(v.string()),
            dest0_ka_override: v.optional(v.string()),
            dest0_ru_override: v.optional(v.string()),
            dest1_en_override: v.optional(v.string()),
            dest1_ka_override: v.optional(v.string()),
            dest1_ru_override: v.optional(v.string()),
            terminusStopId_override: v.optional(v.string()),
            terminusStopId: v.optional(v.string()),
            terminusStopName: v.optional(v.string()),
            virtualTerminusStopId: v.optional(v.string()),
        })
    },
    handler: async (ctx, { routeId, updates }): Promise<{ success: boolean, routeId: string } | { status: string, id: any }> => {
        // Find existing override
        const lookupIds = [routeId];
        if (!routeId.startsWith('1:') && !routeId.startsWith('2:')) lookupIds.push(`1:${routeId}`);
        if (routeId.startsWith('1:') || routeId.startsWith('2:')) lookupIds.push(routeId.slice(2));

        let existing = null;
        for (const id of lookupIds) {
            existing = await ctx.db
                .query("overrides")
                .withIndex("by_routeId", q => q.eq("routeId", id))
                .first();
            if (existing) break;
        }

        if (existing) {
            // Patch existing
            await ctx.db.patch(existing._id, updates);
            console.log(`[UpdateOverride] Patched override for ${routeId}`);
        } else {
            // Insert new
            await ctx.db.insert("overrides", {
                routeId,
                ...updates
            });
            console.log(`[UpdateOverride] Created override for ${routeId}`);
        }

        return { success: true, routeId };
    }
});

// --- Query: Get a single route override ---
export const getOverride = query({
    args: {
        routeId: v.string()
    },
    handler: async (ctx, { routeId }): Promise<any> => {
        // Robust lookup
        const lookupIds = [routeId];
        const strippedId = routeId.replace(/^[12]:/, '');
        lookupIds.push(strippedId);
        lookupIds.push(`1:${strippedId}`);
        lookupIds.push(`2:${strippedId}`);

        if (strippedId.startsWith('r')) {
            const noR = strippedId.slice(1);
            lookupIds.push(noR);
            lookupIds.push(`1:${noR}`);
            lookupIds.push(`2:${noR}`);
        }

        let override = null;
        for (const id of [...new Set(lookupIds)]) {
            override = await ctx.db
                .query("overrides")
                .withIndex("by_routeId", q => q.eq("routeId", id))
                .first();
            if (override) break;
        }

        return override || null;
    }
});

export const getAllOverrides = query({
    args: {},
    handler: async (ctx): Promise<any> => {
        const overrides = await ctx.db.query("overrides").collect();
        return overrides;
    }
});
