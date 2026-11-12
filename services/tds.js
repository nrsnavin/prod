'use strict';
// ══════════════════════════════════════════════════════════════════
//  TDS AFTER THE DEDUCTION
//
//  register()     a month's deductions by section, the due day (7th of
//                 the next month; 30 April for March), what was
//                 deposited by challan, the balance, and the interest
//                 running on it (1.5% a month from the deduction, s.201(1A))
//  form26q()      a quarter's deductee-wise rows: PAN, name, section,
//                 date, amount, TDS, challan; a missing PAN means 20%
//                 should have been deducted (s.206AA)
//  receivable()   what customers deducted from us (receipts' adjustments
//                 "tds_by_customer"), against the certificates received
//                 and the Form 26AS lines uploaded
//  upload26as()   the portal's 26AS / AIS as CSV or Excel, matched to
//                 customers by TAN, else by name
//  purchases194q() per supplier, purchases of goods in the year against
//                 the ₹50 lakh limit, and TDS deducted under 194Q
// ══════════════════════════════════════════════════════════════════

const Payment = require('../models/Payment');
const Supplier = require('../models/Supplier');
const Customer = require('../models/Customer');
const SupplierBill = require('../models/SupplierBill');
const TdsChallan = require('../models/TdsChallan');
const TdsCertificate = require('../models/TdsCertificate');
const Tds26asEntry = require('../models/Tds26asEntry');
const { parseCsv, sheetRows, parseDate } = require('./bankStatement');
const { getSettings } = require('./booksLock');
const { withTxn } = require('./accountsHelpers');
const { onceAtATime } = require('../utils/onceAtATime');
const { once } = require('./posting');

const { r2 } = require('../utils/money');
const DAY = 86_400_000;

function fyRange(fy) {
  const [y1] = String(fy).split('-').map(Number);
  return { from: new Date(y1, 3, 1), to: new Date(y1 + 1, 2, 31, 23, 59, 59, 999), y1 };
}
const fyOf = (d) => { const x = new Date(d); const y = x.getMonth() >= 3 ? x.getFullYear() : x.getFullYear() - 1; return `${y}-${String(y + 1).slice(2)}`; };
const quarterOf = (d) => { const m = new Date(d).getMonth(); return m >= 3 && m <= 5 ? 'Q1' : m >= 6 && m <= 8 ? 'Q2' : m >= 9 && m <= 11 ? 'Q3' : 'Q4'; };
function quarterRange(fy, q) {
  const { y1 } = fyRange(fy);
  const start = { Q1: [y1, 3], Q2: [y1, 6], Q3: [y1, 9], Q4: [y1 + 1, 0] }[q];
  return { from: new Date(start[0], start[1], 1), to: new Date(start[0], start[1] + 3, 0, 23, 59, 59, 999) };
}
/** The 7th of the next month; 30 April for March. */
function dueDate(month) {
  const [y, m] = month.split('-').map(Number);
  return m === 3 ? new Date(y, 3, 30) : new Date(y, m, 7);
}
/** s.201(1A): 1.5% a month, part of a month counted whole, from the deduction to the deposit. */
function interestOn(amount, deductedOn, depositedOn) {
  const d = new Date(deductedOn); const p = new Date(depositedOn);
  if (p <= d) return 0;
  const months = (p.getFullYear() - d.getFullYear()) * 12 + (p.getMonth() - d.getMonth()) + (p.getDate() > d.getDate() ? 1 : 0);
  return r2(amount * 0.015 * Math.max(1, months));
}

