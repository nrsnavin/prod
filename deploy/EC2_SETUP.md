# Setting up Jarvis on a new EC2 instance

From an empty AWS account to the API on `https://api.baluelastics.com`
and the web app on `https://erp.baluelastics.com`. If you are moving from
the old box, the order matters: build and check the new one while the
old one keeps working, then switch DNS, then stop the old one.

The other files in `deploy/` explain the pieces in more depth
(`TLS_SETUP.md`, `WEB_DEPLOY.md`, `API_DEPLOY.md`, `EMAIL_SETUP.md`,
`SECRETS_ROTATION.md`); this one puts them in order.

---

## Before you start

- Access to DNS for `baluelastics.com` (Hostinger).
- The database: the MongoDB Atlas connection string, or a plan to host
  MongoDB on the new box (step 4, option B).
- The old server's `config/.env`, if there is one. Several values in it
  must be copied, not made up again (see step 6).
- Read access to the GitHub repositories `prod` and `prod_web`.

## 1. Launch the instance

EC2 → Launch instance:

| Setting | Value |
|---|---|
| AMI | Ubuntu Server 24.04 LTS, 64-bit (x86) |
| Type | `t3.medium` (2 vCPU, 4 GiB) with Atlas; `t3.large` (8 GiB) if MongoDB runs on this box |
| Storage | gp3, 30 GiB with Atlas; 60 GiB or more with MongoDB on the box |
| Key pair | create or choose one, and keep the `.pem` file |
| Security group | inbound **22** from your own IP only; **80** and **443** from anywhere |

Do not open 2701 (Node) or 27017 (MongoDB): Node listens only on
127.0.0.1, behind the HTTPS proxy.

Then EC2 → Elastic IPs → Allocate → Associate it with the instance, so
the address survives a stop and start. Note the IP; it is `NEW_IP` below.

```sh
ssh -i your-key.pem ubuntu@NEW_IP
```

## 2. Install the basics

```sh
sudo apt update && sudo apt -y upgrade
sudo apt install -y git build-essential curl

# Node.js 22 (the server needs 20 or later)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v        # v22.x
which node     # /usr/bin/node — what deploy/jarvis.service runs
```

On an instance with 2 GiB of memory or less, add swap before building the
web app:

```sh
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

## 3. Get the code

The repositories are private, so give the box its own read-only key:

```sh
ssh-keygen -t ed25519 -C "jarvis-ec2" -f ~/.ssh/id_ed25519 -N ""
cat ~/.ssh/id_ed25519.pub
```

Add that public key on GitHub to **each** repository: Settings → Deploy
keys → Add deploy key (leave "Allow write access" off). Then:

```sh
cd ~
git clone git@github.com:nrsnavin/prod.git
git clone git@github.com:nrsnavin/prod_web.git
```

## 4. The database

The server uses MongoDB **transactions**, which need a replica set.
Atlas always is one; a MongoDB on this box has to be set up as one.

### Option A — MongoDB Atlas (recommended)

- Keep the existing cluster and its connection string (`MONGO_URL`).
- Atlas → Network Access → Add IP Address → `NEW_IP`. Without this the
  server cannot connect. Remove the old server's IP after the move.
- Nothing to copy: the data is already there.

### Option B — MongoDB on this box

```sh
curl -fsSL https://www.mongodb.org/static/pgp/server-8.0.asc \
  | sudo gpg -o /usr/share/keyrings/mongodb-server-8.0.gpg --dearmor
echo "deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-8.0.gpg ] https://repo.mongodb.org/apt/ubuntu noble/mongodb-org/8.0 multiverse" \
  | sudo tee /etc/apt/sources.list.d/mongodb-org-8.0.list
sudo apt update && sudo apt install -y mongodb-org
```

Make it a one-member replica set, listening only on this machine:

```sh
sudo nano /etc/mongod.conf
#   net:
#     bindIp: 127.0.0.1
#   replication:
#     replSetName: rs0
sudo systemctl enable --now mongod
mongosh --eval 'rs.initiate({_id: "rs0", members: [{_id: 0, host: "127.0.0.1:27017"}]})'
```

`MONGO_URL` is then `mongodb://127.0.0.1:27017/jarvis?replicaSet=rs0`.

