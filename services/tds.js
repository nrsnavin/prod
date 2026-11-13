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
const outstanding = require('./outstanding');

const { r2 } = require('../utils/money');
const DAY = 86_400_000;

// Years, quarters and months are read off the books' own calendar
// (utils/bizDates.js), never off the clock of the machine this runs on.
const { fyRange, fyOf, quarterOf, quarterRange, monthRange, monthKey, parts, at, today: businessToday } = require('../utils/bizDates');

/** The 7th of the next month; 30 April for March. */
function dueDate(month) {
  const { y, m } = monthRange(month);
  return m === 3 ? at(y, 4, 30) : at(y, m + 1, 7);
}
/**
 * s.201(1A): 1.5% a month from the deduction to the deposit, and a part
 * of a month is a month. The department counts CALENDAR months: tax
 * deducted on 31 May and deposited on 8 June has run for May and June,
 * two months, though nine days apart. (It was counted date to date,
 * which made that one.)
 */
function interestOn(amount, deductedOn, depositedOn) {
  const d = parts(deductedOn); const p = parts(depositedOn);
  if (!d || !p || at(p.y, p.m, p.d) <= at(d.y, d.m, d.d)) return 0;
  const months = (p.y - d.y) * 12 + (p.m - d.m) + 1;
  return r2(amount * 0.015 * Math.max(1, months));
}

/**
 * What a payment voucher deducted, section by section. A voucher that
 * pays bills under two sections (a contractor's bill and a professional
 * fee, say) keeps the section and the rate on each allocation; a voucher
 * posted before that was kept has the one section on the voucher.
 * @returns [{ section, rate, base, tds, docs }]
 */
function sectionsOf(v) {
  const withTds = (v.allocations || []).filter((a) => a.tds > 0);
  if (!withTds.length || withTds.some((a) => a.section === undefined || a.section === null)) {
    return [{ section: v.tds?.section || '', rate: v.tds?.rate || 0, base: r2(v.tds?.base || (v.amount || 0) + (v.tds?.amount || 0)), tds: r2(v.tds?.amount || 0), docs: (v.allocations || []).map((a) => a.docNo) }];
  }
  const by = new Map();
  for (const a of withTds) {
    const k = `${a.section || ''}|${a.rate || 0}`;
    const g = by.get(k) || { section: a.section || '', rate: a.rate || 0, base: 0, tds: 0, docs: [] };
    g.base = r2(g.base + (a.tdsBase || 0)); g.tds = r2(g.tds + a.tds); g.docs.push(a.docNo);
    by.set(k, g);
  }
  return [...by.values()];
}

async function register(month) {
  const { from, to } = monthRange(month);
  const vouchers = await Payment.find({ status: 'posted', kind: 'payment', 'tds.amount': { $gt: 0 }, date: { $gte: from, $lte: to } }).select('voucherNo date supplier partyName amount tds allocations').sort({ date: 1 }).lean();
  const challans = await TdsChallan.find({ month }).sort({ depositedOn: 1 }).lean();
  const bySection = new Map();
  for (const v of vouchers) for (const part of sectionsOf(v)) {
    const s = part.section || '—';
    const g = bySection.get(s) || { section: s, deducted: 0, count: 0, deposited: 0, interestPaid: 0, challans: [] };
    g.deducted = r2(g.deducted + part.tds); g.count += 1;
    bySection.set(s, g);
  }
  for (const c of challans) {
    const g = bySection.get(c.section) || { section: c.section, deducted: 0, count: 0, deposited: 0, interestPaid: 0, challans: [] };
    g.deposited = r2(g.deposited + c.amount); g.interestPaid = r2(g.interestPaid + (c.interest || 0));
    g.challans.push({ _id: c._id, amount: c.amount, interest: c.interest || 0, bsrCode: c.bsrCode, challanNo: c.challanNo, depositedOn: c.depositedOn });
    bySection.set(c.section, g);
  }
  const due = dueDate(month);
  // Late from the day after the due day, by the calendar the books keep.
  const today = businessToday();
  const rows = [...bySection.values()].map((g) => {
    const balance = r2(g.deducted - g.deposited);
    // Interest the balance is running up if deposited today, counted from the month's end.
    const interestDue = balance > 0.005 && today > due ? interestOn(balance, to, today) : 0;
    return { ...g, balance, interestDue, late: balance > 0.005 && today > due };
  }).sort((a, b) => a.section.localeCompare(b.section));
  return {
    month, from, to, due, rows,
    totals: { deducted: r2(rows.reduce((t, r) => t + r.deducted, 0)), deposited: r2(rows.reduce((t, r) => t + r.deposited, 0)), balance: r2(rows.reduce((t, r) => t + r.balance, 0)), interestDue: r2(rows.reduce((t, r) => t + r.interestDue, 0)) },
    vouchers: vouchers.flatMap((v) => sectionsOf(v).map((part) => ({ _id: v._id, voucherNo: v.voucherNo, date: v.date, partyName: v.partyName, section: part.section, rate: part.rate, base: part.base, tds: part.tds, docs: part.docs }))),
    // Booked and not yet paid: tax that was due to be deducted when the
    // bill was credited (see notDeducted below).
    notDeducted: await notDeducted({ asOf: to }),
  };
}

