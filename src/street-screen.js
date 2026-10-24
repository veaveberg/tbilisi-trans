import { getCurrentStopNamesLanguage } from './i18n.ts';
import { getNativeSettingsPlugin } from './settings.js';
import { PixelBoard } from './pixel-board/board.js';
import { SCHEME_COLORS } from './pixel-board/layout.js';

const TBILISI_WEATHER_URL = 'https://api.open-meteo.com/v1/forecast?latitude=41.6938&longitude=44.8015&current=temperature_2m&timezone=Asia%2FTbilisi';
const DEFAULT_TBILISI_TEMP_C = 22;
const LANGUAGE_SWITCH_MS = 10000;
const MODEL_SYNC_MS = 10000;
const WEATHER_REFRESH_MS = 15 * 60 * 1000;
const CONTROLS_IDLE_MS = 2200;
const DEFAULT_SCHEME = 'orange';
const SCHEMES = new Set(Object.keys(SCHEME_COLORS));
const MAX_VISIBLE_ARRIVAL_MINUTES = 90;
const STREET_SCREEN_COLOR_KEY = 'streetScreenColorScheme';
const STREET_SCREEN_FILL_MODE_KEY = 'streetScreenFillHeightMode';

async function setNativeBoardStatusBarHidden(hidden) {
    const cap = window.Capacitor;
    if (!cap?.isNativePlatform?.()) return;
    const plugin = getNativeSettingsPlugin();
    if (!plugin?.setStatusBarHidden) return;
    try {
        await plugin.setStatusBarHidden({ hidden: !!hidden, animated: true });
    } catch (error) {
        console.warn('[Street Screen] Failed to update iOS status bar visibility', error);
    }
}

