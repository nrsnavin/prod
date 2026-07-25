'use strict';
//
// Advance lifecycle: requested → approved → paid_out → recovered.
//
//   • legacy 'pending'  → 'requested' (same meaning, clearer name)
//   • legacy 'approved' rows are pre-paid-out semantics: under the old model
//     approving WAS handing the cash over, so anything already (partly)
//     recovered — or fully recovered — is migrated to the state it really is.
//     Untouched 'approved' rows are left alone: RECOVERABLE_STATUSES still
//     includes 'approved', so payroll keeps recovering them either way.

module.exports = {
  async up(db) {
    const col = db.collection('advancerequests');

    await col.updateMany({ status: 'pending' }, { $set: { status: 'requested' } });

    // Fully recovered already → 'recovered'.
    await col.updateMany(
      { status: 'approved', $or: [{ remainingBalance: { $lte: 0 } }, { deductedInPayroll: true }] },
      { $set: { status: 'recovered' } }
    );

    // Partly recovered → the cash is demonstrably with the employee.
    const partly = await col.find({
      status: 'approved',
      remainingBalance: { $gt: 0 },
      $expr: { $lt: ['$remainingBalance', '$amount'] },
    }).toArray();
    for (const a of partly) {
      await col.updateOne({ _id: a._id }, {
        $set: { status: 'paid_out', paidOutAt: a.approvedAt || a.updatedAt || a.createdAt || new Date(),
                paidOutBy: a.approvedBy || 'migration' },
      });
    }
  },

  async down(db) {
    const col = db.collection('advancerequests');
    await col.updateMany({ status: 'requested' }, { $set: { status: 'pending' } });
    await col.updateMany({ status: { $in: ['paid_out', 'recovered'] } }, { $set: { status: 'approved' } });
  },
};
