# Pi Proxy Setup

## Quick Start (on Pi)

```bash
# 1. Copy this folder to your Pi
scp -r pi-proxy pi@<pi-ip>:~/

# 2. SSH into Pi
ssh pi@<pi-ip>

# 3. Install dependencies
cd pi-proxy
npm install

# 4. Test locally
npm start
# In another terminal: curl http://localhost:3000/health

# 5. Install cloudflared
curl -L --output cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm.deb
sudo dpkg -i cloudflared.deb

# 6. Quick tunnel (for testing)
cloudflared tunnel --url http://localhost:3000

# 7. For permanent setup, create a named tunnel
cloudflared tunnel login
cloudflared tunnel create ttc-proxy
cloudflared tunnel route dns ttc-proxy ttc-api.yourdomain.com
cloudflared tunnel run ttc-proxy
```

## PM2 for Auto-restart

```bash
npm install -g pm2
pm2 start server.js --name ttc-proxy
pm2 save
pm2 startup
```
