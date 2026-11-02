'use strict';
// ══════════════════════════════════════════════════════════════════
//  DOCUMENT NUMBERS FOR THE ACCOUNTS MODULE
//
//  One series per document type per financial year, off the atomic
//  counter (utils/sequence.js), seeded from whatever is already in the
//  collection so a series survives a counter reset:
//
//      PB/2026-27/0001   purchase (supplier) bill
//      EXP/2026-27/0001  expense
//      CN/2026-27/0001   credit note      DN/2026-27/0001  debit note
//      RCT/2026-27/0001  receipt voucher  PAY/2026-27/0001 payment voucher
// ══════════════════════════════════════════════════════════════════

const { nextNumber } = require('../utils/sequence');
const { financialYearLong } = require('../utils/financialYear');

/**
 * @param Model   the collection the series lives in (has financialYear + sequence)
 * @param prefix  "PB", "EXP", …
 * @param extra   extra filter for the seed (e.g. { kind: 'credit' })
 * @param at      the document's date, which decides the financial year
 */
async function allocate(Model, prefix, { extra = {}, at = new Date() } = {}) {
  const fy = financialYearLong(at);
  const key = `${prefix.toLowerCase()}:${fy}`;
  const sequence = await nextNumber(key, async () => {
    const last = await Model.findOne({ financialYear: fy, ...extra }).sort({ sequence: -1 }).select('sequence').lean();
    return last?.sequence ?? 0;
  });
  return { financialYear: fy, sequence, number: `${prefix}/${fy}/${String(sequence).padStart(4, '0')}` };
}

module.exports = { allocate };
