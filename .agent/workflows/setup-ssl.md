---
description: Setup trusted local SSL for iOS/mobile testing
---

# Trusted local SSL with mkcert

iOS Safari strictly blocks the Geolocation API if the HTTPS certificate is untrusted. Follow these steps to generate a real, trusted local certificate.

## 1. Install mkcert
If you have Homebrew installed, run:
```bash
brew install mkcert
brew install nss # optional, for Firefox support
```

## 2. Generate the Local Root CA
This creates a local "Certificate Authority" on your Mac:
```bash
mkcert -install
```

## 3. Generate Certificates for your project
Navigate to your project root and run:
```bash
# Replace with your Mac's LAN IP if testing on iPhone (e.g. 192.168.1.x)
mkcert localhost 127.0.0.1 ::1 $(ipconfig getifaddr en0)
```
This will create `localhost+X.pem` and `localhost+X-key.pem`.

## 4. Configure Vite
Update `vite.config.js` to use these files instead of `@vitejs/plugin-basic-ssl`:

```javascript
server: {
  https: {
    key: fs.readFileSync('./localhost+3-key.pem'), // Check the filename generated in step 3
    cert: fs.readFileSync('./localhost+3.pem'),
  },
  host: true
}
```

## 5. Trust the CA on iPhone (CRITICAL)
1. Find the location of your Root CA: `mkcert -CAROOT`.
2. Send the `rootCA.pem` file from that folder to your iPhone (AirDrop is easiest).
3. On iPhone: Tap the received file -> **Settings** -> **Profile Downloaded** -> **Install**.
4. **Final Step**: Go to **Settings** -> **General** -> **About** -> **Certificate Trust Settings**. Toggle the switch for `mkcert` to **ON**.

Now, refresh the site on your iPhone. The "Not Secure" warning should be gone, and GPS will work!
