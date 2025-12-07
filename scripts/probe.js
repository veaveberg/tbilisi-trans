
// Native fetch is available in Node 18+

const API_BASE_URL = 'https://transit.ttc.com.ge/pis-gateway/api/v2';
const API_KEY = 'c0a2f304-551a-4d08-b8df-2c53ecd57f9f';

async function fetchWithRetry(url) {
    try {
        console.log(`Fetching ${url}...`);
        const response = await fetch(url, { headers: { 'x-api-key': API_KEY } });
        if (!response.ok) {
            console.log(`Failed: ${response.status} ${response.statusText}`);
            return null;
        }
        return await response.json();
    } catch (e) {
        console.log(`Error: ${e.message}`);
        return null;
    }
}

async function main() {
    const routes = await fetchWithRetry(`${API_BASE_URL}/routes`);
    if (!routes || routes.length === 0) return;

    const route = routes[0];
    console.log(`Probing for route: ${route.id} (${route.shortName})`);

    // 1. Detail
    const detail = await fetchWithRetry(`${API_BASE_URL}/routes/${route.id}`);
    if (detail) {
        console.log('Detail keys:', Object.keys(detail));
        if (detail.stops) console.log('Detail has stops:', detail.stops.length);
    }

    // 2. Stops sub-resource
    const stops = await fetchWithRetry(`${API_BASE_URL}/routes/${route.id}/stops`);
    if (stops) {
        console.log('Stops endpoint returned:', Array.isArray(stops) ? `Array(${stops.length})` : Object.keys(stops));
        if (Array.isArray(stops) && stops.length > 0) console.log('First stop:', stops[0]);
    }

    // 3. V3 Schedule?
    // ...
}

main();
