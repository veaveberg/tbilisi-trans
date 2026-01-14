import express from 'express';

const app = express();
const PORT = process.env.PORT || 3000;

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
    try {
        let targetBase = 'https://transit.ttc.com.ge';
        let targetPath = req.originalUrl;

        // Routing Logic for Rustavi
        if (req.originalUrl.startsWith('/rustavi-proxy')) {
            targetBase = 'https://rustavi-transit.azrycloud.com';
            targetPath = req.originalUrl.replace('/rustavi-proxy', '');
        }

        const targetUrl = targetBase + targetPath;
        console.log(`[Proxy] ${req.method} ${targetUrl}`);

        const headers = {
            'Accept': 'application/json, text/plain, */*',
            'Accept-Language': 'en-US,en;q=0.9',
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Referer': targetBase + '/',
            'Origin': targetBase,
            'x-api-key': 'c0a2f304-551a-4d08-b8df-2c53ecd57f9f',
        };

        const response = await fetch(targetUrl, {
            method: req.method,
            headers: headers,
        });

        const contentType = response.headers.get('content-type') || 'application/json';
        const data = await response.text();

        res.status(response.status);
        res.set('Content-Type', contentType);
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
