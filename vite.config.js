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
            const ext = path.extname(filePath);
            const basename = path.basename(filePath, ext);

            // Create backup directory if it doesn't exist
            if (!fs.existsSync(backupDir)) {
                fs.mkdirSync(backupDir, { recursive: true });
            }

            // Create timestamped backup
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            const backupPath = path.join(backupDir, `${basename}_${timestamp}${ext}`);
            fs.copyFileSync(filePath, backupPath);
            console.log(`[Backup] Created: ${path.basename(backupPath)}`);

            // Clean up old backups (keep only the last N)
            const backups = fs.readdirSync(backupDir)
                .filter(f => f.startsWith(basename) && f.endsWith(ext))
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

        // Single route override update (for the edit panel)
        server.middlewares.use('/api/update-route-override', async (req, res, next) => {
            console.log('[Middleware] Received request:', req.method, req.url);
            if (req.method === 'POST') {
                let body = '';
                req.on('data', chunk => body += chunk);
                req.on('end', async () => {
                    try {
                        const { id, updates } = JSON.parse(body);

                        if (!id) {
                            res.statusCode = 400;
                            res.end('Missing route id');
                            return;
                        }

                        console.log(`[Middleware] Updating route ${id} with:`, updates);

                        const csvPath = path.resolve(__dirname, 'public/data/routes_overrides.csv');

                        // Create backup before saving
                        createBackup(csvPath);

                        // Read existing CSV
                        const content = fs.readFileSync(csvPath, 'utf8');
                        const lines = content.split('\n');
                        const header = lines[0];
                        const headerCols = header.split(',');

                        // Find column indices
                        const colIndices = {};
                        headerCols.forEach((col, idx) => {
                            colIndices[col] = idx;
                        });

                        // Parse CSV line
                        const parseCSVLine = (line) => {
                            const result = [];
                            let current = '';
                            let inQuotes = false;
                            for (let i = 0; i < line.length; i++) {
                                const char = line[i];
                                if (char === '"') {
                                    inQuotes = !inQuotes;
                                } else if (char === ',' && !inQuotes) {
                                    result.push(current);
                                    current = '';
                                } else {
                                    current += char;
                                }
                            }
                            result.push(current);
                            return result;
                        };

                        // Escape CSV field
                        const escapeCSV = (field) => {
                            const str = String(field || '');
                            if (str.includes(',') || str.includes('"') || str.includes('\n')) {
                                return `"${str.replace(/"/g, '""')}"`;
                            }
                            return str;
                        };

                        // Find and update the route row
                        let found = false;
                        for (let i = 1; i < lines.length; i++) {
                            if (!lines[i].trim()) continue;

                            const cols = parseCSVLine(lines[i]);
                            const routeId = cols[colIndices['id']];

                            if (routeId === id) {
                                found = true;

                                // Update each field from updates
                                for (const [field, value] of Object.entries(updates)) {
                                    const colIdx = colIndices[field];
                                    if (colIdx !== undefined) {
                                        // Ensure cols array is long enough
                                        while (cols.length <= colIdx) {
                                            cols.push('');
                                        }
                                        cols[colIdx] = value;
                                    } else {
                                        console.warn(`[Middleware] Unknown column: ${field}`);
                                    }
                                }

                                lines[i] = cols.map(escapeCSV).join(',');
                                console.log(`[Middleware] Updated row ${i} for route ${id}`);
                                break;
                            }
                        }

                        if (!found) {
                            res.statusCode = 404;
                            res.end(`Route ${id} not found in CSV`);
                            return;
                        }

                        // Write back
                        fs.writeFileSync(csvPath, lines.join('\n'));
                        console.log('[Middleware] ✓ Route override saved');

                        res.statusCode = 200;
                        res.end('Saved');
                    } catch (e) {
                        console.error('[Middleware] Failed to update route override:', e);
                        res.statusCode = 500;
                        res.end('Error: ' + e.message);
                    }
                });
            } else {
                next();
            }
        });

        // Metro Segments Save Middleware
        server.middlewares.use('/api/save-metro-segments', async (req, res, next) => {
            console.log('[Middleware] Received request:', req.method, req.url);
            if (req.method === 'POST') {
                let body = '';
                req.on('data', chunk => body += chunk);
                req.on('end', async () => {
                    try {
                        const segments = JSON.parse(body);
                        const segmentsPath = path.resolve(__dirname, 'public/data/metro_segments.json');

                        // Create backup before saving
                        createBackup(segmentsPath);

                        console.log(`[Middleware] Saving ${Object.keys(segments).length} metro segments to public/data/metro_segments.json`);
                        fs.writeFileSync(segmentsPath, JSON.stringify(segments, null, 2));

                        res.statusCode = 200;
                        res.end('Saved');
                    } catch (e) {
                        console.error('[Middleware] Failed to save metro segments:', e);
                        res.statusCode = 500;
                        res.end('Error: ' + e.message);
                    }
                });
            } else {
                next();
            }
        });

        // Metro Midpoints Save Middleware (intermediate bezier control points)
        server.middlewares.use('/api/save-metro-midpoints', async (req, res, next) => {
            console.log('[Middleware] Received request:', req.method, req.url);
            if (req.method === 'POST') {
                let body = '';
                req.on('data', chunk => body += chunk);
                req.on('end', async () => {
                    try {
                        const midpoints = JSON.parse(body);
                        const midpointsPath = path.resolve(__dirname, 'public/data/metro_midpoints.json');

                        // Create backup before saving
                        createBackup(midpointsPath);

                        console.log(`[Middleware] Saving ${Object.keys(midpoints).length} metro midpoint connections to public/data/metro_midpoints.json`);
                        fs.writeFileSync(midpointsPath, JSON.stringify(midpoints, null, 2));

                        res.statusCode = 200;
                        res.end('Saved');
                    } catch (e) {
                        console.error('[Middleware] Failed to save metro midpoints:', e);
                        res.statusCode = 500;
                        res.end('Error: ' + e.message);
                    }
                });
            } else {
                next();
            }
        });

        // Metro Exits Save Middleware
        server.middlewares.use('/api/save-metro-exits', async (req, res, next) => {
            console.log('[Middleware] Received request:', req.method, req.url);
            if (req.method === 'POST') {
                let body = '';
                req.on('data', chunk => body += chunk);
                req.on('end', async () => {
                    try {
                        const exits = JSON.parse(body);
                        const exitsPath = path.resolve(__dirname, 'public/data/metro_exits.json');

                        // Create backup before saving
                        createBackup(exitsPath);

                        console.log(`[Middleware] Saving metro exits to public/data/metro_exits.json`);
                        fs.writeFileSync(exitsPath, JSON.stringify(exits, null, 2));

                        res.statusCode = 200;
                        res.end('Saved');
                    } catch (e) {
                        console.error('[Middleware] Failed to save metro exits:', e);
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
                // Force SW update + cleanup to evict old cached behavior
                skipWaiting: true,
                clientsClaim: true,
                cleanupOutdatedCaches: true,
                cacheId: 'ttc-pwa-2026-02-05',
                maximumFileSizeToCacheInBytes: 20 * 1024 * 1024, // 20MB (Fix size limit error)
                globPatterns: ['**/*.{js,css,html,ico,png,svg,json}'], // Cache everything
                runtimeCaching: [
                    {
                        // Real-time data: Network Only (do not cache)
                        urlPattern: ({ url }) =>
                            url.pathname.includes('/arrival-times') ||
                            url.pathname.includes('/positions'),
                        handler: 'NetworkOnly',
                        options: {
                            cacheName: 'api-realtime-v2',
                            expiration: {
                                maxEntries: 10,
                                maxAgeSeconds: 10 // Very short just in case
                            }
                        }
                    },
                    {
                        // Static/Structural API data: Cache aggressively
                        urlPattern: ({ url }) =>
                            url.pathname.startsWith('/pis-gateway/api/') &&
                            !url.pathname.includes('/arrival-times') &&
                            !url.pathname.includes('/positions'),
                        handler: 'StaleWhileRevalidate',
                        options: {
                            cacheName: 'api-static-v3',
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
    base: process.env.VITE_BASE_URL || '/tbilisi-trans/', // Defaults to GH Pages, override for Capacitor
    server: {
        watch: {
            // Ignore the JSON/CSV data files to avoid infinite reload loops when script updates them
            ignored: [
                '**/public/data/*.json',
                '**/public/data/stops_overrides_tbilisi.csv',
                '**/public/data/stops_overrides_rustavi.csv',
                '**/public/data/stops_overrides.csv',
                '**/public/data/routes_overrides.csv',
                '**/public/data/metro_midpoints.json',
                '**/public/data/metro_exits.json'
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
                    'Origin': 'https://transit.ttc.com.ge',
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'x-api-key': 'c0a2f304-551a-4d08-b8df-2c53ecd57f9f',
                    'Accept': 'application/json, text/plain, */*',
                    'Accept-Language': 'en-US,en;q=0.9',
                },
                xfwd: false, // Don't add X-Forwarded-* headers
                configure: (proxy, _options) => {
                    proxy.on('error', (err, _req, _res) => {
                        console.log('proxy error', err);
                    });
                    proxy.on('proxyReq', (proxyReq, req, _res) => {
                        // console.log('Sending Request to the Target:', req.method, req.url);
                        // Clean up headers that might trigger Cloudflare WAF
                        proxyReq.removeHeader('cookie');
                        proxyReq.removeHeader('sec-ch-ua');
                        proxyReq.removeHeader('sec-ch-ua-mobile');
                        proxyReq.removeHeader('sec-ch-ua-platform');
                    });
                    proxy.on('proxyRes', (proxyRes, req, _res) => {
                        if (proxyRes.statusCode !== 200) {
                            console.log(`[Proxy] Response: ${proxyRes.statusCode} ${proxyRes.statusMessage} for ${req.url}`);
                        }
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
                    'Origin': 'https://rustavi-transit.azrycloud.com',
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'x-api-key': 'c0a2f304-551a-4d08-b8df-2c53ecd57f9f',
                    'Accept': 'application/json, text/plain, */*',
                    'Accept-Language': 'en-US,en;q=0.9',
                },
                xfwd: false,
                configure: (proxy, _options) => {
                    proxy.on('proxyReq', (proxyReq, req, _res) => {
                        proxyReq.removeHeader('cookie');
                        proxyReq.removeHeader('sec-ch-ua');
                        proxyReq.removeHeader('sec-ch-ua-mobile');
                        proxyReq.removeHeader('sec-ch-ua-platform');
                    });
                }
            }
        }
    }
});
