'use strict';
// ══════════════════════════════════════════════════════════════════
//  MONEY INPUT VALIDATION
//
//  `Number.isFinite(Number(v)) && v >= 0` looks like validation and is
//  not. It accepts:
//
//    null        → 0     and 0 on a selling rate is this app's own
//                        signal for "not priced", so a null silently
//                        UN-PRICES an order line and answers 200 OK
//    ''          → 0     same
//    true        → 1     a rate of ₹1
//    1e308       → 1e308 which multiplies out to Infinity, and then
//                        r2(Infinity/Infinity × 100) is NaN, and
//                        `NaN || 0` is 0 — so the P&L reports a
//                        confident "0% margin" on a corrupted order
//
//  The last one is the dangerous shape: not a crash, not an obviously
//  wrong number, but a plausible figure with nothing behind it.
//
//  So: accept a real number, or a string that is unambiguously one.
//  Reject every other type outright rather than coercing it.
// ══════════════════════════════════════════════════════════════════

// A per-unit rate: ₹/meter, ₹/kg. Elastic sells for tens of rupees a
// meter, so ₹10,00,000/m is four or five orders of magnitude past
// anything real — high enough never to reject a genuine price, low
// enough to catch a fat-fingered exponent before it reaches the P&L.
const MAX_RATE = 1_000_000;

// An absolute amount: a job's conversion cost, an adjustment. ₹1,000
// crore on one job, by the same reasoning.
const MAX_AMOUNT = 100_000_000_000;

/**
 * Parse a money input strictly.
 *
 * @param {unknown} value
 * @param {{ max?: number, label?: string, allowNull?: boolean }} opts
 *        allowNull — null/'' means "clear this field", returning
 *        { ok: true, value: null }. Only pass it where clearing is a
 *        real operation (a job cost override handing the line back to
 *        the rate card); never on a rate, where it would be the very
 *        silent-zero this module exists to stop.
 * @returns {{ ok: true, value: number|null } | { ok: false, reason: string }}
 */
function parseMoney(value, { max = MAX_AMOUNT, label = 'value', allowNull = false } = {}) {
  if (allowNull && (value === null || value === '')) return { ok: true, value: null };

  // Booleans, arrays, objects, null and undefined all coerce to a
  // number in JS. None of them is one.
  if (typeof value === 'boolean' || value === null || value === undefined) {
    return { ok: false, reason: `${label} must be a number` };
  }
  if (typeof value !== 'number' && typeof value !== 'string') {
    return { ok: false, reason: `${label} must be a number` };
  }
  if (typeof value === 'string' && value.trim() === '') {
    return { ok: false, reason: `${label} must be a number` };
  }

  const n = Number(value);
  if (!Number.isFinite(n)) return { ok: false, reason: `${label} must be a number` };
  if (n < 0) return { ok: false, reason: `${label} cannot be negative` };
  if (n > max) {
    return {
      ok: false,
      reason: `${label} looks wrong — ${n.toLocaleString('en-IN')} exceeds the `
        + `maximum of ${max.toLocaleString('en-IN')}`,
    };
  }
  return { ok: true, value: n };
}

/**
 * Round to paise WITHOUT laundering a broken number into a plausible
 * one. The old helper was `Math.round((Number(n) || 0) * 100) / 100`,
 * and `NaN || 0` is 0 — which is how an overflowed P&L came to report
 * a margin of exactly 0%.
 */
function round2(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  return Math.round(v * 100) / 100;
}

module.exports = { parseMoney, round2, MAX_RATE, MAX_AMOUNT };
