'use strict';
//
// Write off in the employee ledger what payroll already wrote off.
//
// When a month's deductions came to more than its pay and bonuses,
// payroll paid ₹0 and dropped the rest. The employee ledger posted every
// deduction all the same, so it went on showing the worker as owing the
// excess, month after month, though nothing would ever recover it.
//
// The owner decided the excess is written off. From now on a slip that
// stops at ₹0 carries a line saying how much was given up, and the
// ledger posts it as `write_off` (utils/payslipLines.js,
// services/ledgerService.js). This adds the same row for the slips
// already in the ledger: for a finalised slip whose deductions came to
// more than its pay and bonuses, a `write_off` row of whatever that
// slip's rows leave the worker owing. The slips are not changed; they
// already paid ₹0.
//
// `down` removes the rows this added (marked `meta.addedBy`). Safe to
// run twice: a slip that already has a write-off row is left alone.

const LEDGER = 'ledgerentries';
const ME = '20261111000001-ledger-write-off-below-zero';
const LABEL = "Deductions beyond this month's pay, written off";
const r2 = (n) => Math.round(n * 100) / 100;

module.exports = {
  async up(db) {
    const slips = await db.collection('payrolls').find({
      status: { $in: ['finalized', 'partially_paid', 'paid'] },
      $expr: {
        $gt: [
          { $ifNull: ['$totalDeductions', 0] },
          { $add: [{ $ifNull: ['$grossEarnings', 0] }, { $ifNull: ['$totalBonuses', 0] }] },
        ],
      },
    }).project({ employee: 1, year: 1, month: 1 }).toArray();

    const now = new Date();
    const add = [];
    for (const slip of slips) {
      const rows = await db.collection(LEDGER).find({ source: 'payroll', sourceId: slip._id }).toArray();
      if (!rows.length) continue;                                 // never posted
      if (rows.some((r) => r.kind === 'write_off')) continue;     // already written off
      // What the slip's own rows leave owed, before any cash paid.
      const owed = r2(rows.filter((r) => r.kind !== 'payment').reduce((s, r) => s + (Number(r.amount) || 0), 0));
      if (owed >= 0) continue;
      add.push({
        employee: slip.employee,
        date:     new Date(slip.year, slip.month, 0),
        kind:     'write_off',
        amount:   r2(-owed),
        label:    LABEL,
        year:     slip.year,
        month:    slip.month,
        source:   'payroll',
        sourceId: slip._id,
        meta:     { addedBy: ME },
        postedBy: 'migration',
        createdAt: now, updatedAt: now,
      });
    }
    if (!add.length) { console.log('[ledger-write-off] no ledger carries deductions beyond a month\'s pay'); return; }
    await db.collection(LEDGER).insertMany(add);
    const people = new Set(add.map((r) => String(r.employee))).size;
    const total = r2(add.reduce((s, r) => s + r.amount, 0));
    console.log(`[ledger-write-off] wrote off ${total} over ${add.length} slip(s) for ${people} employee(s)`);
  },

  async down(db) {
    const gone = await db.collection(LEDGER).deleteMany({ 'meta.addedBy': ME });
    console.log(`[ledger-write-off] down: removed ${gone.deletedCount} write-off row(s)`);
  },
};
