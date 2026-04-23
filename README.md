# Tbilisi Transit

See live buses and schedules for all bus routes

**[Open the web app](https://veaveberg.github.io/tbilisi-trans/)**

**[Privacy Policy](https://veaveberg.github.io/tbilisi-trans/privacy-policy)**

## Cloudflare Worker Proxy

This repo includes a simple proxy Worker in `cloudflare-worker.js` (CORS-enabled) that forwards:
- `/pis-gateway/*` -> `https://transit.ttc.com.ge/pis-gateway/*`
- `/rustavi-proxy/*` -> `https://rustavi-transit.azrycloud.com/*`

Deploy it with Wrangler:
```bash
npx wrangler@latest login
npx wrangler@latest deploy
```

Then set the GitHub Actions variable `VITE_API_BASE_URL` to your Worker URL (for example `https://ttc-proxy.<you>.workers.dev`)
and re-run the "Deploy to GitHub Pages" workflow so the web app uses the Worker in production.


Built by Sasha Berg for Tbilisi commuters **[Instagram](https://www.instagram.com/samshabrg)**
