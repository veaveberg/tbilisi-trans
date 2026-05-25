import { getCurrentStopNamesLanguage } from './i18n.ts';

const TBILISI_TIMEZONE = 'Asia/Tbilisi';
const TBILISI_WEATHER_URL = 'https://api.open-meteo.com/v1/forecast?latitude=41.6938&longitude=44.8015&current=temperature_2m&timezone=Asia%2FTbilisi';
const DEFAULT_TBILISI_TEMP_C = 22;
const LANGUAGE_SWITCH_MS = 10000;
const MODEL_SYNC_MS = 10000;
const WEATHER_REFRESH_MS = 15 * 60 * 1000;
const BOARD_WIDTH = 304;
const BOARD_HEIGHT = 144;
const LED_GRID_STEP_PX = 2;
const TICKER_COPY_GAP_PX = 10;
const CONTROLS_IDLE_MS = 2200;
const DEFAULT_SCHEME = 'yellow';
const SCHEMES = new Set(['yellow', 'red', 'green', 'blue', 'cyan', 'magenta', 'white', 'wgy']);
const ROW_HEIGHT_PX = 14;
const ROW_GAP_PX = 4;
const STATIC_SECTION_HEIGHT_PX = 14;
const SURFACE_PADDING_PX = 0;
const SURFACE_GAP_COUNT = 3;
const DEFAULT_MAIN_HEIGHT_PX = 104;
const DEFAULT_MAIN_ROWS = 6;
const TICKER_PIXELS_PER_SECOND = 36;
const MIN_FILL_HEIGHT_ROWS = 1;
const MAX_VISIBLE_ARRIVAL_MINUTES = 90;
const EMPTY_CLOCK_HEIGHT_PX = DEFAULT_MAIN_HEIGHT_PX + ROW_GAP_PX + STATIC_SECTION_HEIGHT_PX;
const EMPTY_CLOCK_CANVAS_SCALE = LED_GRID_STEP_PX;
const EMPTY_CLOCK_PADDING_PX = 10;
const EMPTY_CLOCK_ALPHA_THRESHOLD = 48;
const NUMBER_SWAP_DURATION_MS = 320;
const EMPTY_CLOCK_DIGIT_WIDTH_PX = 42;
const EMPTY_CLOCK_COLON_WIDTH_PX = 18;
const STREET_SCREEN_COLOR_KEY = 'streetScreenColorScheme';
const STREET_SCREEN_FILL_MODE_KEY = 'streetScreenFillHeightMode';

function formatMinutes(minutes) {
    if (!Number.isFinite(minutes)) return '--';
    const safe = Math.max(0, Math.round(minutes));
    return safe < 100 ? String(safe).padStart(2, '0') : String(safe);
}

function formatTickerMinutes(minutes, language) {
    const text = formatMinutes(minutes);
    if (text === '--') return text;
    if (language === 'ka') return `${text}ᲬᲗ`;
    if (language === 'ru') return `${text}мин`;
    return `${text}min`;
}

function buildAnimatedNumberMarkup({ key, value, className = '', html = null, block = false, ariaLabel = '' }) {
    const classes = ['street-screen-number'];
    if (className) classes.push(className);
    if (block) classes.push('street-screen-number--block');
    const content = html ?? escapeHtml(value);
    const aria = ariaLabel ? ` aria-label="${escapeHtml(ariaLabel)}"` : '';
    return `<span class="${classes.join(' ')}" data-number-key="${escapeHtml(key)}" data-number-value="${escapeHtml(value)}"${aria}><span class="street-screen-number-current">${content}</span></span>`;
}

function buildTickerMinutesMarkup(minutes, language, key) {
    const text = formatMinutes(minutes);
    if (text === '--') {
        return buildAnimatedNumberMarkup({
            key,
            value: text,
            className: 'street-screen-ticker-minutes-value'
        });
    }
    if (language === 'ka') {
        return `${buildAnimatedNumberMarkup({
            key,
            value: text,
            className: 'street-screen-ticker-minutes-value'
        })}<span class="street-screen-ticker-minutes-suffix">${escapeHtml('ᲬᲗ')}</span>`;
    }
    return buildAnimatedNumberMarkup({
        key,
        value: formatTickerMinutes(minutes, language),
        className: 'street-screen-ticker-minutes-value'
    });
}

function formatTbilisiTime() {
    return new Intl.DateTimeFormat('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
        timeZone: TBILISI_TIMEZONE
    }).format(new Date());
}

function formatTbilisiTimeWithSeconds() {
    return new Intl.DateTimeFormat('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
        timeZone: TBILISI_TIMEZONE
    }).format(new Date());
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function buildMinutesCellMarkup(minutes, key) {
    const text = formatMinutes(minutes);
    return `<span class="street-screen-minutes-text" aria-label="${escapeHtml(text)}">${buildAnimatedNumberMarkup({
        key,
        value: text,
        className: 'street-screen-minutes-value'
    })}</span>`;
}

function createRasterCanvas(width, height) {
    if (typeof document === 'undefined') return null;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
}

