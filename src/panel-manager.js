import { map } from './map-setup.js';

function isPanelVisible(panel) {
    if (!panel) return false;
    if (panel.classList.contains('hidden')) return false;
    const style = window.getComputedStyle(panel);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    return panel.getClientRects().length > 0;
}

function getVisibleSheetPanel() {
    return ['info-panel', 'route-info', 'directions-panel']
        .map((id) => document.getElementById(id))
        .find((panel) => isPanelVisible(panel)) || null;
}

export function updateMapPadding() {
    // No-op: fitBounds calls opt out of retained padding, so closing a sheet
    // should not move the map just to clean up camera state.
}

// Helper for Sheet State (Mobile)
export function setSheetState(panel, state) {
    if (!panel) return;

    // Handle directions sheet auto-collapse/restore when other sheets open/close
    if (panel.id !== 'directions-panel') {
        const directionsPanel = document.getElementById('directions-panel');
        if (directionsPanel) {
            if (state !== 'hidden') {
                if (!directionsPanel.classList.contains('hidden') && !directionsPanel.classList.contains('sheet-collapsed')) {
                    let currentState = 'half';
                    if (directionsPanel.classList.contains('sheet-full')) currentState = 'full';
                    else if (directionsPanel.classList.contains('sheet-peek')) currentState = 'peek';
                    
                    directionsPanel._prevSheetState = currentState;
                    setSheetState(directionsPanel, 'collapsed');
                }
            } else {
                if (!directionsPanel.classList.contains('hidden') && directionsPanel.classList.contains('sheet-collapsed') && directionsPanel._prevSheetState) {
                    setSheetState(directionsPanel, directionsPanel._prevSheetState);
                }
                delete directionsPanel._prevSheetState;
            }
        }
    } else if (state === 'hidden') {
        delete panel._prevSheetState;
    }

    const wasHidden = panel.classList.contains('hidden');

    // states: hidden, collapsed, peek, half, full
    panel.classList.remove('hidden', 'sheet-half', 'sheet-full', 'sheet-collapsed', 'sheet-peek');
    document.body.classList.remove('sheet-half', 'sheet-full', 'sheet-collapsed', 'sheet-peek');

    if (state === 'hidden') {
        panel.classList.add('hidden');
        panel.style.display = 'none'; // Force hide
        if (!wasHidden) {
            document.dispatchEvent(new CustomEvent('sheet:closed', { detail: { panelId: panel.id } }));
        }

        // Only clear stop highlight when explicitly closing info-panel (not when switching to route)
        if (panel.id === 'info-panel') {
            if (window._searchPlaceMarker) {
                window._searchPlaceMarker.remove();
                window._searchPlaceMarker = null;
            }
            if (map.getSource('selected-stop')) {
                const routePanel = document.getElementById('route-info');
                if (routePanel && routePanel.classList.contains('hidden')) {
                    map.getSource('selected-stop').setData({ type: 'FeatureCollection', features: [] });
                }
            }
        }
    } else if (state === 'collapsed') {
        panel.classList.add('sheet-collapsed');
        document.body.classList.add('sheet-collapsed');
        panel.classList.remove('hidden');
        panel.style.display = '';
    } else if (state === 'peek') {
        panel.classList.add('sheet-peek');
        document.body.classList.add('sheet-peek');
        panel.classList.remove('hidden');
        panel.style.display = ''; // Reset
    } else if (state === 'half') {
        panel.classList.add('sheet-half');
        document.body.classList.add('sheet-half');
        panel.classList.remove('hidden');
        panel.style.display = ''; // Reset
    } else if (state === 'full') {
        panel.classList.add('sheet-full');
        document.body.classList.add('sheet-full');
        panel.classList.remove('hidden');
        panel.style.display = '';
    }

    // Clear any stale inline transform left over from an interrupted drag
    // gesture. On Android WebView, touchcancel can fire without touchend,
    // leaving the inline transform stuck — which would override the
    // CSS-class-based positioning below. (Inline styles beat class rules.)
    panel.style.transform = '';

    // Initialize CSS variables for transition sync
    // These are also defined in CSS, but setting them here ensures JS logic
    // (like startTransformY) is in sync with the visual state immediately.
    const screenH = window.innerHeight;
    const panelH = panel.offsetHeight || (screenH * 0.92);
    let targetY = 0;

    if (state === 'half') targetY = screenH * (1 - 0.483);
    else if (state === 'peek') targetY = screenH * (1 - 0.25);
    else if (state === 'collapsed') targetY = screenH - 80;
    else if (state === 'full') targetY = 0;

    const hiddenH = Math.max(0, (targetY + panelH) - screenH);

    panel.style.setProperty('--sheet-y', `${targetY}px`);
    panel.style.setProperty('--sheet-hidden-h', `${hiddenH}px`);
    updateMapPadding();
}

