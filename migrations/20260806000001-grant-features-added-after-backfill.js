'use strict';
//
// Give existing accounts the features that shipped after their list was
// written.
//
// The gates read `User.features` as the whole truth: an explicit list is
// honoured exactly, so a key that did not exist when the list was saved
// is missing from it forever. Adding a feature to utils/features.js and
// the web nav therefore ships it INVISIBLE — every account with a list,
// including the owner's, has to be re-ticked one at a time on the Users
// screen before anyone can see the new screen at all.
//
// That is what happened to:
//   /order-pnl   Order P&L        (admin, finance)
//   /samples     Sample Requests  (admin, finance, production)
//
// The rule here is the narrow one: a key is added to an account only if
// that account's DEPARTMENT DEFAULT already includes it — exactly what
// the same account would have been created with today. Nothing is ever
// removed, and no account gains a key outside its department's set, so
// an admin's deliberate narrowing of OTHER features is untouched.
//
// Accounts with no `features` field are skipped: absent means "never
// configured, defer to the role gate", and writing a list to them would
// tighten access rather than restore it.
//
// Down: removes the two keys again. It cannot tell a key this migration
// added from one an admin ticked by hand afterwards, so a rollback puts
// those accounts back to needing a tick — the same position they are in
// now, not worse.

const { featuresForDepartment } = require('../utils/features');

/** Features that shipped after 20260723000001-backfill-user-features. */
const NEW_KEYS = ['/order-pnl', '/samples'];

// An account created before departments existed carries only a role, and
// the role names are not the department names. Same mapping the web uses
// in effectiveDepartment(), so both sides agree on what such an account
// would have been given.
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
      `[grant-features-added-after-backfill] granted ${NEW_KEYS.join(', ')} ` +
      `where the department default allows it — ${updated} account(s) updated`
    );
  },

  async down(db) {
    const res = await db.collection('users').updateMany(
      { features: { $in: NEW_KEYS } },
      { $pull: { features: { $in: NEW_KEYS } } }
    );
    // eslint-disable-next-line no-console
    console.log(`[grant-features-added-after-backfill] down: ${res.modifiedCount} account(s)`);
  },
};