To bring the data over from an old database:

```sh
# on a machine that can reach the old database
mongodump --uri="<old MONGO_URL>" --archive=jarvis.gz --gzip
# copy jarvis.gz to the new box, then
mongorestore --uri="mongodb://127.0.0.1:27017/?replicaSet=rs0" --archive=jarvis.gz --gzip
```

## 5. Install the API

```sh
cd ~/prod
npm ci --omit=dev        # production packages only; nothing else is needed
```

## 6. The environment file

```sh
cd ~/prod
cp config/.env.example config/.env
nano config/.env
chmod 600 config/.env    # only this user can read the secrets
```

`config/.env.example` explains every variable. On a move, copy the old
server's file across (`scp`) and check it against the example, rather
than starting from blank. What to fill in:

**Required: the server does not work without these**

| Variable | Value |
|---|---|
| `MONGO_URL` | the connection string from step 4 |
| `PORT` | `2701` (what the proxy configs expect) |
| `JWT_SECRET_KEY` | **On a move: copy the old value.** A new one signs everyone out, phone apps included. New install: `openssl rand -base64 48` |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | the mailbox that sends sign-in codes. Email codes are how people sign in, so without these nobody can (`EMAIL_SETUP.md`) |
| `WEB_URL` | `https://erp.baluelastics.com` (password-reset links) |
| `CORS_ORIGINS` | `https://erp.baluelastics.com` (the browser blocks the web app without it) |

**Copy exactly if the old server had them**

| Variable | Why |
|---|---|
| `AADHAAR_KEY` | Aadhaar numbers are sealed with it. A different key, or none, and the sealed numbers cannot be read again |
| `PORTAL_JWT_SECRET_KEY` | customer portal sessions |

**Recommended**

| Variable | Value |
|---|---|
| `PUBLIC_BASE_URL` | `https://api.baluelastics.com` (WhatsApp report links; must match the Twilio webhook URL) |
| `SESSION_SAMESITE` | `lax`: the web and API share baluelastics.com, so no other site's page can send the sign-in cookie |

**For features (each is off, or a dry run, until set)**