function getStopIdFromUrlPath() {
    let path = String(window.location?.pathname || '');
    const base = String(import.meta.env.BASE_URL || '/');
    if (base && path.startsWith(base)) {
        path = path.slice(base.length);
    } else if (path.startsWith('/')) {
        path = path.slice(1);
    }
    path = path.replace(/^\/+|\/+$/g, '');
    const firstPart = path.split('/')[0] || '';
    if (!firstPart || firstPart === 'privacy-policy' || firstPart === 'support' || firstPart === 'segment') {
        return '';
    }
    if (firstPart.startsWith('bus')) {
        return '';
    }
    const stopId = firstPart.startsWith('stop') ? firstPart.slice(4) : firstPart;
    // City prefixes namespace IDs in URLs (b1152, k624, r43), but the board
    // should show the passenger-facing number without that implementation detail.
    return stopId.replace(/^[bkr](?=\d)/i, '');
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

function getArrivalsModelSignature(stop, arrivals) {
    return JSON.stringify({
        stopId: String(stop?.id || ''),
        arrivals: arrivals.map((arrival) => ({
            routeId: arrival.routeId || '',
            routeNumber: arrival.routeNumber || '',
            directionIndex: arrival.directionIndex ?? 0,
            destinationEn: arrival.destinationEn || '',
            destinationKa: arrival.destinationKa || '',
            minutes: arrival.minutes ?? null,
            isScheduled: arrival.isScheduled === true
        }))
    });
}

export class StreetScreenController {
    constructor(options) {
        this.options = options;
        this.overlayEl = document.getElementById('street-screen-overlay');
        this.closeEl = document.getElementById('street-screen-close');
        this.controlsEl = document.getElementById('street-screen-controls');
        this.paletteEl = document.getElementById('street-screen-palette');
        this.fitToggleEl = document.getElementById('street-screen-fit-toggle');
        this.boardEl = document.getElementById('street-screen-board');
        this.pixelBoard = null;
        this.isOpen = false;
        this.language = getCurrentStopNamesLanguage() === 'ka' ? 'ka' : 'en';
        this.temperatureC = DEFAULT_TBILISI_TEMP_C;
        this.lastWeatherAt = 0;
        this.statusMode = 'temp';
        this.currentModel = null;
        this.modelSignature = null;
        this.syncToken = 0;
        this.languageTimer = null;
        this.modelTimer = null;
        this.clockTimer = null;
        this.syncRetryTimer = null;
        this.syncScheduleTimer = null;
        this.arrivalsObserver = null;
        this.stageResizeObserver = null;
        this.controlsIdleTimer = null;
        this.colorScheme = DEFAULT_SCHEME;
        this.fillHeightMode = false;
        this.boundEscHandler = (event) => {
            if (event.key === 'Escape') this.close({ syncUrl: true });
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
        if (!this.overlayEl || !this.closeEl || !this.boardEl) return;
        this.loadPreferences();
        this.closeEl.addEventListener('click', () => this.close({ syncUrl: true }));
        this.fitToggleEl?.addEventListener('click', () => {
            this.setFillHeightMode(!this.fillHeightMode);
            this.persistPreferences();
            this.bumpControlsVisibility();
            this.updateScale();
            this.render();
        });
        this.overlayEl.addEventListener('click', (event) => {
            if (event.target === this.overlayEl) this.close({ syncUrl: true });
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
            if (!this.isOpen) return;
            if (document.hidden) { this.pixelBoard?.stop(); return; }
            this.pixelBoard?.start();
            setNativeBoardStatusBarHidden(true);
            this.fetchTemperature();
            this.syncModel();
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
                attributeFilter: ['data-minutes', 'data-direction', 'data-route-id', 'data-destination-en', 'data-destination-ka', 'class']
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
        // syncModel normally skips identical content. Opening starts from the
        // loading state, so force it to paint the existing model again.
        this.modelSignature = null;
        this.isOpen = true;
        this.overlayEl.classList.remove('hidden');
        this.overlayEl.setAttribute('aria-hidden', 'false');
        this.pixelBoard ||= new PixelBoard(this.boardEl);
        this.pixelBoard.start();
        document.addEventListener('keydown', this.boundEscHandler);
        this.options.onOpen?.(options);
        this.bumpControlsVisibility();
        this.updateScale();
        setNativeBoardStatusBarHidden(true);
        this.renderLoading();
        this.startTimers();
        this.fetchTemperature();
        await this.syncModel();
    }

    close(options = {}) {
        if (!this.isOpen || !this.overlayEl) return;
        this.isOpen = false;
        this.stopTimers();
        this.pixelBoard?.stop();
        this.syncToken += 1;
        this.overlayEl.classList.add('hidden');
        this.overlayEl.setAttribute('aria-hidden', 'true');
        document.removeEventListener('keydown', this.boundEscHandler);
        if (this.controlsIdleTimer) window.clearTimeout(this.controlsIdleTimer);
        this.controlsIdleTimer = null;
        this.overlayEl.classList.remove('is-idle');
        setNativeBoardStatusBarHidden(false);
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
            this.updateStatusTime();
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
    }

    setColorScheme(scheme) {
        const nextScheme = SCHEMES.has(scheme) ? scheme : DEFAULT_SCHEME;
        this.colorScheme = nextScheme;
        this.pixelBoard?.setState({ scheme: nextScheme });
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

    async syncModel() {
        if (!this.isOpen) return;
        const syncToken = ++this.syncToken;
        const stop = this.options.getCurrentStop?.();
        const arrivals = parseArrivalItemsFromDom();
        const hasOnlyPlaceholderMinutes = arrivals.length > 0
            && arrivals.every((arrival) => !Number.isFinite(arrival.minutes) || arrival.minutes >= 999);
        if (window.arrivalsLoading && (arrivals.length === 0 || hasOnlyPlaceholderMinutes)) {
            if (String(this.currentModel?.stop?.id) !== String(stop?.id)) this.renderLoading();
            if (this.syncRetryTimer) window.clearTimeout(this.syncRetryTimer);
            this.syncRetryTimer = window.setTimeout(() => {
                this.syncRetryTimer = null;
                this.syncModel();
            }, 250);
            return;
        }
        if (!stop || arrivals.length === 0) {
            const nextModel = {
                stop,
                arrivals: []
            };
            const nextSignature = getArrivalsModelSignature(stop, []);
            if (nextSignature === this.modelSignature) return;

            this.currentModel = nextModel;
            this.modelSignature = nextSignature;
            if (syncToken === this.syncToken) this.render();
            return;
        }

        const nextModel = {
            stop,
            arrivals
        };
        const nextSignature = getArrivalsModelSignature(stop, arrivals);
        if (nextSignature === this.modelSignature) return;

        this.currentModel = nextModel;
        this.modelSignature = nextSignature;

        if (syncToken === this.syncToken) {
            this.render();
        }
    }

    renderLoading() {
        this.pixelBoard?.setState({ loading: true, language: this.language, scheme: this.colorScheme });
    }

    render() {
        if (!this.currentModel) { this.renderLoading(); return; }
        const stop = this.options.getCurrentStop?.() || this.currentModel.stop;
        this.pixelBoard?.setState({
            loading: false,
            arrivals: stop ? this.currentModel.arrivals : [],
            stopId: getStopIdFromUrlPath() || String(stop?.code || stop?.id || '').replace(/^[bkr](?=\d)/i, ''),
            source: stop?._source || '',
            temperature: this.temperatureC,
            language: this.language,
            statusMode: this.statusMode,
            scheme: this.colorScheme,
            fillHeight: this.fillHeightMode,
        });
        this.updateScale();
    }

    renderStatus() {
        this.pixelBoard?.setState({ temperature: this.temperatureC, statusMode: this.statusMode });
    }

    updateStatusTime() {
        this.pixelBoard?.requestFrame();
    }

    async animateLanguageSwitch() {
        this.language = this.language === 'ka' ? 'en' : 'ka';
        this.statusMode = this.statusMode === 'temp' ? 'time' : 'temp';
        this.render();
    }

    updateScale() {
        if (!this.pixelBoard || !this.isOpen) return;
        const stage = this.overlayEl.querySelector('.street-screen-stage');
        const rect = stage.getBoundingClientRect();
        const style = window.getComputedStyle(stage);
        const left = Number.parseFloat(style.paddingLeft) || 0;
        const right = Number.parseFloat(style.paddingRight) || 0;
        const top = Number.parseFloat(style.paddingTop) || 0;
        const bottom = Number.parseFloat(style.paddingBottom) || 0;
        this.pixelBoard.resize({
            left: rect.left + left, top: rect.top + top,
            width: Math.max(1, rect.width - left - right),
            height: Math.max(1, rect.height - top - bottom),
        }, this.fillHeightMode);
    }
}
