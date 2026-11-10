# Dependency upgrade plan (go-live)

## Where it stands — 10 Nov 2026

`npm audit` today reported 22 advisories here (5 high) and 16 on the web
(2 critical, 7 high): new ones have been published since the notes below
were written. What was done, and what is left on purpose:

| Package | Was | Now | Why |
|---------|-----|-----|-----|
| zod | 3.25 | **4.6.7** | High — memory exhaustion validating oversized collections, which is exactly what request validation does with what a client sends. Used through `middleware/validate.js` only; its issue shapes changed (no `received`, `origin` for `type`, `errorMap` → `error`), all handled there and covered by the validation suites. |
| nodemailer | 9.1 | **10.4.0** | High. The only breaking change in 10 is **Node 20 or newer** (CI already runs 20; `engines` in package.json now says so). `utils/mailer.js` uses `createTransport` + `sendMail`, which are as they were. |
| uuid (under exceljs) | 8.3.2 | **11.1.1**, by `overrides` | The note further down says not to do this because "uuid v11 is ESM-only". It is not — 11.x ships a CommonJS build (12 and later are ESM-only). exceljs asks it for `v4()` in one place; a workbook with a conditional-format rule (the path that calls it) writes and reads back, and the Excel tests pass. |
| express → qs, js-yaml, brace-expansion, browserslist … | | patched | In range: `npm audit fix`, no `--force`. Also moves jest 30.3 → 30.5.2. |

**Left: 19 moderate, 1 low — all inside the test runner (jest 30.5.2) and
nodemon, both at their latest release.** `glob`/`minimatch` under jest and
`minimatch` under nodemon have fixes upstream that these have not taken
yet; `deepmerge` has no fixed release at all. None of it runs in
production. `npm audit fix --force` would "fix" it by downgrading jest to
29 — do not. Scoped `overrides` for jest's internals were tried and
backed out: they pin the test runner to versions it was not released
with, for advisories about glob patterns the developer writes.

The web's notes are in its own repo's commit history (zod 4,
react-router 7 taken; vite and vitest are the open item there).

---

*The notes below are the earlier state, kept for the reasoning.*

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
