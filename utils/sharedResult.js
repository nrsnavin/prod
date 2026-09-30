'use strict';
// ══════════════════════════════════════════════════════════════════
//  ONE COMPUTATION FOR EVERYONE ASKING THE SAME QUESTION
//
//  The web app polls every mounted query every ten seconds. For a
//  question whose answer is the same for every caller — "how many jobs
//  are open", "which materials are below minimum" — a hundred people on
//  the dashboard meant a hundred identical aggregations every ten
//  seconds, two of them collection scans.
//
//  sharedResult(key, ttlMs, compute):
//    • a caller within `ttlMs` of the last answer gets that answer;
//    • callers arriving while it is being computed wait for the same
//      computation instead of starting their own (single flight);
//    • a failure is never kept — the next caller tries again.
//
//  ── Is this state? ────────────────────────────────────────────────
//  Yes, per process, and deliberately harmless: it holds only DERIVED
//  read results, for seconds, under keys that include the tenant
//  database. Two cluster workers can disagree for at most `ttlMs`, and
//  nothing is ever written from it. It is not a place for anything a
//  write depends on.
// ══════════════════════════════════════════════════════════════════

const MAX_KEYS = 200;

const entries = new Map(); // key → { value, at } | { pending }

function evictOldest() {
  while (entries.size > MAX_KEYS) {
    const first = entries.keys().next().value;
    entries.delete(first);
  }
}

/**
 * @template T
 * @param {string} key
 * @param {number} ttlMs
 * @param {() => Promise<T>} compute
 * @returns {Promise<T>}
 */
async function sharedResult(key, ttlMs, compute) {
  const hit = entries.get(key);
  if (hit?.pending) return hit.pending;
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;

  const pending = (async () => compute())();
  entries.set(key, { pending });
  try {
    const value = await pending;
    entries.delete(key); // re-insert so Map order tracks recency
    entries.set(key, { value, at: Date.now() });
    evictOldest();
    return value;
  } catch (err) {
    if (entries.get(key)?.pending === pending) entries.delete(key);
    throw err;
  }
}

/** Drop one key, or everything. For tests, and for a write that must be seen at once. */
function forgetShared(key) {
  if (key === undefined) entries.clear();
  else entries.delete(key);
}

module.exports = { sharedResult, forgetShared, MAX_KEYS };
