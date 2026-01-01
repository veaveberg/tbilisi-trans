const sources = [
    {
        id: 'tbilisi',
        stripPrefixes: ['1:'],
    },
    {
        id: 'rustavi',
        prefix: 'r',
        separator: '',
        stripPrefixes: ['1:', '2:'],
    }
];

function getSeparator(source) {
    return source.separator !== undefined ? source.separator : ':';
}

function restoreApiId(id, source) {
    if (!id || typeof id !== 'string') return id;
    let apiId = id;
    // 1. Remove source prefix (e.g. 'r' from 'r123')
    if (source.prefix) {
        const sep = getSeparator(source);
        const prefixMatch = source.prefix.toLowerCase() + sep;
        if (apiId.toLowerCase().startsWith(prefixMatch)) {
            apiId = apiId.slice(prefixMatch.length);
        }
    }

    // 2. Strip ANY existing internal prefixes (e.g. '1:', '2:') before re-adding primary
    if (source.stripPrefixes && Array.isArray(source.stripPrefixes)) {
        for (const prefix of source.stripPrefixes) {
            if (apiId.startsWith(prefix)) {
                apiId = apiId.slice(prefix.length);
                break;
            }
        }
    } else if (source.stripPrefix && apiId.startsWith(source.stripPrefix)) {
        apiId = apiId.slice(source.stripPrefix.length);
    }

    // 3. Re-add primary internal prefix
    if (source.stripPrefixes && Array.isArray(source.stripPrefixes) && source.stripPrefixes.length > 0) {
        const primaryPrefix = source.stripPrefixes[0];
        if (!apiId.startsWith(primaryPrefix)) {
            apiId = primaryPrefix + apiId;
        }
    } else if (source.stripPrefix) {
        if (!apiId.startsWith(source.stripPrefix)) {
            apiId = source.stripPrefix + apiId;
        }
    }
    return apiId;
}

const rustavi = sources.find(s => s.id === 'rustavi');
const tbilisi = sources.find(s => s.id === 'tbilisi');

console.log('=== Rustavi ID Restoration Tests ===');
console.log('rR826 (app) -> API:', restoreApiId('rR826', rustavi));
console.log('r145 (app) -> API:', restoreApiId('r145', rustavi));
console.log('r12 (app) -> API:', restoreApiId('r12', rustavi));

console.log('');
console.log('=== Tbilisi ID Restoration Tests ===');
console.log('811 (app) -> API:', restoreApiId('811', tbilisi));
console.log('809 (app) -> API:', restoreApiId('809', tbilisi));

console.log('');
console.log('=== Edge Cases ===');
console.log('2:123 through Rustavi:', restoreApiId('2:123', rustavi));
console.log('1:R826 through Rustavi:', restoreApiId('1:R826', rustavi));
