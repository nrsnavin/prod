'use strict';
//
// Rename Complaint.order → Complaint.job.
//
// The field referenced JobOrder while being called `order`. Nothing had
// ever read it — the model had no routes and no mount in app.js, so no
// complaint could be filed through the API and the collection should be
// empty. This migration exists because "should be" is not "is": a row
// could have been written directly against Mongo, or by a script, and
// silently losing its job link would take the lot trail with it.
//
// So the rename is applied to whatever is actually there rather than
// assumed unnecessary. On an empty collection it is a no-op that costs
// one command; on a non-empty one it is the difference between a working
// blast-radius trace and a join that returns nothing.
//
// Guarded on `job` not already existing, so re-running cannot clobber a
// correct value with a stale one.
//
// Down: renames back, for the same reason and with the same guard.

module.exports = {
  async up(db) {
    const res = await db.collection('complaints').updateMany(
      { order: { $exists: true }, job: { $exists: false } },
      { $rename: { order: 'job' } }
    );
    // eslint-disable-next-line no-console
    console.log(`[complaint-order-to-job] ${res.modifiedCount} complaint(s) renamed order → job`);
  },

  async down(db) {
    const res = await db.collection('complaints').updateMany(
      { job: { $exists: true }, order: { $exists: false } },
      { $rename: { job: 'order' } }
    );
    // eslint-disable-next-line no-console
    console.log(`[complaint-order-to-job] down: ${res.modifiedCount} complaint(s)`);
  },
};
