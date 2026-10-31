// Compare alignment without treating differently sampled versions of the same
// road as reroutes. Rendered coordinates always remain the original vertices.
export const GEOMETRY_TOLERANCE_METERS = 8;
export function changedPathSections(before, after) {
    const all = [...before, ...after].flat();
    if (!all.length) return { added: [], removed: [] };
    const latitude = all.reduce((sum, point) => sum + point[1], 0) / all.length;
    const scaleX = 111320 * Math.cos(latitude * Math.PI / 180), scaleY = 111320;
    const project = point => [point[0] * scaleX, point[1] * scaleY];
    const distanceSquared = (point, a, b) => {
        const dx = b[0] - a[0], dy = b[1] - a[1];
        const t = dx || dy ? Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / (dx * dx + dy * dy))) : 0;
        return (point[0] - a[0] - t * dx) ** 2 + (point[1] - a[1] - t * dy) ** 2;
    };
    function index(paths) {
        const cells = new Map(), longSegments = [], cellSize = 200, tolerance = GEOMETRY_TOLERANCE_METERS;
        for (const path of paths) for (let i = 1; i < path.length; i++) {
            const a = project(path[i - 1]), b = project(path[i]);
            const x1 = Math.floor((Math.min(a[0], b[0]) - tolerance) / cellSize), x2 = Math.floor((Math.max(a[0], b[0]) + tolerance) / cellSize);
            const y1 = Math.floor((Math.min(a[1], b[1]) - tolerance) / cellSize), y2 = Math.floor((Math.max(a[1], b[1]) + tolerance) / cellSize);
            if ((x2 - x1 + 1) * (y2 - y1 + 1) > 2500) { longSegments.push([a, b]); continue; }
            for (let x = x1; x <= x2; x++) for (let y = y1; y <= y2; y++) {
                const key = `${x},${y}`;
                if (!cells.has(key)) cells.set(key, []);
                cells.get(key).push([a, b]);
            }
        }
        return point => [...(cells.get(`${Math.floor(point[0] / cellSize)},${Math.floor(point[1] / cellSize)}`) || []), ...longSegments].some(([a, b]) => distanceSquared(point, a, b) <= tolerance * tolerance);
    }
    function difference(paths, otherPaths) {
        const covered = index(otherPaths), result = [];
        for (const path of paths) {
            let section = [];
            for (let i = 1; i < path.length; i++) {
                const a = project(path[i - 1]), b = project(path[i]);
                const same = [0, 0.25, 0.5, 0.75, 1].every(t => covered([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]));
                if (!same) { if (!section.length) section.push(path[i - 1]); section.push(path[i]); }
                else if (section.length) { result.push(section); section = []; }
            }
            if (section.length) result.push(section);
        }
        return result;
    }
    return { added: difference(after, before), removed: difference(before, after) };
}
