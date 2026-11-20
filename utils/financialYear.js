'use strict';
//
// The Indian financial year, as a document-numbering label.
//
// April to March, written "25/26". Extracted from the delivery-challan
// router because the quote numbers itself the same way, and two copies
// of this would eventually disagree about April — which is exactly the
// month where being wrong renumbers a whole year of documents.
//
// The year turns at midnight IN INDIA. This read the server's own
// clock, which is kept on UTC: a challan raised in the first five and a
// half hours of 1 April — the night shift's despatch — took the next
// number of last year's series.

const cal = require('./bizDates');

/** The year the financial year of `at` begins in, by the calendar in India. */
function startYear(at) {
  const p = cal.parts(at) || cal.parts();
  return p.m >= 4 ? p.y : p.y - 1;
}

function currentFinancialYear(at = new Date()) {
  const fyStart = startYear(at);
  return `${String(fyStart).slice(-2)}/${String(fyStart + 1).slice(-2)}`;
}

/**
 * The same year written out, "2026-27", as an invoice number carries
 * it: a tax invoice is read by people outside the company, and "26/27"
 * with slashes inside INV/.../0001 is one slash too many.
 */
function financialYearLong(at = new Date()) {
  const fyStart = startYear(at);
  return `${fyStart}-${String(fyStart + 1).slice(-2)}`;
}

module.exports = { currentFinancialYear, financialYearLong };
