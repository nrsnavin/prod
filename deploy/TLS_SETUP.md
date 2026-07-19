# Standing up TLS in front of Jarvis (go-live)

The API currently listens on `http://3.6.171.27:2701` in the clear —
auth cookies and all business data are interceptable on any shared
network. This puts an auto-renewing HTTPS proxy in front so every client
(web + mobile) talks encrypted.

Everything the app side needs is already in place: `trust proxy` is set,
the auth cookie is `Secure; SameSite=None; HttpOnly`, and `HOST` now lets
Node bind to localhost. This directory has the ready configs — you run
them on the EC2 box.

## Prerequisite — a domain (not a bare IP)

Let's Encrypt issues certs for **domain names**, not IPs. You need a
hostname pointing at the server:

- Add a DNS **A record**: `api.baluelastics.com → 3.6.171.27`
- Confirm it resolves: `dig +short api.baluelastics.com` → `3.6.171.27`

This is already configured and live — the committed configs use
`api.baluelastics.com`, so there's nothing to edit.

## Firewall / AWS security group

- **Open** inbound `80` (ACME challenge + redirect) and `443` (HTTPS).
- **Close** inbound `2701` to the public — after this, the only public
  entry is the proxy, which reaches Node on `127.0.0.1:2701`.

## Bind Node to localhost

So the plaintext port isn't publicly reachable even by accident:

- Set `HOST=127.0.0.1` in the app environment (the `jarvis.service` unit
  here already does this), then restart Node.

---

## Option A — Caddy (recommended: auto-TLS, nothing to renew)

```sh
# Install Caddy (Ubuntu/Debian)
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy

# Use our config — already set to api.baluelastics.com, nothing to edit
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
sudo systemctl restart caddy
sudo systemctl status caddy
```

Caddy fetches the certificate on first start and renews it automatically
forever. Done.

## Option B — nginx + certbot

```sh
sudo apt install -y nginx certbot python3-certbot-nginx

sudo cp deploy/nginx-jarvis.conf /etc/nginx/sites-available/jarvis   # already set to api.baluelastics.com
sudo ln -s /etc/nginx/sites-available/jarvis /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default

# Provision the cert (edits the config in place, installs a renew timer)
sudo certbot --nginx -d api.baluelastics.com

sudo nginx -t && sudo systemctl reload nginx
```

certbot installs a systemd timer that auto-renews; verify with
`sudo certbot renew --dry-run`.

---

## Run Node as a managed service (fixes "forgot to restart")

```sh
sudo cp deploy/jarvis.service /etc/systemd/system/jarvis.service
sudo nano /etc/systemd/system/jarvis.service   # match User / paths / EnvironmentFile
sudo systemctl daemon-reload
sudo systemctl enable --now jarvis
journalctl -u jarvis -f     # structured request + 5xx error JSON lines
```

After every deploy the whole restart is one command: `sudo systemctl
restart jarvis`.

## Point the clients at HTTPS

- **Web** (`prod_web`): set the API base to `https://api.baluelastics.com`
  and add that origin to the backend `CORS_ORIGINS` env
  (comma-separated), then rebuild/redeploy the web app.
- **Mobile** (`flu`): rebuild with
  `--dart-define=API_BASE_URL=https://api.baluelastics.com/api/v2` and
  block cleartext — see `flu/MOBILE_TLS.md`. Then resubmit.
- **Twilio/WhatsApp**: the public report PDFs under `/public` are now
  served over HTTPS through the proxy — update any configured media base
  URL to the `https://` host.

## Verify

```sh
curl -I https://api.baluelastics.com/api/v2/health          # 200, valid cert
curl    https://api.baluelastics.com/api/v2/health/ready     # {"status":"ready","db":"connected"}
curl -I http://api.baluelastics.com/api/v2/health           # 301 → https
# From another machine, confirm the plaintext port is now closed:
curl --max-time 5 http://3.6.171.27:2701/api/v2/health # should hang / refuse
```

An A/A+ at https://www.ssllabs.com/ssltest/ confirms the TLS config is
sound.
