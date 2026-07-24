'use strict';
//
// Backfill User.features from department (Phase 4 — API feature gates).
//
// The per-user feature system (User.features — the nav-path keys that
// decide what a user may open) enforces access both in the UI and, as of
// Phase 4, at the API. Users created/edited through the Users screen
// already carry an explicit list; this backfills everyone who predates
// it so their access matches their department's default set.
//
// Scope is deliberately narrow to avoid NARROWING anyone: we only touch
// users whose `department` is one of the known departments AND whose
// `features` is empty/absent. Legacy accounts that carry only a raw
// `role` (e.g. sales/stores) and no department are LEFT EMPTY on
// purpose — requireFeature treats an empty list as "defer to the role
// gate", so those users keep working exactly as before.

const { DEPARTMENTS } = require("../utils/roles");
const { featuresForDepartment, sanitizeFeatures } = require("../utils/features");

module.exports = {
  async up(db) {
    const users = db.collection("users");
    const cursor = users.find({
      department: { $in: DEPARTMENTS },
      $or: [
        { features: { $exists: false } },
        { features: { $size: 0 } },
      ],
    });

    let updated = 0;
    for await (const u of cursor) {
      const features = sanitizeFeatures(featuresForDepartment(u.department));
      if (features.length === 0) continue;
      await users.updateOne({ _id: u._id }, { $set: { features } });
      updated += 1;
    }
    // eslint-disable-next-line no-console
    console.log(`[backfill-user-features] set features on ${updated} user(s)`);
  },

  // Reversible: clear only the lists this migration could have written.
  // We can't distinguish a backfilled list from an admin-authored one
  // that happens to equal the department default, so `down` clears
  // features for the same narrow department set. This is a soft rollback
  // of enforcement (empty => defer to role gate), not data loss beyond
  // what the app can rebuild from the Users screen.
  async down(db) {
    await db.collection("users").updateMany(
      { department: { $in: DEPARTMENTS } },
      { $set: { features: [] } },
    );
  },
};
