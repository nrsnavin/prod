'use strict';
// ══════════════════════════════════════════════════════════════════
//  WHAT THE BOOKS NOTICE
//
//  anomalies()        flags on a bill or expense BEFORE it is saved:
//                     the same amount from the same supplier lately, a
//                     rate off the last few bills, a GSTIN that is not
//                     the supplier's, a bill past its ITC window, an
//                     expense just under the approval limit again
//  suggestCategory()  the head an expense most likely belongs under,
//                     from what this payee's expenses were before
//  forecast()         cash in the next weeks, from when each customer
//                     actually pays (not when the invoice says), what we
//                     owe and when, and the recurring expenses
//  closeChecklist()   what is left before a month can be closed
// ══════════════════════════════════════════════════════════════════

const mongoose = require('mongoose');
const SupplierBill = require('../models/SupplierBill');
const Expense = require('../models/Expense');
const ExpenseCategory = require('../models/ExpenseCategory');
const Supplier = require('../models/Supplier');
const Customer = require('../models/Customer');
const Invoice = require('../models/Invoice');
const Payment = require('../models/Payment');
const Contra = require('../models/Contra');
const Journal = require('../models/Journal');
const BankAccount = require('../models/BankAccount');
const BankStatement = require('../models/BankStatement');
const RecurringExpense = require('../models/RecurringExpense');
const AccountNote = require('../models/AccountNote');
const Payroll = require('../models/Payroll');
const outstanding = require('./outstanding');
const credits = require('./credits');
const gstSummary = require('./gstSummary');
const bankBalances = require('./bankBalances');
const { occurrences } = require('./recurring');
const { getSettings } = require('./booksLock');

