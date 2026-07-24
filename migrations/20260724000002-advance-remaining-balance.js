'use strict';
//
// Backfill AdvanceRequest.remainingBalance for existing advances.
//
// The advance carry-forward feature tracks how much of each advance is
// still to be recovered. Legacy advances predate the field:
//   • fully recovered (deductedInPayroll = true) → remainingBalance 0
//   • everything else                            → remainingBalance = amount
// The payroll engine already falls back to `amount` when the field is
// null, so this is purely to make reports/queries on remainingBalance
// accurate; it changes no pay math.

module.exports = {
  async up(db) {
    const col = db.collection('advancerequests');
    const done = await col.updateMany(
      { remainingBalance: null, deductedInPayroll: true },
      [{ $set: { remainingBalance: 0 } }],
    );
    const open = await col.updateMany(
      { remainingBalance: null },
      [{ $set: { remainingBalance: '$amount' } }],
    );
    // eslint-disable-next-line no-console
    console.log(`[advance-remaining-balance] recovered=${done.modifiedCount} open=${open.modifiedCount}`);
  },

  async down(db) {
    await db.collection('advancerequests').updateMany({}, { $set: { remainingBalance: null } });
  },
};
