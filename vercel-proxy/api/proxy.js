// Regular Node.js serverless function (not Edge)
// May have different IP ranges that aren't blocked

export default async function handler(req, res) {
    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
        res.setHeader('Access-Control-Max-Age', '86400');
        return res.status(200).end();
    }

    const url = new URL(req.url, `https://${req.headers.host}`);

    let targetBase = 'https://transit.ttc.com.ge';
    let targetPath = url.pathname;

    // Routing Logic
    if (url.pathname.startsWith('/rustavi-proxy')) {
        targetBase = 'https://rustavi-transit.azrycloud.com';
        targetPath = url.pathname.replace('/rustavi-proxy', '');
    }

    const targetUrl = targetBase + targetPath + url.search;

    try {
        const response = await fetch(targetUrl, {
            method: req.method,
            headers: {
                'Accept': 'application/json, text/plain, */*',
                'Accept-Language': 'en-US,en;q=0.9',
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Referer': targetBase + '/',
                'Origin': targetBase,
                'x-api-key': 'c0a2f304-551a-4d08-b8df-2c53ecd57f9f',
            },
        });

        const data = await response.text();

        // Set CORS headers
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
        res.setHeader('Content-Type', response.headers.get('content-type') || 'application/json');

        return res.status(response.status).send(data);
    } catch (e) {
        return res.status(500).send('Proxy Error: ' + e.message);
    }
}
