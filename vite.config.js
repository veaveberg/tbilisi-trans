import { defineConfig } from 'vite';

export default defineConfig({
    base: './', // For GitHub Pages
    server: {
        host: true, // Allow LAN access
        proxy: {
            '/pis-gateway': {
                target: 'https://transit.ttc.com.ge',
                changeOrigin: true,
                headers: {
                    'Referer': 'https://transit.ttc.com.ge/',
                    'Origin': 'https://transit.ttc.com.ge'
                }
            }
        }
    }
});
