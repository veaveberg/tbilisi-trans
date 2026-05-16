const UPSTREAM_ORIGIN = 'https://veaveberg.github.io';
const UPSTREAM_BASE = '/tbilisi-trans';
const STATIC_EXT_RE = /\.[a-z0-9]+$/i;

function isHtmlNavigation(request) {
    const accept = request.headers.get('accept') || '';
    return request.method === 'GET' && accept.includes('text/html');
}

function buildUpstreamUrl(requestUrl, request) {
    const url = new URL(requestUrl);
    const path = url.pathname;
    const subpath = path === '/' ? '/' : path;
    const isStaticAsset = STATIC_EXT_RE.test(subpath);
    const isDirectoryPage = subpath === '/' || subpath.startsWith('/privacy-policy') || subpath.startsWith('/support');

    if (isHtmlNavigation(request) && !isStaticAsset && !isDirectoryPage) {
        return `${UPSTREAM_ORIGIN}${UPSTREAM_BASE}/index.html`;
    }

    const upstreamPath = subpath === '/' ? `${UPSTREAM_BASE}/` : `${UPSTREAM_BASE}${subpath}`;
    return `${UPSTREAM_ORIGIN}${upstreamPath}${url.search}`;
}

export default {
    async fetch(request) {
        const upstreamUrl = buildUpstreamUrl(request.url, request);
        if (!upstreamUrl) {
            return new Response('Not found', { status: 404 });
        }

        const upstreamResponse = await fetch(upstreamUrl, {
            method: request.method,
            headers: request.headers,
            body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
            redirect: 'follow'
        });

        const response = new Response(upstreamResponse.body, upstreamResponse);
        response.headers.set('Cache-Control', isHtmlNavigation(request)
            ? 'no-cache'
            : (upstreamResponse.headers.get('Cache-Control') || 'public, max-age=300'));
        return response;
    }
};
