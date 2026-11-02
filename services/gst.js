'use strict';
// ══════════════════════════════════════════════════════════════════
//  GST ARITHMETIC FOR A TAX INVOICE
//
//  Pure functions, no database. The rule that matters:
//
//    seller's state == buyer's state  →  CGST + SGST, half the rate each
//    otherwise                        →  IGST at the full rate
//
//  Both states come from the two GSTINs (the first two digits are the
//  state code), so a wrong split can only come from a wrong GSTIN —
//  which the e-invoice portal would also refuse.
//
//  Money is rounded to the paisa per line and the grand total to the
//  rupee, with the round-off shown, as the e-invoice schema expects.
// ══════════════════════════════════════════════════════════════════

const STATE_NAMES = {
  '01': 'Jammu & Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh',
  '05': 'Uttarakhand', '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh',
  '10': 'Bihar', '11': 'Sikkim', '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur',
  '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya', '18': 'Assam', '19': 'West Bengal',
  '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh', '24': 'Gujarat',
  '26': 'Dadra & Nagar Haveli and Daman & Diu', '27': 'Maharashtra', '29': 'Karnataka', '30': 'Goa',
  '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry',
  '35': 'Andaman & Nicobar Islands', '36': 'Telangana', '37': 'Andhra Pradesh', '38': 'Ladakh',
  '97': 'Other Territory',
};

const GSTIN_RE = /^(\d{2})[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

/** "33AAECB1234F1Z5" → "33"; anything that is not a GSTIN → "". */
function stateCodeFromGstin(gstin) {
  const m = GSTIN_RE.exec(String(gstin || '').trim().toUpperCase());
  return m ? m[1] : '';
}

const isGstin = (gstin) => GSTIN_RE.test(String(gstin || '').trim().toUpperCase());

const stateName = (code) => STATE_NAMES[String(code || '')] || '';

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Price the lines and split the tax.
 *
 * @param lines  [{ quantity, rate, gstPercent }]  (other keys pass through)
 * @param sellerStateCode, buyerStateCode  two-digit codes; a blank buyer
 *        state is treated as the seller's (intra-state) — the readiness
 *        check for the e-invoice says so out loud.
 */
function computeInvoice(lines, { sellerStateCode, buyerStateCode } = {}) {
  const seller = String(sellerStateCode || '');
  const buyer = String(buyerStateCode || '') || seller;
  const interState = !!seller && !!buyer && seller !== buyer;

  const priced = lines.map((l) => {
    const quantity = Number(l.quantity) || 0;
    const rate = Number(l.rate) || 0;
    const gstPercent = Number(l.gstPercent) || 0;
    const taxable = round2(quantity * rate);
    const tax = round2((taxable * gstPercent) / 100);
    const half = round2(tax / 2);
    const cgst = interState ? 0 : half;
    // The other half takes the rounding remainder so the two add up to the tax.
    const sgst = interState ? 0 : round2(tax - half);
    const igst = interState ? tax : 0;
    return { ...l, quantity, rate, gstPercent, taxable, cgst, sgst, igst, amount: round2(taxable + tax) };
  });

  const sum = (k) => round2(priced.reduce((a, l) => a + l[k], 0));
  const taxable = sum('taxable');
  const cgst = sum('cgst');
  const sgst = sum('sgst');
  const igst = sum('igst');
  const tax = round2(cgst + sgst + igst);
  const beforeRound = round2(taxable + tax);
  const grand = Math.round(beforeRound);
  const roundOff = round2(grand - beforeRound);

  return {
    supplyType: interState ? 'inter' : 'intra',
    placeOfSupply: buyer,
    lines: priced,
    totals: { taxable, cgst, sgst, igst, tax, roundOff, grand },
  };
}

// ── Amount in words, Indian grouping ───────────────────────────────
const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
  'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function belowThousand(n) {
  const parts = [];
  if (n >= 100) { parts.push(`${ONES[Math.floor(n / 100)]} Hundred`); n %= 100; }
  if (n >= 20) { parts.push(TENS[Math.floor(n / 10)] + (n % 10 ? ` ${ONES[n % 10]}` : '')); }
  else if (n > 0) parts.push(ONES[n]);
  return parts.join(' ');
}

function wholeInWords(n) {
  if (n === 0) return 'Zero';
  const parts = [];
  const crore = Math.floor(n / 1e7); n %= 1e7;
  const lakh = Math.floor(n / 1e5); n %= 1e5;
  const thousand = Math.floor(n / 1e3); n %= 1e3;
  if (crore) parts.push(`${belowThousand(crore)} Crore`);
  if (lakh) parts.push(`${belowThousand(lakh)} Lakh`);
  if (thousand) parts.push(`${belowThousand(thousand)} Thousand`);
  if (n) parts.push(belowThousand(n));
  return parts.join(' ');
}

/** 12345.5 → "Rupees Twelve Thousand Three Hundred Forty Five and Fifty Paise Only" */
function amountInWords(amount) {
  const n = Math.max(0, Number(amount) || 0);
  const rupees = Math.floor(n);
  const paise = Math.round((n - rupees) * 100);
  let out = `Rupees ${wholeInWords(rupees)}`;
  if (paise) out += ` and ${wholeInWords(paise)} Paise`;
  return `${out} Only`;
}

module.exports = { STATE_NAMES, stateCodeFromGstin, isGstin, stateName, computeInvoice, amountInWords, round2 };
