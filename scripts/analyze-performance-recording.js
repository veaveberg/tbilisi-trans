#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const filePath = process.argv[2];

if (!filePath) {
    console.error('Usage: node scripts/analyze-performance-recording.js <recording.json>');
    process.exit(1);
}

const absolutePath = path.resolve(filePath);
const recording = JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
const events = Array.isArray(recording.events) ? recording.events : [];

function byDurationDesc(a, b) {
    return (b.detail?.durationMs || 0) - (a.detail?.durationMs || 0);
}

function printSection(title, rows, formatRow, limit = 10) {
    console.log(`\n${title}`);
    console.log('-'.repeat(title.length));
    if (!rows.length) {
        console.log('None recorded.');
        return;
    }
    rows.slice(0, limit).forEach((row, index) => {
        console.log(`${index + 1}. ${formatRow(row)}`);
    });
}

const longTasks = events
    .filter((event) => event.type === 'longtask')
    .sort(byDurationDesc);

const slowFetches = events
    .filter((event) => event.type === 'fetch')
    .sort(byDurationDesc);

const eventLoopDelays = events
    .filter((event) => event.type === 'event-loop-delay')
    .sort((a, b) => (b.detail?.delayMs || 0) - (a.detail?.delayMs || 0));

const marks = events.filter((event) => event.type === 'mark');
const mapEvents = events.filter((event) => event.type?.startsWith?.('map:'));
const sourceSetDataEvents = events.filter((event) => event.type === 'source:setData');
const counts = events.reduce((acc, event) => {
    acc[event.type] = (acc[event.type] || 0) + 1;
    return acc;
}, {});

console.log(`Recording: ${absolutePath}`);
console.log(`Exported: ${recording.exportedAt || 'unknown'}`);
console.log(`URL: ${recording.href || 'unknown'}`);
console.log(`Events: ${events.length}`);
console.log(`Device: ${recording.device?.platform || 'unknown'} | DPR ${recording.device?.viewport?.devicePixelRatio || 'unknown'} | ${recording.device?.viewport?.width || '?'}x${recording.device?.viewport?.height || '?'}`);

console.log('\nEvent Counts');
console.log('------------');
Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .forEach(([type, count]) => console.log(`${type}: ${count}`));

printSection(
    'Worst Long Tasks',
    longTasks,
    (event) => `t=${event.t}ms duration=${event.detail.durationMs}ms`
);

printSection(
    'Slowest Fetches',
    slowFetches,
    (event) => `t=${event.t}ms duration=${event.detail.durationMs}ms status=${event.detail.status} ${event.detail.url}`
);

printSection(
    'Worst Event Loop Delays',
    eventLoopDelays,
    (event) => `t=${event.t}ms delay=${event.detail.delayMs}ms`
);

printSection(
    'Marks',
    marks,
    (event) => `t=${event.t}ms ${event.detail.name}${event.detail.state ? ` state=${event.detail.state}` : ''}`,
    30
);

printSection(
    'Map Events',
    mapEvents,
    (event) => `t=${event.t}ms ${event.type}${event.detail?.sourceId ? ` source=${event.detail.sourceId}` : ''}`,
    30
);

const sourceSetDataCounts = sourceSetDataEvents.reduce((acc, event) => {
    const sourceId = event.detail?.sourceId || 'unknown';
    acc[sourceId] = (acc[sourceId] || 0) + 1;
    return acc;
}, {});

console.log('\nSource setData Counts');
console.log('---------------------');
Object.entries(sourceSetDataCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .forEach(([sourceId, count]) => console.log(`${sourceId}: ${count}`));

const sourceSetDataStacks = sourceSetDataEvents.reduce((acc, event) => {
    const key = `${event.detail?.sourceId || 'unknown'} | ${event.detail?.stack || 'unknown'}`;
    const current = acc.get(key) || {
        sourceId: event.detail?.sourceId || 'unknown',
        stack: event.detail?.stack || 'unknown',
        count: 0,
        maxFeatures: 0
    };
    current.count += 1;
    current.maxFeatures = Math.max(current.maxFeatures, event.detail?.featureCount || 0);
    acc.set(key, current);
    return acc;
}, new Map());

printSection(
    'Top setData Call Sites',
    Array.from(sourceSetDataStacks.values()).sort((a, b) => b.count - a.count),
    (row) => `${row.sourceId}: ${row.count} calls, maxFeatures=${row.maxFeatures} | ${row.stack}`,
    20
);
