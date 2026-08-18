'use strict';
//
// Give existing accounts the /complaints feature.
//
// The fourth time. 20260806000001 documented the trap, 20260812000001
// rescued /quotes, 20260818000001 rescued /ai-health, and this one is
// /complaints. The mechanism has not changed: the gates read
// `User.features` as the whole truth, canAccess() checks the explicit
// list BEFORE the admin shortcut, so a key that did not exist when an
// account's list was saved is absent from it for ever. Ship a nav entry
// without this and the page is invisible to every configured account —
// including the owner's — with no error to explain it.
//
// This one differs from /ai-health in one way worth stating: /complaints
// is not admin-only. Its department default covers admin, packing and
// production, so this migration touches production and packing accounts
// too. The rule is unchanged and is what keeps that safe — a key is
// added to an account only where that account's DEPARTMENT DEFAULT
// already includes it, which is exactly what the same account would be
// created with today. An admin who deliberately narrowed somebody's
// features keeps that narrowing everywhere else.
//
// Accounts with no `features` field are skipped: absent means "never
// configured, defer to the role gate", and writing a list to them would
// tighten access rather than restore it.
//
// Down: removes the key again. It cannot tell a key this migration added
// from one an admin ticked by hand afterwards, so a rollback puts those
// accounts back to needing a tick — where they are now, not worse.

const { featuresForDepartment } = require('../utils/features');

const NEW_KEYS = ['/complaints'];

const ROLE_AS_DEPARTMENT = {
  admin: 'admin',
  accounts: 'finance',
  production: 'production',
};

const departmentOf = (u) => u.department || ROLE_AS_DEPARTMENT[u.role] || null;

module.exports = {
  async up(db) {
    const users = db.collection('users');
    const cursor = users.find({
      features: { $exists: true, $not: { $size: 0 } },
    });

    let updated = 0;
    for await (const u of cursor) {
      const dept = departmentOf(u);
      if (!dept) continue;
      const allowed = new Set(featuresForDepartment(dept));
      const missing = NEW_KEYS.filter(
        (k) => allowed.has(k) && !(u.features || []).includes(k)
      );
      if (missing.length === 0) continue;
      await users.updateOne({ _id: u._id }, { $addToSet: { features: { $each: missing } } });
      updated += 1;
    }

    // eslint-disable-next-line no-console
    console.log(
      `[grant-complaints-feature] granted ${NEW_KEYS.join(', ')} where the ` +
      `department default allows it — ${updated} account(s) updated`
    );
  },

  async down(db) {
    const res = await db.collection('users').updateMany(
      { features: { $in: NEW_KEYS } },
      { $pull: { features: { $in: NEW_KEYS } } }
    );
    // eslint-disable-next-line no-console
    console.log(`[grant-complaints-feature] down: ${res.modifiedCount} account(s)`);
  },
};