function measureClockFontSize(ctx, text, maxWidth, maxHeight) {
    let size = Math.max(8, Math.floor(maxHeight));
    while (size > 8) {
        ctx.font = `${size}px "Sinhala MN Placeholder", "Matrix Sans Print", "Matrix Sans", monospace`;
        const metrics = ctx.measureText(text);
        const width = Math.ceil(metrics.width);
        const ascent = Math.ceil(metrics.actualBoundingBoxAscent || size * 0.8);
        const descent = Math.ceil(metrics.actualBoundingBoxDescent || size * 0.2);
        const height = ascent + descent;
        if (width <= maxWidth && height <= maxHeight) {
            return { size, ascent, descent };
        }
        size -= 1;
    }
    return {
        size: 8,
        ascent: 7,
        descent: 2
    };
}

function buildEmptyClockSvgMarkup(text, width = BOARD_WIDTH, height = EMPTY_CLOCK_HEIGHT_PX, paddingPx = EMPTY_CLOCK_PADDING_PX) {
    const rasterWidth = Math.max(1, Math.floor(width / EMPTY_CLOCK_CANVAS_SCALE));
    const rasterHeight = Math.max(1, Math.floor(height / EMPTY_CLOCK_CANVAS_SCALE));
    const rasterPadding = Math.max(1, Math.floor(paddingPx / EMPTY_CLOCK_CANVAS_SCALE));
    const canvas = createRasterCanvas(rasterWidth, rasterHeight);
    const ctx = canvas?.getContext?.('2d', { willReadFrequently: true });
    if (!canvas || !ctx) {
        return escapeHtml(text);
    }

    ctx.clearRect(0, 0, rasterWidth, rasterHeight);
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.imageSmoothingEnabled = false;

    const { size } = measureClockFontSize(
        ctx,
        text,
        rasterWidth - rasterPadding * 2,
        rasterHeight - rasterPadding * 2
    );
    ctx.font = `${size}px "Sinhala MN Placeholder", "Matrix Sans Print", "Matrix Sans", monospace`;
    ctx.fillText(text, rasterWidth / 2, rasterHeight / 2);

    const { data } = ctx.getImageData(0, 0, rasterWidth, rasterHeight);
    const dots = [];
    for (let y = 0; y < rasterHeight; y += 1) {
        for (let x = 0; x < rasterWidth; x += 1) {
            const alpha = data[((y * rasterWidth) + x) * 4 + 3];
            if (alpha < EMPTY_CLOCK_ALPHA_THRESHOLD) continue;
            const cx = (x * EMPTY_CLOCK_CANVAS_SCALE) + (EMPTY_CLOCK_CANVAS_SCALE / 2);
            const cy = (y * EMPTY_CLOCK_CANVAS_SCALE) + (EMPTY_CLOCK_CANVAS_SCALE / 2);
            dots.push(`<circle class="street-screen-empty-clock-dot" cx="${cx}" cy="${cy}" r="0.82" />`);
        }
    }

    return `
        <svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" aria-hidden="true" focusable="false">
            ${dots.join('')}
        </svg>
    `;
}

function buildEmptyClockMarkup(text) {
    const cells = Array.from(text).map((char, index) => {
        if (char === ':') {
            return `<span class="street-screen-empty-clock-colon" aria-hidden="true">${buildEmptyClockSvgMarkup(char, EMPTY_CLOCK_COLON_WIDTH_PX, EMPTY_CLOCK_HEIGHT_PX, 4)}</span>`;
        }
        return buildAnimatedNumberMarkup({
            key: `empty-clock-digit-${index}`,
            value: char,
            html: buildEmptyClockSvgMarkup(char, EMPTY_CLOCK_DIGIT_WIDTH_PX, EMPTY_CLOCK_HEIGHT_PX, 6),
            className: 'street-screen-empty-clock-number',
            block: true,
            ariaLabel: char
        });
    }).join('');

    return `<div class="street-screen-empty-clock" role="img" aria-label="${escapeHtml(text)}">${cells}</div>`;
}

function buildStatusTimeMarkup(text) {
    const [hours = '--', minutes = '--'] = String(text || '').split(':');
    return `${buildAnimatedNumberMarkup({
        key: 'status-time-hours',
        value: hours,
        className: 'street-screen-status-value street-screen-status-value--time'
    })}<span class="street-screen-status-time-separator" aria-hidden="true">:</span>${buildAnimatedNumberMarkup({
        key: 'status-time-minutes',
        value: minutes,
        className: 'street-screen-status-value street-screen-status-value--time'
    })}`;
}

function normalizeLedLabel(text, locale) {
    const value = String(text || '').trim();
    if (!value) return value;
    if (locale === 'ka' || /[\u10A0-\u10FF]/.test(value)) {
        return value.toLocaleUpperCase('ka-GE');
    }
    return value;
}

