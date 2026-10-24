export function retention(deltaSeconds, halfLifeMs) {
    return halfLifeMs <= 0 ? 0 : Math.pow(0.5, deltaSeconds * 1000 / halfLifeMs);
}
