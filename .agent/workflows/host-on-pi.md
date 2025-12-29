---
description: Hosting the dev build on a Raspberry Pi (e.g. via Tailscale)
---

# Hosting on Raspberry Pi Zero 2W

This guide explains how to set up the dev server on a Raspberry Pi so you can access it via Tailscale.

## 1. Prerequisites (on the Pi)

### Install Tailscale
If you haven't already:
```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

### Install Node.js
The Pi Zero 2W (ARMv8) can run standard Node.js. Use NodeSource:
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

### Setup Swap (Critical for 512MB RAM)
`npm install` and Vite might crash without swap:
```bash
sudo dphys-swapfile swapoff
sudo sed -i 's/CONF_SWAPSIZE=.*/CONF_SWAPSIZE=1024/' /etc/dphys-swapfile
sudo dphys-swapfile setup
sudo dphys-swapfile swapon
```

## 2. Project Setup

### Clone and Install
```bash
git clone <your-repo-url> ttc-app
cd ttc-app
npm install
```

### Prefetch Data
You need the static data for the app to work correctly:
```bash
npm run prefetch
```

## 3. Running the Server

Run the dev server:
```bash
npm run dev
```

Since `vite.config.js` already has `host: true`, it will listen on all interfaces.

### Accessing the App
Get your Pi's Tailscale IP:
```bash
tailscale ip -4
```
Then visit: `https://<your-pi-ip>:5173/tbilisi-trans/`

> **Note**: You will see a certificate warning because of the self-signed SSL. You can safely "Proceed" or follow the `/setup-ssl` workflow to generate a trusted cert for your Tailscale IP.

## 4. (Optional) Keep it running with PM2
To keep the server running after you close the terminal:
```bash
sudo npm install -g pm2
pm2 start "npm run dev" --name ttc-app
pm2 save
pm2 startup
```
