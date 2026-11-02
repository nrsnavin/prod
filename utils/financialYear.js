'use strict';
//
// The Indian financial year, as a document-numbering label.
//
// April to March, written "25/26". Extracted from the delivery-challan
// router because the quote numbers itself the same way, and two copies
// of this would eventually disagree about April — which is exactly the
// month where being wrong renumbers a whole year of documents.

function currentFinancialYear(at = new Date()) {
  const month   = at.getMonth();          // 0 = January, 3 = April
  const year    = at.getFullYear();
  const fyStart = month >= 3 ? year : year - 1;
  return `${String(fyStart).slice(-2)}/${String(fyStart + 1).slice(-2)}`;
}

/**
 * The same year written out, "2026-27", as an invoice number carries
 * it: a tax invoice is read by people outside the company, and "26/27"
 * with slashes inside INV/.../0001 is one slash too many.
 */
function financialYearLong(at = new Date()) {
  const month   = at.getMonth();
  const year    = at.getFullYear();
  const fyStart = month >= 3 ? year : year - 1;
  return `${fyStart}-${String(fyStart + 1).slice(-2)}`;
}

module.exports = { currentFinancialYear, financialYearLong };
