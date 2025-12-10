export const RouteFilterColorManager = {
    palette: [
        '#5BB042', // green
        '#97544C', // brown
        '#C78FBF', // violet
        '#0083C8', // blue
        '#EF3F47', // red
        '#FFCB05', // yellow
        '#00C1F3', // light blue
        '#ADCD3F', // lime
        '#F58620', // orange
        '#EE4C9B', // magenta
        '#A1A2A3', // grey
        '#09B096', // mint
        '#8F489C', // purple
        '#FBA919'  // physalis
    ],
    pathColors: new Map(), // signature -> color
    routeColors: new Map(), // routeId -> color
    colorQueue: [],
    queueIndex: 0,

    reset() {
        console.log('[ColorManager] RESET triggered.');
        this.pathColors.clear();
        this.routeColors.clear();
        this.colorQueue = this.shuffle([...this.palette]);
        this.queueIndex = 0;
    },

    // Fisher-Yates Shuffle
    shuffle(array) {
        for (let i = array.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [array[i], array[j]] = [array[j], array[i]];
        }
        return array;
    },

    // Peek at the next color for Hover
    getNextColor() {
        if (this.colorQueue.length === 0) this.reset();
        return this.colorQueue[this.queueIndex % this.colorQueue.length];
    },

    // Consume next color for Selection
    assignNextColor(signature, routeIds) {
        // If already assigned, return existing
        if (this.pathColors.has(signature)) {
            const existing = this.pathColors.get(signature);
            routeIds.forEach(rid => this.routeColors.set(rid, existing));
            return existing;
        }

        const color = this.getNextColor(); // Get current peek color
        console.log(`[ColorManager] Assigning NEW color ${color} to signature ${signature}. Path Queue Index: ${this.queueIndex} -> ${(this.queueIndex + 1) % this.colorQueue.length}`);
        this.pathColors.set(signature, color);
        routeIds.forEach(rid => this.routeColors.set(rid, color));

        // Advance Pointer
        this.queueIndex = (this.queueIndex + 1) % this.colorQueue.length;

        return color;
    },

    // Legacy method mostly replaced by assignNextColor, but kept for compatibility if needed
    assignColorForPath(signature, routeIds) {
        return this.assignNextColor(signature, routeIds);
    },

    getColorForRoute(routeId) {
        return this.routeColors.get(routeId);
    }
};
