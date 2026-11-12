'use strict';
// ══════════════════════════════════════════════════════════════════
//  PAYROLL INTO THE BOOKS
//
//  The HR module works out each employee's month (models/Payroll.js);
//  the books see it as two journals a month:
//
//    salary    Dr Salaries & Wages      gross earnings + bonuses − penalties
//              Cr PF Payable            employees' share
//              Cr ESI Payable           employees' share
//              Cr Staff Advances        recovered out of pay
//              Cr Salary Payable        net
//    paid      Dr Salary Payable        cash handed over in the month
//              Cr Cash                  the cash box
//
//  posted from the finalised slips on request (and again, replacing
//  the earlier journal, when a slip changes). PF and ESI fall due on
//  the 15th of the next month; the employees' share deposited late is
//  not an expense of the year (s.36(1)(va)).
// ══════════════════════════════════════════════════════════════════

const Payroll = require('../models/Payroll');
const Journal = require('../models/Journal');
const BankAccount = require('../models/BankAccount');
const StatutoryDeposit = require('../models/StatutoryDeposit');
const journals = require('./journals');
const { getSettings } = require('./booksLock');

const { r2 } = require('../utils/money');

function monthRange(month) {
  const [y, m] = String(month).split('-').map(Number);
  return { y, m, from: new Date(y, m - 1, 1), to: new Date(y, m, 0, 23, 59, 59, 999) };
}
const DEFAULT = { salaries: 'Salaries & Wages', salaryPayable: 'Salary Payable', pfPayable: 'PF Payable', esiPayable: 'ESI Payable', staffAdvances: 'Staff Advances' };
async function ledgers() {
  const t = (await getSettings()).tally || {};
  return Object.fromEntries(Object.entries(DEFAULT).map(([k, v]) => [k, String(t[k] || '').trim() || v]));
}

/** The month's slips, totalled, and what is in the books for it. */
async function summary(month) {
  const { y, m, from, to } = monthRange(month);
  const slips = await Payroll.find({ year: y, month: m, status: { $in: ['finalized', 'partially_paid', 'paid'] } }).select('employee grossEarnings totalBonuses totalDeductions pfDeduction esiDeduction totalAdvanceDeduction netPay status payouts').lean();
  const drafts = await Payroll.countDocuments({ year: y, month: m, status: 'draft' });
  const t = { people: slips.length, gross: 0, bonuses: 0, pf: 0, esi: 0, advances: 0, other: 0, net: 0 };
  for (const s of slips) {
    t.gross = r2(t.gross + (s.grossEarnings || 0)); t.bonuses = r2(t.bonuses + (s.totalBonuses || 0));
    t.pf = r2(t.pf + (s.pfDeduction || 0)); t.esi = r2(t.esi + (s.esiDeduction || 0)); t.advances = r2(t.advances + (s.totalAdvanceDeduction || 0));
    t.net = r2(t.net + (s.netPay || 0));
  }
  t.other = r2(t.gross + t.bonuses - t.pf - t.esi - t.advances - t.net);   // penalties and the like
  t.expense = r2(t.gross + t.bonuses - t.other);
  // Cash handed over in the calendar month, whichever slip it settled.
  const paidSlips = await Payroll.find({ 'payouts.at': { $gte: from, $lte: to } }).select('payouts').lean();
  const paid = r2(paidSlips.reduce((s, p) => s + (p.payouts || []).filter((x) => x.at >= from && x.at <= to).reduce((a, x) => a + (x.cash || 0), 0), 0));
  const [salaryJournal, paidJournal] = await Promise.all([
    Journal.findOne({ source: 'payroll', sourceRef: `salary:${month}`, status: 'posted' }).select('journalNo date total').lean(),
    Journal.findOne({ source: 'payroll', sourceRef: `paid:${month}`, status: 'posted' }).select('journalNo date total').lean(),
  ]);
  const deposits = await StatutoryDeposit.find({ month }).sort({ depositedOn: 1 }).lean();
  const due = new Date(y, m, 15);
  const dep = (kind) => deposits.filter((d) => d.kind === kind);
  const sum = (rows) => r2(rows.reduce((s, d) => s + d.amount, 0));
  const late = (rows) => rows.some((d) => new Date(d.depositedOn) > due);
  return {
    month, from, to, totals: t, drafts, paid,
    journals: { salary: salaryJournal, paid: paidJournal, salaryStale: salaryJournal ? Math.abs(salaryJournal.total - t.expense) > 0.005 : false, paidStale: paidJournal ? Math.abs(paidJournal.total - paid) > 0.005 : false },
    statutory: {
      due,
      pf: { due: t.pf, deposited: sum(dep('pf')), late: late(dep('pf')), rows: dep('pf') },
      esi: { due: t.esi, deposited: sum(dep('esi')), late: late(dep('esi')), rows: dep('esi') },
      pt: { deposited: sum(dep('pt')), rows: dep('pt') },
    },
  };
}

