'use strict';
// ═════════════════════════════════════════════════════════════════
//  DOES THE READ BILL ADD UP?
//
//  The reader copies what is printed and never computes it (see
//  utils/billOcr.js). One misread digit — 18,600 read as 16,600 — used
//  to reach the form unnoticed: the printed total was shown beside the
//  lines and never compared with them. This compares them:
//
//    LINE_MATH    quantity × rate against the line's amount
//    GST_RATE     a rate that is not a GST rate (6% is half of 12%)
//    TAXABLE      the lines against the printed taxable value
//    TAX          GST on the lines against the GST printed
//    GRAND        the lines and their tax against the printed total
//    SPLIT        CGST not equal to SGST
//    SUPPLY       IGST from a supplier in our state, or CGST and SGST
//                 from one in another state
//
//  Only figures the bill prints are compared; a figure not read is not a
//  mistake. Sums are worked in paise (utils/money.js), half-up.
//
//  checkRead(read, { ourStateCode }) → { ok, issues, computed }
//    issues: [{ code, severity: 'danger'|'warning', line?: index, message }]
//    computed: { taxable, tax, grand } from the lines as read
// ═════════════════════════════════════════════════════════════════
const { r2 } = require('./money');

/** CGST + SGST together, or IGST: the rates a line can carry. */
const GST_RATES = [0, 0.1, 0.25, 1, 1.5, 3, 5, 12, 18, 28, 40];

const fmt = (n) => Number(n).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const has = (v) => v != null && v !== '' && Number.isFinite(Number(v));
/** A line differs from its amount by more than a rupee and a fifth of a percent. */
const off = (a, b) => Math.abs(a - b) > Math.max(1, Math.abs(b) * 0.002);

function checkRead(read, { ourStateCode } = {}) {
  const issues = [];
  const lines = Array.isArray(read?.lines) ? read.lines : [];
  let taxable = 0;
  let tax = 0;
  let complete = lines.length > 0;
  lines.forEach((l, i) => {
    const q = has(l.quantity) ? Number(l.quantity) : null;
    const rate = has(l.rate) ? Number(l.rate) : null;
    const amount = has(l.amount) ? Number(l.amount) : null;
    const n = i + 1;
    if (q != null && rate != null && amount != null && off(q * rate, amount)) {
      issues.push({ code: 'LINE_MATH', severity: 'danger', line: i, message: `Line ${n}: ${fmt(q)} × ${fmt(rate)} is ${fmt(r2(q * rate))}, the bill says ${fmt(amount)}` });
    }
    const value = amount ?? (q != null && rate != null ? r2(q * rate) : null);
    if (value == null) { complete = false; return; }
    taxable += value;
    if (has(l.gstPercent)) {
      const g = Number(l.gstPercent);
      if (!GST_RATES.includes(g)) {
        const hint = GST_RATES.includes(g * 2) ? ` — is it CGST ${fmt(g)}% + SGST ${fmt(g)}%, that is ${fmt(g * 2)}%?` : '';
        issues.push({ code: 'GST_RATE', severity: 'warning', line: i, message: `Line ${n}: ${fmt(g)}% is not a GST rate${hint}` });
      }
      tax += r2(value * g / 100);
    } else {
      complete = false;
    }
  });
  taxable = r2(taxable);
  tax = r2(tax);
  const grand = r2(taxable + tax);

  const t = read?.totals || {};
  if (complete && has(t.taxable) && off(taxable, Number(t.taxable))) {
    issues.push({ code: 'TAXABLE', severity: 'danger', message: `The lines come to ${fmt(taxable)} before tax; the bill prints ${fmt(t.taxable)}` });
  }
  const printedTax = [t.cgst, t.sgst, t.igst].some(has) ? r2([t.cgst, t.sgst, t.igst].reduce((s, v) => s + (has(v) ? Number(v) : 0), 0)) : null;
  if (complete && printedTax != null && Math.abs(tax - printedTax) > Math.max(1, printedTax * 0.005)) {
    issues.push({ code: 'TAX', severity: 'danger', message: `GST on the lines is ${fmt(tax)}; the bill prints ${fmt(printedTax)}` });
  }
  // A total may be rounded to the rupee: up to a rupee either way is round-off.
  if (complete && has(t.grand) && Math.abs(grand - Number(t.grand)) > 1.0001) {
    issues.push({ code: 'GRAND', severity: 'danger', message: `The lines and their GST come to ${fmt(grand)}; the bill's total is ${fmt(t.grand)}` });
  }
  if (has(t.cgst) && has(t.sgst) && Math.abs(Number(t.cgst) - Number(t.sgst)) > 0.02) {
    issues.push({ code: 'SPLIT', severity: 'warning', message: `CGST ${fmt(t.cgst)} and SGST ${fmt(t.sgst)} should be equal` });
  }
  const theirState = /^\d{2}/.test(String(read?.supplierGstin || '')) ? String(read.supplierGstin).slice(0, 2) : null;
  if (ourStateCode && theirState) {
    const same = String(ourStateCode).padStart(2, '0') === theirState;
    if (same && has(t.igst) && Number(t.igst) > 0) issues.push({ code: 'SUPPLY', severity: 'warning', message: 'IGST charged by a supplier in our own state: it should be CGST and SGST' });
    if (!same && ((has(t.cgst) && Number(t.cgst) > 0) || (has(t.sgst) && Number(t.sgst) > 0))) issues.push({ code: 'SUPPLY', severity: 'warning', message: 'CGST and SGST charged by a supplier in another state: it should be IGST' });
  }
  return { ok: !issues.some((x) => x.severity === 'danger'), issues, computed: { taxable, tax, grand } };
}

module.exports = { checkRead, GST_RATES };