// Helper to toggle panel open class on body
export function setPanelState(isOpen) {
    if (isOpen) {
        document.body.classList.add('panel-open');
    } else {
        // Only remove if BOTH panels are hidden
        const info = document.getElementById('info-panel');
        const route = document.getElementById('route-info');
        const directions = document.getElementById('directions-panel');
        const infoHidden = info ? info.classList.contains('hidden') : true;
        const routeHidden = route ? route.classList.contains('hidden') : true;
        const directionsHidden = directions ? directions.classList.contains('hidden') : true;

        if (infoHidden && routeHidden && directionsHidden) {
            document.body.classList.remove('panel-open');
        }
    }
    updateMapPadding();
}

export function closeAllPanels() {
    const infoPanel = document.getElementById('info-panel');
    const routePanel = document.getElementById('route-info');
    const directionsPanel = document.getElementById('directions-panel');

    if (infoPanel) setSheetState(infoPanel, 'hidden');
    if (routePanel) setSheetState(routePanel, 'hidden');
    if (directionsPanel) setSheetState(directionsPanel, 'hidden');

    setPanelState(false);
}

// --- Drag Logic ---

// Helper: Snap Logic (Shared scope, but now defined functionally)
// We export this just in case, but usually it's internal to setupPanelDrag.
export const snapSheet = (panel, delta, velocity) => {
    // Helper to get current translate Y from computed style
    const getTranslateY = () => {
        const style = window.getComputedStyle(panel);
        const matrix = new DOMMatrixReadOnly(style.transform);
        return matrix.m42;
    };

    const currentY = getTranslateY();
    const screenH = window.innerHeight;

    // Thresholds
    const TRIGGER_VELOCITY = 0.3;
    const HALF_SHEET_Y = screenH * 0.52; // Based on 48.3vh height (1 - 0.483)

    let targetState = 'half';

    // 1. Velocity Flick
    if (velocity > TRIGGER_VELOCITY) {
        if (delta > 0) {
            // Flipped Down
            targetState = currentY > HALF_SHEET_Y + 50 ? 'collapsed' : 'half';
        } else {
            // Flipped Up
            targetState = 'full';
        }
    } else {
        // 2. Position Check
        if (currentY < screenH * 0.15) targetState = 'full';
        else if (currentY > screenH * 0.85) targetState = 'collapsed';
        else targetState = 'half';
    }

    setSheetState(panel, targetState);
    panel.style.transform = ''; // Clear inline transform
    // Note: --sheet-y and --sheet-hidden-h remain as set by setSheetState for the snap curve
};