/** Post this source's journal for the month, in place of the one posted before (services/journals.js replace). */
function replace(ref, build, req) {
  const { date, purpose, narration, reason, lines } = build;
  return journals.replace({ date, purpose, narration, reason, lines, source: 'payroll', sourceRef: ref }, 'Replaced by a fresh posting of the payroll month', req);
}

async function postSalary(month, req) {
  const s = await summary(month);
  if (!s.totals.people) throw Object.assign(new Error(`No finalised payroll for ${month} yet`), { status: 409 });
  const L = await ledgers();
  const lines = [
    { kind: 'ledger', ledger: L.salaries, debit: s.totals.expense },
    ...(s.totals.pf > 0 ? [{ kind: 'ledger', ledger: L.pfPayable, credit: s.totals.pf }] : []),
    ...(s.totals.esi > 0 ? [{ kind: 'ledger', ledger: L.esiPayable, credit: s.totals.esi }] : []),
    ...(s.totals.advances > 0 ? [{ kind: 'ledger', ledger: L.staffAdvances, credit: s.totals.advances }] : []),
    { kind: 'ledger', ledger: L.salaryPayable, credit: s.totals.net },
  ];
  const out = await replace(`salary:${month}`, { date: s.to, purpose: 'salary', narration: `Salaries for ${month}: ${s.totals.people} people`, reason: `Payroll ${month} finalised in HR`, lines }, req);
  return { ...out, summary: await summary(month) };
}

async function postPaid(month, req) {
  const s = await summary(month);
  if (!(s.paid > 0)) throw Object.assign(new Error(`No salary was paid out in ${month}`), { status: 409 });
  const L = await ledgers();
  const cash = await BankAccount.findOne({ kind: 'cash', active: { $ne: false } }).sort({ isDefault: -1 }).lean();
  if (!cash) throw Object.assign(new Error('No cash account to pay salaries from (Settings → Accounts)'), { status: 409 });
  const lines = [
    { kind: 'ledger', ledger: L.salaryPayable, debit: s.paid },
    { kind: 'bank', account: cash._id, credit: s.paid },
  ];
  const out = await replace(`paid:${month}`, { date: s.to, purpose: 'salary', narration: `Salaries paid in cash, ${month}`, reason: `Payroll payouts of ${month} in HR`, lines }, req);
  return { ...out, summary: await summary(month) };
}

async function addDeposit({ kind, month, amount, challanNo, depositedOn, account, note, by }) {
  if (!['pf', 'esi', 'pt'].includes(kind)) throw Object.assign(new Error('kind must be pf, esi or pt'), { status: 400 });
  if (!/^\d{4}-\d{2}$/.test(String(month || ''))) throw Object.assign(new Error('month must be YYYY-MM'), { status: 400 });
  if (!(r2(amount) > 0)) throw Object.assign(new Error('amount must be more than 0'), { status: 400 });
  if (!depositedOn) throw Object.assign(new Error('depositedOn is required'), { status: 400 });
  return StatutoryDeposit.create({ kind, month, amount: r2(amount), challanNo: String(challanNo || '').trim(), depositedOn, account: account || undefined, note: String(note || '').trim(), createdBy: by || undefined });
}

module.exports = { summary, postSalary, postPaid, addDeposit, ledgers };
