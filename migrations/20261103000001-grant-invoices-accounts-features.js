'use strict';
//
// Give existing accounts the /invoices, /accounts and /claims features.
//
// The trap 20260806000001 and 20260812000001 documented, a fourth time:
// the gates read `User.features` as the whole truth and check it BEFORE
// the admin shortcut, so a key that did not exist when an account's list
// was saved is missing from it forever. Invoices and Accounts shipped
// without this migration and were invisible — no sidebar entry, the
// route refused — to every account with a list, the owner's included.
//
// Same narrow rule: a key is added only where the account's DEPARTMENT
// DEFAULT already includes it (Invoices and Accounts: admin and finance;
// Expense claims: everyone), which is what the account would be created
// with today. Nothing is removed; an admin's deliberate narrowing of
// other features stands. Accounts with no `features` field are skipped:
// absent means "defer to the role gate".
//
// Down: removes the keys again (it cannot tell them from a hand-ticked
// key, so a rollback puts those accounts back to needing a tick).

const { featuresForDepartment } = require('../utils/features');

const NEW_KEYS = ['/invoices', '/accounts', '/claims'];

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
      `[grant-invoices-accounts-features] granted ${NEW_KEYS.join(', ')} where the ` +
      `department default allows it — ${updated} account(s) updated`
    );
  },

  async down(db) {
    const res = await db.collection('users').updateMany(
      { features: { $in: NEW_KEYS } },
      { $pull: { features: { $in: NEW_KEYS } } }
    );
    // eslint-disable-next-line no-console
    console.log(`[grant-invoices-accounts-features] down: ${res.modifiedCount} account(s)`);
  },
};
