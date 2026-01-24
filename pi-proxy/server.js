import express from 'express';

const app = express();
const PORT = process.env.PORT || 3000;

// In-memory cache for GET requests
const cache = new Map();

/**
 * Get TTL based on URL pattern
 */
function getTTL(url) {
    if (url.includes('/arrival-times')) return 15000; // 15 seconds for live arrivals
    if (url.includes('/schedule')) return 300000;      // 5 minutes for schedules
    if (url.includes('/positions')) return 5000;       // 5 seconds for live bus positions
    if (url.includes('/polylines') || url.includes('/stops-of-patterns')) return 3600000; // 1 hour for structural data
    return 60000; // 1 minute default for others
}

// CORS middleware
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, x-api-key');

    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Proxy handler
app.use('*', async (req, res) => {
    const start = Date.now();
    const url = req.originalUrl;

    try {
        let targetBase = 'https://transit.ttc.com.ge';
        let targetPath = url;

        // Routing Logic for Rustavi
        if (url.startsWith('/rustavi-proxy')) {
            targetBase = 'https://rustavi-transit.azrycloud.com';
            targetPath = url.replace('/rustavi-proxy', '');
        }

        const targetUrl = targetBase + targetPath;
        const ttl = getTTL(url);

        // Cache Check (only for GET)
        if (req.method === 'GET' && cache.has(targetUrl)) {
            const entry = cache.get(targetUrl);
            if (Date.now() - entry.timestamp < entry.ttl) {
                const duration = Date.now() - start;
                console.log(`[Proxy] CACHE HIT ${req.method} ${targetUrl} (${duration}ms)`);
                res.status(entry.status);
                res.set('Content-Type', entry.contentType);
                res.set('X-Proxy-Cache', 'HIT');
                res.set('X-Proxy-TTL', entry.ttl);
                return res.send(entry.data);
            }
            cache.delete(targetUrl);
        }

        const headers = {
            'Accept': 'application/json, text/plain, */*',
            'Accept-Language': 'en-US,en;q=0.9',
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Referer': targetBase + '/',
            'Origin': targetBase,
            'x-api-key': 'c0a2f304-551a-4d08-b8df-2c53ecd57f9f',
        };

        const fetchStart = Date.now();
        const response = await fetch(targetUrl, {
            method: req.method,
            headers: headers,
        });
        const fetchDuration = Date.now() - fetchStart;

        const contentType = response.headers.get('content-type') || 'application/json';
        const data = await response.text();
        const totalDuration = Date.now() - start;

        console.log(`[Proxy] ${req.method} ${targetUrl} | Status: ${response.status} | TTC: ${fetchDuration}ms | Total: ${totalDuration}ms`);

        // Cache the result if successful
        if (req.method === 'GET' && response.status === 200) {
            cache.set(targetUrl, {
                timestamp: Date.now(),
                ttl: ttl,
                data: data,
                status: response.status,
                contentType: contentType
            });
        }

        res.status(response.status);
        res.set('Content-Type', contentType);
        res.set('X-Proxy-Cache', 'MISS');
        res.set('X-Proxy-TTC-Time', `${fetchDuration}ms`);
        res.send(data);
    } catch (error) {
        console.error('[Proxy] Error:', error.message);
        res.status(500).json({ error: 'Proxy error', message: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`[Proxy] Server running on port ${PORT}`);
    console.log(`[Proxy] Health check: http://localhost:${PORT}/health`);
});