function buildNameCell(currentText, nextText, options = {}) {
    const locale = options.locale === 'ka' ? 'ka' : 'en';
    const current = normalizeLedLabel(currentText, locale) || ' ';
    const next = normalizeLedLabel(nextText, locale) || current;
    const shouldMarquee = options.marquee === true;
    const currentContent = shouldMarquee
        ? `<div class="street-screen-name-line street-screen-name-line--marquee" data-marquee-text="${escapeHtml(current)}"><div class="street-screen-name-marquee-viewport"><div class="street-screen-name-marquee"><span>${escapeHtml(current)}</span></div></div></div>`
        : `<div class="street-screen-name-line street-screen-name-line--static">${escapeHtml(current)}</div>`;
    const nextContent = `<div class="street-screen-name-line street-screen-name-line--static">${escapeHtml(next)}</div>`;
    return `
        <div class="street-screen-name-switch${options.switching ? ' is-switching' : ''}">
            <div class="street-screen-name-track">
                ${currentContent}
                ${nextContent}
            </div>
        </div>
    `;
}

function parseArrivalItemsFromDom() {
    return Array.from(document.querySelectorAll('#arrivals-list .arrival-item')).map((item) => {
        const routeNumber = item.querySelector('.route-number')?.textContent?.trim() || '';
        const destinationEl = item.querySelector('.destination');
        const destination = destinationEl?.textContent?.trim() || '';
        const destinationEn = destinationEl?.getAttribute('data-destination-en')?.trim() || destination;
        const destinationKa = destinationEl?.getAttribute('data-destination-ka')?.trim() || destination;
        const timeText = item.querySelector('.arrival-time-primary')?.textContent?.trim() || '--';
        const routeId = item.getAttribute('data-route-id') || routeNumber;
        const directionIndex = Number.parseInt(item.getAttribute('data-direction') || '0', 10);
        const minutes = Number.parseInt(item.getAttribute('data-minutes') || '', 10);
        const isScheduled = item.querySelector('.arrival-time-primary')?.classList.contains('scheduled-time') || timeText.includes('˚');
        return {
            routeNumber,
            destination,
            destinationEn,
            destinationKa,
            routeId,
            directionIndex,
            minutes: Number.isFinite(minutes) ? minutes : null,
            isScheduled,
            timeText
        };
    }).filter((arrival) => !Number.isFinite(arrival.minutes) || arrival.minutes <= MAX_VISIBLE_ARRIVAL_MINUTES);
}

function buildTickerItems(arrivals, language) {
    return arrivals.map((arrival, index) => {
        const label = normalizeLedLabel(language === 'ka' ? arrival.destinationKa : arrival.destinationEn, language);
        const itemKey = `${arrival.routeId || arrival.routeNumber}-${arrival.directionIndex}-${index}`;
        return `
            <span class="street-screen-ticker-route">${buildAnimatedNumberMarkup({
                key: `ticker-route-${itemKey}`,
                value: arrival.routeNumber,
                className: 'street-screen-ticker-route-value'
            })}</span>
            <span class="street-screen-ticker-name">${escapeHtml(label)}</span>
            <span class="street-screen-ticker-minutes">${buildTickerMinutesMarkup(arrival.minutes, language, `ticker-minutes-${itemKey}`)}</span>
            <span class="street-screen-ticker-separator">*</span>
        `;
    }).join('');
}

export class StreetScreenController {
    constructor(options) {
        this.options = options;
        this.overlayEl = document.getElementById('street-screen-overlay');
        this.closeEl = document.getElementById('street-screen-close');
        this.controlsEl = document.getElementById('street-screen-controls');
        this.paletteEl = document.getElementById('street-screen-palette');
        this.fitToggleEl = document.getElementById('street-screen-fit-toggle');
        this.surfaceEl = document.querySelector('.street-screen-surface');
        this.mainEl = document.getElementById('street-screen-main');
        this.scrollEl = document.getElementById('street-screen-scroll');
        this.statusEl = document.getElementById('street-screen-status');
        this.isOpen = false;
        this.language = getCurrentStopNamesLanguage() === 'ka' ? 'ka' : 'en';
        this.temperatureC = DEFAULT_TBILISI_TEMP_C;
        this.lastWeatherAt = 0;
        this.statusMode = 'temp';
        this.currentModel = null;
        this.syncToken = 0;
        this.languageTimer = null;
        this.modelTimer = null;
        this.clockTimer = null;
        this.syncRetryTimer = null;
        this.syncScheduleTimer = null;
        this.arrivalsObserver = null;
        this.stageResizeObserver = null;
        this.nameMarqueeTimers = [];
        this.controlsIdleTimer = null;
        this.colorScheme = DEFAULT_SCHEME;
        this.fillHeightMode = false;
        this.numberTransitionMap = new Map();
        this.numberTransitionTimers = [];
        this.layoutMetrics = {
            boardHeight: BOARD_HEIGHT,
            mainHeight: DEFAULT_MAIN_HEIGHT_PX,
            dynamicRows: DEFAULT_MAIN_ROWS,
            totalVisibleCapacity: DEFAULT_MAIN_ROWS + 1
        };
        this.boundEscHandler = (event) => {
            if (event.key === 'Escape') this.close();
        };
        this.boundResizeHandler = () => {
            this.updateScale();
            if (this.isOpen && this.currentModel) {
                this.render();
            }
        };
        this.boundControlsActivityHandler = () => this.bumpControlsVisibility();
    }

