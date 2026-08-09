/**
 * ArrivalsController - Centralized arrivals data lifecycle manager
 * 
 * Handles:
 * - Two-phase loading: scheduled (instant) → live (network)
 * - Request cancellation on stop change
 * - Periodic refresh based on earliest arrival time
 */

import {
    fetchArrivals,
    fetchArrivalsOptimistic,
    renderArrivals,
    setArrivalsLiveDataStale,
    updateArrivalsLoadingState
} from './arrivals.js';

class ArrivalsController {
    constructor() {
        this.stopId = null;
        this.arrivals = [];
        this.timestamp = 0;
        this.abortController = null;
        this.refreshTimer = null;
        this.isRefreshing = false;
        this.requestSeq = 0;
    }

    /**
     * Select a stop and load its arrivals
     * Phase 1: Show cached/scheduled data instantly
     * Phase 2: Fetch live data with loading indicator
     */
    async selectStop(stopId) {
        const requestId = ++this.requestSeq;
        const isRefresh = this.stopId === stopId;
        console.debug('[ArrivalLoad] request started', { stopId, requestId, isRefresh });

        // Cancel any in-flight request
        if (this.abortController) this.abortController.abort();
        this.abortController = new AbortController();

        // Phase 0: Cleanup (Only if switching stops)
        if (this.stopId && !isRefresh) {
            this.arrivals = [];
            window.lastArrivals = [];
            renderArrivals([], stopId); // Clears list
        }

        this.stopId = stopId;

        // === PHASE 1: Instant scheduled (cached) ===
        // SKIP Phase 1 if this is a refresh, as current live data is better than scheduled.
        if (!isRefresh) {
            try {
                const scheduled = await fetchArrivalsOptimistic(stopId);
                if (requestId !== this.requestSeq || this.stopId !== stopId) {
                    console.debug('[ArrivalLoad] scheduled response discarded', { stopId, requestId, currentRequestId: this.requestSeq, activeStopId: this.stopId });
                    return;
                }

                if (scheduled.length > 0) {
                    this.arrivals = scheduled;
                    this.timestamp = Date.now();
                    window.lastArrivals = scheduled;
                    renderArrivals(scheduled, stopId);
                    console.debug('[ArrivalLoad] scheduled rendered', { stopId, requestId, count: scheduled.length });
                }
            } catch (e) {
                console.warn('[ArrivalsController] Optimistic fetch failed:', e);
            }
        }

        // === PHASE 2: Live fetch (loading bar visible) ===
        updateArrivalsLoadingState(true);
        try {
            const live = await fetchArrivals(stopId);
            if (requestId !== this.requestSeq || this.stopId !== stopId) {
                console.debug('[ArrivalLoad] live response discarded', { stopId, requestId, currentRequestId: this.requestSeq, activeStopId: this.stopId });
                return;
            }

            if (live.length > 0) {
                // Upgrade to live data
                this.arrivals = live;
                this.timestamp = Date.now();
                window.lastArrivals = live;
                window.arrivalsDataTimestamp = this.timestamp;
                setArrivalsLiveDataStale(false);
                renderArrivals(live, stopId);
                console.debug('[ArrivalLoad] live rendered', { stopId, requestId, count: live.length });
            } else if (this.arrivals.length === 0) {
                // No live AND no scheduled - render empty state
                renderArrivals([], stopId);
                console.debug('[ArrivalLoad] empty rendered', { stopId, requestId });
            }
            // else: keep showing scheduled (already rendered in phase 1)

            if (requestId === this.requestSeq) {
                this.startRefreshTimer();
            }
        } catch (e) {
            console.warn('[ArrivalsController] Live fetch failed:', e);
            console.debug('[ArrivalLoad] live fetch failed', { stopId, requestId, message: e?.message });
            // Keep showing scheduled data if available
        } finally {
            updateArrivalsLoadingState(false);
        }
    }

    /**
     * Start the refresh timer - checks every 5s if data is stale
     */
    startRefreshTimer() {
        if (this.refreshTimer) clearInterval(this.refreshTimer);

        this.refreshTimer = setInterval(() => {
            if (!this.stopId || this.isRefreshing) return;
            if (document.hidden) return;

            const age = (Date.now() - this.timestamp) / 1000;
            const threshold = this.getRefreshThreshold();

            if (age > threshold) {
                this.refresh();
            }
        }, 5000);
    }

    pause() {
        if (this.abortController) this.abortController.abort();
        if (this.refreshTimer) clearInterval(this.refreshTimer);
        this.refreshTimer = null;
    }

    resume() {
        if (this.stopId) {
            this.startRefreshTimer();
        }
    }

    /**
     * Determine refresh threshold based on earliest arrival
     * - <10 min: refresh every 15s
     * - <90 min: refresh every 60s  
     * - else: refresh every 10min
     */
    getRefreshThreshold() {
        if (this.arrivals.length === 0) return 60;

        const earliest = Math.min(...this.arrivals.map(a =>
            a.realtimeArrivalMinutes ?? a.scheduledArrivalMinutes ?? 999
        ));

        if (earliest < 10) return 15;
        if (earliest < 90) return 60;
        return 600;
    }

    /**
     * Refresh arrivals for current stop
     */
    async refresh() {
        if (!this.stopId || this.isRefreshing) return;

        this.isRefreshing = true;
        try {
            await this.selectStop(this.stopId);
        } finally {
            this.isRefreshing = false;
        }
    }

    /**
     * Clear controller state (e.g., when closing panel)
     */
    clear() {
        if (this.abortController) this.abortController.abort();
        if (this.refreshTimer) clearInterval(this.refreshTimer);
        this.requestSeq++;
        this.stopId = null;
        this.arrivals = [];
        this.timestamp = 0;

        // Force reset the loading state
        window._arrivalsLoadingCount = 0;
        updateArrivalsLoadingState(false);
    }
}

// Singleton instance
export const arrivalsController = new ArrivalsController();
