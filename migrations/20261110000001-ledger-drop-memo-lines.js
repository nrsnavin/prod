'use strict';
//
// Take out of the employee ledger the rows that are not money changing
// hands between the factory and the worker.
//
// Finalising a payslip posted every one of its lines to the ledger, and
// paying one added a row of its own for an advance recovered. Three
// kinds of row came of that which change nobody's balance, and each
// moved it (utils/payslipLines.js):
//
//   "Absent — pay lost (DAY 2026-06-03)"   — the shift was never credited
//   "Late deduction 20m (DAY 2026-06-04)"  — the shift line is already less
//        Posted as deductions they were taken off twice: a month with
//        one absence, paid in full, left the worker owing a shift's pay.
//
//   advance recovered (through the payslip, or at payment)
//        The advance is on the ledger from the day the cash was handed
//        over; recovering it is why the salary then paid is less.
//        Posted as well, the payslip route left the worker owing the
//        advance a second time and the payment route left the factory
//        owing it back.
//
// From now on none of these is posted. This removes the ones already
// there, so every ledger comes back to what was owed and paid.
//
// One more thing has to be put right with it. An advance goes on the
// ledger when it is paid out, and that step exists only on the web: an
// advance approved in the admin app was recovered from pay without ever
// having been on the ledger as given. With the recovery row gone, such a
// ledger would read as the worker having been short-paid — so for every
// advance recovered through a payslip that is on the ledger, the row for
// the cash handed over is added if it is not there.
//
// Nothing is thrown away: the rows are moved to
// `ledgerentries_memo_removed`, and `down` moves them back and removes
// the rows this added (marked `meta.addedBy`). Safe to run twice (a row
// already moved is simply not found again, a row already added is found).

const MEMO = '^(Absent —|Late deduction )';
const LEDGER = 'ledgerentries';
const KEPT = 'ledgerentries_memo_removed';
const ME = '20261110000001-ledger-drop-memo-lines';

/** The advances recovered through payslips that are on the ledger, missing their own row. */
async function advancesNeverBooked(db) {
  const posted = await db.collection(LEDGER).distinct('sourceId', { source: 'payroll' });
  if (!posted.length) return [];
  const slips = await db.collection('payrolls')
    .find({ _id: { $in: posted }, 'advanceRecoveries.0': { $exists: true } })
    .project({ advanceRecoveries: 1 }).toArray();
  const ids = new Map();
  for (const p of slips) {
    for (const r of p.advanceRecoveries || []) {
      if (r && r.advance && Number(r.amount) > 0) ids.set(String(r.advance), r.advance);
    }
  }
  if (!ids.size) return [];
  const booked = new Set((await db.collection(LEDGER)
    .distinct('sourceId', { source: 'advance', kind: 'advance_issued', sourceId: { $in: [...ids.values()] } }))
    .map(String));
  const missing = [...ids.entries()].filter(([k]) => !booked.has(k)).map(([, v]) => v);
  if (!missing.length) return [];
  return db.collection('advancerequests').find({ _id: { $in: missing } }).toArray();
}

const NOT_MONEY = {
  $or: [
    { source: 'payroll', kind: { $in: ['absence', 'penalty'] }, label: { $regex: MEMO } },
    { kind: 'advance_recovered' },
  ],
};

module.exports = {
  async up(db) {
    // Before anything is moved: which advances the ledger has recovered
    // without ever having shown them as given.
    const unbooked = await advancesNeverBooked(db);
    if (unbooked.length) {
      const now = new Date();
      await db.collection(LEDGER).insertMany(unbooked.map((a) => ({
        employee: a.employee,
        date:     a.paidOutAt || a.approvedAt || a.createdAt || now,
        kind:     'advance_issued',
        amount:   -(Math.round((Number(a.amount) || 0) * 100) / 100),
        label:    `Advance paid${a.reason ? ` — ${a.reason}` : ''}`,
        year: null, month: null,
        source:   'advance',
        sourceId: a._id,
        meta:     { addedBy: ME },
        postedBy: 'migration',
        createdAt: now, updatedAt: now,
      })));
      console.log(`[ledger-memo] ${unbooked.length} advance(s) recovered from pay were never on the ledger as given: added`);
    }

    const rows = await db.collection(LEDGER).find(NOT_MONEY).toArray();
    if (!rows.length) { console.log('[ledger-memo] nothing in the ledger that is not money'); return; }

    await db.collection(KEPT).bulkWrite(
      rows.map((r) => ({ replaceOne: { filter: { _id: r._id }, replacement: r, upsert: true } })),
      { ordered: false }
    );
    const gone = await db.collection(LEDGER).deleteMany({ _id: { $in: rows.map((r) => r._id) } });

    const net = rows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
    const people = new Set(rows.map((r) => String(r.employee))).size;
    const r2 = (n) => Math.round(n * 100) / 100;
    console.log(`[ledger-memo] moved ${gone.deletedCount} row(s) out of the ledger for ${people} employee(s); `
      + `between them the balances move by ${r2(-net)}`);
  },

  async down(db) {
    const added = await db.collection(LEDGER).deleteMany({ 'meta.addedBy': ME });
    if (added.deletedCount) console.log(`[ledger-memo] down: removed ${added.deletedCount} advance row(s) this added`);
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
