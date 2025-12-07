# Tbilisi Transit Web App

This is a modern web application for tracking Tbilisi buses, rebuilt to be hosted on GitHub Pages.

## Features
- Interactive Map (Mapbox GL JS)
- Live Bus Stops
- Real-time Arrival Times
- Modern, responsive UI

## Local Development

1. Install dependencies:
   ```bash
   npm install
   ```

2. Start the development server:
   ```bash
   npm run dev
   ```

3. Open http://localhost:5173

## Deployment to GitHub Pages

Because the TTC API does not support direct requests from GitHub Pages (CORS issues), you need a proxy.

### Step 1: Deploy the Proxy
1. Sign up for [Cloudflare Workers](https://workers.cloudflare.com/) (Free).
2. Create a new Worker.
3. Copy the content of `cloudflare-worker.js` into the worker script.
4. Deploy the worker and copy its URL (e.g., `https://ttc-proxy.yourname.workers.dev`).

### Step 2: Configure the App
1. Open `src/main.js`.
2. Find `API_BASE_URL`.
3. Replace `'https://YOUR_WORKER_URL.workers.dev/api/v2'` with your actual Worker URL (keep the `/api/v2` suffix if your worker logic requires it, but the provided worker handles the path mapping, so usually just `https://ttc-proxy.yourname.workers.dev` if the worker maps root to root, but check the worker script logic).
   * Note: The provided `cloudflare-worker.js` maps the request path. If you request `WORKER_URL/api/v2/stops`, it forwards to `TTC_URL/api/v2/stops`. So set `API_BASE_URL` to `https://your-worker.workers.dev/api/v2`.

### Step 3: Build and Deploy
1. Run build:
   ```bash
   npm run build
   ```
2. Deploy the `dist` folder to GitHub Pages.
   * You can use `gh-pages` package or manual upload.
