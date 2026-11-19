'use strict';
// ══════════════════════════════════════════════════════════════════
//  QUANTITIES ARE KEPT TO THREE DECIMALS
//
//  Metres to the millimetre, kilograms to the gram. Sums and products of
//  typed decimals are not exact in floating point — 0.1 + 0.2 is
//  0.30000000000000004, 1000.2 × 3 is 3000.6000000000004 — and a figure
//  stored with that noise is then compared, summed and shown with it.
//  Every stored quantity that is worked out is rounded with this where
//  it is written. (Money is to the paisa: utils/money.js.)
// ══════════════════════════════════════════════════════════════════

/** `n` to three decimals; anything that is not a number is 0. */
const round3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000;

module.exports = { round3 };
