'use strict';
//
// Give existing accounts the /quotes feature.
//
// The same trap 20260806000001 documented, walked into again. The gates
// read `User.features` as the whole truth: an explicit list is honoured
// exactly, and canAccess() checks it BEFORE the admin shortcut, so a key
// that did not exist when the list was saved is missing from it forever.
//
// Adding /quotes to utils/features.js and the web nav therefore shipped
// Quotations invisible — the sidebar entry absent and the route refused,
// for every account with a list, the owner's included. There was no way
// to reach the screen at all, and no error to explain why.
//
// The rule is the narrow one from that migration: a key is added to an
// account only if that account's DEPARTMENT DEFAULT already includes it,
// which is exactly what the same account would be created with today.
// Nothing is removed, and no account gains a key outside its department's
// set, so an admin's deliberate narrowing of other features stands.
//
// Accounts with no `features` field are skipped: absent means "never
// configured, defer to the role gate", and writing a list to them would
// tighten access rather than restore it.
//
// Down: removes the key again. It cannot tell a key this migration added
// from one an admin ticked by hand afterwards, so a rollback puts those
// accounts back to needing a tick — where they are now, not worse.

const { featuresForDepartment } = require('../utils/features');

const NEW_KEYS = ['/quotes'];

// An account created before departments existed carries only a role, and
// the role names are not the department names. Same mapping the web uses
// in effectiveDepartment(), so both sides agree.
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
      `[grant-quotes-feature] granted ${NEW_KEYS.join(', ')} where the ` +
      `department default allows it — ${updated} account(s) updated`
    );
  },

  async down(db) {
    const res = await db.collection('users').updateMany(
      { features: { $in: NEW_KEYS } },
      { $pull: { features: { $in: NEW_KEYS } } }
    );
    // eslint-disable-next-line no-console
    console.log(`[grant-quotes-feature] down: ${res.modifiedCount} account(s)`);
  },
};