    loadPreferences() {
        if (typeof localStorage === 'undefined') return;
        try {
            const storedScheme = localStorage.getItem(STREET_SCREEN_COLOR_KEY);
            if (SCHEMES.has(storedScheme || '')) {
                this.colorScheme = storedScheme;
            }
            this.fillHeightMode = localStorage.getItem(STREET_SCREEN_FILL_MODE_KEY) === 'true';
        } catch (error) {
            console.warn('[Street Screen] Failed to load preferences', error);
        }
    }

    persistPreferences() {
        if (typeof localStorage === 'undefined') return;
        try {
            localStorage.setItem(STREET_SCREEN_COLOR_KEY, this.colorScheme);
            localStorage.setItem(STREET_SCREEN_FILL_MODE_KEY, String(this.fillHeightMode));
        } catch (error) {
            console.warn('[Street Screen] Failed to persist preferences', error);
        }
    }

    setFillHeightMode(enabled) {
        this.fillHeightMode = enabled === true;
        this.overlayEl?.classList.toggle('is-fill-height', this.fillHeightMode);
        this.fitToggleEl?.setAttribute('aria-pressed', this.fillHeightMode ? 'true' : 'false');
        this.fitToggleEl?.setAttribute('title', this.fillHeightMode ? 'Fit screen' : 'Fill height');
    }

