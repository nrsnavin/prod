'use strict';
//
// Take the payslip lines that only explain out of the employee ledger.
//
// Finalising a payslip posted every one of its lines to the ledger,
// including the two kinds that are not money (utils/payslipLines.js):
//
//   "Absent — pay lost (DAY 2026-06-03)"   — the shift was never credited
//   "Late deduction 20m (DAY 2026-06-04)"  — the shift line is already less
//
// Posted as deductions they were taken off twice: a month with one
// absence, paid in full, left the ledger saying the worker owed a
// shift's pay. From now on they are not posted; this removes the ones
// already there, so every ledger comes back to what was actually owed
// and paid.
//
// Nothing is thrown away: the rows are moved to
// `ledgerentries_memo_removed`, and `down` moves them back. Safe to run
// twice (a row already moved is simply not found again).

const MEMO = '^(Absent —|Late deduction )';
const LEDGER = 'ledgerentries';
const KEPT = 'ledgerentries_memo_removed';

module.exports = {
  async up(db) {
    const rows = await db.collection(LEDGER)
      .find({ source: 'payroll', kind: { $in: ['absence', 'penalty'] }, label: { $regex: MEMO } })
      .toArray();
    if (!rows.length) { console.log('[ledger-memo] no explanatory rows in the ledger'); return; }

    await db.collection(KEPT).bulkWrite(
      rows.map((r) => ({ replaceOne: { filter: { _id: r._id }, replacement: r, upsert: true } })),
      { ordered: false }
    );
    const gone = await db.collection(LEDGER).deleteMany({ _id: { $in: rows.map((r) => r._id) } });

    const total = rows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
    const people = new Set(rows.map((r) => String(r.employee))).size;
    console.log(`[ledger-memo] moved ${gone.deletedCount} row(s) out of the ledger for ${people} employee(s); `
      + `their balances rise by ${Math.abs(Math.round(total * 100) / 100)} in all`);
  },

  async down(db) {
    const rows = await db.collection(KEPT).find({}).toArray();
    if (!rows.length) { console.log('[ledger-memo] down: nothing to put back'); return; }
    await db.collection(LEDGER).bulkWrite(
      rows.map((r) => ({ replaceOne: { filter: { _id: r._id }, replacement: r, upsert: true } })),
      { ordered: false }
    );
    await db.collection(KEPT).deleteMany({ _id: { $in: rows.map((r) => r._id) } });
    console.log(`[ledger-memo] down: put ${rows.length} row(s) back`);
  },
};
