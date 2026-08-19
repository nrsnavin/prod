# Secrets rotation — the last go-live blocker

Two credentials were committed to this repo in the past and are still in
git history, so they must be treated as PUBLIC:

- MongoDB Atlas: user `navin`, password `navin`
- `JWT_SECRET_KEY=balutapes` (also trivially guessable)

Untracking `.env` did NOT neutralize them — anyone with repo access can
read old commits. Until both are rotated, assume anyone can read/write
your entire database and mint admin login tokens.

Total time: ~20 minutes. Order matters — follow top to bottom.

## 1. Rotate the MongoDB password (Atlas)

1. https://cloud.mongodb.com → your project → **Database Access**.
2. Edit user `navin` → **Edit Password** → use a generated 24+ char
   password (Atlas can generate one). Save it in a password manager.
   (Better: create a NEW user, e.g. `jarvis_prod`, with the new password
   and `readWrite` on your database, then delete `navin` after cutover.)
3. While there → **Network Access**: remove `0.0.0.0/0` if present and
   allow only your server's Elastic IP `3.6.171.27`.

## 2. Generate a strong JWT secret

On any machine:

```sh
openssl rand -base64 48
```

Copy the output — that's your new `JWT_SECRET_KEY`.

## 3. Update the server env and restart

On the EC2 box:

```sh
nano ~/prod/config/.env
#   MONGO_URL=mongodb+srv://navin:<NEW_PASSWORD>@cluster0.ftoq7bw.mongodb.net/baluElastics?appName=Cluster0
#   JWT_SECRET_KEY=<output of openssl rand>
sudo systemctl restart jarvis
journalctl -u jarvis -n 5 --no-pager   # expect "mongod connected with server: … database: baluElastics"
curl -s https://api.baluelastics.com/api/v2/health/ready   # {"status":"ready","db":"connected"}
```

> **The database name goes in the PATH, before the `?`.**
>
> This line used to read `…mongodb.net/?appName=Cluster0` — no database
> at all. A MongoDB URI with no path silently connects to a database
> literally named **`test`**, so that instruction quietly put live data
> in `test` and left `baluElastics` empty. Two things then go wrong and
> neither announces itself:
>
> - Sandbox routing (`SANDBOX_DB=test`, see `db/tenants.js`) points at
>   the same database as the primary, so it switches itself off and the
>   sandbox users are working in production believing otherwise.
> - The day somebody adds the name back, every id in every open browser
>   tab stops resolving, because the data is in the other database.
>
> Confirm what the running process actually holds:
>
> ```sh
> curl -s -b cookies.txt https://api.baluelastics.com/api/v2/health/build | jq .database
> #   { "name": "baluElastics", "host": "…" }
> ```

Notes:
- Changing the JWT secret logs EVERYONE out (web + both mobile apps).
  Expected — they just log in again.
- If the WhatsApp cron or anything else holds its own copy of MONGO_URL,
  update it too (`grep -r MONGO_URL /etc/cron*` to check).
- Whatever you set, it must be the SAME database the data is already in.
  Moving between databases is a data migration, not a config change.

## 4. Purge the secrets from git history

The old values must leave the history so a repo leak can't resurrect
them. On a machine with a FRESH clone (never on the production server):

```sh
pip install git-filter-repo          # or: brew install git-filter-repo

git clone git@github.com:nrsnavin/prod.git prod-clean && cd prod-clean

cat > /tmp/replacements.txt <<'EOF'
navin:navin==>REDACTED:REDACTED
balutapes==>REDACTED
EOF
git filter-repo --replace-text /tmp/replacements.txt

git push --force --all origin
git push --force --tags origin
```

Then on the production server, re-sync to the rewritten history:

```sh
cd ~/prod
git fetch origin
git reset --hard origin/main     # local secret-bearing commits are discarded
```

⚠️ The production server must still NEVER `git push` — its old local
commits contain the secrets and would re-leak them.

## 5. Verify

- Old password rejected: `mongosh "mongodb+srv://navin:navin@cluster0.ftoq7bw.mongodb.net/"`
  must fail with auth error.
- History clean: `git log -S balutapes --oneline` in the fresh clone
  prints nothing.
- App healthy: dashboards load, users can log in again.

## Done ✅

After this, every launch blocker raised in the security review is closed:
TLS ✅ · localhost bind ✅ · rate limits ✅ · secrets rotated & purged ✅.