const DAY = 86_400_000;
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const fmt = (n) => (Number(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
const dmy = (d) => new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

/** The last day ITC on an invoice of this date can be claimed: 30 Nov after its financial year. */
function itcDeadline(date) {
  const d = new Date(date);
  const fyEndYear = d.getMonth() >= 3 ? d.getFullYear() + 1 : d.getFullYear();
  return new Date(fyEndYear, 10, 30, 23, 59, 59);
}

/**
 * @param kind  'bill' | 'expense'
 * @param b     the form's body: supplier, supplierBillNo, billDate|date, lines,
 *              grand (or amount), scannedGstin, category, _id (when editing)
 */
async function anomalies(kind, b, user) {
  const flags = [];
  const date = new Date(b.billDate || b.date || Date.now());
  const grand = r2(b.grand ?? b.amount ?? (Array.isArray(b.lines) ? b.lines.reduce((s, l) => s + (Number(l.quantity) || 0) * (Number(l.rate) || 0) * (1 + (Number(l.gstPercent) || 0) / 100), 0) : 0));
  const supplier = mongoose.Types.ObjectId.isValid(String(b.supplier || '')) ? await Supplier.findById(b.supplier).select('name gstin pan gstRegistration').lean() : null;

  if (date > new Date(Date.now() + DAY)) flags.push({ code: 'FUTURE_DATE', severity: 'warning', message: `Dated ${dmy(date)}, in the future` });

  if (supplier && grand > 0) {
    // 1. The same amount from the same supplier in the last 30 days.
    const Model = kind === 'bill' ? SupplierBill : Expense;
    const dateField = kind === 'bill' ? 'billDate' : 'date';
    const twin = await Model.findOne({
      supplier: supplier._id, status: { $nin: ['cancelled', 'rejected'] },
      [dateField]: { $gte: new Date(date.getTime() - 30 * DAY), $lte: new Date(date.getTime() + 30 * DAY) },
      'totals.grand': { $gte: grand - 1, $lte: grand + 1 },
    }).select(`${kind === 'bill' ? 'billNo supplierBillNo' : 'expenseNo'} ${dateField}`).lean();
    if (twin) {
      flags.push({ code: 'SAME_AMOUNT', severity: 'danger', message: `₹${fmt(grand)} from ${supplier.name} is already entered as ${twin.billNo || twin.expenseNo}${twin.supplierBillNo ? ` (their ${twin.supplierBillNo})` : ''} on ${dmy(twin[dateField])} — the same bill twice?` });
    }
    // 2. A GSTIN read off the bill that is not the supplier's.
    const read = String(b.scannedGstin || '').trim().toUpperCase();
    if (read && supplier.gstin && read !== String(supplier.gstin).toUpperCase()) {
      flags.push({ code: 'GSTIN_MISMATCH', severity: 'danger', message: `The bill's GSTIN ${read} is not ${supplier.name}'s (${supplier.gstin}) — input credit goes to the GSTIN on the bill` });
    }
  }

  // 3. A rate off this supplier's last three bills for the same material.
  if (kind === 'bill' && supplier) {
    for (const l of (b.lines || []).filter((x) => x.rawMaterial && Number(x.rate) > 0)) {
      const past = await SupplierBill.aggregate([
        { $match: { supplier: supplier._id, status: { $ne: 'cancelled' }, 'lines.rawMaterial': new mongoose.Types.ObjectId(String(l.rawMaterial)) } },
        { $sort: { billDate: -1 } }, { $limit: 3 }, { $unwind: '$lines' },
        { $match: { 'lines.rawMaterial': new mongoose.Types.ObjectId(String(l.rawMaterial)) } },
        { $group: { _id: null, avg: { $avg: '$lines.rate' }, n: { $sum: 1 } } },
      ]);
      const avg = past[0]?.avg;
      if (avg && Math.abs(Number(l.rate) - avg) / avg > 0.05) {
        flags.push({ code: 'RATE_OFF', severity: 'warning', message: `${l.description || 'A line'} at ₹${Number(l.rate)} — the last ${past[0].n} bill${past[0].n === 1 ? '' : 's'} averaged ₹${r2(avg)} (${Number(l.rate) > avg ? '+' : ''}${r2((Number(l.rate) - avg) / avg * 100)}%)` });
      }
    }
  }

  // 4. The ITC window.
  if (kind === 'bill' && b.itcEligible !== false) {
    const deadline = itcDeadline(date);
    if (Date.now() > deadline.getTime()) flags.push({ code: 'ITC_EXPIRED', severity: 'danger', message: `Input credit on a bill dated ${dmy(date)} could only be claimed until ${dmy(deadline)}` });
    else if (Date.now() - date.getTime() > 60 * DAY) flags.push({ code: 'OLD_BILL', severity: 'info', message: `Dated ${dmy(date)}: claim its input credit in this month's return (by ${dmy(deadline)} at the latest)` });
  }

  // 5. An expense just under the approval limit, again this week.
  if (kind === 'expense' && mongoose.Types.ObjectId.isValid(String(b.category || ''))) {
    const cat = await ExpenseCategory.findById(b.category).select('name approvalAbove').lean();
    const limit = cat?.approvalAbove || 0;
    if (limit > 0 && grand <= limit && grand >= limit * 0.85 && user?._id) {
      const near = await Expense.countDocuments({
        submittedBy: user._id, category: cat._id, status: { $nin: ['cancelled', 'rejected'] },
        date: { $gte: new Date(date.getTime() - 7 * DAY) }, 'totals.grand': { $gte: limit * 0.85, $lte: limit },
      });
      if (near >= 1) flags.push({ code: 'UNDER_LIMIT', severity: 'warning', message: `${near + 1} ${cat.name} expenses this week just under the ₹${fmt(limit)} approval limit — one bill split in parts?` });
    }
  }
  // 6. GST and TDS coding (services/taxCoding.js).
  const category = mongoose.Types.ObjectId.isValid(String(b.category || '')) ? await ExpenseCategory.findById(b.category).select('name tdsSection itcEligible').lean() : null;
  const lines = Array.isArray(b.lines) ? b.lines
    : kind === 'expense' && Number(b.amount) > 0 ? [{ description: b.description || '', quantity: 1, rate: Number(b.amount), gstPercent: b.gstPercent }] : [];
  flags.push(...await require('./taxCoding').codingFlags({
    kind, date, supplier, lines, billKind: b.kind, category, description: b.description,
    reverseCharge: !!b.reverseCharge, itcEligible: b.itcEligible, tds: b.tds,
  }));
  return flags;
}

/** The likeliest head for an expense, and why. */
async function suggestCategory({ supplier, payee, description }) {
  const q = { status: { $nin: ['cancelled', 'rejected'] } };
  let basis = '';
  if (mongoose.Types.ObjectId.isValid(String(supplier || ''))) { q.supplier = new mongoose.Types.ObjectId(String(supplier)); basis = 'supplier'; }
  else if (String(payee || '').trim().length >= 3) { q.payeeName = new RegExp(`^${String(payee).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'); basis = 'payee'; }
  if (basis) {
    const past = await Expense.find(q).select('category categoryName payeeName').sort({ date: -1 }).limit(20).lean();
    if (past.length) {
      const count = new Map();
      for (const e of past) count.set(String(e.category), { n: (count.get(String(e.category))?.n || 0) + 1, name: e.categoryName });
      const [id, top] = [...count.entries()].sort((a, b) => b[1].n - a[1].n)[0];
      return { category: id, name: top.name, confidence: r2(top.n / past.length), reason: `${top.n} of the last ${past.length} expenses to ${past[0].payeeName || 'this payee'} were ${top.name}` };
    }
  }
  const words = String(description || '').toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 4);
  if (words.length) {
    const re = new RegExp(`\\b(${words.slice(0, 6).join('|')})`, 'i');
    const past = await Expense.find({ status: { $nin: ['cancelled', 'rejected'] }, description: re }).select('category categoryName').sort({ date: -1 }).limit(30).lean();
    if (past.length >= 2) {
      const count = new Map();
      for (const e of past) count.set(String(e.category), { n: (count.get(String(e.category))?.n || 0) + 1, name: e.categoryName });
      const [id, top] = [...count.entries()].sort((a, b) => b[1].n - a[1].n)[0];
      if (top.n / past.length >= 0.5) return { category: id, name: top.name, confidence: r2(top.n / past.length * 0.8), reason: `Expenses described like this were ${top.name} ${top.n} times out of ${past.length}` };
    }
  }
  return null;
}

/**
 * How many days after the invoice each customer actually pays, weighted
 * by amount, over the last year of receipts.
 */
async function payingDays() {
  const since = new Date(Date.now() - 365 * DAY);
  const rows = await Payment.aggregate([
    { $match: { kind: 'receipt', status: 'posted', date: { $gte: since } } },
    { $unwind: '$allocations' },
    { $match: { 'allocations.docType': 'Invoice' } },
    { $lookup: { from: 'invoices', localField: 'allocations.doc', foreignField: '_id', as: 'inv' } },
    { $unwind: '$inv' },
    { $project: { customer: '$customer', amount: '$allocations.amount', days: { $divide: [{ $subtract: ['$date', '$inv.invoiceDate'] }, DAY] } } },
    { $group: { _id: '$customer', weighted: { $sum: { $multiply: ['$amount', '$days'] } }, amount: { $sum: '$amount' }, n: { $sum: 1 } } },
  ]);
  return new Map(rows.filter((r) => r.amount > 0).map((r) => [String(r._id), { days: Math.max(0, Math.round(r.weighted / r.amount)), n: r.n }]));
}

// ── When customers actually pay, learned ──────────────────────────
//
// Every receipt of the last two years, invoice by invoice: how many days
// after the invoice it came, and how far past its terms. Recent payments
// count more (a half-life of six months), and big ones more than small.
// A customer with few payments of their own borrows the whole book's
// habit of paying past terms, until their own history is enough.

const HALF_LIFE_DAYS = 180;
const OWN_ENOUGH = 4;
const QUANTILES = [0.1, 0.3, 0.5, 0.7, 0.9];

async function payingProfiles(now = new Date()) {
  const since = new Date(now.getTime() - 730 * DAY);
  const rows = await Payment.aggregate([
    { $match: { kind: 'receipt', status: 'posted', date: { $gte: since } } },
    { $unwind: '$allocations' },
    { $match: { 'allocations.docType': 'Invoice' } },
    { $lookup: { from: 'invoices', localField: 'allocations.doc', foreignField: '_id', as: 'inv' } },
    { $unwind: '$inv' },
    { $project: { customer: '$customer', amount: '$allocations.amount', at: '$date', invoiceDate: '$inv.invoiceDate', dueDate: '$inv.dueDate' } },
  ]);
  const byCustomer = new Map();
  const book = [];
  for (const r of rows) {
    if (!(r.amount > 0) || !r.invoiceDate) continue;
    const days = Math.max(0, (new Date(r.at) - new Date(r.invoiceDate)) / DAY);
    const terms = r.dueDate ? (new Date(r.dueDate) - new Date(r.invoiceDate)) / DAY : null;
    const w = r.amount * 0.5 ** ((now - new Date(r.at)) / DAY / HALF_LIFE_DAYS);
    const sample = { days, late: terms == null ? null : days - terms, w };
    const k = String(r.customer);
    if (!byCustomer.has(k)) byCustomer.set(k, []);
    byCustomer.get(k).push(sample);
    book.push(sample);
  }
  return { byCustomer, book };
}

/** The weighted q-quantile of `field` over samples. */
function wq(samples, q, field = 'days') {
  const s = samples.filter((x) => x.w > 0).sort((a, b) => a[field] - b[field]);
  const total = s.reduce((t, x) => t + x.w, 0);
  if (!total) return null;
  let run = 0;
  for (const x of s) { run += x.w; if (run >= q * total) return x[field]; }
  return s[s.length - 1][field];
}

/**
 * A customer's paying days as samples: their own, and — while they have
 * fewer than OWN_ENOUGH — the book's lateness on their terms, weighted
 * for what is missing. Terms alone when nothing at all is known.
 */
function profileFor(profiles, customerId, termsDays) {
  const own = profiles.byCustomer.get(String(customerId)) || [];
  const n = own.length;
  if (n >= OWN_ENOUGH) return { samples: own, n, borrowed: false };
  const late = profiles.book.filter((x) => x.late != null);
  if (!late.length) return { samples: n ? own : [{ days: termsDays, w: 1 }], n, borrowed: false };
  const ownW = own.reduce((t, x) => t + x.w, 0) || 1;
  const bookW = late.reduce((t, x) => t + x.w, 0) || 1;
  const share = (OWN_ENOUGH - n) / OWN_ENOUGH;
  const scaleOwn = n ? (1 - share) / ownW : 0;
  const scaleBook = share / bookW;
  return {
    samples: [
      ...own.map((x) => ({ days: x.days, w: x.w * scaleOwn })),
      ...late.map((x) => ({ days: Math.max(0, termsDays + x.late), w: x.w * scaleBook })),
    ],
    n, borrowed: true,
  };
}

/**
 * Where an open invoice's money is likely to land: five equal shares at
 * the 10th–90th percentiles of the customer's paying days — counting
 * only the days past the invoice's age, since it is not paid yet. Past
 * every day they have ever taken: in one to three weeks.
 */
function placeInvoice(profile, invoiceDate, today) {
  const age = (today - new Date(invoiceDate)) / DAY;
  let cond = profile.samples.filter((x) => x.days > age);
  const total = profile.samples.reduce((t, x) => t + x.w, 0);
  const condW = cond.reduce((t, x) => t + x.w, 0);
  const lateNow = condW < 0.1 * total;
  if (lateNow) cond = [7, 14, 21].map((d) => ({ days: age + d, w: 1 }));
  const days = QUANTILES.map((q) => wq(cond, q));
  const at = (d) => { const t = new Date(new Date(invoiceDate).getTime() + d * DAY); return t < today ? new Date(today) : t; };
  return {
    points: days.map((d) => ({ date: at(d), share: 1 / QUANTILES.length })),
    p25: Math.round(wq(cond, 0.25)), p50: Math.round(wq(cond, 0.5)), p75: Math.round(wq(cond, 0.75)), lateNow,
  };
}

/** Monday 00:00 of the week `d` falls in. */
const weekStart = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; };

/**
 * Take a party's credit off its open documents, oldest due first, so the
 * forecast does not expect money that was already paid ahead.
 * Returns the rows with `outstanding` reduced and `ahead` set on those it touched.
 */
function netCredits(rows, credit) {
  const left = new Map([...credit.entries()].map(([k, v]) => [k, v.available]));
  return [...rows].sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate)).map((r) => {
    const k = String(r.party);
    const avail = left.get(k) || 0;
    if (avail <= 0.005) return r;
    const take = Math.min(avail, r.outstanding);
    left.set(k, r2(avail - take));
    return { ...r, outstanding: r2(r.outstanding - take), ahead: r2(take) };
  }).filter((r) => r.outstanding > 0.005);
}

const monthName = (y, m) => new Date(y, m, 1).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' });

/**
 * The day of the month salaries are usually paid, from the last six
 * months of paid slips; the 7th when there is no history.
 */
async function salaryDay(now) {
  const rows = await Payroll.find({ paidAt: { $gte: new Date(now.getTime() - 190 * DAY) } }).select('paidAt').lean();
  const days = rows.map((r) => new Date(r.paidAt).getDate()).sort((a, b) => a - b);
  return days.length ? days[Math.floor(days.length / 2)] : 7;
}

/**
 * What the law and the payroll will take that no bill shows: salaries,
 * TDS deposited by the 7th (30 April for March), GST by the 20th.
 */
async function statutoryAndPayroll(today, end) {
  const items = [];
  const y = today.getFullYear(); const m = today.getMonth();
  const at = (yy, mm, d) => new Date(yy, mm, Math.min(d, new Date(yy, mm + 1, 0).getDate()));
  const when = (d) => (d < today ? today : d);

  // Salaries. Slips not yet fully paid, then the latest month's total for
  // each month still to come whose pay day falls in the window.
  const payDay = await salaryDay(today);
  const slips = await Payroll.find({ status: { $ne: 'paid' } }).select('year month netPay amountPaid').lean();
  const owed = new Map();
  for (const s of slips) {
    const due = r2((s.netPay || 0) - (s.amountPaid || 0));
    if (due <= 0.005) continue;
    const k = `${s.year}-${s.month}`;
    owed.set(k, r2((owed.get(k) || 0) + due));
  }
  for (const [k, amount] of owed) {
    const [sy, sm] = k.split('-').map(Number);
    const payOn = at(sy, sm, payDay); // month sm (1-based) is paid in the month after
    // A slip whose pay day is long gone was paid by hand and never marked:
    // not money still to go out.
    if (payOn < new Date(today.getTime() - 45 * DAY)) continue;
    const d = when(payOn);
    if (d <= end) items.push({ direction: 'out', date: d, amount, party: 'Salaries', docNo: `Salaries ${monthName(sy, sm - 1)}`, basis: 'payroll not yet paid' });
  }
  const latest = await Payroll.aggregate([
    { $group: { _id: { year: '$year', month: '$month' }, net: { $sum: '$netPay' }, n: { $sum: 1 } } },
    { $sort: { '_id.year': -1, '_id.month': -1 } }, { $limit: 1 },
  ]);
  if (latest.length) {
    const { year: ly, month: lm } = latest[0]._id;
    // Months after the latest payroll, paid on pay day the month after each.
    for (let i = 1; i <= 4; i++) {
      const mm0 = lm - 1 + i; // 0-based month being earned
      const payOn = at(ly, mm0 + 1, payDay);
      if (payOn > end) break;
      if (payOn < today) continue;
      const ey = new Date(ly, mm0, 1);
      items.push({ direction: 'out', date: payOn, amount: r2(latest[0].net), party: 'Salaries', docNo: `Salaries ${monthName(ey.getFullYear(), ey.getMonth())}`, basis: `estimate: ${monthName(ly, lm - 1)} payroll, ${latest[0].n} people` });
    }
  }

  // TDS deducted last month and this month.
  for (const back of [1, 0]) {
    const from = new Date(y, m - back, 1);
    const to = new Date(y, m - back + 1, 0, 23, 59, 59, 999);
    const due = from.getMonth() === 2 ? at(from.getFullYear(), 3, 30) : at(from.getFullYear(), from.getMonth() + 1, 7);
    if (due < today || due > end) continue;
    const [t] = await Payment.aggregate([{ $match: { status: 'posted', kind: 'payment', date: { $gte: from, $lte: to }, 'tds.amount': { $gt: 0 } } }, { $group: { _id: null, amount: { $sum: '$tds.amount' } } }]);
    if (t?.amount > 0.005) items.push({ direction: 'out', date: due, amount: r2(t.amount), party: 'Income tax (TDS)', docNo: `TDS ${monthName(from.getFullYear(), from.getMonth())}`, basis: back ? 'deducted, to deposit' : 'deducted so far this month' });
  }

  // GST: last month's return by the 20th, and this month's so far.
  for (const back of [1, 0]) {
    const from = new Date(y, m - back, 1);
    const to = new Date(y, m - back + 1, 0, 23, 59, 59, 999);
    const due = at(from.getFullYear(), from.getMonth() + 1, 20);
    if (due < today || due > end) continue;
    const cash = gstSummary.cashDue(await gstSummary.summary({ from, to }));
    if (cash > 0.005) items.push({ direction: 'out', date: due, amount: cash, party: 'GST', docNo: `GST ${monthName(from.getFullYear(), from.getMonth())}`, basis: back ? 'net of input credit' : 'net of input credit, so far this month' });
  }
  return items;
}

async function forecast({ weeks = 6, now = new Date() } = {}) {
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const start = weekStart(today);
  const end = new Date(start.getTime() + weeks * 7 * DAY - 1);
  const accounts = await BankAccount.find({ active: true }).lean();
  const balances = await bankBalances.withBalances(accounts);
  const opening = r2(balances.reduce((s, a) => s + a.balance, 0));
  const [recvAll, payAll, profiles, recurring, customers, loose, customerCredits, supplierCredits, statutory, promises] = await Promise.all([
    outstanding.receivables({ asOf: today }), outstanding.payables({ asOf: today }), payingProfiles(today),
    RecurringExpense.find({ active: true }).lean(), Customer.find({}).select('paymentTerms').lean(),
    // Not in the payables: expenses still waiting for approval, and
    // approved ones with no supplier (the payee is paid directly).
    Expense.find({ $or: [{ status: 'pending' }, { status: 'approved', supplier: null }] }).select('expenseNo date dueDate payeeName description totals paidAmount status source').lean(),
    credits.byParty('customer'), credits.byParty('supplier'),
    statutoryAndPayroll(today, end),
    // A customer's live promise to pay sets the day, whatever their habit.
    require('../models/CollectionNote').aggregate([
      { $match: { kind: 'promise', promiseDate: { $gte: today } } },
      { $sort: { createdAt: -1 } },
      { $group: { _id: '$customer', date: { $first: '$promiseDate' }, amount: { $first: '$promiseAmount' } } },
    ]),
  ]);
  const recv = netCredits(recvAll, customerCredits);
  const pay = netCredits(payAll, supplierCredits);
  const terms = new Map(customers.map((c) => [String(c._id), parseInt(c.paymentTerms, 10) || 30]));
  const items = [];
  // Promised money, oldest invoices first, up to what was promised.
  const promised = new Map(promises.map((p) => [String(p._id), { date: new Date(p.date), left: p.amount > 0 ? p.amount : Infinity }]));
  for (const r of [...recv].sort((a, b) => new Date(a.date) - new Date(b.date))) {
    const ahead = r.ahead ? `, less ₹${fmt(r.ahead)} paid ahead` : '';
    const p = promised.get(String(r.party));
    if (p && p.left > 0.005) {
      const take = r2(Math.min(p.left, r.outstanding));
      p.left = r2(p.left - take);
      items.push({ direction: 'in', date: p.date, amount: take, party: r.partyName, docNo: r.docNo, basis: `promised by ${dmy(p.date)}${ahead}` });
      if (take >= r.outstanding - 0.005) continue;
      r.outstanding = r2(r.outstanding - take);
    }
    const termsDays = terms.get(String(r.party)) ?? 30;
    const profile = profileFor(profiles, r.party, termsDays);
    const place = placeInvoice(profile, r.date, today);
    const habit = profile.n
      ? `pays in ${place.p50} days${place.p25 !== place.p75 ? ` (usually ${place.p25}–${place.p75})` : ''} — ${profile.n} payment${profile.n === 1 ? '' : 's'}${profile.borrowed ? ', with the book\'s habit' : ''}`
      : profile.borrowed ? `terms ${termsDays} days, paid as the book usually pays (${place.p50} days)` : `terms ${termsDays} days`;
    const basis = `${habit}${place.lateNow ? ', already later than they have ever paid' : ''}${ahead}`;
    // One item per week its shares land in: the money spread as it is likely to come.
    const byWeek = new Map();
    for (const pt of place.points) {
      const k = Math.floor((pt.date - start) / (7 * DAY));
      const cur = byWeek.get(k) || { date: pt.date, share: 0 };
      cur.share += pt.share;
      byWeek.set(k, cur);
    }
    for (const { date, share } of byWeek.values()) {
      items.push({ direction: 'in', date, amount: r2(r.outstanding * share), party: r.partyName, docNo: r.docNo, basis: share < 0.999 ? `${basis} · ${Math.round(share * 100)}% likely this week` : basis });
    }
  }
  for (const p of pay) {
    const when = new Date(p.dueDate) < today ? today : new Date(p.dueDate);
    items.push({ direction: 'out', date: when, amount: p.outstanding, party: p.partyName, docNo: p.docNo, basis: `${new Date(p.dueDate) < today ? 'overdue' : 'due'}${p.ahead ? `, less ₹${fmt(p.ahead)} paid ahead` : ''}` });
  }
  for (const e of loose) {
    const left = r2((e.totals?.grand || 0) - (e.paidAmount || 0));
    if (left <= 0.005) continue;
    const pending = e.status === 'pending';
    const due = e.dueDate ? new Date(e.dueDate) : new Date(e.date);
    // Waiting for approval: a week out. Approved: when due, or now.
    const when = pending ? new Date(Math.max(today.getTime() + 7 * DAY, due.getTime())) : due < today ? today : due;
    items.push({ direction: 'out', date: when, amount: left, party: e.payeeName || e.description, docNo: e.expenseNo, basis: pending ? 'expense waiting for approval' : e.source === 'claim' ? 'claim to repay' : 'expense approved, not paid' });
  }
  for (const t of recurring) {
    for (const d of occurrences(t, end)) {
      const gross = r2(t.amount * (1 + (t.gstPercent || 0) / 100));
      items.push({ direction: 'out', date: d, amount: gross, party: t.payeeName || t.name, docNo: t.name, basis: 'recurring' });
    }
  }
  items.push(...statutory);
  const buckets = [];
  let running = opening;
  let firstShort = null;
  for (let i = 0; i < weeks; i++) {
    const from = new Date(start.getTime() + i * 7 * DAY);
    const to = new Date(from.getTime() + 7 * DAY - 1);
    const inWeek = items.filter((x) => x.date >= from && x.date <= to);
    const inflow = r2(inWeek.filter((x) => x.direction === 'in').reduce((s, x) => s + x.amount, 0));
    const outflow = r2(inWeek.filter((x) => x.direction === 'out').reduce((s, x) => s + x.amount, 0));
    running = r2(running + inflow - outflow);
    if (running < 0 && !firstShort) firstShort = from;
    const rows = inWeek.sort((a, b) => b.amount - a.amount).map((x) => ({ direction: x.direction, party: x.party, docNo: x.docNo, amount: x.amount, basis: x.basis, date: x.date }));
    buckets.push({ from, to, inflow, outflow, closing: running, top: rows.slice(0, 5), items: rows });
  }
  const beyond = items.filter((x) => x.date > end);
  return {
    opening, weeks: buckets, firstShortWeek: firstShort,
    later: { inflow: r2(beyond.filter((x) => x.direction === 'in').reduce((s, x) => s + x.amount, 0)), outflow: r2(beyond.filter((x) => x.direction === 'out').reduce((s, x) => s + x.amount, 0)) },
    habits: profiles.byCustomer.size,
  };
}

/**
 * @param month 'YYYY-MM'
 * @returns { month, from, to, items: [{ key, label, detail, count, amount, ok, link }] }
 */
async function closeChecklist(month) {
  const [y, m] = String(month || '').match(/^(\d{4})-(\d{2})$/) ? month.split('-').map(Number) : [new Date().getFullYear(), new Date().getMonth()];
  const from = new Date(y, m - 1, 1);
  const to = new Date(y, m, 0, 23, 59, 59, 999);
  const range = { $gte: from, $lte: to };
  const fresh = { $or: [{ 'tally.batch': { $exists: false } }, { 'tally.batch': null }] };
  const [
    statements, uncleared, unclearedContra, noPhoto, pending, tds, unsent, settings, rcmAndBills, credits,
  ] = await Promise.all([
    BankStatement.find({ 'lines.date': range }).select('lines.date lines.status lines.amount lines.key').lean(),
    Payment.countDocuments({ status: 'posted', mode: { $ne: 'cash' }, date: { $lte: new Date(to.getTime() - 15 * DAY), $gte: new Date(from.getTime() - 60 * DAY) }, $or: [{ clearedOn: { $exists: false } }, { clearedOn: null }] }),
    Contra.countDocuments({ status: 'posted', mode: { $ne: 'cash' }, date: { $lte: new Date(to.getTime() - 15 * DAY) }, $and: [{ $or: [{ fromClearedOn: { $exists: false } }, { fromClearedOn: null }] }, { $or: [{ toClearedOn: { $exists: false } }, { toClearedOn: null }] }] }),
    SupplierBill.countDocuments({ status: { $ne: 'cancelled' }, billDate: range, 'attachments.0': { $exists: false } }),
    Expense.find({ status: 'pending', date: { $lte: new Date(Date.now() - 7 * DAY) } }).select('totals.grand').lean(),
    Payment.aggregate([{ $match: { status: 'posted', kind: 'payment', date: range, 'tds.amount': { $gt: 0 } } }, { $group: { _id: '$tds.section', amount: { $sum: '$tds.amount' } } }]),
    Promise.all(['Invoice', 'SupplierBill', 'Expense', 'AccountNote', 'Payment', 'Contra', 'Journal'].map(async (t) => {
      const Model = { Invoice, SupplierBill, Expense, AccountNote, Payment, Contra, Journal }[t];
      const dateField = { Invoice: 'invoiceDate', SupplierBill: 'billDate', Expense: 'date', AccountNote: 'date', Payment: 'date', Contra: 'date', Journal: 'date' }[t];
      const status = { Invoice: 'issued', SupplierBill: { $ne: 'cancelled' }, Expense: { $in: ['approved', 'paid'] }, AccountNote: 'issued', Payment: 'posted', Contra: 'posted', Journal: 'posted' }[t];
      // An expense with no supplier never goes as a voucher of its own —
      // its payment carries the head — so it is not waiting to be sent.
      const own = t === 'Expense' ? { supplier: { $ne: null } } : {};
      return Model.countDocuments({ status, [dateField]: range, ...own, ...fresh });
    })),
    getSettings(),
    SupplierBill.countDocuments({ status: { $ne: 'cancelled' }, billDate: range }),
    AccountNote.countDocuments({ status: 'issued', unapplied: { $gt: 0.005 } }),
  ]);
  const monthKey = `${y}-${String(m).padStart(2, '0')}`;
  const [msmeDues, twoB, rule37] = await Promise.all([
    require('./msme').dues({ asOf: to }),
    require('./gstr2b').summary(monthKey),
    require('./itcReversal').due(monthKey),
  ]);
  const msmeOver = msmeDues.rows.filter((r) => r.dueDate <= to && r.state === 'overdue');
  const seen = new Map();
  for (const st of statements) for (const l of st.lines) {
    if (l.date < from || l.date > to) continue;
    const done = ['recorded', 'posted', 'ignored'].includes(l.status);
    if (!seen.has(l.key) || done) seen.set(l.key, { done, amount: l.amount });
  }
  const unplaced = [...seen.values()].filter((x) => !x.done);
  const tdsTotal = r2(tds.reduce((s, x) => s + x.amount, 0));
  const tdsDue = new Date(y, m, 7);
  const unsentTotal = unsent.reduce((s, x) => s + x, 0);
  const locked = settings.lockDate && new Date(settings.lockDate) >= new Date(y, m - 1, new Date(y, m, 0).getDate());
  const gstDue = new Date(y, m, 20);
  const items = [
    { key: 'bank', label: 'Bank lines placed', ok: unplaced.length === 0 && statements.length > 0, count: unplaced.length, amount: r2(unplaced.reduce((s, x) => s + x.amount, 0)), detail: statements.length === 0 ? 'No statement uploaded for this month yet' : unplaced.length ? `${unplaced.length} statement line${unplaced.length === 1 ? '' : 's'} not in the books` : 'Every line is in the books', link: '/accounts/bank' },
    { key: 'cleared', label: 'Cheques and transfers cleared', ok: uncleared + unclearedContra === 0, count: uncleared + unclearedContra, detail: uncleared + unclearedContra ? `${uncleared + unclearedContra} entr${uncleared + unclearedContra === 1 ? 'y' : 'ies'} older than 15 days the bank has not shown` : 'Nothing old is waiting to clear', link: '/accounts/bank' },
    { key: 'photos', label: 'Bills have their copy attached', ok: noPhoto === 0, count: noPhoto, detail: noPhoto ? `${noPhoto} of ${rcmAndBills} bills this month have no photo or PDF` : 'Every bill has its copy', link: '/accounts/bills' },
    { key: 'approvals', label: 'Expenses decided', ok: pending.length === 0, count: pending.length, amount: r2(pending.reduce((s, e) => s + (e.totals?.grand || 0), 0)), detail: pending.length ? `${pending.length} waiting for approval more than a week` : 'Nothing waiting more than a week', link: '/accounts/expenses' },
    { key: 'tds', label: `TDS to deposit by ${dmy(tdsDue)}`, ok: tdsTotal === 0, count: tds.length, amount: tdsTotal, detail: tdsTotal ? `₹${fmt(tdsTotal)} deducted (${tds.map((x) => `${x._id || '—'} ₹${fmt(x.amount)}`).join(', ')}) — deposit by the 7th` : 'No TDS deducted this month', link: '/accounts/reports' },
    { key: 'gst', label: `GST return by ${dmy(gstDue)}`, ok: true, count: rcmAndBills, detail: 'Check the GST report against the purchase register before filing', link: '/accounts/reports' },
    { key: 'msme', label: 'MSME suppliers paid in time', ok: msmeOver.length === 0, count: msmeOver.length, amount: r2(msmeOver.reduce((s, r) => s + r.outstanding, 0)), detail: msmeOver.length ? `${msmeOver.length} bill${msmeOver.length === 1 ? '' : 's'} to micro / small suppliers past the 45-day limit — disallowed at year end if still unpaid (s.43B(h))` : msmeDues.suppliers ? 'Every MSME bill is within its limit' : 'No supplier is marked micro or small', link: '/accounts/statutory' },
    { key: 'gstr2b', label: 'GSTR-2B matched', ok: twoB.uploaded && twoB.counts.missing === 0 && twoB.counts.mismatch === 0, count: twoB.uploaded ? twoB.counts.missing + twoB.counts.mismatch : 0, amount: twoB.uploaded ? r2(twoB.itc.missing + twoB.itc.mismatch) : 0, detail: !twoB.uploaded ? 'Upload the month\'s GSTR-2B from the portal before claiming input credit' : twoB.counts.missing + twoB.counts.mismatch ? `${twoB.counts.missing} bill${twoB.counts.missing === 1 ? '' : 's'} not in 2B (₹${fmt(twoB.itc.missing)} ITC on hold), ${twoB.counts.mismatch} with a different tax` : 'Every bill with credit is in GSTR-2B', link: '/accounts/statutory' },
    { key: 'rule37', label: 'Credit reversed on bills unpaid 180 days', ok: rule37.toReverse.filter((b) => b.inMonth).length === 0, count: rule37.toReverse.length, amount: rule37.totals.reverse, detail: rule37.toReverse.length ? `${rule37.toReverse.length} bill${rule37.toReverse.length === 1 ? '' : 's'} unpaid past 180 days: reverse ₹${fmt(rule37.totals.reverse)} of credit in GSTR-3B (Rule 37)` : 'Nothing to reverse', link: '/accounts/statutory' },
    { key: 'credits', label: 'Unapplied credit notes', ok: credits === 0, count: credits, detail: credits ? `${credits} note${credits === 1 ? '' : 's'} with credit not yet set against an invoice` : 'Every credit is applied', link: '/accounts/notes' },
    { key: 'tally', label: 'Sent to Tally', ok: unsentTotal === 0, count: unsentTotal, detail: unsentTotal ? `${unsentTotal} document${unsentTotal === 1 ? '' : 's'} not yet sent` : 'Everything has gone', link: '/accounts/tally' },
    { key: 'lock', label: 'Books locked', ok: !!locked, count: 0, detail: locked ? `Locked up to ${dmy(settings.lockDate)}` : 'Lock the month once it has gone to Tally', link: '/accounts/settings' },
  ];
  return { month: `${y}-${String(m).padStart(2, '0')}`, from, to, items, done: items.filter((i) => i.ok).length, total: items.length };
}

/** The checklist as one WhatsApp message. */
function checklistText(c, company = 'Balu Elastics') {
  const monthName = new Date(c.from).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
  return [
    `*${company} — closing ${monthName}*`,
    `${c.done} of ${c.total} done`,
    '',
    ...c.items.map((i) => `${i.ok ? '✅' : '⬜'} ${i.label}${i.ok ? '' : ` — ${i.detail}`}`),
  ].join('\n');
}

module.exports = { anomalies, suggestCategory, forecast, payingDays, payingProfiles, profileFor, placeInvoice, closeChecklist, checklistText, itcDeadline };
