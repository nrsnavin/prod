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
const BankAccount = require('../models/BankAccount');
const BankStatement = require('../models/BankStatement');
const RecurringExpense = require('../models/RecurringExpense');
const AccountNote = require('../models/AccountNote');
const outstanding = require('./outstanding');
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
  const supplier = mongoose.Types.ObjectId.isValid(String(b.supplier || '')) ? await Supplier.findById(b.supplier).select('name gstin').lean() : null;

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

/** Monday 00:00 of the week `d` falls in. */
const weekStart = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; };

async function forecast({ weeks = 6, now = new Date() } = {}) {
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const start = weekStart(today);
  const end = new Date(start.getTime() + weeks * 7 * DAY - 1);
  const accounts = await BankAccount.find({ active: true }).lean();
  const balances = await bankBalances.withBalances(accounts);
  const opening = r2(balances.reduce((s, a) => s + a.balance, 0));
  const [recv, pay, habits, recurring, customers] = await Promise.all([
    outstanding.receivables({ asOf: today }), outstanding.payables({ asOf: today }), payingDays(),
    RecurringExpense.find({ active: true }).lean(), Customer.find({}).select('paymentTerms').lean(),
  ]);
  const terms = new Map(customers.map((c) => [String(c._id), parseInt(c.paymentTerms, 10) || 30]));
  const items = [];
  for (const r of recv) {
    const habit = habits.get(String(r.party));
    const days = habit ? habit.days : terms.get(String(r.party)) ?? 30;
    let when = new Date(new Date(r.date).getTime() + days * DAY);
    // Already later than they usually pay: expect it next week, not today.
    const late = when < today;
    if (late) when = new Date(today.getTime() + 7 * DAY);
    items.push({ direction: 'in', date: when, amount: r.outstanding, party: r.partyName, docNo: r.docNo, basis: habit ? `pays in ${days} days on average${late ? ', already late' : ''}` : `terms ${days} days${late ? ', already late' : ''}` });
  }
  for (const p of pay) {
    const when = new Date(p.dueDate) < today ? today : new Date(p.dueDate);
    items.push({ direction: 'out', date: when, amount: p.outstanding, party: p.partyName, docNo: p.docNo, basis: new Date(p.dueDate) < today ? 'overdue' : 'due' });
  }
  for (const t of recurring) {
    for (const d of occurrences(t, end)) {
      const gross = r2(t.amount * (1 + (t.gstPercent || 0) / 100));
      items.push({ direction: 'out', date: d, amount: gross, party: t.payeeName || t.name, docNo: t.name, basis: 'recurring' });
    }
  }
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
    buckets.push({
      from, to, inflow, outflow, closing: running,
      top: inWeek.sort((a, b) => b.amount - a.amount).slice(0, 5).map((x) => ({ direction: x.direction, party: x.party, docNo: x.docNo, amount: x.amount, basis: x.basis })),
    });
  }
  const beyond = items.filter((x) => x.date > end);
  return {
    opening, weeks: buckets, firstShortWeek: firstShort,
    later: { inflow: r2(beyond.filter((x) => x.direction === 'in').reduce((s, x) => s + x.amount, 0)), outflow: r2(beyond.filter((x) => x.direction === 'out').reduce((s, x) => s + x.amount, 0)) },
    habits: [...habits.entries()].length,
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
    Promise.all(['Invoice', 'SupplierBill', 'Expense', 'AccountNote', 'Payment', 'Contra'].map(async (t) => {
      const Model = { Invoice, SupplierBill, Expense, AccountNote, Payment, Contra }[t];
      const dateField = { Invoice: 'invoiceDate', SupplierBill: 'billDate', Expense: 'date', AccountNote: 'date', Payment: 'date', Contra: 'date' }[t];
      const status = { Invoice: 'issued', SupplierBill: { $ne: 'cancelled' }, Expense: { $in: ['approved', 'paid'] }, AccountNote: 'issued', Payment: 'posted', Contra: 'posted' }[t];
      return Model.countDocuments({ status, [dateField]: range, ...fresh });
    })),
    getSettings(),
    SupplierBill.countDocuments({ status: { $ne: 'cancelled' }, billDate: range }),
    AccountNote.countDocuments({ status: 'issued', unapplied: { $gt: 0.005 } }),
  ]);
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

module.exports = { anomalies, suggestCategory, forecast, payingDays, closeChecklist, checklistText, itcDeadline };
