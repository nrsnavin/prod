'use strict';
//
// Indexes for the scale work (rate limits across processes, and the
// employee page reading shifts by reference). Recorded here as well as
// declared, following 20260711000002-idempotency-indexes.js, rather
// than trusting mongoose autoIndex at boot:
//
//   • shiftdetails { employee: 1, createdAt: -1 } — the employee page's
//     ten newest shifts and their count, which used to come from
//     populating Employee.shifts whole.
//   • ratelimits { resetAt: 1 } TTL 0 — clears finished rate-limit
//     windows (utils/rateLimitStore.js also creates it lazily).

const { ensureIndex } = require('../utils/ensureIndex');

module.exports = {
  async up(db) {
    await ensureIndex(db, 'shiftdetails', { employee: 1, createdAt: -1 },
      { name: 'employee_1_createdAt_-1' });
    await ensureIndex(db, 'ratelimits', { resetAt: 1 },
      { expireAfterSeconds: 0, name: 'resetAt_1' });
  },

  async down(db) {
    try { await db.collection('shiftdetails').dropIndex('employee_1_createdAt_-1'); } catch (_) {}
    try { await db.collection('ratelimits').dropIndex('resetAt_1'); } catch (_) {}
  },
};
