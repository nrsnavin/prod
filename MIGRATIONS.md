# Database migrations

Schema/index/data changes are versioned with [migrate-mongo](https://github.com/seppevs/migrate-mongo).
Applied migrations are recorded in the `changelog` collection, so each
migration runs exactly once per environment.

## Deploy step (required)

After pulling new code on the server, before (re)starting the app:

```bash
npm install          # picks up migrate-mongo and any new deps
npm run migrate      # applies pending migrations
```

`npm run migrate:status` shows what has / hasn't run.

## Writing a migration

```bash
npm run migrate:create -- descriptive-name
```

Edit the generated file in `migrations/`. Rules:

- **Never edit a migration after it has run anywhere.** Write a new one.
- Migrations must be **idempotent-safe to review**: prefer `$max`,
  `updateOne(upsert)`, and `createIndex` (a no-op when the index exists).
- A migration that would destroy or reinterpret financial data must
  **abort with a report** instead of guessing (see
  `20260711000001-po-dc-counters-and-unique-pono.js` for the pattern —
  it refuses to create the unique poNo index while duplicates exist).

## Current baseline

`20260711000001-po-dc-counters-and-unique-pono.js`
- Seeds the atomic `counters` used by `utils/sequence.js` (PO numbers and
  per-financial-year DC sequences) from the current data maxima.
- Creates the unique sparse index on `purchaseorders.poNo` after checking
  for pre-existing duplicates (aborts with a list if any are found).
