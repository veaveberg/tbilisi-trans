/**
 * CSV Parser Utility
 * Parses CSV files and extracts override values from columns ending with '_override'
 */

/**
 * Parse CSV text into an array of objects
 * @param {string} csvText - Raw CSV text
 * @returns {Array<Object>} Array of row objects
 */
export function parseCSV(csvText) {
    const lines = csvText.split('\n').filter(line => line.trim());
    if (lines.length === 0) return [];

    // Parse header
    const headers = parseCSVLine(lines[0]);

    // Parse rows
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
        const values = parseCSVLine(lines[i]);
        if (values.length === 0) continue;

        const row = {};
        headers.forEach((header, index) => {
            row[header] = values[index] || '';
        });
        rows.push(row);
    }

    return rows;
}

/**
 * Parse a single CSV line, handling quoted fields
 * @param {string} line - CSV line
 * @returns {Array<string>} Array of field values
 */
function parseCSVLine(line) {
    const result = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        const nextChar = line[i + 1];

        if (char === '"') {
            if (inQuotes && nextChar === '"') {
                // Escaped quote
                current += '"';
                i++; // Skip next quote
            } else {
                // Toggle quote mode
                inQuotes = !inQuotes;
            }
        } else if (char === ',' && !inQuotes) {
            // End of field
            result.push(current.trim());
            current = '';
        } else {
            current += char;
        }
    }

    // Add last field
    result.push(current.trim());

    return result;
}

/**
 * Extract overrides from CSV rows
 * Only processes columns ending with '_override' and returns non-empty values
 * @param {Array<Object>} rows - Parsed CSV rows
 * @param {string} idColumn - Name of the ID column (default: 'id')
 * @returns {Object} Map of ID to override object
 */
export function extractOverrides(rows, idColumn = 'id') {
    const overrides = {};

    rows.forEach(row => {
        const id = row[idColumn];
        if (!id) return;

        const override = {};
        const baseDestinations = {}; // Store base values first

        // First pass: collect base destination values (non-override)
        Object.keys(row).forEach(key => {
            const value = row[key];
            if (!value || value.trim() === '') return;

            // Base destination fields (e.g., dest0_en, dest1_ka)
            if (key.startsWith('dest') && !key.endsWith('_override')) {
                const match = key.match(/^dest(\d+)_(\w+)$/);
                if (match) {
                    const [, direction, lang] = match;
                    if (!baseDestinations[direction]) {
                        baseDestinations[direction] = { headsign: {} };
                    }
                    baseDestinations[direction].headsign[lang] = value;
                }
            }
        });

        // Process all columns
        Object.keys(row).forEach(key => {
            const value = row[key];
            if (!value || value.trim() === '') return; // Skip empty values

            // Handle override columns
            if (key.endsWith('_override')) {
                const fieldName = key.replace('_override', '');

                // Handle nested fields (e.g., dest0_en -> destinations.0.headsign.en)
                if (fieldName.startsWith('dest')) {
                    const match = fieldName.match(/^dest(\d+)_(\w+)$/);
                    if (match) {
                        const [, direction, lang] = match;
                        if (!override.destinations) override.destinations = {};
                        if (!override.destinations[direction]) {
                            override.destinations[direction] = { headsign: {} };
                        }
                        override.destinations[direction].headsign[lang] = value;
                    }
                } else if (fieldName.startsWith('longName_')) {
                    // longName_en -> longName.en
                    const lang = fieldName.replace('longName_', '');
                    if (!override.longName) override.longName = {};
                    override.longName[lang] = value;
                } else if (fieldName.startsWith('name_')) {
                    // name_en -> name.en
                    const lang = fieldName.replace('name_', '');
                    if (!override.name) override.name = {};
                    override.name[lang] = value;
                } else if (['lat', 'lon', 'rotation'].includes(fieldName)) {
                    // Numeric fields
                    override[fieldName] = parseFloat(value);
                } else {
                    // Simple fields
                    override[fieldName] = value;
                }
            } else if (key === 'mergeParent' || key === 'hubTarget' || key === 'rotation' || key === 'invertDirection') {
                // Special non-override fields that should be included
                if (key === 'rotation') {
                    override[key] = parseFloat(value);
                } else if (key === 'invertDirection') {
                    override[key] = value.toLowerCase() === 'true' || value === '1';
                } else {
                    override[key] = value;
                }
                if (key === 'rotation' && id && id.includes('813')) {
                    console.log('[CSV DEBUG] Extracted rotation for', id, ':', value, '->', override[key]);
                }
            }
        });

        // Merge base destinations into override.destinations (base as fallback)
        if (Object.keys(baseDestinations).length > 0) {
            if (!override.destinations) override.destinations = {};
            Object.keys(baseDestinations).forEach(dir => {
                if (!override.destinations[dir]) {
                    // No override for this direction, use base
                    override.destinations[dir] = baseDestinations[dir];
                } else {
                    // Merge base headsigns as fallback (override takes priority)
                    const baseHeadsign = baseDestinations[dir].headsign || {};
                    const overrideHeadsign = override.destinations[dir].headsign || {};
                    override.destinations[dir].headsign = { ...baseHeadsign, ...overrideHeadsign };
                }
            });
        }

        // Only add if there are actual overrides
        if (Object.keys(override).length > 0) {
            overrides[id] = override;
        }
    });

    return overrides;
}

