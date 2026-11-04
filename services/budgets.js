'use strict';
// ══════════════════════════════════════════════════════════════════
//  BUDGET AGAINST ACTUAL, PER EXPENSE HEAD
//
//  A budget is twelve figures a year for a head (models/Budget.js).
//  The actual is what the books already hold under that head —
//  expenses once approved, and service bills booked to it — month by
//  month over the financial year. The comparison says, for each head,
//  how far the year has run, what was spent against what was planned
//  for the months gone, and which heads are over or close to it.
// ══════════════════════════════════════════════════════════════════

const Budget = require('../models/Budget');
const Expense = require('../models/Expense');
const SupplierBill = require('../models/SupplierBill');
const ExpenseCategory = require('../models/ExpenseCategory');
const ErrorHandler = require('../utils/ErrorHandler');
const { isId } = require('./accountsHelpers');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const FY_RE = /^\d{4}-\d{2}$/;
const MONTHS = ['Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar'];
const fyStart = (fy) => new Date(Date.UTC(Number(fy.slice(0, 4)), 3, 1));
const fyEnd = (fy) => new Date(Date.UTC(Number(fy.slice(0, 4)) + 1, 2, 31, 23, 59, 59, 999));
/** 0 for April … 11 for March. */
const monthIndex = (d) => (new Date(d).getUTCMonth() + 9) % 12;

/** How many of the year's months have begun by `now`: 12 for a past year, 0 for one to come. */
function monthsElapsed(fy, now = new Date()) {
  if (now > fyEnd(fy)) return 12;
  if (now < fyStart(fy)) return 0;
  return monthIndex(now) + 1;
}

async function actuals(fy) {
  const range = { $gte: fyStart(fy), $lte: fyEnd(fy) };
  const [expenses, bills] = await Promise.all([
    Expense.aggregate([
      { $match: { status: { $in: ['approved', 'paid'] }, date: range } },
      { $group: { _id: { category: '$category', month: { $month: '$date' } }, amount: { $sum: '$totals.taxable' }, count: { $sum: 1 } } },
    ]),
    SupplierBill.aggregate([
      { $match: { status: { $ne: 'cancelled' }, kind: 'service', category: { $ne: null }, billDate: range } },
      { $group: { _id: { category: '$category', month: { $month: '$billDate' } }, amount: { $sum: '$totals.taxable' }, count: { $sum: 1 } } },
    ]),
  ]);
  const by = new Map();
  for (const x of [...expenses, ...bills]) {
    const key = String(x._id.category);
    const row = by.get(key) || { months: Array(12).fill(0), count: 0 };
    row.months[(x._id.month + 8) % 12] = r2(row.months[(x._id.month + 8) % 12] + x.amount);
    row.count += x.count;
    by.set(key, row);
  }
  return by;
}

async function compare(fy, now = new Date()) {
  if (!FY_RE.test(String(fy || ''))) throw new ErrorHandler('fy must be like 2026-27', 400);
  const [categories, budgets, spent] = await Promise.all([
    ExpenseCategory.find({}).select('name ledger active').sort({ name: 1 }).lean(),
    Budget.find({ fy }).lean(),
    actuals(fy),
  ]);
  const budgetOf = new Map(budgets.map((b) => [String(b.category), b]));
  const elapsed = monthsElapsed(fy, now);
  const rows = [];
  for (const c of categories) {
    const b = budgetOf.get(String(c._id));
    const a = spent.get(String(c._id));
    if (!b && !a && c.active === false) continue;
    const budget = b ? b.amounts.map(r2) : Array(12).fill(0);
    const actual = a ? a.months : Array(12).fill(0);
    const budgetTotal = r2(budget.reduce((s, n) => s + n, 0));
    const actualTotal = r2(actual.reduce((s, n) => s + n, 0));
    const ytdBudget = r2(budget.slice(0, elapsed).reduce((s, n) => s + n, 0));
    const ytdActual = r2(actual.slice(0, elapsed).reduce((s, n) => s + n, 0));
    const overMonths = MONTHS.filter((_, i) => i < elapsed && budget[i] > 0 && actual[i] > budget[i] + 0.005);
    const variance = r2(ytdBudget - ytdActual);   // positive: under budget
    const used = ytdBudget > 0 ? Math.round((ytdActual / ytdBudget) * 1000) / 10 : null;
    const state = !b || budgetTotal === 0 ? 'unbudgeted' : ytdActual > ytdBudget + 0.005 ? 'over' : used !== null && used >= 90 ? 'near' : 'ok';
    // Where the year lands at this pace.
    const projected = elapsed > 0 ? r2((ytdActual / elapsed) * 12) : 0;
    rows.push({ category: c._id, name: c.name, ledger: c.ledger || '', active: c.active !== false, budget, actual, budgetTotal, actualTotal, ytdBudget, ytdActual, variance, used, overMonths, state, projected, note: b?.note || '', count: a?.count || 0 });
  }
  rows.sort((a, b) => ({ over: 0, near: 1, ok: 2, unbudgeted: 3 }[a.state] - { over: 0, near: 1, ok: 2, unbudgeted: 3 }[b.state]) || b.ytdActual - a.ytdActual);
  const t = (k) => r2(rows.reduce((s, r) => s + r[k], 0));
  return {
    fy, from: fyStart(fy), to: fyEnd(fy), months: MONTHS, elapsed, rows,
    totals: { budgetTotal: t('budgetTotal'), actualTotal: t('actualTotal'), ytdBudget: t('ytdBudget'), ytdActual: t('ytdActual'), variance: t('variance'), over: rows.filter((r) => r.state === 'over').length, near: rows.filter((r) => r.state === 'near').length, unbudgeted: rows.filter((r) => r.state === 'unbudgeted' && r.actualTotal > 0).length },
  };
}

/** Save the year's figures for the heads given: twelve amounts, or one annual figure spread evenly. */
async function save(fy, rows, by) {
  if (!FY_RE.test(String(fy || ''))) throw new ErrorHandler('fy must be like 2026-27', 400);
  if (!Array.isArray(rows) || !rows.length) throw new ErrorHandler('rows is required', 400);
  const saved = [];
  for (const [i, r] of rows.entries()) {
    if (!isId(r.category)) throw new ErrorHandler(`Row ${i + 1}: pick the expense head`, 400);
    const c = await ExpenseCategory.findById(r.category).select('name').lean();
    if (!c) throw new ErrorHandler(`Row ${i + 1}: head not found`, 404);
    let amounts;
    if (Array.isArray(r.amounts)) {
      if (r.amounts.length !== 12) throw new ErrorHandler(`Row ${i + 1} (${c.name}): twelve monthly amounts, April to March`, 400);
      amounts = r.amounts.map((n) => r2(n));
    } else {
      const annual = r2(r.annual);
      if (!(annual >= 0)) throw new ErrorHandler(`Row ${i + 1} (${c.name}): annual must be 0 or more`, 400);
      const each = Math.floor((annual / 12) * 100) / 100;
      amounts = Array(12).fill(each);
      amounts[11] = r2(annual - each * 11);   // the rounding lands in March
    }
    if (amounts.some((n) => !(n >= 0))) throw new ErrorHandler(`Row ${i + 1} (${c.name}): amounts must be 0 or more`, 400);
    const doc = await Budget.findOneAndUpdate({ fy, category: c._id }, { $set: { amounts, note: String(r.note || '').trim().slice(0, 200), updatedBy: by || undefined } }, { upsert: true, new: true, setDefaultsOnInsert: true }).lean();
    saved.push(doc);
  }
  return saved;
}

module.exports = { compare, save, actuals, monthsElapsed, MONTHS };
