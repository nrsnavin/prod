# Dependency upgrade plan (go-live)

Grounded in the actual `npm audit` state, not a blind `npm audit fix --force`
(which would have *downgraded* exceljs — a regression).

## Status

| When | Advisories | Notes |
|------|-----------|-------|
| Before | 5 (3 high, 2 moderate) | tar chain via `bcrypt`, uuid via `exceljs` |
| **Now** | **2 (moderate)** | 3 high cleared by removing dead `bcrypt` |

## Done — removed dead `bcrypt` (cleared all 3 high advisories, zero risk)

All password hashing in this codebase uses **`bcryptjs`** (pure JS) —
`models/User.js` and `models/CustomerUser.js`. The native `bcrypt`
package was a direct dependency but **required nowhere in the code**. It
pulled the entire vulnerable chain:

```
bcrypt → @mapbox/node-pre-gyp → tar   (7 tar advisories, high)
```

`npm remove bcrypt` eliminated all three high advisories with **no
breaking change** — nothing imported it. Verified: models load, auth
tests green.

> Deploy note: run `npm install` (or `npm ci`) on the server so
> `node_modules` matches the updated lockfile.

## Remaining — 2 moderate (`exceljs` → `uuid@8`): accept + monitor

```
exceljs@4.4.0  →  uuid@^8.3.0   (installed 8.3.2)
```

- **Advisory** GHSA-w5hq-g745-h8pq: *"Missing buffer bounds check in
  uuid v3/v5/v6 when `buf` is provided."* Fixed in `uuid@>=11.1.1`.
- **Not exploitable here.** exceljs uses `uuid.v4()` (random) and never
  passes a `buf` argument, and we only generate XLSX from **trusted
  internal data** (`api/io.js`, `utils/excelIo.js`, `scripts/excel-io.js`)
  — we do not parse untrusted uploads through the affected path.
- **Do NOT `--force`.** It pins `exceljs@3.4.0`, a two-major downgrade of
  a working feature.
- **Do NOT override `uuid` to v11.** exceljs requires `^8.3.0`; uuid v11
  is ESM-only with a changed export surface and would break Excel I/O for
  no real security gain.

**Real fix path (fast-follow, not a launch blocker):**
1. Watch for an `exceljs` release that bumps its `uuid` range past 11.1.1,
   then `npm i exceljs@latest` and re-audit.
2. If exceljs stalls, evaluate migrating Excel export to a lighter,
   maintained lib (e.g. `xlsx`/SheetJS or `write-excel-file`) — the
   export code is isolated to three files.

## Web (`prod_web`) — separate checkout

The 2 web advisories are `esbuild` (GHSA-67mh-4wv8-2f99) → `vite`. This is
a **dev-server-only** issue: it lets a website talk to the running
`vite dev` server and read responses. It does **not** affect the
production build — the shipped app is static files served by a real web
server, with no esbuild dev server in the picture. So it is **not a
production risk** and does not block launch.

Fixing it requires `vite@8` (a breaking major from the current version),
which needs a real `npm run build` + smoke pass. Do it as a fast-follow
on a branch, not on launch eve. Do **not** `--force` it blind.

## Standing policy

- CI already runs the suite serially (`npx jest --runInBand --forceExit`).
- Re-run `npm audit` after every dependency change; treat new **high/
  critical** as release-blocking, **moderate** as triaged (exploitable-in-
  context or not) like the exceljs/uuid item above.
