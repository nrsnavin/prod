'use strict';
//
// Merge the "preparatory" and "weaving" departments into "production".
//
// They always derived the same backend role ("production"); this collapses
// them into a single department so the web/mobile nav and the Users screen
// show one "Production" option. Packing stays separate. The `role` field is
// unchanged (already "production"), so only `department` is rewritten.

module.exports = {
  async up(db) {
    const res = await db.collection('users').updateMany(
      { department: { $in: ['preparatory', 'weaving'] } },
      { $set: { department: 'production' } },
    );
    // eslint-disable-next-line no-console
    console.log(`[merge-prep-weaving] moved ${res.modifiedCount} user(s) to production`);
  },

  // Irreversible in a lossless way — once merged we can't tell which users
  // were preparatory vs weaving. Roll back by moving them to "weaving" (the
  // broader default) so access is preserved; adjust individually if needed.
  async down(db) {
    await db.collection('users').updateMany(
      { department: 'production' },
      { $set: { department: 'weaving' } },
    );
  },
};
