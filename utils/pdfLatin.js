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
//  (Tamil and Hindi are not dropped any more where a name is printed:
//  utils/pdfScripts.js draws them in fonts that have them, and uses this
//  for the Latin around them.)
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