    init() {
        if (!this.overlayEl || !this.closeEl || !this.mainEl || !this.scrollEl || !this.statusEl || !this.surfaceEl) return;
        this.loadPreferences();
        this.closeEl.addEventListener('click', () => this.close());
        this.fitToggleEl?.addEventListener('click', () => {
            this.setFillHeightMode(!this.fillHeightMode);
            this.persistPreferences();
            this.bumpControlsVisibility();
            this.render();
        });
        this.overlayEl.addEventListener('click', (event) => {
            if (event.target === this.overlayEl) this.close();
        });
        ['mousemove', 'mousedown', 'touchstart', 'touchmove', 'pointerdown', 'pointermove', 'keydown'].forEach((eventName) => {
            this.overlayEl.addEventListener(eventName, this.boundControlsActivityHandler, { passive: true });
        });
        this.paletteEl?.addEventListener('click', (event) => {
            const swatch = event.target instanceof Element ? event.target.closest('.street-screen-swatch') : null;
            const scheme = swatch?.getAttribute('data-scheme') || '';
            if (!SCHEMES.has(scheme)) return;
            this.setColorScheme(scheme);
            this.bumpControlsVisibility();
        });
        document.addEventListener('visibilitychange', () => {
            if (this.isOpen && !document.hidden) {
                this.fetchTemperature();
                this.syncModel();
            }
        });
        const arrivalsList = document.getElementById('arrivals-list');
        if (arrivalsList && typeof MutationObserver !== 'undefined') {
            this.arrivalsObserver = new MutationObserver(() => {
                if (!this.isOpen) return;
                this.scheduleSync(120);
            });
            this.arrivalsObserver.observe(arrivalsList, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ['data-minutes', 'data-direction', 'data-route-id']
            });
        }
        const stage = this.overlayEl.querySelector('.street-screen-stage');
        if (stage && typeof ResizeObserver !== 'undefined') {
            this.stageResizeObserver = new ResizeObserver(() => {
                if (!this.isOpen) return;
                this.updateScale();
                if (this.currentModel) this.render();
            });
            this.stageResizeObserver.observe(stage);
        }
        window.addEventListener('resize', this.boundResizeHandler);
        window.visualViewport?.addEventListener?.('resize', this.boundResizeHandler);
        this.setColorScheme(this.colorScheme);
        this.setFillHeightMode(this.fillHeightMode);
    }

    async open(options = {}) {
        if (!this.overlayEl) return;
        this.language = getCurrentStopNamesLanguage() === 'ka' ? 'ka' : 'en';
        this.statusMode = 'temp';
        this.isOpen = true;
        this.overlayEl.classList.remove('hidden');
        this.overlayEl.setAttribute('aria-hidden', 'false');
        document.addEventListener('keydown', this.boundEscHandler);
        this.options.onOpen?.(options);
        this.bumpControlsVisibility();
        this.updateScale();
        this.renderLoading();
        this.startTimers();
        this.fetchTemperature();
        await this.syncModel();
    }

    close(options = {}) {
        if (!this.isOpen || !this.overlayEl) return;
        this.isOpen = false;
        this.stopTimers();
        this.overlayEl.classList.add('hidden');
        this.overlayEl.setAttribute('aria-hidden', 'true');
        document.removeEventListener('keydown', this.boundEscHandler);
        if (this.controlsIdleTimer) window.clearTimeout(this.controlsIdleTimer);
        this.controlsIdleTimer = null;
        this.overlayEl.classList.remove('is-idle');
        this.options.onClose?.(options);
    }

    startTimers() {
        this.stopTimers();
        this.languageTimer = window.setInterval(() => {
            if (!this.isOpen || !this.currentModel) return;
            this.animateLanguageSwitch();
        }, LANGUAGE_SWITCH_MS);
        this.modelTimer = window.setInterval(() => {
            if (!this.isOpen) return;
            this.syncModel();
            this.fetchTemperature();
        }, MODEL_SYNC_MS);
        this.clockTimer = window.setInterval(() => {
            if (!this.isOpen) return;
            if (this.currentModel?.stop && (!this.currentModel.arrivals || this.currentModel.arrivals.length === 0)) {
                this.render();
                return;
            }
            if (this.statusMode !== 'time') return;
            this.renderStatus();
        }, 1000);
    }

    stopTimers() {
        [this.languageTimer, this.modelTimer, this.clockTimer].forEach((timerId) => {
            if (timerId) window.clearInterval(timerId);
        });
        this.languageTimer = null;
        this.modelTimer = null;
        this.clockTimer = null;
        if (this.syncRetryTimer) window.clearTimeout(this.syncRetryTimer);
        if (this.syncScheduleTimer) window.clearTimeout(this.syncScheduleTimer);
        this.syncRetryTimer = null;
        this.syncScheduleTimer = null;
        this.clearNameMarqueeTimers();
        this.numberTransitionTimers.forEach((timerId) => window.clearTimeout(timerId));
        this.numberTransitionTimers = [];
    }

    setColorScheme(scheme) {
        const nextScheme = SCHEMES.has(scheme) ? scheme : DEFAULT_SCHEME;
        this.colorScheme = nextScheme;
        this.surfaceEl?.setAttribute('data-scheme', nextScheme);
        this.paletteEl?.querySelectorAll('.street-screen-swatch').forEach((el) => {
            el.classList.toggle('is-active', el.getAttribute('data-scheme') === nextScheme);
        });
        this.persistPreferences();
    }

    bumpControlsVisibility(persist = false) {
        if (!this.isOpen || !this.overlayEl) return;
        this.overlayEl.classList.remove('is-idle');
        if (this.controlsIdleTimer) window.clearTimeout(this.controlsIdleTimer);
        if (persist) return;
        this.controlsIdleTimer = window.setTimeout(() => {
            if (!this.isOpen) return;
            this.overlayEl.classList.add('is-idle');
        }, CONTROLS_IDLE_MS);
    }

    scheduleSync(delay = 0) {
        if (this.syncScheduleTimer) window.clearTimeout(this.syncScheduleTimer);
        this.syncScheduleTimer = window.setTimeout(() => {
            this.syncScheduleTimer = null;
            this.syncModel();
        }, delay);
    }

    async fetchTemperature() {
        const now = Date.now();
        if (now - this.lastWeatherAt < WEATHER_REFRESH_MS) return;
        this.lastWeatherAt = now;
        try {
            const response = await fetch(TBILISI_WEATHER_URL, { cache: 'no-store' });
            if (!response.ok) throw new Error(`Weather status ${response.status}`);
            const data = await response.json();
            const nextValue = Math.round(Number(data?.current?.temperature_2m));
            if (Number.isFinite(nextValue)) {
                this.temperatureC = nextValue;
                if (this.isOpen && this.currentModel && this.statusMode === 'temp') {
                    this.renderStatus();
                }
            }
        } catch (error) {
            console.warn('[Street Screen] Failed to fetch Tbilisi temperature', error);
        }
    }

    clearNameMarqueeTimers() {
        this.nameMarqueeTimers.forEach((timerId) => window.clearTimeout(timerId));
        this.nameMarqueeTimers = [];
    }

    async syncModel() {
        if (!this.isOpen) return;
        const syncToken = ++this.syncToken;
        const stop = this.options.getCurrentStop?.();
        const arrivals = parseArrivalItemsFromDom();
        const hasOnlyPlaceholderMinutes = arrivals.length > 0
            && arrivals.every((arrival) => !Number.isFinite(arrival.minutes) || arrival.minutes >= 999);
        if (window.arrivalsLoading && hasOnlyPlaceholderMinutes) {
            if (this.syncRetryTimer) window.clearTimeout(this.syncRetryTimer);
            this.syncRetryTimer = window.setTimeout(() => {
                this.syncRetryTimer = null;
                this.syncModel();
            }, 250);
            return;
        }
        if (!stop || arrivals.length === 0) {
            this.currentModel = {
                stop,
                arrivals: []
            };
            if (syncToken === this.syncToken) this.render();
            return;
        }

        this.currentModel = {
            stop,
            arrivals
        };

        if (syncToken === this.syncToken) {
            this.render();
        }
    }

    renderLoading() {
        this.surfaceEl?.classList.remove('is-scroll-hidden');
        this.mainEl.innerHTML = '<div class="street-screen-loading">Loading screen…</div>';
        this.scrollEl.innerHTML = '';
        this.statusEl.innerHTML = '';
    }

    render() {
        if (!this.currentModel) {
            this.renderLoading();
            return;
        }

        if (this.surfaceEl) {
            this.surfaceEl.dataset.language = this.language;
        }

        const { stop, arrivals } = this.currentModel;
        if (!stop || arrivals.length === 0) {
            this.surfaceEl?.classList.add('is-scroll-hidden');
            this.mainEl.innerHTML = `<div class="street-screen-empty street-screen-empty--clock">${buildEmptyClockMarkup(formatTbilisiTimeWithSeconds())}</div>`;
            this.scrollEl.innerHTML = '';
            this.renderStatus({ tempOnly: true });
            this.applyNumberTransitions();
            return;
        }

        const { mainCapacity, totalVisibleCapacity } = this.getVisibleCapacity(arrivals.length);
        const canHideScrollRow = arrivals.length === mainCapacity + 1 && arrivals.length <= totalVisibleCapacity;
        const effectiveMainCapacity = canHideScrollRow ? Math.min(arrivals.length, mainCapacity + 1) : mainCapacity;
        const mainRows = arrivals.slice(0, effectiveMainCapacity);
        const extraRows = arrivals.slice(effectiveMainCapacity);
        const singleOverflowRow = !canHideScrollRow && extraRows.length === 1 && arrivals.length <= totalVisibleCapacity ? extraRows[0] : null;
        const tickerRows = singleOverflowRow ? [] : extraRows;
        this.surfaceEl?.classList.toggle('is-scroll-hidden', canHideScrollRow);

        this.mainEl.innerHTML = mainRows.map((arrival, index) => {
            const currentName = this.language === 'ka' ? arrival.destinationKa : arrival.destinationEn;
            const nextName = this.language === 'ka' ? arrival.destinationEn : arrival.destinationKa;
            const itemKey = `${arrival.routeId || arrival.routeNumber}-${arrival.directionIndex}-${index}`;
            return `
                <div class="street-screen-row">
                    <div class="street-screen-route">${buildAnimatedNumberMarkup({
                        key: `main-route-${itemKey}`,
                        value: arrival.routeNumber,
                        className: 'street-screen-route-value'
                    })}</div>
                    ${buildNameCell(currentName, nextName, {
                        marquee: currentName.length > 16,
                        switching: false,
                        locale: this.language
                    })}
                    <div class="street-screen-minutes${arrival.minutes !== null && arrival.minutes <= 2 && !arrival.isScheduled ? ' is-urgent' : ''}">${buildMinutesCellMarkup(arrival.minutes, `main-minutes-${itemKey}`)}</div>
                </div>
            `;
        }).join('');

        if (canHideScrollRow) {
            this.scrollEl.innerHTML = '';
        } else if (singleOverflowRow) {
            const label = this.language === 'ka' ? singleOverflowRow.destinationKa : singleOverflowRow.destinationEn;
            this.scrollEl.innerHTML = `
                <div class="street-screen-row street-screen-row--scroll-static">
                    <div class="street-screen-route">${buildAnimatedNumberMarkup({
                        key: 'overflow-route',
                        value: singleOverflowRow.routeNumber,
                        className: 'street-screen-route-value'
                    })}</div>
                    <div class="street-screen-name-line street-screen-name-line--static">${escapeHtml(label)}</div>
                    <div class="street-screen-minutes${singleOverflowRow.minutes !== null && singleOverflowRow.minutes <= 2 && !singleOverflowRow.isScheduled ? ' is-urgent' : ''}">${buildMinutesCellMarkup(singleOverflowRow.minutes, 'overflow-minutes')}</div>
                </div>
            `;
        } else if (tickerRows.length > 0) {
            const tickerHtml = buildTickerItems(tickerRows, this.language);
            const tickerLength = tickerRows.reduce((total, arrival) => {
                const label = this.language === 'ka' ? arrival.destinationKa : arrival.destinationEn;
                return total + String(arrival.routeNumber).length + String(label).length + formatTickerMinutes(arrival.minutes, this.language).length + 2;
            }, 0);
            const duration = `${Math.max(18, Math.ceil(tickerLength / 2.25))}s`;
            const steps = Math.max(40, Math.ceil((tickerLength * 12) / LED_GRID_STEP_PX));
            this.scrollEl.innerHTML = `
                <div class="street-screen-scroll-baseline">
                    <div class="street-screen-scroll-track" style="animation-duration:${duration}; animation-timing-function: steps(${steps}, end);">
                        <span class="street-screen-scroll-copy">${tickerHtml}</span>
                        <span class="street-screen-scroll-copy">${tickerHtml}</span>
                    </div>
                </div>
            `;
            this.applyTickerMetrics();
        } else {
            this.scrollEl.innerHTML = '<div class="street-screen-scroll-empty">&nbsp;</div>';
        }

        this.renderStatus();
        this.applyNumberTransitions();
        this.applyMarqueeDurations();
        this.updateScale();
    }

    renderStatus(options = {}) {
        if (!this.statusEl || !this.currentModel?.stop) return;
        const stop = this.currentModel.stop;
        const stopCode = String(stop.code || stop.id || '').replace(/^1:/, '');
        if (options.tempOnly === true) {
            this.statusEl.innerHTML = `
                <div class="street-screen-status-item street-screen-status-item--id"></div>
                <div class="street-screen-status-item street-screen-status-item--right">${buildAnimatedNumberMarkup({
                    key: 'status-temp',
                    value: String(Math.round(this.temperatureC)),
                    className: 'street-screen-status-value'
                })}<span class="street-screen-status-degree">${escapeHtml('°')}</span><span class="street-screen-status-value street-screen-status-value--unit">${escapeHtml('C')}</span></div>
            `;
            return;
        }
        const rightValue = this.statusMode === 'temp'
            ? `${buildAnimatedNumberMarkup({
                key: 'status-temp',
                value: String(Math.round(this.temperatureC)),
                className: 'street-screen-status-value'
            })}<span class="street-screen-status-degree">${escapeHtml('°')}</span><span class="street-screen-status-value street-screen-status-value--unit">${escapeHtml('C')}</span>`
            : buildStatusTimeMarkup(formatTbilisiTime());
        this.statusEl.innerHTML = `
            <div class="street-screen-status-item street-screen-status-item--id">ID:${escapeHtml(stopCode)} SMS:93344</div>
            <div class="street-screen-status-item street-screen-status-item--right">${rightValue}</div>
        `;
    }

    applyNumberTransitions() {
        const elements = Array.from(this.surfaceEl?.querySelectorAll?.('.street-screen-number[data-number-key]') || []);
        const seenKeys = new Set();
        this.numberTransitionTimers.forEach((timerId) => window.clearTimeout(timerId));
        this.numberTransitionTimers = [];

        elements.forEach((element) => {
            const key = element.getAttribute('data-number-key') || '';
            const value = element.getAttribute('data-number-value') || '';
            if (!key) return;
            seenKeys.add(key);

            const currentNode = element.querySelector('.street-screen-number-current');
            const markup = currentNode?.innerHTML || '';
            const previous = this.numberTransitionMap.get(key);
            if (!previous || previous.value === value) {
                this.numberTransitionMap.set(key, { value, markup });
                return;
            }

            element.innerHTML = `
                <span class="street-screen-number-layer street-screen-number-layer--old" aria-hidden="true">${previous.markup}</span>
                <span class="street-screen-number-layer street-screen-number-layer--new" aria-hidden="true">${markup}</span>
            `;
            element.classList.add('is-animating');
            window.requestAnimationFrame(() => {
                element.classList.add('is-active');
            });

            const cleanupTimer = window.setTimeout(() => {
                element.innerHTML = `<span class="street-screen-number-current">${markup}</span>`;
                element.classList.remove('is-animating', 'is-active');
            }, NUMBER_SWAP_DURATION_MS + 40);
            this.numberTransitionTimers.push(cleanupTimer);
            this.numberTransitionMap.set(key, { value, markup });
        });

        Array.from(this.numberTransitionMap.keys()).forEach((key) => {
            if (!seenKeys.has(key)) this.numberTransitionMap.delete(key);
        });
    }

    applyMarqueeDurations() {
        this.clearNameMarqueeTimers();
        this.mainEl.querySelectorAll('.street-screen-name-line--marquee').forEach((element) => {
            const marquee = element.querySelector('.street-screen-name-marquee');
            const textSpan = marquee?.querySelector('span');
            const viewport = element.querySelector('.street-screen-name-marquee-viewport');
            if (!marquee || !textSpan || !viewport) return;

            marquee.style.transform = 'translateX(0)';

            const viewportWidth = viewport.getBoundingClientRect().width;
            const textWidth = textSpan.getBoundingClientRect().width;
            const overflow = textWidth - viewportWidth;

            if (overflow <= 2) {
                element.classList.remove('is-active');
                return;
            }

            const snappedDistance = Math.max(overflow, LED_GRID_STEP_PX);
            const fullSteps = Math.max(1, Math.floor(snappedDistance / LED_GRID_STEP_PX));
            const remainder = snappedDistance - (fullSteps * LED_GRID_STEP_PX);
            const totalSteps = remainder > 0.25 ? fullSteps + 1 : fullSteps;
            const scrollSeconds = Math.max(2.4, snappedDistance / 22);
            const stepMs = (scrollSeconds * 1000) / totalSteps;

            element.classList.add('is-active');

            const runCycle = () => {
                marquee.style.transform = 'translateX(0)';
                const startTimer = window.setTimeout(() => {
                    let stepIndex = 0;
                    const advance = () => {
                        stepIndex += 1;
                        const travelled = stepIndex >= totalSteps
                            ? snappedDistance
                            : Math.min(stepIndex * LED_GRID_STEP_PX, snappedDistance);
                        marquee.style.transform = `translateX(${-travelled}px)`;
                        if (stepIndex < totalSteps) {
                            const nextTimer = window.setTimeout(advance, stepMs);
                            this.nameMarqueeTimers.push(nextTimer);
                            return;
                        }
                        const resetTimer = window.setTimeout(runCycle, 2000);
                        this.nameMarqueeTimers.push(resetTimer);
                    };
                    advance();
                }, 2000);
                this.nameMarqueeTimers.push(startTimer);
            };

            runCycle();
        });
    }

    applyTickerMetrics() {
        const track = this.scrollEl?.querySelector('.street-screen-scroll-track');
        const copy = this.scrollEl?.querySelector('.street-screen-scroll-copy');
        if (!track || !copy) return;
        const rawDistance = copy.getBoundingClientRect().width + TICKER_COPY_GAP_PX;
        const distance = Math.max(LED_GRID_STEP_PX, Math.round(rawDistance / LED_GRID_STEP_PX) * LED_GRID_STEP_PX);
        const steps = Math.max(1, Math.round(distance / LED_GRID_STEP_PX));
        const durationSeconds = Math.max(12, distance / TICKER_PIXELS_PER_SECOND);
        track.style.setProperty('--street-scroll-distance', `${distance}px`);
        track.style.animationDuration = `${durationSeconds}s`;
        track.style.animationTimingFunction = `steps(${steps}, end)`;
    }

    async animateLanguageSwitch() {
        if (!this.currentModel) return;
        this.language = this.language === 'ka' ? 'en' : 'ka';
        this.statusMode = this.statusMode === 'temp' ? 'time' : 'temp';
        this.render();
    }

    updateScale() {
        if (!this.overlayEl) return;
        const stage = this.overlayEl.querySelector('.street-screen-stage');
        const board = this.overlayEl.querySelector('.street-screen-board');
        if (!stage || !board) return;
        const rect = stage.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        const viewportPadding = 2;
        const availableWidth = Math.max(1, rect.width - viewportPadding);
        const availableHeight = Math.max(1, rect.height - viewportPadding);

        if (this.fillHeightMode) {
            const scale = Math.max(0.1, availableWidth / BOARD_WIDTH);
            const boardWidth = BOARD_WIDTH;
            const rawBoardHeight = availableHeight / scale;
            const boardHeight = Math.max(
                LED_GRID_STEP_PX,
                Math.floor(rawBoardHeight / LED_GRID_STEP_PX) * LED_GRID_STEP_PX
            );
            const metrics = this.computeFillHeightMetrics(boardHeight);
            board.style.setProperty('--street-screen-board-width', `${boardWidth}px`);
            board.style.setProperty('--street-screen-board-height', `${boardHeight}px`);
            board.style.setProperty('--street-screen-main-height', `${metrics.mainHeight}px`);
            board.style.setProperty('--street-screen-scale', String(scale));
            this.layoutMetrics = metrics;
            return;
        }

        const scale = Math.min(availableWidth / BOARD_WIDTH, availableHeight / BOARD_HEIGHT);
        board.style.setProperty('--street-screen-board-width', `${BOARD_WIDTH}px`);
        board.style.setProperty('--street-screen-board-height', `${BOARD_HEIGHT}px`);
        board.style.setProperty('--street-screen-main-height', `${DEFAULT_MAIN_HEIGHT_PX}px`);
        board.style.setProperty('--street-screen-scale', String(Math.max(0.1, scale)));
        this.layoutMetrics = {
            boardHeight: BOARD_HEIGHT,
            mainHeight: DEFAULT_MAIN_HEIGHT_PX,
            dynamicRows: DEFAULT_MAIN_ROWS,
            totalVisibleCapacity: DEFAULT_MAIN_ROWS + 1
        };
    }

    computeFillHeightMetrics(boardHeight) {
        const maxMainHeight = Math.max(
            0,
            boardHeight - (SURFACE_PADDING_PX * 2) - (STATIC_SECTION_HEIGHT_PX * 2) - (ROW_GAP_PX * SURFACE_GAP_COUNT)
        );
        const dynamicRows = Math.max(
            MIN_FILL_HEIGHT_ROWS,
            Math.floor((maxMainHeight + ROW_GAP_PX) / (ROW_HEIGHT_PX + ROW_GAP_PX))
        );
        const mainHeight = (dynamicRows * ROW_HEIGHT_PX) + (Math.max(0, dynamicRows - 1) * ROW_GAP_PX);
        return {
            boardHeight,
            mainHeight,
            dynamicRows,
            totalVisibleCapacity: dynamicRows + 1
        };
    }

    getVisibleCapacity(totalArrivals = 0) {
        if (!this.fillHeightMode) {
            const totalVisibleCapacity = DEFAULT_MAIN_ROWS + 1;
            const mainCapacity = Math.min(DEFAULT_MAIN_ROWS, totalArrivals);
            return { mainCapacity, totalVisibleCapacity, dynamicRows: DEFAULT_MAIN_ROWS };
        }
        const metrics = this.layoutMetrics || this.computeFillHeightMetrics(BOARD_HEIGHT);
        const dynamicRows = Math.max(MIN_FILL_HEIGHT_ROWS, metrics.dynamicRows || MIN_FILL_HEIGHT_ROWS);
        const totalVisibleCapacity = metrics.totalVisibleCapacity || (dynamicRows + 1);
        const mainCapacity = Math.min(dynamicRows, totalArrivals);
        return { mainCapacity, totalVisibleCapacity, dynamicRows };
    }
}
