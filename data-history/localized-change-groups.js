const localizedNames = new Set(['name', 'longName', 'headsign', 'Record', 'patterns', '_stopsOfPatterns']);
const languageNames = { en: 'English', ka: 'Georgian' };
function mergeFields(members, key) {
    const result = [], seen = new Map();
    const variants = new Map(), sources = new Map();
    for (const member of members) for (const field of member.change[key] || []) {
        const valueKey = JSON.stringify([field.field, field.before, field.after]);
        if (!sources.has(valueKey)) sources.set(valueKey, new Set());
        sources.get(valueKey).add(member.language);
        if (!variants.has(field.field)) variants.set(field.field, new Set());
        variants.get(field.field).add(JSON.stringify([field.before, field.after]));
    }
    for (const { language, change } of members) for (const field of change[key] || []) {
        const translated = localizedNames.has(field.field) || variants.get(field.field).size > 1 || sources.get(JSON.stringify([field.field, field.before, field.after])).size === 1;
        const identity = JSON.stringify([field.field, field.before, field.after, translated ? language : null]);
        if (seen.has(identity)) continue;
        const value = { ...field, ...(translated ? { language } : {}) };
        seen.set(identity, value); result.push(value);
    }
    return result;
}
export function combineLocalizedGroups(groups, preferred = 'en') {
    const result = groups.filter(group => !/_(en|ka)$/.test(group.kind));
    const families = new Map();
    for (const group of groups) {
        const match = /^(.*)_(en|ka)$/.exec(group.kind);
        if (!match) continue;
        const [, base, language] = match;
        if (!families.has(base)) families.set(base, new Map());
        for (const change of group.changes) {
            const entities = families.get(base);
            if (!entities.has(change.id)) entities.set(change.id, []);
            entities.get(change.id).push({ language, change });
        }
    }
    for (const [base, entities] of families) {
        const changes = [];
        for (const [id, members] of entities) {
            members.sort((a, b) => Number(b.language === preferred) - Number(a.language === preferred));
            const primary = members[0].change;
            const context = { ...primary.context };
            const before = members.find(member => member.change.context?.entityBefore)?.change.context;
            const after = members.find(member => member.change.context?.entityAfter)?.change.context;
            const knowsPresence = members.some(member => typeof member.change.context?.entityBefore === 'boolean');
            const status = knowsPresence ? before && after ? 'modified' : after ? 'added' : 'removed' : members.every(member => member.change.status === primary.status) ? primary.status : 'modified';
            const descriptions = [];
            if (base === 'stops') {
                const namesBefore = context.namesBefore || {}, namesAfter = context.namesAfter || {};
                const names = status === 'removed' ? namesBefore : namesAfter;
                context.names = names;
                for (const side of ['Before', 'After']) {
                    const location = context[`locations${side}`]?.[preferred] || context[`locations${side}`]?.[preferred === 'en' ? 'ka' : 'en'] || context[`location${side}`];
                    if (location) context[`location${side}`] = { ...location, name: (side === 'Before' ? namesBefore : namesAfter)[preferred] || location.name };
                }
                if (status === 'added') descriptions.push('Stop added.');
                else if (status === 'removed') descriptions.push('Stop removed from the saved data.');
                else {
                    const changedNames = new Set(members.filter(member => member.change.fields.some(field => field.field === 'name')).map(member => member.language));
                    for (const { language, change } of members) if (change.status !== 'modified' && namesBefore[language] !== namesAfter[language] && (namesBefore[language] || namesAfter[language])) changedNames.add(language);
                    if (changedNames.size) descriptions.push(`Name updated in ${[...changedNames].map(language => languageNames[language]).join(' and ')}.`);
                    const movement = members.map(member => member.change.context?.description?.match(/Location (?:moved about \d+ m|coordinates adjusted)\./)?.[0]).find(Boolean);
                    if (movement) descriptions.push(movement);
                    if (!descriptions.length) descriptions.push('Stop information updated.');
                }
                context.description = descriptions.join(' ');
            }
            context.relatedChanges = [...new Set(members.flatMap(member => member.change.context?.relatedChanges || []))];
            for (const key of ['stopsAdded', 'stopsRemoved']) if (members.some(member => member.change.context?.[key])) context[key] = [...new Map([...members].reverse().flatMap(member => member.change.context?.[key] || []).map(stop => [stop.id, stop])).values()];
            if (context.route && context.routeNames?.[preferred]) context.route = { ...context.route, name: context.routeNames[preferred] };
            changes.push({ ...primary, id, status, label: base === 'stops' ? context.names?.[preferred] || context.names?.[preferred === 'en' ? 'ka' : 'en'] || primary.label : primary.label, context, fields: mergeFields(members, 'fields'), technicalFields: mergeFields(members, 'technicalFields') });
        }
        result.push({ kind: `${base}_${preferred}`, changes });
    }
    return result;
}
