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

        const newRequest = new Request(targetUrl, {
            method: request.method,
            headers: request.headers,
            body: request.body
        });

        // Add required headers for the target API
        newRequest.headers.set('Referer', targetBase + '/');
        newRequest.headers.set('Origin', targetBase);

        // Ensure we don't send host header of the worker
        newRequest.headers.delete('Host');

        try {
            const response = await fetch(newRequest);

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
