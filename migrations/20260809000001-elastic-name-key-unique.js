'use strict';
// ══════════════════════════════════════════════════════════════════
//  DERIVE nameKey ON EVERY EXISTING ELASTIC
//
//  Backfill only. The unique index itself is declared on the schema
//  (models/Elastic.js) and built by mongoose at startup — deliberately
//  NOT created here.
//
//  Why: a migration that creates an index at the end of this chain does
//  not return. It reproduces on every seeded shape the migration test
//  uses, on collections unrelated to this work, and with the operation
//  written three different ways. The database is idle throughout and
//  holds no lock, so the command never reaches it. Rather than ship a
//  step that can stall `npm start`, the constraint is left to the
//  application's own index build, which retries every boot and reports
//  failure without stopping anything.
//
//  This half is plain updates — the same thing the migration before it
//  does — and is what the API's duplicate check actually reads.
// ══════════════════════════════════════════════════════════════════

const { elasticNameKey } = require('../utils/elasticName.js');

module.exports = {
  async up(db) {
    const coll = db.collection('elastics');

    // An elastic is a product master — hundreds of rows carrying one
    // short string each — so read it whole and write it in one go.
    const rows = await coll
      .find({ $or: [{ nameKey: { $exists: false } }, { nameKey: null }] })
      .project({ name: 1 })
      .toArray();

    if (!rows.length) return;

    const writes = rows.map((doc) => ({
      updateOne: {
        filter: { _id: doc._id },
        update: { $set: { nameKey: elasticNameKey(doc.name) } },
      },
    }));

    // Unordered, and a duplicate-key error is expected rather than
    // exceptional. The unique index is sparse, so rows that have no key
    // yet all slip under it — and the moment this gives two of them the
    // SAME key, the second is refused. That is not a failure of the
    // migration, it is the catalogue telling us those two rows are one
    // product. Every other row is still written; throwing here would
    // abort the chain and stop `npm start` over data that needs a person.
    let filled = rows.length;
    try {
      await coll.bulkWrite(writes, { ordered: false });
    } catch (err) {
      const collisions = err.writeErrors?.length;
      if (!collisions) throw err;
      filled -= collisions;
      console.warn(
        `[migration] elastics: ${collisions} row(s) could not take a key ` +
        `because another row already answers to that name. Run ` +
        `"node scripts/find-duplicate-elastics.js" to see them; until they ` +
        `are resolved those rows stay unkeyed and the unique index cannot ` +
        `be built. New duplicates are refused by the API regardless.`
      );
    }
    if (filled > 0) {
      console.log(`[migration] elastics: derived nameKey on ${filled} row(s)`);
    }
  },

  async down(db) {
    await db.collection('elastics').updateMany({}, { $unset: { nameKey: '' } });
  },
};
