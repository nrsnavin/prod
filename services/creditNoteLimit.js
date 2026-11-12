'use strict';
// ══════════════════════════════════════════════════════════════════
//  HOW LATE A GST CREDIT NOTE MAY BE  (CGST Act s.34(2))
//
//  A credit note for a supply of one financial year can carry GST only
//  if declared by 30 November of the next year (or the annual return,
//  if filed earlier). After that it is a financial credit note: the
//  customer's account comes down, no tax moves, nothing goes to GSTR-1.
// ══════════════════════════════════════════════════════════════════

const DAY = 86_400_000;

const cal = require('../utils/bizDates');

/** The last day a GST credit note may be dated for a supply on `invoiceDate`. */
function limitFor(invoiceDate) {
  const fyEnd = cal.fyRange(cal.fyOf(invoiceDate)).y1 + 1;                  // the year the invoice's financial year ends in
  return cal.endOf(cal.at(fyEnd, 11, 30));                                  // 30 November that year, to the day's end
}

function check(invoiceDate, noteDate = new Date()) {
  const limit = limitFor(invoiceDate);
  const daysLeft = Math.floor((limit - new Date(noteDate)) / DAY);
  return { limit, daysLeft, past: daysLeft < 0, soon: daysLeft >= 0 && daysLeft <= 60 };
}

module.exports = { limitFor, check };
