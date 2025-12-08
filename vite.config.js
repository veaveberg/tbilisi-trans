import { defineConfig } from 'vite';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

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
                        const filePath = path.resolve(__dirname, 'src/data/stops_config.json');
                        console.log('[Middleware] Saving to:', filePath);
                        fs.writeFileSync(filePath, body);
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
    }
});

export default defineConfig({
    plugins: [saveStopsPlugin()],
    base: './', // For GitHub Pages
    server: {
        watch: {
            // Prevent full reload when saving stops config
            ignored: ['**/src/data/stops_config.json']
        },
        host: true, // Allow LAN access
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
            }
        }
    }
});
