export default {
    async fetch(request, env) {
        // Handle CORS Preflight requests directly
        if (request.method === 'OPTIONS') {
            return new Response(null, {
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
                    'Access-Control-Allow-Headers': 'Content-Type, x-api-key',
                    'Access-Control-Max-Age': '86400',
                },
            });
        }

        const url = new URL(request.url);
        let targetBase = 'https://transit.ttc.com.ge';
        let targetPath = url.pathname;
        const targetSearch = url.search;

        // Routing Logic
        if (url.pathname.startsWith('/rustavi-proxy')) {
            targetBase = 'https://rustavi-transit.azrycloud.com';
            targetPath = url.pathname.replace('/rustavi-proxy', '');
        }

        const targetUrl = targetBase + targetPath + targetSearch;

        // Create fresh headers - minimal set that should work
        const browserHeaders = new Headers({
            'Accept': 'application/json, text/plain, */*',
            'Accept-Language': 'en-US,en;q=0.9',
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Referer': targetBase + '/',
            'Origin': targetBase,
            'x-api-key': 'c0a2f304-551a-4d08-b8df-2c53ecd57f9f',
        });

        try {
            const response = await fetch(targetUrl, {
                method: request.method,
                headers: browserHeaders,
                body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : undefined,
            });

            // Recreate response to allow CORS
            const newResponse = new Response(response.body, response);
            newResponse.headers.set('Access-Control-Allow-Origin', '*');
            newResponse.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
            newResponse.headers.set('Access-Control-Allow-Headers', 'Content-Type, x-api-key');

            return newResponse;
        } catch (e) {
            return new Response('Proxy Error: ' + e.message, { status: 500 });
        }
    }
}
