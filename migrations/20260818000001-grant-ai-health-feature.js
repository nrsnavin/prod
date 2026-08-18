'use strict';
//
// Give existing admin accounts the /ai-health feature.
//
// The third time this trap has been walked into, and the second time it
// has needed a migration to get out of. 20260806000001 documented it,
// 20260812000001 rescued /quotes from it, and the comment on NavItem in
// prod_web/src/app/navigation.ts names /quotes by name as the warning.
//
// The mechanism, once more: the gates read `User.features` as the whole
// truth. An explicit list is honoured exactly, and canAccess() checks it
// BEFORE the admin shortcut — so a key that did not exist when the list
// was saved is missing from it for ever. Adding /ai-health to the nav
// and to utils/features.js therefore shipped the page invisible to every
// account carrying a list, the owner's included, with no error to
// explain the absence.
//
// The endpoint itself was never affected: GET /api/v2/health/ai is gated
// on isAdmin('admin') directly and has no feature check, so an admin who
// knew the URL could always reach the page. Only the way in was missing.
//
// The rule is the narrow one both earlier migrations used: a key is
// added to an account only if that account's DEPARTMENT DEFAULT already
// includes it — exactly what the same account would be created with
// today. /ai-health is admin-only, so no non-admin account is touched,
// and an admin's deliberate narrowing of other features stands.
//
// Accounts with no `features` field are skipped: absent means "never
// configured, defer to the role gate", and writing a list to them would
// tighten access rather than restore it.
//
// Down: removes the key again. It cannot tell a key this migration added
// from one an admin ticked by hand afterwards, so a rollback puts those
// accounts back to needing a tick — where they are now, not worse.

const { featuresForDepartment } = require('../utils/features');

const NEW_KEYS = ['/ai-health'];

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
      `[grant-ai-health-feature] granted ${NEW_KEYS.join(', ')} where the ` +
      `department default allows it — ${updated} account(s) updated`
    );
  },

  async down(db) {
    const res = await db.collection('users').updateMany(
      { features: { $in: NEW_KEYS } },
      { $pull: { features: { $in: NEW_KEYS } } }
    );
    // eslint-disable-next-line no-console
    console.log(`[grant-ai-health-feature] down: ${res.modifiedCount} account(s)`);
  },
};