/**
 * TDS ON BILLS BOOKED AND NOT YET PAID
 *
 * These books deduct TDS when a bill is PAID: the payment voucher works
 * it out and the register, 26Q and the challan follow the payment's
 * date. The law asks for the deduction when the supplier is credited
 * or paid, whichever comes first (s.194C, 194J and the rest), so a bill
 * booked in March and paid in April owes its TDS in March: deposited
 * late it bears interest, and at the year's end 30% of an expense on
 * which tax was not deducted can be disallowed (s.40(a)(ia)).
 *
 * Whether to book TDS at the bill is a decision for the firm and its
 * accountant. Until it is made the other way, this is the check: every
 * bill of the financial year, carrying a TDS section, that was still
 * unpaid (in whole or part) at the end of the period asked, with the
 * tax on its unpaid share.
 *
 * @param asOf  the period's end (a month's or the year's last moment)
 * @returns {{ asOf, rows: [{ _id, billNo, supplierBillNo, supplierName, billDate, section, rate, unpaid, base, tds, month }], total, base }}
 */
async function notDeducted({ asOf }) {
  const { from } = fyRange(fyOf(asOf));
  const bills = await SupplierBill.find({ status: { $ne: 'cancelled' }, 'tds.applicable': true, 'tds.rate': { $gt: 0 }, billDate: { $gte: from, $lte: asOf } })
    .select('billNo supplierBillNo supplier supplierName billDate totals tds paidAmount tdsAmount debitedAmount').sort({ billDate: 1 }).lean();
  if (!bills.length) return { asOf, rows: [], total: 0, base: 0 };
  // What was paid by the period's end: a payment dated later had not been made yet.
  const later = await Payment.find({ status: 'posted', date: { $gt: asOf }, 'allocations.doc': { $in: bills.map((b) => b._id) } }).select('allocations').lean();
  const paidLater = new Map();
  for (const v of later) for (const a of v.allocations || []) if (a.docType === 'SupplierBill') paidLater.set(String(a.doc), r2((paidLater.get(String(a.doc)) || 0) + a.amount));
  const rows = [];
  for (const b of bills) {
    const grand = r2(b.totals?.grand || 0);
    const unpaid = r2(grand - (b.paidAmount || 0) - (b.tdsAmount || 0) - (b.debitedAmount || 0) + (paidLater.get(String(b._id)) || 0));
    if (unpaid <= 0.005 || grand <= 0) continue;
    // TDS is on the value net of GST: the unpaid share of the taxable value.
    const base = r2(Math.min(unpaid, grand) * outstanding.ratio(b.totals));
    const tds = r2(base * b.tds.rate / 100);
    if (tds < 0.5) continue;
    rows.push({ _id: b._id, billNo: b.billNo, supplierBillNo: b.supplierBillNo, supplierName: b.supplierName, billDate: b.billDate, section: b.tds.section || '', rate: b.tds.rate, unpaid, base, tds, month: monthKey(b.billDate) });
  }
  return { asOf, rows, total: r2(rows.reduce((t, r) => t + r.tds, 0)), base: r2(rows.reduce((t, r) => t + r.base, 0)) };
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
  const months = [...new Set(vouchers.map((v) => monthKey(v.date)))];
  const challans = await TdsChallan.find({ month: { $in: months } }).lean();
  const challanOf = (month, section) => challans.filter((c) => c.month === month && c.section === section).map((c) => `${c.bsrCode}/${c.challanNo}/${c.depositedOn.toISOString().slice(0, 10)}`).join(', ');
  const checks = [];
  // One line for each section a voucher deducted under: the return is filed section by section.
  const rows = vouchers.flatMap((v) => {
    const s = suppliers.get(String(v.supplier)) || {};
    const pan = s.pan || '';
    const month = monthKey(v.date);
    if (!pan) checks.push({ level: 'error', doc: v.voucherNo, text: `${v.partyName}: no PAN on file — without one, tax should have been deducted at 20% (s.206AA), and the return cannot carry the line` });
    else if (!/^[A-Z]{5}\d{4}[A-Z]$/.test(pan)) checks.push({ level: 'error', doc: v.voucherNo, text: `${v.partyName}: PAN ${pan} is not in the PAN form` });
    return sectionsOf(v).map((part) => {
      if (!challanOf(month, part.section)) checks.push({ level: 'warn', doc: v.voucherNo, text: `No challan recorded for ${part.section} of ${month}` });
      return { voucherNo: v.voucherNo, date: v.date, supplier: v.supplier, deductee: v.partyName, pan, section: part.section, rate: part.rate, amountPaid: part.base, tds: part.tds, docs: part.docs, challan: challanOf(month, part.section) };
    });
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
  return store26as({ fy, rows: await parse26as(buffer, filename), by });
}

/**
 * A year's Form 26AS lines, from a CSV or Excel file or read from the PDF
 * (services/tdsPapers.js): each placed on a customer (by TAN, else name)
 * and the year's lines replaced with these.
 */
async function store26as({ fy, rows, by }) {
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

module.exports = { register, addChallan, form26q, receivable, upload26as, store26as, parse26as, purchases194q, apply194q, dueDate, interestOn, fyOf, quarterOf, quarterRange, fyRange, sectionsOf, notDeducted };
