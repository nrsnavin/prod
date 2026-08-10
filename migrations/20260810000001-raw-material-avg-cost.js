'use strict';
// ══════════════════════════════════════════════════════════════════
//  SEED avgCost FROM price
//
//  Materials that existed before weighted-average costing have no
//  average — nothing has been received since it existed. Their latest
//  purchase price is the only estimate of what their stock cost, and
//  it is exactly what they were being costed at before this, so
//  seeding from it changes no number on any screen on the day it runs.
//  From the next receipt onwards the average starts moving on its own.
//
//  Backfill only, no index creation. An index built at the end of this
//  chain does not return — see the note in
//  migrations/20260809000001-elastic-name-key-unique.js. There is no
//  new index to build here in any case; `avgCost` is read alongside a
//  material that has already been fetched by _id.
//
//  Readers do not depend on this having run: utils/materialValuation's
//  costOf() falls back to `price` whenever avgCost is 0 or absent. The
//  migration exists so the field is materialised and can be reported
//  on, not to make the code correct.
// ══════════════════════════════════════════════════════════════════

module.exports = {
  async up(db) {
    const coll = db.collection('rawmaterials');

    // Only rows that have no average yet. Re-running must not reset an
    // average that receipts have since moved — that would revalue the
    // whole shelf at the latest quote, which is the exact behaviour
    // this work exists to remove.
    const result = await coll.updateMany(
      {
        $or: [
          { avgCost: { $exists: false } },
          { avgCost: null },
          { avgCost: 0 },
        ],
      },
      [
        {
          $set: {
            // $max against 0: a legacy row with a negative price would
            // otherwise seed a negative cost, and stock cannot be worth
            // less than nothing.
            avgCost: { $max: [{ $ifNull: ['$price', 0] }, 0] },
          },
        },
      ]
    );

    if (result.modifiedCount) {
      console.log(
        `[migration] rawmaterials: seeded avgCost from price on ` +
        `${result.modifiedCount} row(s)`
      );
    }
  },

  async down(db) {
    await db.collection('rawmaterials').updateMany({}, { $unset: { avgCost: '' } });
  },
};