async function register(month) {
  const [y, m] = month.split('-').map(Number);
  const from = new Date(y, m - 1, 1); const to = new Date(y, m, 0, 23, 59, 59, 999);
  const vouchers = await Payment.find({ status: 'posted', kind: 'payment', 'tds.amount': { $gt: 0 }, date: { $gte: from, $lte: to } }).select('voucherNo date supplier partyName amount tds allocations').sort({ date: 1 }).lean();
  const challans = await TdsChallan.find({ month }).sort({ depositedOn: 1 }).lean();
  const bySection = new Map();
  for (const v of vouchers) {
    const s = v.tds.section || '—';
    const g = bySection.get(s) || { section: s, deducted: 0, count: 0, deposited: 0, interestPaid: 0, challans: [] };
    g.deducted = r2(g.deducted + v.tds.amount); g.count += 1;
    bySection.set(s, g);
  }
  for (const c of challans) {
    const g = bySection.get(c.section) || { section: c.section, deducted: 0, count: 0, deposited: 0, interestPaid: 0, challans: [] };
    g.deposited = r2(g.deposited + c.amount); g.interestPaid = r2(g.interestPaid + (c.interest || 0));
    g.challans.push({ _id: c._id, amount: c.amount, interest: c.interest || 0, bsrCode: c.bsrCode, challanNo: c.challanNo, depositedOn: c.depositedOn });
    bySection.set(c.section, g);
  }
  const due = dueDate(month);
  const today = new Date();
  const rows = [...bySection.values()].map((g) => {
    const balance = r2(g.deducted - g.deposited);
    // Interest the balance is running up if deposited today, counted from the month's end.
    const interestDue = balance > 0.005 && today > due ? interestOn(balance, to, today) : 0;
    return { ...g, balance, interestDue, late: balance > 0.005 && today > due };
  }).sort((a, b) => a.section.localeCompare(b.section));
  return {
    month, from, to, due, rows,
    totals: { deducted: r2(rows.reduce((t, r) => t + r.deducted, 0)), deposited: r2(rows.reduce((t, r) => t + r.deposited, 0)), balance: r2(rows.reduce((t, r) => t + r.balance, 0)), interestDue: r2(rows.reduce((t, r) => t + r.interestDue, 0)) },
    vouchers: vouchers.map((v) => ({ _id: v._id, voucherNo: v.voucherNo, date: v.date, partyName: v.partyName, section: v.tds.section, rate: v.tds.rate, base: v.tds.base, tds: v.tds.amount, docs: (v.allocations || []).map((a) => a.docNo) })),
  };
}

/**
 * Record a challan, once: the same request sent twice is answered by
 * the challan the first made, and a challan already on the register
 * (same bank code, serial, date, month, section and amount) is refused.
 * @returns {{ challan, replay }}
 */
async function addChallan({ month, section, amount, interest = 0, bsrCode, challanNo, depositedOn, account, note, by, requestId }) {
  if (!/^\d{4}-\d{2}$/.test(String(month || ''))) throw Object.assign(new Error('month must be YYYY-MM'), { status: 400 });
  if (!(r2(amount) > 0)) throw Object.assign(new Error('amount must be more than 0'), { status: 400 });
  if (!section) throw Object.assign(new Error('section is required'), { status: 400 });
  if (!depositedOn) throw Object.assign(new Error('depositedOn is required'), { status: 400 });
  const data = { month, section: String(section).toUpperCase(), amount: r2(amount), interest: r2(interest), bsrCode: String(bsrCode || '').trim(), challanNo: String(challanNo || '').trim(), depositedOn, account: account || undefined, note: String(note || '').trim(), createdBy: by || undefined };
  const already = () => Object.assign(new Error(`Challan ${data.challanNo} of ${depositedOn.toISOString().slice(0, 10)} for ₹${data.amount.toFixed(2)} is already recorded for ${month}, section ${data.section}`), { status: 409 });
  try {
    const { doc, replay } = await once(TdsChallan, requestId, async (id) => {
      if (data.challanNo && await TdsChallan.exists({ month, section: data.section, bsrCode: data.bsrCode, challanNo: data.challanNo, depositedOn, amount: data.amount })) throw already();
      return (await TdsChallan.create({ ...data, requestId: id })).toObject();
    });
    return { challan: doc, replay };
  } catch (err) {
    if (err?.code === 11000) throw already();   // two saves together: the index let one in
    throw err;
  }
}

