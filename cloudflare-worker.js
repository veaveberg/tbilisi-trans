
export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        // Forward the path exactly as is.
        // Example: request to worker.dev/pis-gateway/api/v2/stops 
        // -> https://transit.ttc.com.ge/pis-gateway/api/v2/stops
        const targetUrl = 'https://transit.ttc.com.ge' + url.pathname + url.search;

        const newRequest = new Request(targetUrl, {
            method: request.method,
            headers: request.headers,
            body: request.body
        });

        // Add required headers for TTC API
        newRequest.headers.set('Referer', 'https://transit.ttc.com.ge/');
        newRequest.headers.set('Origin', 'https://transit.ttc.com.ge');

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
