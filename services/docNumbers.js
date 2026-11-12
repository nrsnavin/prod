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
const cal = require('../utils/bizDates');

/**
 * @param Model   the collection the series lives in (has financialYear + sequence)
 * @param prefix  "PB", "EXP", …
 * @param extra   extra filter for the seed (e.g. { kind: 'credit' })
 * @param at      the document's date, which decides the financial year
 */
async function allocate(Model, prefix, { extra = {}, at = new Date() } = {}) {
  // The financial year of the document's own day in India ("2026-27"),
  // whatever clock the server keeps: a voucher dated 1 April is the new
  // year's, and one numbered at 1 a.m. on 1 April is too.
  const fy = cal.fyOf(at);
  const key = `${prefix.toLowerCase()}:${fy}`;
  const sequence = await nextNumber(key, async () => {
    const last = await Model.findOne({ financialYear: fy, ...extra }).sort({ sequence: -1 }).select('sequence').lean();
    return last?.sequence ?? 0;
  });
  return { financialYear: fy, sequence, number: `${prefix}/${fy}/${String(sequence).padStart(4, '0')}` };
}

/**
 * A number that was drawn and will not be used: the write it was drawn
 * for failed. Kept, with why, so the gap in the series is accounted for
 * (models/BurntNumber.js). Never throws: losing the note of a lost
 * number must not hide the error that lost it.
 *
 * @param series  "invoice" | "credit-note" | "debit-note"
 */
async function burn(series, { number, financialYear, sequence, date, reason, req }) {
  try {
    const BurntNumber = require('../models/BurntNumber');
    await BurntNumber.updateOne(
      { series, number },
      { $setOnInsert: { series, number, financialYear: financialYear || '', sequence, date: date || new Date(), reason: String(reason || '').slice(0, 300), by: req?.user?._id, byName: req?.user?.name || '' } },
      { upsert: true }
    );
  } catch (err) {
    console.warn(`[numbers] ${series} ${number} was lost and could not be noted: ${err.message}`);
  }
}

module.exports = { allocate, burn };
