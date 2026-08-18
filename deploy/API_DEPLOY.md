# Deploying the API

Short runbook for `~/prod` on the production box. Four commands, and the
third is the one that keeps getting missed.

```sh
cd ~/prod && git pull origin main
npm ci
npm run migrate            # ← see below. Not optional, not automatic.
sudo systemctl restart jarvis
```

## Why `npm run migrate` is a separate step

`package.json` has a `prestart` script that runs `migrate-mongo up`, so
`npm start` would migrate on its own. **The service does not use it.**
`deploy/jarvis.service` reads:

```ini
ExecStart=/usr/bin/node index.js
```

npm is never involved, so `prestart` never fires. Migrations run only
when somebody runs them.

That was not written down anywhere until this file existed, and the cost
has been paid repeatedly: `20260814000001-material-groups` sat unrun for
weeks, and every feature-grant migration that goes unrun leaves a
finished page **invisible to every account that has an explicit feature
list** — the owner's included — with no error to explain the absence.
From the outside, "the migration hasn't run" and "the feature was never
built" look identical.

## Checking, instead of remembering

`GET /api/v2/health/build` (admin session) reports what has landed:

```jsonc
{
  "commitSha": "…",
  "migrations": {
    "pending": ["20260818000003-grant-complaints-feature.js"],
    "pendingCount": 1
  }
}
```

A non-empty `pending` list is the answer to "why is the new page
missing?". `npm run migrate:status` gives the same answer on the box.

## Should the service just run them itself?

It could — `ExecStartPre=/usr/bin/npm run migrate` in the unit file, or
changing `ExecStart` to `npm start`. That has not been done because the
unit is configured `Restart=always` with a 30-restart budget, so a
migration that fails takes the ERP down and holds it down rather than
starting the app against an older schema. That is a defensible choice in
either direction and it belongs to whoever runs the plant, not to the
person writing the migration.

Until it is decided, the answer is the third command above, and the
health probe to confirm it worked.

## Rolling one back

```sh
npm run migrate:down       # reverts the most recent migration only
```

Every migration in this repo defines `down`. Read it before running it —
the feature-grant ones cannot tell a key they added from one an admin
ticked by hand afterwards, so a rollback puts those accounts back to
needing a tick.
