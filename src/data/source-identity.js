export function getSourceSeparator(source) {
    return source?.separator !== undefined ? source.separator : ':';
}

export function getAppPrefix(source) {
    if (!source?.prefix) return '';
    return `${source.prefix}${getSourceSeparator(source)}`;
}

export function isAppIdForSource(id, source) {
    if (typeof id !== 'string' || !source?.prefix) return false;
    const prefix = getAppPrefix(source);
    return getSourceSeparator(source) === ''
        ? id.startsWith(prefix)
        : id.toLowerCase().startsWith(prefix.toLowerCase());
}

export function sourceForAppId(id, sources, defaultSource = null) {
    const value = String(id || '');
    const explicit = sources.find(source => isAppIdForSource(value, source));
    return explicit || defaultSource || null;
}

export function toAppId(id, source) {
    if (!id || typeof id !== 'string' || !source) return id;
    let value = id;

    for (const prefix of source.stripPrefixes || []) {
        if (value.startsWith(prefix)) {
            value = value.slice(prefix.length);
            break;
        }
    }
    if (source.stripPrefix && value.startsWith(source.stripPrefix)) {
        value = value.slice(source.stripPrefix.length);
    }

    const appPrefix = getAppPrefix(source);
    if (appPrefix && !isAppIdForSource(value, source)) {
        value = `${appPrefix}${value}`;
    }
    return value;
}

export function toApiId(id, source, sources = []) {
    if (!id || typeof id !== 'string' || !source) return id;
    let value = id;

    if (isAppIdForSource(value, source)) {
        value = value.slice(getAppPrefix(source).length);
    }

    for (const prefix of source.stripPrefixes || []) {
        if (value.startsWith(prefix)) {
            value = value.slice(prefix.length);
            break;
        }
    }
    if (source.stripPrefix && value.startsWith(source.stripPrefix)) {
        value = value.slice(source.stripPrefix.length);
    }

    const belongsToAnotherSource = sources.some(other =>
        other?.id !== source.id && isAppIdForSource(value, other)
    );
    if (belongsToAnotherSource) return value;

    const primaryPrefix = source.stripPrefixes?.[0] || source.stripPrefix || '';
    return primaryPrefix && !value.startsWith(primaryPrefix)
        ? `${primaryPrefix}${value}`
        : value;
}

export function namespaceVehicleId(vehicleId, source) {
    return toAppId(String(vehicleId || ''), source);
}

export function staticRouteResourceKeys(routeId, suffix, source, sources = []) {
    const appRouteId = toAppId(String(routeId || ''), source);
    const apiRouteId = toApiId(appRouteId, source, sources);
    const safeSuffix = String(suffix || '').replace(/:/g, '_').replace(/,/g, '-');
    return [...new Set([
        `${apiRouteId}_${safeSuffix}`,
        `${appRouteId}_${safeSuffix}`,
        `${routeId}_${safeSuffix}`
    ])];
}
