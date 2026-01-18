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
    }

    /**
     * Select a stop and load its arrivals
     * Phase 1: Show cached/scheduled data instantly
     * Phase 2: Fetch live data with loading indicator
     */
    async selectStop(stopId) {
        // Cancel any in-flight request
        if (this.abortController) this.abortController.abort();
        this.abortController = new AbortController();

        // Clear previous stop's content immediately
        if (this.stopId && this.stopId !== stopId) {
            this.arrivals = [];
            window.lastArrivals = [];
            renderArrivals([], stopId); // Clears list
        }

        this.stopId = stopId;

        // === PHASE 1: Instant scheduled (cached) ===
        try {
            const scheduled = await fetchArrivalsOptimistic(stopId);
            if (this.stopId !== stopId) return; // Stop changed during fetch

            if (scheduled.length > 0) {
                this.arrivals = scheduled;
                this.timestamp = Date.now();
                window.lastArrivals = scheduled;
                renderArrivals(scheduled, stopId);
            }
        } catch (e) {
            console.warn('[ArrivalsController] Optimistic fetch failed:', e);
        }

        // === PHASE 2: Live fetch (loading bar visible) ===
        updateArrivalsLoadingState(true);
        try {
            const live = await fetchArrivals(stopId);
            if (this.stopId !== stopId) return; // Stop changed during fetch

            if (live.length > 0) {
                // Upgrade to live data
                this.arrivals = live;
                this.timestamp = Date.now();
                window.lastArrivals = live;
                window.arrivalsDataTimestamp = this.timestamp;
                renderArrivals(live, stopId);
            } else if (this.arrivals.length === 0) {
                // No live AND no scheduled - render empty state
                renderArrivals([], stopId);
            }
            // else: keep showing scheduled (already rendered in phase 1)

            this.startRefreshTimer();
        } catch (e) {
            console.warn('[ArrivalsController] Live fetch failed:', e);
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

            const age = (Date.now() - this.timestamp) / 1000;
            const threshold = this.getRefreshThreshold();

            if (age > threshold) {
                this.refresh();
            }
        }, 5000);
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
        this.stopId = null;
        this.arrivals = [];
        this.timestamp = 0;
    }
}

// Singleton instance
export const arrivalsController = new ArrivalsController();
