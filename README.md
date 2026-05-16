# Tbilisi Trans

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

## Custom Domain via Cloudflare

If you want the app to also live at `https://tbilisi-trans.samshabrg.org/`, keep GitHub Pages as the build origin and put a Cloudflare Worker in front of that subdomain.

This repo includes `cloudflare-site-proxy.js` plus `wrangler.site.toml` for that setup.

Deploy it with:
```bash
npx wrangler@latest deploy --config wrangler.site.toml
```

Then in GitHub:
- Set the GitHub Actions variable `VITE_PUBLIC_WEB_BASE_URL` to `https://tbilisi-trans.samshabrg.org/` so native share links point at the custom domain

The worker keeps the URL on `tbilisi-trans.samshabrg.org` while fetching the built app from `https://veaveberg.github.io/tbilisi-trans/`.


Built by Sasha Berg for Tbilisi commuters **[Instagram](https://www.instagram.com/samshabrg)**
