# Hosting the React web app at erp.baluelastics.com

The web app (`prod_web`) is a static Vite/React build. It calls the API
cross-origin at `https://api.baluelastics.com/api/v2` (the production
default in `src/app/config.ts`). We serve it from the **same Caddy** on
this box as a second site with its own auto-TLS cert — no extra
infrastructure.

## 1. DNS — add the web subdomain

Hostinger → baluelastics.com → DNS records → Add record:

| Type | Name | Value |
|------|------|-------|
| A | `erp` | `3.6.171.27` |

Verify: `dig +short erp.baluelastics.com` → `3.6.171.27`.

## 2. Allow the web origin in the API's CORS

The browser will send credentialed cross-origin requests from
`erp.baluelastics.com` to `api.baluelastics.com`. Add the web origin to
the backend's `CORS_ORIGINS` (comma-separated) env — in
`config/.env` on the server (the file the jarvis.service EnvironmentFile
points at):

```
CORS_ORIGINS=https://erp.baluelastics.com
```

Then restart the API:

```sh
sudo systemctl restart jarvis
```

(The auth cookie is already `SameSite=None; Secure`, so it's sent on the
cross-subdomain request. Without the CORS origin the browser blocks the
responses.)

## 3. Build the web app and place it in /var/www/erp

On the box (Node is already installed for the backend):

```sh
# get prod_web onto the server (first time)
cd ~
git clone <prod_web repo url> prod_web
cd ~/prod_web

# or update an existing checkout
cd ~/prod_web && git pull origin main

npm ci
npm run build          # outputs to dist/

# publish the build
sudo mkdir -p /var/www/erp
sudo rm -rf /var/www/erp/*
sudo cp -r dist/* /var/www/erp/
sudo chown -R caddy:caddy /var/www/erp    # Caddy reads these files
```

> No env file needed — production builds default to
> `https://api.baluelastics.com/api/v2`. Only set `VITE_API_BASE_URL`
> at build time if you ever point the web app at a different backend.

## 4. Add the Caddy site (already in deploy/Caddyfile)

The `erp.baluelastics.com` block is committed in `deploy/Caddyfile`.
Re-copy and reload:

```sh
cd ~/prod && git pull origin main
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Caddy fetches a Let's Encrypt cert for `erp.baluelastics.com` on reload
(ports 80/443 are already open from the API setup).

## 5. Verify

```sh
curl -I https://erp.baluelastics.com/            # 200, valid cert, serves index.html
dig +short erp.baluelastics.com                  # 3.6.171.27
```

Open `https://erp.baluelastics.com` in a browser, log in, and confirm
data loads (Network tab: requests go to `https://api.baluelastics.com`
and return 200, not CORS errors). If you see CORS errors, re-check
step 2 (`CORS_ORIGINS` must contain `https://erp.baluelastics.com`
exactly, scheme included) and that the API was restarted.

## Redeploying the web later

```sh
cd ~/prod_web && git pull origin main && npm ci && npm run build
sudo rm -rf /var/www/erp/* && sudo cp -r dist/* /var/www/erp/
sudo chown -R caddy:caddy /var/www/erp
```

No Caddy reload needed — it serves whatever is in /var/www/erp.
index.html is sent `no-cache`, so users get the new build on next load.
