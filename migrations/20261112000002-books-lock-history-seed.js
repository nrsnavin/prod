'use strict';
//
// Start the books lock's history from the lock as it stands.
//
// The lock had no history: the settings row kept only the lock date and
// who last changed it, and when. Every change is now written to
// `bookslockevents` (services/booksLock.js), and the books health check
// reads that history to find entries made inside a period after it was
// closed. Without a first row, the stretch the books have been locked
// for until today would drop out of that check the first time the lock
// moves.
//
// If the books are locked and the history is empty, this writes one
// "closed" row from the settings: the lock date, and the time and name
// recorded when it was last set. Nothing else is touched.
//
// `down` removes the row this added (marked via: 'before-history').
// Safe to run twice: with any history present it does nothing.

module.exports = {
  async up(db) {
    if (await db.collection('bookslockevents').countDocuments({}, { limit: 1 })) return;
    const s = await db.collection('accountssettings').findOne({ key: 'accounts' }, { projection: { lockDate: 1, lockedAt: 1, lockedBy: 1 } });
    if (!s?.lockDate || !s?.lockedAt) return;
    await db.collection('bookslockevents').insertOne({
      kind: 'closed', lockDate: s.lockDate, previousLockDate: null, reason: '', via: 'before-history',
      byName: s.lockedBy || '', at: s.lockedAt,
    });
  },

  async down(db) {
    await db.collection('bookslockevents').deleteMany({ via: 'before-history' });
  },
};
