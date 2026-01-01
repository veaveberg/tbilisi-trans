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

        // Backup helper function
        const createBackup = (filePath, maxBackups = 10) => {
            if (!fs.existsSync(filePath)) return;

            const dir = path.dirname(filePath);
            const backupDir = path.join(dir, 'backups');
            const basename = path.basename(filePath, '.csv');

            // Create backup directory if it doesn't exist
            if (!fs.existsSync(backupDir)) {
                fs.mkdirSync(backupDir, { recursive: true });
            }

            // Create timestamped backup
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            const backupPath = path.join(backupDir, `${basename}_${timestamp}.csv`);
            fs.copyFileSync(filePath, backupPath);
            console.log(`[Backup] Created: ${path.basename(backupPath)}`);

            // Clean up old backups (keep only the last N)
            const backups = fs.readdirSync(backupDir)
                .filter(f => f.startsWith(basename) && f.endsWith('.csv'))
                .sort()
                .reverse();

            if (backups.length > maxBackups) {
                backups.slice(maxBackups).forEach(oldBackup => {
                    fs.unlinkSync(path.join(backupDir, oldBackup));
                    console.log(`[Backup] Cleaned up old: ${oldBackup}`);
                });
            }
        };

        server.middlewares.use('/api/save-stops-config', async (req, res, next) => {
            console.log('[Middleware] Received request:', req.method, req.url);
            if (req.method === 'POST') {
                let body = '';
                req.on('data', chunk => body += chunk);
                req.on('end', async () => {
                    try {
                        // Parse incoming JSON (stopsConfig format)
                        const config = JSON.parse(body);

                        console.log('[Middleware] Received config with:');
                        console.log('  - Overrides:', Object.keys(config.overrides || {}).length);
                        console.log('  - Merges:', Object.keys(config.merges || {}).length);
                        console.log('  - Hubs:', Object.keys(config.hubs || {}).length);

                        // Detailed debug for overrides
                        const overrideKeys = Object.keys(config.overrides || {});
                        console.log('[Middleware] First 5 override keys:', overrideKeys.slice(0, 5));

                        if (overrideKeys.length > 0) {
                            const sampleKey = overrideKeys[0];
                            console.log(`[Middleware] Sample override details for ${sampleKey}:`, JSON.stringify(config.overrides[sampleKey], null, 2));
                        }


                        // Convert to CSV format (Grouped by Tbilisi then Rustavi with separators)
                        const { convertStopsConfigToCSV } = await import('./src/csv-converter.js');

                        const csvPath = path.resolve(__dirname, 'public/data/stops_overrides.csv');

                        // Create backup before saving
                        createBackup(csvPath);

                        const csvContent = await convertStopsConfigToCSV(config, csvPath);
                        fs.writeFileSync(csvPath, csvContent);

                        console.log('[Middleware] ✓ Save complete (public/data/stops_overrides.csv)');

                        res.statusCode = 200;
                        res.end('Saved');
                    } catch (e) {
                        console.error('[Middleware] Failed to save stops config:', e);
                        console.error('[Middleware] Stack:', e.stack);
                        res.statusCode = 500;
                        res.end('Error: ' + e.message);
                    }
                });
            } else {
                next();
            }
        });

        server.middlewares.use('/api/save-routes-config', async (req, res, next) => {
            console.log('[Middleware] Received request:', req.method, req.url);
            if (req.method === 'POST') {
                let body = '';
                req.on('data', chunk => body += chunk);
                req.on('end', async () => {
                    try {
                        // Parse incoming JSON (routesConfig format)
                        const config = JSON.parse(body);

                        // Convert to CSV format
                        const csvPath = path.resolve(__dirname, 'public/data/routes_overrides.csv');

                        // Create backup before saving
                        createBackup(csvPath);

                        const { convertRoutesConfigToCSV } = await import('./src/csv-converter.js');
                        const csvContent = await convertRoutesConfigToCSV(config, csvPath);

                        console.log('[Middleware] Saving routes CSV to data/');
                        fs.writeFileSync(csvPath, csvContent);

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
            // Ignore the JSON/CSV data files to avoid infinite reload loops when script updates them
            ignored: [
                '**/public/data/*.json',
                '**/public/data/stops_overrides_tbilisi.csv',
                '**/public/data/stops_overrides_rustavi.csv',
                '**/public/data/stops_overrides.csv',
                '**/public/data/routes_overrides.csv'
            ]
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
