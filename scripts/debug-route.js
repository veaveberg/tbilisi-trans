


const ROUTE_ID = '1:R29981'; // Bus 301
const API_BASE = 'https://transit.ttc.com.ge/pis-gateway/api/v3';
const HEADERS = {
    'x-api-key': 'c0a2f304-551a-4d08-b8df-2c53ecd57f9f',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
};

async function run() {
    console.log(`Fetching details for ${ROUTE_ID}...`);
    const detailsUrl = `${API_BASE}/routes/${ROUTE_ID}`;
    const res = await fetch(detailsUrl, { headers: HEADERS });
    if (!res.ok) {
        console.log(`Failed to fetch details: ${res.status} ${res.statusText}`);
        console.log(await res.text());
        return;
    }
    const details = await res.json();
    console.log('Details fetched.');

    if (details.patterns && details.patterns.length > 0) {
        console.log(`Found ${details.patterns.length} patterns.`);
        const suffixes = details.patterns.map(p => p.patternSuffix).join(',');
        console.log(`Suffixes: ${suffixes}`);

        const patUrl = `${API_BASE}/routes/${ROUTE_ID}/stops-of-patterns?patternSuffixes=${suffixes}&locale=en`;
        console.log(`Fetching patterns: ${patUrl}`);

        const patRes = await fetch(patUrl, { headers: HEADERS });
        if (!patRes.ok) {
            console.log('Pattern fetch failed:', patRes.status, patRes.statusText);
            return;
        }

        const patData = await patRes.json();
        console.log('Pattern Data Type:', Array.isArray(patData) ? 'Array' : typeof patData);
        console.log('Keys:', Object.keys(patData));

        if (Array.isArray(patData)) {
            console.log('First Item keys:', Object.keys(patData[0]));
            if (patData[0].stops) console.log(`Stops found in first pattern: ${patData[0].stops.length}`);
            else console.log('No "stops" key in array item.');
        } else if (patData.patterns) {
            console.log('Found "patterns" key.');
        } else {
            console.log('Unknown structure.');
        }

        console.log('Full First Item:', JSON.stringify(Array.isArray(patData) ? patData[0] : patData, null, 2).substring(0, 500));
    } else {
        console.log('No patterns in details.');
    }
}

run();
