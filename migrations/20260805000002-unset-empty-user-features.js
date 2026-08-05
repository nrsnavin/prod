'use strict';
//
// Separate "never configured" from "configured to have nothing" on
// User.features.
//
// The array was overloaded: [] meant BOTH "this account predates the
// feature list, fall back to the role gate" AND "the admin ticked no
// boxes". The guards could only honour one reading, so they honoured the
// permissive one — and an admin who deliberately granted nothing still
// got everything their role allowed.
//
// From here on:
//   • field ABSENT  → never configured → defer to the role gate
//   • field []      → explicitly nothing → denied
//
// This migration moves every account that currently reads [] (or has no
// field at all) into the ABSENT bucket, so behaviour on deploy is
// identical to today and nobody is locked out. That includes three
// populations that would otherwise lose all access the moment the guards
// change:
//   1. the owner login from scripts/create-admin.js, which is created
//      with role+department 'admin' and no features — it would lose the
//      Users screen needed to undo the lockout;
//   2. the WhatsApp bot user (utils/whatsappInbound.js), role 'admin'
//      with no department;
//   3. legacy role-only accounts that 20260723000001-backfill-user-features
//      deliberately skipped for exactly this reason.
//
// RUN THIS BEFORE deploying the guard change in middleware/auth.js.
// Between the two, every account still reads as unconfigured, which is
// the current behaviour — there is no window where anyone is denied.
//
// Down: restores [] on accounts with no field, i.e. the previous shape.

module.exports = {
  async up(db) {
    const users = db.collection('users');

    const res = await users.updateMany(
      { $or: [{ features: { $exists: false } }, { features: { $size: 0 } }] },
      { $unset: { features: '' } }
    );

    // Report what is now explicitly-empty (should be none at this point):
    // any such account WILL be denied once the guards change, so it is
    // worth seeing in the deploy log rather than discovering later.
    const explicitlyEmpty = await users.countDocuments({ features: { $size: 0 } });

    // eslint-disable-next-line no-console
    console.log(
      `[unset-empty-user-features] ${res.modifiedCount} account(s) moved to "never configured"; ` +
      `${explicitlyEmpty} account(s) remain explicitly empty (these will be denied by the feature gates)`
    );
  },

  async down(db) {
    const users = db.collection('users');
    const res = await users.updateMany(
      { features: { $exists: false } },
      { $set: { features: [] } }
    );
    // eslint-disable-next-line no-console
    console.log(`[unset-empty-user-features] restored [] on ${res.modifiedCount} account(s)`);
  },
};
