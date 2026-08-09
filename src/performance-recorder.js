const STORAGE_KEY = 'ttcPerfRecorderEnabled';
const MAX_EVENTS = 10000;
const LONG_TASK_THRESHOLD_MS = 50;
const EVENT_LOOP_SAMPLE_MS = 1000;
const MEMORY_SAMPLE_MS = 5000;

const params = new URLSearchParams(window.location.search);
const shouldEnableFromUrl = params.has('perf') || params.get('debug') === 'perf';
const shouldDisableFromUrl = params.get('perf') === '0';

if (shouldEnableFromUrl) {
    try {
        localStorage.setItem(STORAGE_KEY, 'true');
    } catch {
        // Ignore storage failures; the current session can still record.
    }
}

if (shouldDisableFromUrl) {
    try {
        localStorage.removeItem(STORAGE_KEY);
    } catch {
        // Ignore storage failures.
    }
}

function isRecorderEnabled() {
    if (shouldEnableFromUrl) return true;
    if (shouldDisableFromUrl) return false;
    try {
        return localStorage.getItem(STORAGE_KEY) === 'true';
    } catch {
        return false;
    }
}

function now() {
    return Math.round(performance.now());
}

function clampNumber(value) {
    return Number.isFinite(value) ? Math.round(value) : null;
}

function serializeError(error) {
    if (!error) return null;
    return {
        name: error.name || 'Error',
        message: error.message || String(error)
    };
}

class PerformanceRecorder {
    constructor() {
        const initiallyEnabled = isRecorderEnabled();
        this.enabled = false;
        this.startedAt = performance.now();
        this.events = [];
        this.eventCounts = new Map();
        this.fetchInstalled = false;
        this.longTaskObserver = null;
        this.memoryTimer = null;
        this.eventLoopTimer = null;
        this.panel = null;
        this.statusEl = null;
        this.lastEventLoopTick = performance.now();

        this.device = {
            userAgent: navigator.userAgent,
            platform: navigator.platform,
            language: navigator.language,
            hardwareConcurrency: navigator.hardwareConcurrency || null,
            deviceMemory: navigator.deviceMemory || null,
            maxTouchPoints: navigator.maxTouchPoints || 0,
            viewport: {
                width: window.innerWidth,
                height: window.innerHeight,
                devicePixelRatio: window.devicePixelRatio || 1
            }
        };

        window.ttcPerf = {
            start: () => this.start({ persist: true }),
            stop: () => this.stop({ persist: true }),
            clear: () => this.clear(),
            mark: (name, detail) => this.mark(name, detail),
            export: () => this.export(),
            copy: () => this.copy(),
            download: () => this.download(),
            summary: () => this.summary(),
            get events() {
                return recorder.events;
            }
        };

        if (initiallyEnabled) {
            this.start();
        }
    }

    start({ persist = false } = {}) {
        if (persist) {
            try {
                localStorage.setItem(STORAGE_KEY, 'true');
            } catch {
                // Ignore storage failures.
            }
        }
        if (this.enabled) return;
        this.enabled = true;
        this.startedAt = performance.now();
        this.addEvent('recorder:start');
        this.install();
    }

    stop({ persist = false } = {}) {
        if (persist) {
            try {
                localStorage.removeItem(STORAGE_KEY);
            } catch {
                // Ignore storage failures.
            }
        }
        if (!this.enabled) return;
        this.addEvent('recorder:stop');
        this.enabled = false;
        this.uninstallTimers();
        this.updatePanel();
    }

    clear() {
        this.events = [];
        this.eventCounts.clear();
        this.addEvent('recorder:clear');
        this.updatePanel();
    }

    install() {
        this.installFetchRecorder();
        this.installLongTaskRecorder();
        this.installEventLoopSampler();
        this.installMemorySampler();
        this.installLifecycleMarks();
        this.createPanel();
        this.addNavigationTiming();
        this.addEvent('device', this.device);
        this.updatePanel();
    }