/**
 * Convert overrides object to CSV rows
 * Merges with existing rows to preserve original values
 * @param {Object} overrides - Override object (id -> override data)
 * @param {Array<Object>} existingRows - Existing CSV rows to merge with
 * @param {string} idColumn - Name of the ID column
 * @returns {Array<Object>} Updated CSV rows
 */
export function overridesToCSVRows(overrides, existingRows = [], idColumn = 'id') {
    const rowsMap = new Map();

    // Start with existing rows
    existingRows.forEach(row => {
        const id = row[idColumn];
        if (id) rowsMap.set(id, { ...row });
    });

    // Update with overrides
    Object.keys(overrides).forEach(id => {
        const override = overrides[id];
        let row = rowsMap.get(id) || { [idColumn]: id };

        // Clear all override columns first
        Object.keys(row).forEach(key => {
            if (key.endsWith('_override')) {
                row[key] = '';
            }
        });

        // Apply new overrides
        if (override.shortName) row.shortName_override = override.shortName;

        if (override.longName) {
            if (override.longName.en) row.longName_en_override = override.longName.en;
            if (override.longName.ka) row.longName_ka_override = override.longName.ka;
            if (override.longName.ru) row.longName_ru_override = override.longName.ru;
        }

        if (override.name) {
            if (override.name.en) row.name_en_override = override.name.en;
            if (override.name.ka) row.name_ka_override = override.name.ka;
            if (override.name.ru) row.name_ru_override = override.name.ru;
        }

        if (override.destinations) {
            Object.keys(override.destinations).forEach(dir => {
                const headsign = override.destinations[dir].headsign;
                if (headsign.en) row[`dest${dir}_en_override`] = headsign.en;
                if (headsign.ka) row[`dest${dir}_ka_override`] = headsign.ka;
                if (headsign.ru) row[`dest${dir}_ru_override`] = headsign.ru;
            });
        }

        if (override.lat !== undefined) row.lat_override = override.lat;
        if (override.lon !== undefined) row.lon_override = override.lon;
        if (override.rotation !== undefined) row.rotation_override = override.rotation;
        if (override.mergeParent) row.mergeParent = override.mergeParent;
        if (override.hubTarget) row.hubTarget = override.hubTarget;

        rowsMap.set(id, row);
    });

    return Array.from(rowsMap.values());
}

/**
 * Convert CSV rows back to CSV text
 * @param {Array<Object>} rows - CSV rows
 * @param {Array<string>} headers - Column headers (optional, will be inferred from first row)
 * @returns {string} CSV text
 */
export function rowsToCSV(rows, headers = null) {
    if (rows.length === 0) return '';

    // Get headers
    if (!headers) {
        headers = Object.keys(rows[0]);
    }

    // Escape and quote field if needed
    const escapeField = (field) => {
        const str = String(field || '');
        if (str.includes(',') || str.includes('"') || str.includes('\n')) {
            return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
    };

    // Build CSV
    const lines = [];
    lines.push(headers.map(escapeField).join(','));

    rows.forEach(row => {
        const values = headers.map(h => escapeField(row[h] || ''));
        lines.push(values.join(','));
    });

    return lines.join('\n');
}
