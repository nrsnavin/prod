'use strict';
//
// Idempotency infrastructure indexes (Phase 1).
//
// Makes the requestId dedupe indexes explicit and recorded, rather than
// relying on mongoose autoIndex at boot:
//   • unique sparse requestId on packings / wastages / deliverychallans
//     (single-document creates carry the key on the document)
//   • TTL index on idempotencykeys (batch writes claim a key doc inside
//     their transaction; claims expire after 30 days)

const TTL_SECONDS = 60 * 60 * 24 * 30;

module.exports = {
  async up(db) {
    for (const coll of ['packings', 'wastages', 'deliverychallans']) {
      await db.collection(coll).createIndex(
        { requestId: 1 },
        { unique: true, sparse: true, name: 'requestId_unique' }
      );
    }
    await db.collection('idempotencykeys').createIndex(
      { createdAt: 1 },
      { expireAfterSeconds: TTL_SECONDS, name: 'createdAt_ttl' }
    );
  },

  async down(db) {
    for (const coll of ['packings', 'wastages', 'deliverychallans']) {
      try { await db.collection(coll).dropIndex('requestId_unique'); } catch (_) {}
    }
    try { await db.collection('idempotencykeys').dropIndex('createdAt_ttl'); } catch (_) {}
  },
};
