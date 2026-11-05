'use strict';
// ══════════════════════════════════════════════════════════════════
//  GST AND TDS CODING, CHECKED BEFORE A BILL IS SAVED
//
//  Warnings, never blocks: each says what looks wrong and what to do.
//
//    GST_RATE_ODD      a line at a rate that is no GST rate
//    HSN_MISSING       a goods line with no HSN (GSTR-1/2B and e-way
//                      bills need it)
//    HSN_RATE_UNUSUAL  this HSN at a rate our own past bills seldom used
//                      for it — learned from the books, no rate table
//    NO_GSTIN_ITC      input credit claimed on a bill from a supplier
//                      with no GSTIN on file
//    ITC_BLOCKED       input credit claimed on something CGST s.17(5)
//                      blocks (food and catering, clubs, motor cars…)
//    RCM_LIKELY        freight by a goods transport agency, or an
//                      advocate's fees, without reverse charge
//    TDS_DUE           TDS not deducted where the section's threshold is
//                      passed (194C contracts, 194J professional fees,
//                      194I rent), counting this year's bills
//    TDS_RATE_ODD      a TDS rate the section does not use
//    NO_PAN            TDS on a payee with no PAN: 20% under s.206AA
//
//  Thresholds as they stand from FY 2025-26 (Finance Act 2025): 194C
//  ₹30,000 a bill or ₹1,00,000 a year; 194J ₹50,000 a year; 194I
//  ₹50,000 a month. They are constants below, to change with the law.
// ══════════════════════════════════════════════════════════════════

const mongoose = require('mongoose');
const SupplierBill = require('../models/SupplierBill');
const Expense = require('../models/Expense');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const fmt = (n) => Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });

const GST_RATES = new Set([0, 0.1, 0.25, 1, 1.5, 3, 5, 6, 7.5, 12, 18, 28, 40]);
const TDS = {
  '194C': { rates: [1, 2], single: 30_000, year: 100_000, what: 'contract work (job work, transport, labour)' },
  '194J': { rates: [2, 10], single: null, year: 50_000, what: 'professional or technical fees' },
  '194I': { rates: [2, 10], single: 50_000, year: null, what: 'rent' },
};
const SECTION_WORDS = [
  ['194J', /\b(professional|consult\w*|audit\w*|chartered|advocate|legal|lawyer|technical service|software service|architect|engineer\w* fee)\b/i],
  ['194I', /\b(rent|lease|godown hire|building hire|machinery hire)\b/i],
  ['194C', /\b(job ?work|contract\w*|labou?r|transport\w*|freight|lorry|truck|carriage|loading|unloading|dyeing|printing|stitching|repair work|annual maintenance|amc)\b/i],
];
const BLOCKED = /\b(food|canteen|catering|meals?|snacks|beverages?|outdoor catering|club|membership|gym|health ?club|beauty|cosmetic|life insurance|health insurance|motor ?car|car hire|cab|taxi|travel(?:ling)? allowance|leave travel|gifts?|diwali gift)\b/i;
const GTA = /\b(transport\w*|freight|lorry|truck|carriage|gta|goods transport)\b/i;
const ADVOCATE = /\b(advocate|lawyer|legal fees?)\b/i;

function fyStart(date) {
  const d = new Date(date);
  const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
  return new Date(y, 3, 1);
}

/** The section the words point to: the head's own, else the words on the bill. */
function sectionFor({ category, text }) {
  if (category?.tdsSection && TDS[category.tdsSection]) return category.tdsSection;
  const hit = SECTION_WORDS.find(([, re]) => re.test(text));
  return hit ? hit[0] : null;
}

/**
 * @param p { kind: 'bill'|'expense', date, supplier (lean: name gstin pan gstRegistration), lines, billKind,
 *            category (lean: name tdsSection itcEligible), reverseCharge, itcEligible, tds: { applicable, section, rate } }
 */