export function setupPanelDrag(panelId) {
    const panel = document.getElementById(panelId);
    if (!panel) return;

    let startY = 0;
    let startTransformY = 0;
    let isDragging = false;
    let startTime = 0;

    // Helper to get current translate Y from computed style
    const getTranslateY = () => {
        const style = window.getComputedStyle(panel);
        // Transform is matrix(1, 0, 0, 1, 0, Y)
        const matrix = new DOMMatrixReadOnly(style.transform);
        return matrix.m42;
    };

    // Unified Start Handler (Mouse & Touch)
    const handleStart = (e) => {
        const target = e.target;

        if (target.closest('input, textarea, select, button, label, [contenteditable="true"]')) {
            return;
        }

        // Explicitly ignore Close Buttons and Icon Buttons
        if (target.closest('#close-panel') || target.closest('#close-route-info') || target.closest('#close-directions') || target.closest('.icon-btn')) {
            return;
        }

        // Allow Text Selection in Route Header (ignore drag start)
        if (target.closest('#route-info-text') || target.closest('#route-info-number')) {
            return; // Let browser handle selection
        }

        // Check if header or body
        const isHeader = target.closest('.panel-header') ||
            target.closest('#header-extension') ||
            target.closest('.drag-handle') ||
            panel.classList.contains('metro-mode');

        // Normalize coordinates
        const clientY = e.type.includes('mouse') ? e.clientY : e.touches[0].clientY;

        startY = clientY;
        startTime = Date.now();
        startTransformY = getTranslateY();

        // If Header, start dragging immediately
        if (isHeader) {
            isDragging = true;
            panel.style.transition = 'none';
            panel.classList.add('is-dragging');
            if (e.type.includes('mouse')) e.preventDefault(); // Prevent text selection
        } else {
            // If body, we MIGHT start dragging if they pull down at top
            isDragging = false;
        }
    };

    // Unified Move Handler
    const handleMove = (e) => {
        const clientY = e.type.includes('mouse') ? e.clientY : e.touches[0].clientY;
        const delta = clientY - startY;

        // If NOT yet dragging, check if we should switch to drag
        if (!isDragging) {
            const isPartial = panel.classList.contains('sheet-half') ||
                panel.classList.contains('sheet-peek') ||
                panel.classList.contains('sheet-collapsed');

            // 1. Pull Down at TOP -> Collapse
            if (delta > 0) {
                const scrollable = panel.querySelector('.panel-body');
                if (scrollable && scrollable.scrollTop <= 0) {
                    isDragging = true;
                }
            }
            // 2. Pull Up in Partial Mode -> Expand
            else if (delta < 0 && isPartial) {
                isDragging = true;
            }

            if (isDragging) {
                startTransformY = getTranslateY();
                startY = clientY;
                panel.style.transition = 'none';
                panel.classList.add('is-dragging');
                if (e.cancelable) e.preventDefault();
            }
        }

        if (isDragging) {
            if (e.cancelable) e.preventDefault();

            const currentDelta = clientY - startY;
            const newTransformY = startTransformY + currentDelta;
            const screenH = window.innerHeight;
            const panelH = panel.offsetHeight;
            const hiddenH = Math.max(0, (newTransformY + panelH) - screenH);

            panel.style.transform = `translateY(${newTransformY}px)`;
            panel.style.setProperty('--sheet-y', `${newTransformY}px`);
            panel.style.setProperty('--sheet-hidden-h', `${hiddenH}px`);
        }
    };

    // Unified End Handler
    const handleEnd = (e) => {
        if (!isDragging) return;

        isDragging = false;
        panel.classList.remove('is-dragging');
        panel.style.transition = '';

        // Get end Y
        let endY;
        if (e.type.includes('mouse')) {
            endY = e.clientY;
        } else {
            endY = e.changedTouches[0].clientY;
        }

        const delta = endY - startY;
        const time = Date.now() - startTime;
        const velocity = Math.abs(delta / time);

        // Snap Logic
        snapSheet(panel, delta, velocity);
    };

    // Touch Listeners
    panel.addEventListener('touchstart', handleStart, { passive: true });
    panel.addEventListener('touchmove', handleMove, { passive: false });
    panel.addEventListener('touchend', handleEnd);
    panel.addEventListener('touchcancel', () => {
        // Android system gestures (notification shade, app switcher, etc.)
        // can cancel a touch mid-drag. Clean up so a stale inline transform
        // doesn't persist and break panel positioning on the next open.
        if (!isDragging) return;
        isDragging = false;
        panel.classList.remove('is-dragging');
        panel.style.transition = '';
        // Snap to the nearest valid state instead of leaving the panel mid-drag.
        snapSheet(panel, 0, 0);
    });

    // Mouse Listeners
    panel.addEventListener('mousedown', handleStart);
    window.addEventListener('mousemove', (e) => {
        if (isDragging) handleMove(e);
    });
    window.addEventListener('mouseup', handleEnd);

    // Wheel Logic (Desktop)
    let wheelTimeout;
    let isScrollingContent = false;
    let scrollEndTimeout;

    panel.addEventListener('wheel', (e) => {
        const currentClass = panel.classList.contains('sheet-full') ? 'full' :
            panel.classList.contains('sheet-half') ? 'half' :
                panel.classList.contains('sheet-collapsed') ? 'collapsed' : 'half';

        // Reset scroll end detection
        clearTimeout(scrollEndTimeout);
        scrollEndTimeout = setTimeout(() => {
            isScrollingContent = false;
        }, 60);

        // Threshold to prevent accidental jitters
        if (Math.abs(e.deltaY) < 5) return;

        if (currentClass === 'collapsed') {
            if (e.deltaY > 0) { // Scroll Down (pull up) -> Expand
                e.preventDefault();
                setSheetState(panel, 'half');
            }
        } else if (currentClass === 'half') {
            if (e.deltaY > 0) { // Scroll Down -> Full
                e.preventDefault();
                setSheetState(panel, 'full');
            } else if (e.deltaY < 0) { // Scroll Up -> Collapse
                e.preventDefault();
                setSheetState(panel, 'collapsed');
            }
        } else if (currentClass === 'full') {
            const scrollable = panel.querySelector('.panel-body');

            // Check usage
            if (scrollable && scrollable.scrollTop > 0) {
                isScrollingContent = true;
                return;
            }

            // If we are here, we are at TOP (or no scrollable).
            if (e.deltaY < 0 && (scrollable && scrollable.scrollTop <= 0)) {

                if (isScrollingContent) {
                    return;
                }

                e.preventDefault();

                // FLUID DRAG LOGIC
                panel.style.transition = 'none';

                const currentY = getTranslateY();
                const newY = currentY - e.deltaY;
                panel.style.transform = `translateY(${newY}px)`;

                // Debounce Snap
                clearTimeout(wheelTimeout);
                wheelTimeout = setTimeout(() => {
                    panel.style.transition = '';
                    snapSheet(panel, 0, 0);
                }, 150);
            }
        }
    }, { passive: false });
}
