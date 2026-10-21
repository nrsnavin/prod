'use strict';
//
// Give existing accounts the /dispatch feature.
//
// The same trap as /quotes, /ai-health and /complaints (see
// 20260818000003): the gates read `User.features` as the whole truth and
// canAccess() checks the explicit list before the admin shortcut, so a
// key that did not exist when an account's list was saved is missing
// from it for ever. Without this the Dispatch screen ships invisible to
// every configured account, the owner's included.
//
// Same narrow rule: a key is added only where the account's DEPARTMENT
// DEFAULT already includes it (admin, finance, packing, marketing).
// Accounts with no `features` field are skipped — absent means "defer to
// the role gate". Down removes the key again.

const { featuresForDepartment } = require('../utils/features');

const NEW_KEYS = ['/dispatch'];

const ROLE_AS_DEPARTMENT = {
  admin: 'admin',
  accounts: 'finance',
  production: 'production',
  marketing: 'marketing',
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
      `[grant-dispatch-feature] granted ${NEW_KEYS.join(', ')} where the ` +
      `department default allows it — ${updated} account(s) updated`
    );
  },

  async down(db) {
    const res = await db.collection('users').updateMany(
      { features: { $in: NEW_KEYS } },
      { $pull: { features: { $in: NEW_KEYS } } }
    );
    // eslint-disable-next-line no-console
    console.log(`[grant-dispatch-feature] down: ${res.modifiedCount} account(s)`);
  },
};
