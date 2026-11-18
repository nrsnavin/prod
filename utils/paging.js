'use strict';
// ══════════════════════════════════════════════════════════════════
//  WHICH PAGE OF A LIST
//
//  Most lists clamp page and limit by hand; five did not. `?page=-1`
//  (or 0, or text) became a negative skip, which the database refuses,
//  and the list answered 500. `?limit=100000` was served as asked.
//
//  Page counts from 1. Anything that is not a whole number of at least 1
//  is page 1; a limit that is missing or unreadable is `def`, and no
//  limit is more than `max`.
// ══════════════════════════════════════════════════════════════════

/**
 * @param {object} query            req.query
 * @param {{ def?: number, max?: number }} [opts]
 * @returns {{ page: number, limit: number, skip: number }}
 */
function pageOf(query, { def = 20, max = 200 } = {}) {
  const whole = (v) => { const n = Math.floor(Number(v)); return Number.isFinite(n) ? n : NaN; };
  const p = whole(query?.page);
  const l = whole(query?.limit);
  const page = p >= 1 ? p : 1;
  const limit = Math.min(max, l >= 1 ? l : def);
  return { page, limit, skip: (page - 1) * limit };
}

module.exports = { pageOf };