| Feature | Variables | Example file |
|---|---|---|
| AI (bill scans, statement matching, Ask Jarvis…) | `ANTHROPIC_API_KEY` | `.env.example` |
| WhatsApp messages | `WHATSAPP_PROVIDER`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM` | `.env.whatsapp.example` |
| Bank statements by email | `BANK_FEED_IMAP_*`, `BANK_FEED_SENDERS`, `BANK_FEED_EVERY_MIN` | `.env.example` |
| Bank statements by SFTP | `BANK_SFTP_*` | `.env.example` |
| Error reporting | `SENTRY_DSN` | `.env.example` |

Everything else (process counts, timeouts, report times, retention,
the plant's time zone) has a working default, and the example says what
each changes. `NODE_ENV=PRODUCTION` and `HOST=127.0.0.1` are set by the
service file in step 8, not here.

## 7. Bring the database up to date

```sh
cd ~/prod
npm run migrate
npm run migrate:status    # every migration should say "applied"
```

This is not automatic (`API_DEPLOY.md` explains why). A migration left
unrun hides finished pages from accounts that have a feature list.

## 8. Run the API as a service

```sh
sudo cp ~/prod/deploy/jarvis.service /etc/systemd/system/jarvis.service
# The unit expects user "ubuntu" and /home/ubuntu/prod; edit if yours differ.
sudo systemctl daemon-reload
sudo systemctl enable --now jarvis
systemctl status jarvis
journalctl -u jarvis -f          # its log; Ctrl-C to stop watching
```

Check it from the box itself:

```sh
curl -s http://127.0.0.1:2701/api/v2/health          # the process answers
curl -s http://127.0.0.1:2701/api/v2/health/ready    # and it has the database
```

## 9. Build the web app

```sh
cd ~/prod_web
npm ci
npm run build                     # writes dist/
sudo mkdir -p /var/www/erp
sudo cp -r dist/* /var/www/erp/
```

No environment file is needed: production builds call
`https://api.baluelastics.com/api/v2`. Set `VITE_API_BASE_URL` at build
time only to point the web app at a different API.

## 10. Point DNS at the new box

Hostinger → baluelastics.com → DNS records. Set both A records to `NEW_IP`:

| Type | Name | Value |
|---|---|---|
| A | `api` | `NEW_IP` |
| A | `erp` | `NEW_IP` |

On a move, lower the records' TTL to 300 a day before, so the switch
takes minutes. Check from your own computer:

```sh
dig +short api.baluelastics.com    # NEW_IP
dig +short erp.baluelastics.com    # NEW_IP
```

## 11. HTTPS (Caddy)

Caddy fetches and renews the certificates for both names by itself. It
needs step 10 done first, because Let's Encrypt checks the name points
here.

```sh
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy

sudo cp ~/prod/deploy/Caddyfile /etc/caddy/Caddyfile   # both sites, already named
sudo chown -R caddy:caddy /var/www/erp
sudo systemctl restart caddy
journalctl -u caddy --since "5 min ago" | grep -i certificate
```

(`TLS_SETUP.md` has nginx with certbot instead, if you prefer it.)

## 12. Check everything

```sh
curl -I https://api.baluelastics.com/api/v2/health     # 200, valid certificate
curl -I https://erp.baluelastics.com/                  # 200
```

Then in a browser:

1. Open `https://erp.baluelastics.com` and sign in with an emailed code.
   That one step proves the mail settings, the session secret, CORS and
   the database all work.
2. Signed in as an admin, open `https://api.baluelastics.com/api/v2/health/build`.
   It should show the commit you deployed, `"pendingCount": 0` for
   migrations, and no configuration risks.
3. `…/api/v2/health/mailer?test=you@example.com` sends a test email.
4. Open the phone apps. They call `api.baluelastics.com`, so they follow
   the DNS change with no new build.

## 13. Finish a move

When the new box has served for a while without trouble, stop the old
one, so two servers are not both running the background work (bank feed,
reminders, scheduled reports):

```sh
# on the OLD box
sudo systemctl stop jarvis && sudo systemctl disable jarvis
```

Then remove the old IP from Atlas's Network Access, and once you are
sure, release its Elastic IP and terminate it.

## 14. Keep it healthy

- **Backups.** Atlas: its backups are on with the cluster (check the
  plan). MongoDB on the box: run a nightly `mongodump` to S3, and turn on
  EBS snapshots (EC2 → Lifecycle Manager → a daily policy for the volume).
- **Log size.** The API logs to journald. Cap it with
  `SystemMaxUse=200M` in `/etc/systemd/journald.conf`, then
  `sudo systemctl restart systemd-journald`.
- **Disk.** EC2 → Volumes → Modify volume to grow it; then
  `sudo growpart /dev/nvme0n1 1` and `sudo resize2fs /dev/nvme0n1p1`
  (check names with `lsblk`).
- **Security updates.** `sudo apt update && sudo apt -y upgrade` monthly,
  then `sudo reboot` if the kernel was updated. Everything restarts by
  itself.

## Updating later

API (`API_DEPLOY.md`):

```sh
cd ~/prod && git pull origin main
npm ci --omit=dev
npm run migrate
sudo systemctl restart jarvis
```

Web:

```sh
cd ~/prod_web && git pull origin main
npm ci && npm run build
sudo rm -rf /var/www/erp/* && sudo cp -r dist/* /var/www/erp/
sudo chown -R caddy:caddy /var/www/erp
```

## Not on this box

- The **Tally connector** runs on the PC with Tally (`tools/tally-connector`).
- The **phone apps** are built and released separately; nothing on the
  server changes for them.
- The **one-off scripts** in `scripts/` read `MONGO_URI` or `DB_URL`.
  Set it to `MONGO_URL`'s value for the one command you run.
