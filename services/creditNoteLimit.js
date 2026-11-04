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

/** The last day a GST credit note may be dated for a supply on `invoiceDate`. */
function limitFor(invoiceDate) {
  const d = new Date(invoiceDate);
  const fyEnd = d.getMonth() >= 3 ? d.getFullYear() + 1 : d.getFullYear();   // 31 March of the FY's end year
  return new Date(fyEnd, 10, 30, 23, 59, 59, 999);                          // 30 November that year
}

function check(invoiceDate, noteDate = new Date()) {
  const limit = limitFor(invoiceDate);
  const daysLeft = Math.floor((limit - new Date(noteDate)) / DAY);
  return { limit, daysLeft, past: daysLeft < 0, soon: daysLeft >= 0 && daysLeft <= 60 };
}

module.exports = { limitFor, check };
