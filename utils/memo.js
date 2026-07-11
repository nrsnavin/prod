'use strict';
// Tiny TTL memoizer for hot read-side aggregates.
//
// The plant-rate loaders run a full 30-day ShiftDetail aggregation on
// EVERY request that shows an ETA (order lists, forecast page, risk
// feed, planner). The number moves only when a shift is verified — a
// short cache stops transactional posting from competing with the same
// scan being recomputed dozens of times a minute, at the cost of the
// figure being up to `ttlMs` stale (fine for a forecasting hint).
//
// Single concurrent flight: while one caller computes, others await the
// same promise instead of piling on duplicate aggregations.

function memoizeAsync(fn, ttlMs) {
  let value;
  let expiresAt = 0;
  let inFlight = null;

  const wrapped = async (...args) => {
    const now = Date.now();
    if (now < expiresAt) return value;
    if (inFlight) return inFlight;

    inFlight = (async () => {
      try {
        value = await fn(...args);
        expiresAt = Date.now() + ttlMs;
        return value;
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  };

  // Test hook / manual invalidation.
  wrapped.invalidate = () => { expiresAt = 0; value = undefined; };
  return wrapped;
}

module.exports = { memoizeAsync };