/** The quarter's deductee-wise rows and the checks a return preparer makes. */
async function form26q(fy, q) {
  const { from, to } = quarterRange(fy, q);
  const vouchers = await Payment.find({ status: 'posted', kind: 'payment', 'tds.amount': { $gt: 0 }, date: { $gte: from, $lte: to } }).select('voucherNo date supplier partyName amount tds allocations').sort({ date: 1 }).lean();
  const ids = [...new Set(vouchers.map((v) => String(v.supplier)).filter((x) => x !== 'undefined' && x !== 'null'))];
  const suppliers = new Map((await Supplier.find({ _id: { $in: ids } }).select('name pan').lean()).map((s) => [String(s._id), s]));
  const months = [...new Set(vouchers.map((v) => `${v.date.getFullYear()}-${String(v.date.getMonth() + 1).padStart(2, '0')}`))];
  const challans = await TdsChallan.find({ month: { $in: months } }).lean();
  const challanOf = (month, section) => challans.filter((c) => c.month === month && c.section === section).map((c) => `${c.bsrCode}/${c.challanNo}/${c.depositedOn.toISOString().slice(0, 10)}`).join(', ');
  const checks = [];
  const rows = vouchers.map((v) => {
    const s = suppliers.get(String(v.supplier)) || {};
    const pan = s.pan || '';
    const month = `${v.date.getFullYear()}-${String(v.date.getMonth() + 1).padStart(2, '0')}`;
    const base = r2(v.tds.base || v.amount + v.tds.amount);
    if (!pan) checks.push({ level: 'error', doc: v.voucherNo, text: `${v.partyName}: no PAN on file — without one, tax should have been deducted at 20% (s.206AA), and the return cannot carry the line` });
    else if (!/^[A-Z]{5}\d{4}[A-Z]$/.test(pan)) checks.push({ level: 'error', doc: v.voucherNo, text: `${v.partyName}: PAN ${pan} is not in the PAN form` });
    if (!challanOf(month, v.tds.section)) checks.push({ level: 'warn', doc: v.voucherNo, text: `No challan recorded for ${v.tds.section} of ${month}` });
    return { voucherNo: v.voucherNo, date: v.date, supplier: v.supplier, deductee: v.partyName, pan, section: v.tds.section, rate: v.tds.rate, amountPaid: base, tds: v.tds.amount, docs: (v.allocations || []).map((a) => a.docNo), challan: challanOf(month, v.tds.section) };
  });
  const issued = await TdsCertificate.find({ kind: 'issued', fy, quarter: q }).lean();
  return { fy, quarter: q, from, to, rows, checks, totals: { amountPaid: r2(rows.reduce((t, r) => t + r.amountPaid, 0)), tds: r2(rows.reduce((t, r) => t + r.tds, 0)), deductees: new Set(rows.map((r) => String(r.supplier))).size }, certificates: issued };
}

/** What customers deducted from us in a year, by customer: books, certificates, 26AS. */
async function receivable(fy) {
  const { from, to } = fyRange(fy);
  const receipts = await Payment.find({ status: 'posted', kind: 'receipt', date: { $gte: from, $lte: to }, 'adjustments.kind': 'tds_by_customer' }).select('voucherNo date customer partyName adjustments').lean();
  const byCustomer = new Map();
  for (const r of receipts) {
    const amt = r2((r.adjustments || []).filter((a) => a.kind === 'tds_by_customer').reduce((t, a) => t + a.amount, 0));
    if (amt <= 0) continue;
    const k = String(r.customer);
    const g = byCustomer.get(k) || { customer: r.customer, customerName: r.partyName, deducted: 0, receipts: [], certificates: 0, in26as: 0 };
    g.deducted = r2(g.deducted + amt); g.receipts.push({ voucherNo: r.voucherNo, date: r.date, amount: amt });
    byCustomer.set(k, g);
  }
  for (const c of await TdsCertificate.find({ kind: 'received', fy }).lean()) {
    const k = String(c.party);
    const g = byCustomer.get(k) || { customer: c.party, customerName: c.partyName, deducted: 0, receipts: [], certificates: 0, in26as: 0 };
    g.certificates = r2(g.certificates + c.amount);
    byCustomer.set(k, g);
  }
  const as = await Tds26asEntry.find({ fy }).lean();
  let unmatched26as = 0;
  for (const e of as) {
    if (!e.customer) { unmatched26as = r2(unmatched26as + e.tds); continue; }
    const k = String(e.customer);
    const g = byCustomer.get(k) || { customer: e.customer, customerName: e.deductorName, deducted: 0, receipts: [], certificates: 0, in26as: 0 };
    g.in26as = r2(g.in26as + e.tds);
    byCustomer.set(k, g);
  }
  const rows = [...byCustomer.values()].map((g) => ({ ...g, short26as: r2(g.deducted - g.in26as), state: as.length === 0 ? 'no26as' : Math.abs(g.deducted - g.in26as) <= 1 ? 'matched' : g.in26as < g.deducted ? 'short' : 'more' })).sort((a, b) => b.deducted - a.deducted);
  return {
    fy, rows, has26as: as.length > 0, unmatched26as,
    totals: { deducted: r2(rows.reduce((t, r) => t + r.deducted, 0)), certificates: r2(rows.reduce((t, r) => t + r.certificates, 0)), in26as: r2(rows.reduce((t, r) => t + r.in26as, 0)) },
  };
}