    uninstallTimers() {
        if (this.memoryTimer) {
            clearInterval(this.memoryTimer);
            this.memoryTimer = null;
        }
        if (this.eventLoopTimer) {
            clearInterval(this.eventLoopTimer);
            this.eventLoopTimer = null;
        }
        if (this.longTaskObserver) {
            this.longTaskObserver.disconnect();
            this.longTaskObserver = null;
        }
    }

    installFetchRecorder() {
        if (this.fetchInstalled || typeof window.fetch !== 'function') return;
        this.fetchInstalled = true;
        const originalFetch = window.fetch.bind(window);
        window.fetch = async (...args) => {
            if (!this.enabled) return originalFetch(...args);

            const input = args[0];
            const url = typeof input === 'string' ? input : input?.url || 'unknown';
            const method = args[1]?.method || input?.method || 'GET';
            const start = performance.now();

            try {
                const response = await originalFetch(...args);
                const duration = performance.now() - start;
                this.addEvent('fetch', {
                    url,
                    method,
                    status: response.status,
                    ok: response.ok,
                    durationMs: clampNumber(duration),
                    contentLength: response.headers?.get?.('content-length') || null,
                    contentType: response.headers?.get?.('content-type') || null
                });
                return response;
            } catch (error) {
                const duration = performance.now() - start;
                this.addEvent('fetch:error', {
                    url,
                    method,
                    durationMs: clampNumber(duration),
                    error: serializeError(error)
                });
                throw error;
            }
        };
    }

    installLongTaskRecorder() {
        if (typeof PerformanceObserver !== 'function') return;
        try {
            this.longTaskObserver = new PerformanceObserver((list) => {
                for (const entry of list.getEntries()) {
                    this.addEvent('longtask', {
                        startTime: clampNumber(entry.startTime),
                        durationMs: clampNumber(entry.duration),
                        attribution: entry.attribution?.map((item) => ({
                            name: item.name,
                            entryType: item.entryType,
                            containerType: item.containerType
                        })) || []
                    });
                }
            });
            this.longTaskObserver.observe({ entryTypes: ['longtask'] });
        } catch {
            this.longTaskObserver = null;
        }
    }

    installEventLoopSampler() {
        if (this.eventLoopTimer) return;
        this.lastEventLoopTick = performance.now();
        this.eventLoopTimer = setInterval(() => {
            if (!this.enabled) return;
            const current = performance.now();
            const delay = current - this.lastEventLoopTick - EVENT_LOOP_SAMPLE_MS;
            this.lastEventLoopTick = current;
            if (delay > 40) {
                this.addEvent('event-loop-delay', {
                    delayMs: clampNumber(delay)
                });
            }
        }, EVENT_LOOP_SAMPLE_MS);
    }

    installMemorySampler() {
        if (this.memoryTimer || !performance.memory) return;
        const sample = () => {
            if (!this.enabled || !performance.memory) return;
            this.addEvent('memory', {
                usedJSHeapSize: performance.memory.usedJSHeapSize,
                totalJSHeapSize: performance.memory.totalJSHeapSize,
                jsHeapSizeLimit: performance.memory.jsHeapSizeLimit
            });
        };
        sample();
        this.memoryTimer = setInterval(sample, MEMORY_SAMPLE_MS);
    }

    installLifecycleMarks() {
        document.addEventListener('DOMContentLoaded', () => this.mark('dom-content-loaded'), { once: true });
        window.addEventListener('load', () => this.mark('window-load'), { once: true });
        document.addEventListener('visibilitychange', () => {
            this.mark('visibility-change', { state: document.visibilityState });
        });
        window.addEventListener('pagehide', () => this.mark('pagehide'));
        window.addEventListener('pageshow', (event) => this.mark('pageshow', { persisted: event.persisted }));
    }

