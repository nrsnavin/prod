'use strict';
// ══════════════════════════════════════════════════════════════════
//  TEXT THE BUILT-IN PDF FONT CAN PRINT
//
//  pdfkit's own Helvetica holds Western European letters and nothing
//  else. Anything outside it — an emoji in a payslip label, the rupee
//  sign, a long dash, a name written in Tamil — comes out as a blank
//  box or as the wrong letters. `latin1` makes a string safe to print
//  with it: the rupee sign spelt "Rs.", a long dash as a hyphen, and
//  whatever is left that the font does not have, dropped.
//
//  (A name wholly in another script comes out empty; the caller prints
//  its own stand-in. Printing it properly needs a font that has it.)
// ══════════════════════════════════════════════════════════════════

function latin1(s) {
  return String(s ?? '')
    .replace(/₹\s?/g, 'Rs. ')
    .replace(/[–—]/g, '-')
    .replace(/[^\x20-\xFF]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

module.exports = { latin1 };