/** Read the portal's 26AS / AIS export: CSV or Excel with deductor, TAN, section, date, amount paid, TDS. */
async function parse26as(buffer, filename = '') {
  const isSheet = /\.xlsx?$/i.test(filename);
  const table = isSheet ? await sheetRows(buffer) : parseCsv(buffer.toString('utf8').replace(/^﻿/, ''));
  let cols = null; let headerAt = -1;
  for (let i = 0; i < Math.min(table.length, 40); i++) {
    const h = (table[i] || []).map((x) => String(x || '').trim().toLowerCase());
    const find = (re) => h.findIndex((x) => re.test(x));
    const c = { name: find(/deductor|name of/), tan: find(/\btan\b/), section: find(/section/), date: find(/date/), amount: find(/amount paid|amount credited|total amount|amount/), tds: find(/tax deducted|tds|total tax/) };
    if (c.tds >= 0 && (c.tan >= 0 || c.name >= 0)) { cols = c; headerAt = i; break; }
  }
  if (!cols) throw Object.assign(new Error('Could not find the 26AS columns (deductor, TAN, section, date, amount paid, tax deducted). Export Form 26AS as CSV or Excel from the income-tax portal.'), { status: 400 });
  const rows = [];
  for (let i = headerAt + 1; i < table.length; i++) {
    const r = table[i]; if (!r) continue;
    const tds = Number(String(r[cols.tds] ?? '').replace(/[,\s]/g, ''));
    if (!(tds > 0)) continue;
    rows.push({ deductorName: String(cols.name >= 0 ? r[cols.name] : '').trim(), tan: String(cols.tan >= 0 ? r[cols.tan] : '').trim().toUpperCase(), section: String(cols.section >= 0 ? r[cols.section] : '').trim().toUpperCase(), date: cols.date >= 0 ? parseDate(r[cols.date]) : null, amountPaid: r2(String(cols.amount >= 0 ? r[cols.amount] : '0').replace(/[,\s]/g, '')), tds: r2(tds) });
  }
  return rows;
}

const normName = (s) => String(s || '').toUpperCase().replace(/\b(PVT|PRIVATE|LTD|LIMITED|CO|COMPANY|THE|M\/S|&|AND)\b/g, ' ').replace(/[^A-Z0-9]/g, '');

async function upload26as({ fy, buffer, filename, by }) {
  const rows = await parse26as(buffer, filename);
  const customers = await Customer.find({}).select('name tan').lean();
  const byTan = new Map(customers.filter((c) => c.tan).map((c) => [c.tan.toUpperCase(), c]));
  const learnt = [];
  const docs = rows.map((r) => {
    let customer = r.tan ? byTan.get(r.tan) : null; let matchedBy = customer ? 'tan' : '';
    if (!customer && r.deductorName) {
      const n = normName(r.deductorName);
      // The same name: that customer, and their TAN is learnt for next
      // time. A name that only contains the other ("RAJA" in "MAHARAJA
      // TEXTILES") still places the row, to be looked at — but a TAN is
      // never learnt from it: saved on the wrong customer it would map
      // every later line of that deductor to them, by TAN, without a doubt.
      const exact = customers.find((c) => normName(c.name) === n) || null;
      customer = exact || customers.find((c) => { const m = normName(c.name); return m.length >= 4 && (n.includes(m) || m.includes(n)); }) || null;
      matchedBy = customer ? 'name' : '';
      if (exact && r.tan && !exact.tan) { learnt.push({ customer: exact._id, tan: r.tan }); exact.tan = r.tan; byTan.set(r.tan, exact); }
    }
    return { fy, ...r, customer: customer?._id, matchedBy, uploadedBy: by || undefined };
  });
  // One upload at a time for a year, and the year's old rows go only if
  // the new ones arrive: they were deleted and then inserted in two
  // steps, so a file that failed half way left the year empty, and two
  // uploads together left it double.
  await onceAtATime(`tds-26as:${fy}`, () => withTxn(async (session) => {
    await Tds26asEntry.deleteMany({ fy }, { session });
    if (docs.length) await Tds26asEntry.insertMany(docs, { session });
  }), { what: 'This year\'s Form 26AS' });
  for (const l of learnt) await Customer.updateOne({ _id: l.customer, $or: [{ tan: '' }, { tan: null }, { tan: { $exists: false } }] }, { $set: { tan: l.tan } });
  return { fy, lines: docs.length, matched: docs.filter((d) => d.customer).length, unmatched: docs.filter((d) => !d.customer).map((d) => ({ deductorName: d.deductorName, tan: d.tan, tds: d.tds })) };
}