    addNavigationTiming() {
        setTimeout(() => {
            const nav = performance.getEntriesByType?.('navigation')?.[0];
            if (!nav) return;
            this.addEvent('navigation', {
                type: nav.type,
                domInteractive: clampNumber(nav.domInteractive),
                domContentLoaded: clampNumber(nav.domContentLoadedEventEnd),
                loadEventEnd: clampNumber(nav.loadEventEnd),
                transferSize: nav.transferSize || null,
                encodedBodySize: nav.encodedBodySize || null,
                decodedBodySize: nav.decodedBodySize || null
            });
        }, 0);
    }

    addEvent(type, detail = {}) {
        if (!this.enabled && type !== 'recorder:clear') return;

        const count = (this.eventCounts.get(type) || 0) + 1;
        this.eventCounts.set(type, count);

        this.events.push({
            t: now(),
            type,
            detail
        });

        if (this.events.length > MAX_EVENTS) {
            this.events.splice(0, this.events.length - MAX_EVENTS);
        }

        if (count % 10 === 1 || type.startsWith('recorder')) {
            this.updatePanel();
        }
    }

    mark(name, detail = {}) {
        this.addEvent('mark', { name, ...detail });
    }

    createPanel() {
        if (!this.enabled) return;
        if (this.panel || !document.body) return;

        const style = document.createElement('style');
        style.textContent = `
            .perf-recorder-panel {
                position: fixed;
                left: 12px;
                bottom: max(12px, env(safe-area-inset-bottom));
                z-index: 2147483647;
                display: flex;
                align-items: center;
                gap: 6px;
                padding: 8px;
                border: 1px solid rgba(255, 255, 255, 0.24);
                border-radius: 8px;
                background: rgba(10, 12, 16, 0.88);
                color: #fff;
                font: 12px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
                box-shadow: 0 8px 24px rgba(0, 0, 0, 0.28);
                backdrop-filter: blur(10px);
            }
            .perf-recorder-panel button {
                min-width: 0;
                padding: 6px 8px;
                border: 0;
                border-radius: 6px;
                background: rgba(255, 255, 255, 0.16);
                color: #fff;
                font: inherit;
            }
            .perf-recorder-panel button:active {
                background: rgba(255, 255, 255, 0.28);
            }
            .perf-recorder-status {
                min-width: 72px;
                opacity: 0.9;
            }
        `;
        document.head.appendChild(style);

        this.panel = document.createElement('div');
        this.panel.className = 'perf-recorder-panel';
        this.panel.innerHTML = `
            <span class="perf-recorder-status">Perf: 0</span>
            <button type="button" data-action="copy">Copy</button>
            <button type="button" data-action="download">Save</button>
            <button type="button" data-action="stop">Stop</button>
        `;
        this.statusEl = this.panel.querySelector('.perf-recorder-status');
        this.panel.addEventListener('click', (event) => {
            const action = event.target?.dataset?.action;
            if (action === 'copy') this.copy();
            if (action === 'download') this.download();
            if (action === 'stop') this.stop({ persist: true });
        });
        document.body.appendChild(this.panel);
    }

    updatePanel() {
        if (!this.statusEl) return;
        const longTasks = this.eventCounts.get('longtask') || 0;
        this.statusEl.textContent = `Perf: ${this.events.length} / LT ${longTasks}`;
    }

    summary() {
        const counts = Object.fromEntries(this.eventCounts.entries());
        const longTasks = this.events
            .filter((event) => event.type === 'longtask')
            .map((event) => event.detail.durationMs)
            .filter((duration) => Number.isFinite(duration));
        const fetches = this.events
            .filter((event) => event.type === 'fetch')
            .map((event) => event.detail.durationMs)
            .filter((duration) => Number.isFinite(duration));

        return {
            eventCount: this.events.length,
            counts,
            longTaskCount: longTasks.length,
            worstLongTaskMs: longTasks.length ? Math.max(...longTasks) : 0,
            fetchCount: fetches.length,
            slowestFetchMs: fetches.length ? Math.max(...fetches) : 0
        };
    }

