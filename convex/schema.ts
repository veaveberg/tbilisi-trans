import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
    stops: defineTable({
        stopId: v.string(), // e.g. "tbilisi:123" or just "123" depending on normalization
        source: v.string(), // "tbilisi" | "rustavi"
        locale: v.string(), // "en" | "ka"
        data: v.any(), // The full JSON object
    })
        .index("by_source_locale", ["source", "locale"])
        .index("by_stopId", ["stopId"])
        .index("by_source_locale_stopId", ["source", "locale", "stopId"]),

    routes: defineTable({
        routeId: v.string(),
        source: v.string(),
        locale: v.string(),
        data: v.any(),
    })
        .index("by_source_locale", ["source", "locale"])
        .index("by_routeId", ["routeId"])
        .index("by_source_locale_routeId", ["source", "locale", "routeId"]),

    routeDetails: defineTable({
        routeId: v.string(),
        source: v.string(),
        locale: v.string(),
        data: v.any(),
        lastUpdated: v.number(),
    })
        .index("by_source_routeId_locale", ["source", "routeId", "locale"])
        .index("by_routeId_locale", ["routeId", "locale"]),

    schedules: defineTable({
        key: v.string(), // routeId_suffix
        routeId: v.string(),
        suffix: v.string(),
        data: v.any(),
        lastUpdated: v.number(),
    })
        .index("by_key", ["key"])
        .index("by_routeId", ["routeId"]),

    polylines: defineTable({
        key: v.string(), // routeId_suffix
        routeId: v.string(),
        suffix: v.string(),
        data: v.any(),
        lastUpdated: v.number(),
    })
        .index("by_key", ["key"]),

    overrides: defineTable({
        routeId: v.string(), // "1:330" (matches "1:" prefix convention from CSV)
        shortName: v.optional(v.string()),
        shortName_override: v.optional(v.string()),
        isLoop: v.optional(v.boolean()),
        // We'll store locale-specific overrides in a JSON object for flexibilty
        // or flat fields matching the CSV. Let's use flat fields to match CSV 1:1 for easy import.
        longName_en: v.optional(v.string()),
        longName_en_override: v.optional(v.string()),
        longName_ka: v.optional(v.string()),
        longName_ka_override: v.optional(v.string()),
        longName_ru_override: v.optional(v.string()),

        dest0_en: v.optional(v.string()),
        dest0_en_override: v.optional(v.string()),
        dest0_ka: v.optional(v.string()),
        dest0_ka_override: v.optional(v.string()),
        dest0_ru_override: v.optional(v.string()),

        dest1_en: v.optional(v.string()),
        dest1_en_override: v.optional(v.string()),
        dest1_ka: v.optional(v.string()),
        dest1_ka_override: v.optional(v.string()),
        dest1_ru_override: v.optional(v.string()),

        invertDirection: v.optional(v.boolean()),
    })
        .index("by_routeId", ["routeId"])
        .index("by_shortName", ["shortName"]),
});