/** s.194Q: goods bought from each supplier in the year against the limit, and TDS deducted under it. */
async function purchases194q(fy) {
  const { from, to } = fyRange(fy);
  const s = (await getSettings()).tds?.purchase194q || { enabled: false, limit: 5000000, rate: 0.1 };
  const bills = await SupplierBill.aggregate([
    { $match: { status: { $ne: 'cancelled' }, kind: 'goods', billDate: { $gte: from, $lte: to } } },
    { $group: { _id: '$supplier', supplierName: { $first: '$supplierName' }, taxable: { $sum: '$totals.taxable' }, bills: { $sum: 1 }, flagged: { $sum: { $cond: [{ $eq: ['$tds.section', '194Q'] }, 1, 0] } } } },
    { $sort: { taxable: -1 } },
  ]);
  const deducted = await Payment.aggregate([
    { $match: { status: 'posted', kind: 'payment', 'tds.section': '194Q', date: { $gte: from, $lte: to } } },
    { $group: { _id: '$supplier', tds: { $sum: '$tds.amount' } } },
  ]);
  const tdsBy = new Map(deducted.map((d) => [String(d._id), r2(d.tds)]));
  const pans = new Map((await Supplier.find({ _id: { $in: bills.map((b) => b._id) } }).select('pan').lean()).map((p) => [String(p._id), p.pan || '']));
  const rows = bills.map((b) => ({ supplier: b._id, supplierName: b.supplierName, pan: pans.get(String(b._id)) || '', purchases: r2(b.taxable), bills: b.bills, billsFlagged: b.flagged, over: r2(Math.max(0, b.taxable - s.limit)), crossed: b.taxable > s.limit, tdsDue: r2(Math.max(0, b.taxable - s.limit) * s.rate / 100), tdsDeducted: tdsBy.get(String(b._id)) || 0 }));
  return { fy, settings: s, rows, totals: { crossed: rows.filter((r) => r.crossed).length, tdsDue: r2(rows.reduce((t, r) => t + r.tdsDue, 0)), tdsDeducted: r2(rows.reduce((t, r) => t + r.tdsDeducted, 0)) } };
}

/**
 * For a new goods bill: should 194Q apply? When enabled and this
 * supplier's goods purchases in the year, with this bill, pass the
 * limit (and the bill carries no TDS already).
 */
async function apply194q(supplierId, billDate, taxable) {
  const s = (await getSettings()).tds?.purchase194q;
  if (!s?.enabled) return null;
  const { from, to } = fyRange(fyOf(billDate));
  const [agg] = await SupplierBill.aggregate([
    { $match: { supplier: supplierId, status: { $ne: 'cancelled' }, kind: 'goods', billDate: { $gte: from, $lte: to } } },
    { $group: { _id: null, taxable: { $sum: '$totals.taxable' } } },
  ]);
  const before = r2(agg?.taxable || 0);
  if (before + taxable <= s.limit) return null;
  return { section: '194Q', rate: s.rate, before, limit: s.limit, over: r2(before + taxable - s.limit) };
}

module.exports = { register, addChallan, form26q, receivable, upload26as, parse26as, purchases194q, apply194q, dueDate, interestOn, fyOf, quarterOf, quarterRange, fyRange };