    export() {
        return {
            exportedAt: new Date().toISOString(),
            href: window.location.href,
            device: this.device,
            summary: this.summary(),
            events: this.events
        };
    }

    async copy() {
        const text = JSON.stringify(this.export(), null, 2);
        try {
            await navigator.clipboard.writeText(text);
            this.mark('export:copy', { bytes: text.length });
            alert('Performance recording copied.');
        } catch {
            console.log('[PerfRecorder] Export JSON:', text);
            alert('Clipboard failed. Export was printed to the console.');
        }
    }

    download() {
        const text = JSON.stringify(this.export(), null, 2);
        const blob = new Blob([text], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        anchor.href = url;
        anchor.download = `ttc-performance-${timestamp}.json`;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        this.mark('export:download', { bytes: text.length });
    }
}

const recorder = new PerformanceRecorder();

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => recorder.createPanel(), { once: true });
} else if (recorder.enabled) {
    recorder.createPanel();
}

export function markPerformanceEvent(name, detail = {}) {
    recorder.mark(name, detail);
}

export function recordPerformanceEvent(type, detail = {}) {
    recorder.addEvent(type, detail);
}

export function attachMapPerformanceRecorder(map) {
    if (!map || !recorder.enabled) return;

    const events = ['load', 'idle', 'styledata', 'sourcedata', 'render', 'error'];
    const renderSampleMs = 2000;
    let lastRenderSample = 0;

    for (const eventName of events) {
        map.on(eventName, (event) => {
            if (eventName === 'render') {
                const current = performance.now();
                if (current - lastRenderSample < renderSampleMs) return;
                lastRenderSample = current;
            }

            recorder.addEvent(`map:${eventName}`, {
                sourceId: event.sourceId || null,
                sourceDataType: event.sourceDataType || null,
                isSourceLoaded: event.isSourceLoaded ?? null,
                error: serializeError(event.error)
            });
        });
    }

    installMapSourceSetDataRecorder(map);
}

function countGeoJSONFeatures(data) {
    if (!data) return null;
    if (data.type === 'FeatureCollection' && Array.isArray(data.features)) return data.features.length;
    if (data.type === 'Feature') return 1;
    return null;
}

function getGeoJSONGeometryType(data) {
    if (!data) return null;
    if (data.type === 'FeatureCollection') {
        const first = data.features?.[0];
        return first?.geometry?.type || null;
    }
    if (data.type === 'Feature') return data.geometry?.type || null;
    return data.type || null;
}

function getStackSignature() {
    const stack = new Error().stack || '';
    return stack
        .split('\n')
        .slice(3, 8)
        .map((line) => line.trim().replace(window.location.origin, ''))
        .join(' | ');
}

function installMapSourceSetDataRecorder(map) {
    if (map.__perfSetDataRecorderInstalled) return;
    map.__perfSetDataRecorderInstalled = true;

    const patchSource = (sourceId, source) => {
        if (!source || typeof source.setData !== 'function' || source.__perfSetDataPatched) return source;
        const originalSetData = source.setData.bind(source);
        source.setData = (data) => {
            const start = performance.now();
            try {
                return originalSetData(data);
            } finally {
                recorder.addEvent('source:setData', {
                    sourceId,
                    featureCount: countGeoJSONFeatures(data),
                    geometryType: getGeoJSONGeometryType(data),
                    durationMs: clampNumber(performance.now() - start),
                    stack: getStackSignature()
                });
            }
        };
        source.__perfSetDataPatched = true;
        return source;
    };

    const originalGetSource = map.getSource.bind(map);
    map.getSource = (sourceId) => {
        const source = originalGetSource(sourceId);
        return patchSource(sourceId, source);
    };

    const originalAddSource = map.addSource.bind(map);
    map.addSource = (sourceId, sourceDefinition) => {
        const result = originalAddSource(sourceId, sourceDefinition);
        patchSource(sourceId, originalGetSource(sourceId));
        return result;
    };
}
