import { defineConfig } from 'vite';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { VitePWA } from 'vite-plugin-pwa';
import basicSsl from '@vitejs/plugin-basic-ssl';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('Loading vite.config.js...'); // Top-level debug

const saveStopsPlugin = () => ({
    name: 'save-stops-middleware',
    configureServer(server) {
        console.log('Configuring Stop Config Save Middleware via Plugin...');
        server.middlewares.use('/api/save-stops-config', (req, res, next) => {
            console.log('[Middleware] Received request:', req.method, req.url);
            if (req.method === 'POST') {
                let body = '';
                req.on('data', chunk => body += chunk);
                req.on('end', () => {
                    try {
                        // Ensure valid JSON
                        JSON.parse(body);
                        // Save to Source (for Git)
                        const srcPath = path.resolve(__dirname, 'src/data/stops_config.json');
                        console.log('[Middleware] Saving to Src:', srcPath);
                        fs.writeFileSync(srcPath, body);

                        // Save to Public (for Immediate Serving)
                        const publicPath = path.resolve(__dirname, 'public/data/stops_config.json');
                        console.log('[Middleware] Saving to Public:', publicPath);
                        fs.writeFileSync(publicPath, body);

                        res.statusCode = 200;
                        res.end('Saved');
                    } catch (e) {
                        console.error('[Middleware] Failed to save stops config:', e);
                        res.statusCode = 500;
                        res.end('Error: ' + e.message);
                    }
                });
            } else {
                next();
            }
        });

        server.middlewares.use('/api/save-routes-config', (req, res, next) => {
            console.log('[Middleware] Received request:', req.method, req.url);
            if (req.method === 'POST') {
                let body = '';
                req.on('data', chunk => body += chunk);
                req.on('end', () => {
                    try {
                        // Ensure valid JSON
                        JSON.parse(body);
                        // Save to Source (for Git)
                        const srcPath = path.resolve(__dirname, 'src/data/routes_config.json');
                        console.log('[Middleware] Saving to Src:', srcPath);
                        fs.writeFileSync(srcPath, body);

                        // Save to Public (for Immediate Serving)
                        const publicPath = path.resolve(__dirname, 'public/data/routes_config.json');
                        console.log('[Middleware] Saving to Public:', publicPath);
                        fs.writeFileSync(publicPath, body);

                        res.statusCode = 200;
                        res.end('Saved');
                    } catch (e) {
                        console.error('[Middleware] Failed to save routes config:', e);
                        res.statusCode = 500;
                        res.end('Error: ' + e.message);
                    }
                });
            } else {
                next();
            }
        });
    }
});

// detect mkcert files
const hasCert = fs.existsSync('./localhost+3.pem') && fs.existsSync('./localhost+3-key.pem');

export default defineConfig({
    plugins: [
        hasCert ? null : basicSsl(),
        saveStopsPlugin(),
        VitePWA({
            registerType: 'autoUpdate',
            includeAssets: ['favicon.ico', 'apple-touch-icon.png', 'mask-icon.svg', 'data/*.json'], // Include fallback data!
            workbox: {
                maximumFileSizeToCacheInBytes: 20 * 1024 * 1024, // 20MB (Fix size limit error)
                globPatterns: ['**/*.{js,css,html,ico,png,svg,json}'], // Cache everything
                runtimeCaching: [
                    {
                        urlPattern: ({ url }) => url.pathname.startsWith('/pis-gateway/api/'),
                        handler: 'StaleWhileRevalidate',
                        options: {
                            cacheName: 'api-cache-v2',
                            expiration: {
                                maxEntries: 100,
                                maxAgeSeconds: 60 * 60 * 24 * 30 // 30 Days
                            },
                            cacheableResponse: {
                                statuses: [0, 200]
                            }
                        }
                    }
                ]
            },
            manifest: {
                name: 'Tbilisi Transit',
                short_name: 'TTC',
                description: 'Real-time Tbilisi Transport',
                theme_color: '#ffffff',
                icons: [
                    {
                        src: 'pwa-192x192.png',
                        sizes: '192x192',
                        type: 'image/png'
                    },
                    {
                        src: 'pwa-512x512.png',
                        sizes: '512x512',
                        type: 'image/png'
                    }
                ]
            }
        })
    ],
    base: '/tbilisi-trans/', // For GitHub Pages
    server: {
        watch: {
            // Prevent full reload when saving stops config
            ignored: ['**/stops_config.json', '**/src/data/stops_config.json', '**/routes_config.json', '**/src/data/routes_config.json']
        },
        host: true, // Allow LAN access
        https: hasCert ? {
            key: fs.readFileSync('./localhost+3-key.pem'),
            cert: fs.readFileSync('./localhost+3.pem'),
        } : true,
        proxy: {
            '/pis-gateway': {
                target: 'https://transit.ttc.com.ge',
                changeOrigin: true,
                secure: false, // Accept self-signed or picky certs if needed
                headers: {
                    'Referer': 'https://transit.ttc.com.ge/',
                    'Origin': 'https://transit.ttc.com.ge'
                },
                configure: (proxy, _options) => {
                    proxy.on('error', (err, _req, _res) => {
                        console.log('proxy error', err);
                    });
                    proxy.on('proxyReq', (proxyReq, req, _res) => {
                        console.log('Sending Request to the Target:', req.method, req.url);
                    });
                    proxy.on('proxyRes', (proxyRes, req, _res) => {
                        console.log('Received Response from the Target:', proxyRes.statusCode, req.url);
                    });
                }
            },
            '/rustavi-proxy': {
                target: 'https://rustavi-transit.azrycloud.com',
                changeOrigin: true,
                secure: false,
                rewrite: (path) => path.replace(/^\/rustavi-proxy/, ''),
                headers: {
                    'Referer': 'https://rustavi-transit.azrycloud.com/',
                    'Origin': 'https://rustavi-transit.azrycloud.com'
                }
            }
        }
    }
});