async function codingFlags(p) {
  const flags = [];
  const lines = Array.isArray(p.lines) ? p.lines : [];
  const supplier = p.supplier || null;
  const date = new Date(p.date || Date.now());
  const taxable = r2(lines.reduce((s, l) => s + (Number(l.quantity) || 0) * (Number(l.rate) || 0), 0));
  const tax = r2(lines.reduce((s, l) => s + (Number(l.quantity) || 0) * (Number(l.rate) || 0) * (Number(l.gstPercent) || 0) / 100, 0));
  const text = [p.category?.name, p.description, ...lines.map((l) => l.description)].filter(Boolean).join(' · ');
  const service = p.kind === 'expense' || p.billKind === 'service';

  // GST rates and HSN.
  for (const l of lines) {
    const g = Number(l.gstPercent);
    if (l.gstPercent !== '' && l.gstPercent != null && Number.isFinite(g) && !GST_RATES.has(g)) {
      flags.push({ code: 'GST_RATE_ODD', severity: 'warning', message: `${l.description || 'A line'} at ${g}% — that is not a GST rate` });
    }
  }
  if (p.kind === 'bill' && !service) {
    const missing = lines.filter((l) => String(l.description || '').trim() && !/^\d{4,8}$/.test(String(l.hsn || '').trim()));
    if (missing.length) flags.push({ code: 'HSN_MISSING', severity: 'info', message: `${missing.length} line${missing.length === 1 ? ' has' : 's have'} no HSN — the GST returns and e-way bills need it` });
  }
  const hsns = [...new Set(lines.map((l) => String(l.hsn || '').trim().slice(0, 4)).filter((h) => /^\d{4}$/.test(h)))];
  if (hsns.length) {
    const since = new Date(date.getTime() - 730 * 86_400_000);
    for (const h of hsns.slice(0, 8)) {
      const past = await SupplierBill.aggregate([
        { $match: { status: { $ne: 'cancelled' }, billDate: { $gte: since }, 'lines.hsn': { $regex: `^${h}` } } },
        { $unwind: '$lines' }, { $match: { 'lines.hsn': { $regex: `^${h}` } } },
        { $group: { _id: '$lines.gstPercent', n: { $sum: 1 } } }, { $sort: { n: -1 } },
      ]);
      const total = past.reduce((s, x) => s + x.n, 0);
      if (total < 3) continue;
      const usual = past[0];
      for (const l of lines.filter((x) => String(x.hsn || '').startsWith(h) && x.gstPercent !== '' && x.gstPercent != null)) {
        const at = past.find((x) => x._id === Number(l.gstPercent))?.n || 0;
        if (Number(l.gstPercent) !== usual._id && at / total < 0.2) {
          flags.push({ code: 'HSN_RATE_UNUSUAL', severity: 'warning', message: `HSN ${h} has been billed at ${usual._id}% on ${usual.n} of ${total} past lines; ${l.description || 'this line'} says ${Number(l.gstPercent)}% — check the rate (or the HSN)` });
        }
      }
    }
  }

  // Input credit.
  if (p.itcEligible !== false && tax > 0 && !p.reverseCharge) {
    if (supplier && (supplier.gstRegistration || 'regular') === 'regular' && !String(supplier.gstin || '').trim()) {
      flags.push({ code: 'NO_GSTIN_ITC', severity: 'warning', message: `${supplier.name} has no GSTIN on file — input credit cannot be claimed without it; add the GSTIN from the bill, or untick input credit` });
    }
    const blocked = text.match(BLOCKED);
    if (blocked) flags.push({ code: 'ITC_BLOCKED', severity: 'warning', message: `Input credit on ${blocked[0].toLowerCase()} is blocked (CGST s.17(5)) — untick input credit` });
  }

  // Reverse charge.
  if (service && !p.reverseCharge) {
    if (GTA.test(text) && tax === 0) flags.push({ code: 'RCM_LIKELY', severity: 'warning', message: 'Freight by a goods transport agency that charges no GST is under reverse charge — tick reverse charge' });
    else if (ADVOCATE.test(text)) flags.push({ code: 'RCM_LIKELY', severity: 'warning', message: 'An advocate\'s fees are under reverse charge — tick reverse charge' });
  }

  // TDS.
  const section = p.tds?.applicable ? (p.tds.section || sectionFor({ category: p.category, text })) : sectionFor({ category: p.category, text });
  const rule = section && TDS[section];
  if (p.tds?.applicable) {
    const rate = Number(p.tds.rate);
    if (rule && Number.isFinite(rate) && rate > 0 && !rule.rates.includes(rate) && !(supplier && !supplier.pan && rate === 20)) {
      flags.push({ code: 'TDS_RATE_ODD', severity: 'warning', message: `TDS under ${section} is ${rule.rates.join('% or ')}%, not ${rate}%` });
    }
    if (supplier && !String(supplier.pan || '').trim()) flags.push({ code: 'NO_PAN', severity: 'warning', message: `${supplier.name} has no PAN on file — TDS is 20% without one (s.206AA); add the PAN` });
  } else if (rule && supplier && service && section !== '194Q') {
    const start = fyStart(date);
    const sid = new mongoose.Types.ObjectId(String(supplier._id));
    const [bills, expenses] = await Promise.all([
      SupplierBill.aggregate([{ $match: { supplier: sid, kind: 'service', status: { $ne: 'cancelled' }, billDate: { $gte: start } } }, { $group: { _id: null, t: { $sum: '$totals.taxable' } } }]),
      Expense.aggregate([{ $match: { supplier: sid, status: { $nin: ['cancelled', 'rejected'] }, date: { $gte: start } } }, { $group: { _id: null, t: { $sum: '$totals.taxable' } } }]),
    ]);
    const year = r2((bills[0]?.t || 0) + (expenses[0]?.t || 0) + taxable);
    const overSingle = rule.single != null && taxable > rule.single;
    const overYear = rule.year != null && year > rule.year;
    if (overSingle || overYear) {
      flags.push({
        code: 'TDS_DUE', severity: 'warning',
        message: `TDS under ${section} (${rule.what}) looks due: ${overSingle ? `this bill is ₹${fmt(taxable)}, over ₹${fmt(rule.single)}` : `₹${fmt(year)} from ${supplier.name} this year with this bill, over ₹${fmt(rule.year)}`} — deduct it${supplier.pan ? '' : ' (and add their PAN: without one it is 20%)'}`,
      });
    }
  }
  return flags;
}

module.exports = { codingFlags, sectionFor, GST_RATES, TDS };
