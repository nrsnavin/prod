'use strict';
//
// Employee ledger — turns domain events (a finalized payroll, an advance,
// a payment, a Diwali bonus) into signed ledger rows.
//
// Every posting function takes a mongoose `session` and MUST be called
// inside the caller's transaction, so the ledger can never drift from the
// documents it describes: either both land or neither does.
//
// Postings are idempotent per source document — re-finalizing or
// re-generating replaces that document's rows rather than duplicating them.

const LedgerEntry = require('../models/LedgerEntry');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Parse "… (DAY 2026-06-05)" / "… (2026-06-05)" out of a payroll line-item
// label so shift rows land on the day they were worked, not month-end.
function dateFromLabel(label, fallback) {
  const m = /(\d{4})-(\d{2})-(\d{2})/.exec(String(label || ''));
  if (!m) return fallback;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  return isNaN(d.getTime()) ? fallback : d;
}

// Classify a payroll line item into a ledger kind.
function kindForLineItem(li) {
  const l = String(li.label || '').toLowerCase();
  if (l.includes('overtime'))            return 'overtime';
  if (l.includes('advance'))             return 'advance_recovered';
  if (l.includes('pf (') || l.includes('esi ('))  return 'statutory';
  if (l.includes('absent'))              return 'absence';
  if (l.includes('penalty'))             return 'penalty';
  if (l.includes('late deduction'))      return 'penalty';
  if (li.type === 'bonus' || l.includes('bonus')) return 'bonus';
  if (l.includes('shift') || l.includes('leave'))  return 'shift_salary';
  return li.amount < 0 ? 'penalty' : 'shift_salary';
}

// Payslip line items with this prefix describe an advance recovered at
// PAYMENT time. The pay route books those to the ledger itself (against the
// advance, so the row cancels the original advance_issued debt), so
// postPayroll must skip them or the recovery lands twice.
const PAYMENT_RECOVERY_PREFIX = 'Advance recovered at payment';

/** Remove every row a source document previously posted (same txn). */
async function clearSource(source, sourceId, session) {
  await LedgerEntry.deleteMany({ source, sourceId }, { session });
}

/**
 * Post one payroll slip's earnings/deductions. Called at FINALIZE — a
 * draft is still being recomputed, so it must not hit the ledger yet.
 * Payment rows are posted separately by postPayment().
 */
async function postPayroll(p, session, { postedBy = '' } = {}) {
  await LedgerEntry.deleteMany(
    { source: 'payroll', sourceId: p._id, kind: { $ne: 'payment' } },
    { session }
  );

  const monthEnd = new Date(p.year, p.month, 0);
  const rows = (p.lineItems || [])
    .filter((li) => Number(li.amount) !== 0)
    .filter((li) => !String(li.label || '').startsWith(PAYMENT_RECOVERY_PREFIX))
    .map((li) => ({
      employee: p.employee,
      date:     dateFromLabel(li.label, monthEnd),
      kind:     kindForLineItem(li),
      amount:   r2(li.amount),
      label:    li.label,
      year:     p.year,
      month:    p.month,
      source:   'payroll',
      sourceId: p._id,
      postedBy,
    }));

  if (rows.length) await LedgerEntry.insertMany(rows, { session, ordered: true });
  return rows.length;
}

/** A salary payment handed over (negative — it settles what we owed). */
async function postPayment(p, { cash, recovered = 0, at = new Date(), postedBy = '' }, session) {
  const rows = [];
  if (cash > 0) {
    rows.push({
      employee: p.employee, date: at, kind: 'payment', amount: -r2(cash),
      label: `Salary paid${p.paymentNote ? ` — ${p.paymentNote}` : ''}`,
      year: p.year, month: p.month, source: 'payroll', sourceId: p._id, postedBy,
    });
  }
  // Advance recovered at payment time is booked against the advance source
  // by the advance helper; here we only record the cash movement.
  if (rows.length) await LedgerEntry.insertMany(rows, { session, ordered: true });
  return rows.length;
}

/** Cash advanced to an employee — they owe it back, so it's negative. */
async function postAdvanceIssued(adv, session, { postedBy = '' } = {}) {
  await clearSource('advance', adv._id, session);
  await LedgerEntry.create([{
    employee: adv.employee,
    date:     adv.createdAt || new Date(),
    kind:     'advance_issued',
    amount:   -r2(adv.amount),
    label:    `Advance paid${adv.reason ? ` — ${adv.reason}` : ''}`,
    source:   'advance',
    sourceId: adv._id,
    postedBy,
  }], { session });
}

/** The Diwali/festival bonus, dated on the festival itself. */
async function postDiwaliBonus(rec, diwaliDate, session, { postedBy = '' } = {}) {
  await clearSource('bonus', rec._id, session);
  await LedgerEntry.create([{
    employee: rec.employee,
    date:     diwaliDate || rec.createdAt || new Date(),
    kind:     'diwali_bonus',
    amount:   r2(rec.bonusAmount),
    label:    `Diwali bonus ${rec.year}`,
    year:     rec.year,
    source:   'bonus',
    sourceId: rec._id,
    meta:     { attendanceTier: rec.attendanceTier, percent: rec.percent },
    postedBy,
  }], { session });
}

/** Bonus actually paid out (settles the payable). */
async function postBonusPaid(rec, session, { postedBy = '' } = {}) {
  await LedgerEntry.create([{
    employee: rec.employee,
    date:     new Date(),
    kind:     'payment',
    amount:   -r2(rec.bonusAmount),
    label:    `Diwali bonus ${rec.year} paid`,
    year:     rec.year,
    source:   'bonus',
    sourceId: rec._id,
    postedBy,
  }], { session });
}

/**
 * One employee's ledger over a date window, oldest first, with a running
 * balance and an opening balance carried in from before `from`.
 */
async function getLedger(empId, { from, to } = {}) {
  const range = {};
  if (from) range.$gte = from;
  if (to)   range.$lte = to;

  const [opening] = await LedgerEntry.aggregate([
    { $match: { employee: new (require('mongoose').Types.ObjectId)(String(empId)),
                ...(from ? { date: { $lt: from } } : { date: { $lt: new Date(0) } }) } },
    { $group: { _id: null, total: { $sum: '$amount' } } },
  ]);
  const openingBalance = r2(opening?.total ?? 0);

  const entries = await LedgerEntry.find({
    employee: empId, ...(from || to ? { date: range } : {}),
  }).sort({ date: 1, createdAt: 1 }).lean();

  let bal = openingBalance;
  const rows = entries.map((e) => {
    bal = r2(bal + e.amount);
    return { ...e, balance: bal };
  });

  const sumOf = (...kinds) =>
    r2(entries.filter((e) => kinds.includes(e.kind)).reduce((s, e) => s + e.amount, 0));

  return {
    openingBalance,
    closingBalance: bal,
    entries: rows,
    totals: {
      earnings:  sumOf('shift_salary', 'overtime'),
      bonuses:   sumOf('bonus', 'diwali_bonus'),
      penalties: sumOf('penalty', 'absence'),
      statutory: sumOf('statutory'),
      advances:  sumOf('advance_issued', 'advance_recovered'),
      payments:  sumOf('payment'),
    },
  };
}

module.exports = {
  postPayroll, postPayment, postAdvanceIssued,
  postDiwaliBonus, postBonusPaid, getLedger, clearSource,
  dateFromLabel, kindForLineItem, PAYMENT_RECOVERY_PREFIX,
};
