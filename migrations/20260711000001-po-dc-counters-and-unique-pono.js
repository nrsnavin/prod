'use strict';
//
// Baseline migration for race-free document numbering.
//
// 1. Seeds the atomic counters (utils/sequence.js) from the current max
//    poNo and per-(type, financial-year) DC sequences, so the first
//    allocation after deploy continues the existing series.
// 2. Creates the unique sparse index on purchaseorders.poNo — but first
//    checks for existing duplicates and ABORTS with a report if any are
//    found. Duplicated PO numbers are financial documents; renumbering
//    them is a human decision, not a migration side-effect.
//
// Down: drops the index and the seeded counters (data itself untouched).

module.exports = {
  async up(db) {
    // ── 1. Refuse to proceed if duplicate poNos already exist ─────────
    const dupes = await db.collection('purchaseorders').aggregate([
      { $match: { poNo: { $type: 'number' } } },
      { $group: { _id: '$poNo', n: { $sum: 1 }, ids: { $push: '$_id' } } },
      { $match: { n: { $gt: 1 } } },
    ]).toArray();

    if (dupes.length > 0) {
      const report = dupes
        .map((d) => `poNo ${d._id}: ${d.n} docs (${d.ids.join(', ')})`)
        .join('\n  ');
      throw new Error(
        `Cannot create unique index — ${dupes.length} duplicated PO number(s) found.\n` +
        `Resolve these manually (renumber the later document of each pair), then re-run:\n  ${report}`
      );
    }

    // ── 2. Seed the poNo counter from the current max ─────────────────
    const [maxPo] = await db.collection('purchaseorders')
      .find({ poNo: { $type: 'number' } })
      .sort({ poNo: -1 })
      .limit(1)
      .project({ poNo: 1 })
      .toArray();
    const poSeed = Math.max(1000, maxPo?.poNo || 1000);
    await db.collection('counters').updateOne(
      { _id: 'poNo' },
      { $max: { seq: poSeed } },
      { upsert: true }
    );

    // ── 3. Seed each DC (type, financialYear) sequence counter ────────
    const dcMaxes = await db.collection('deliverychallans').aggregate([
      { $group: {
          _id: { type: '$type', fy: '$financialYear' },
          maxSeq: { $max: '$sequence' },
        } },
    ]).toArray();
    for (const row of dcMaxes) {
      if (!row._id.type || !row._id.fy) continue;
      await db.collection('counters').updateOne(
        { _id: `dc:${row._id.type}:${row._id.fy}` },
        { $max: { seq: row.maxSeq || 0 } },
        { upsert: true }
      );
    }

    // ── 4. Unique sparse index on poNo (DB-level last line of defense) ─
    await db.collection('purchaseorders').createIndex(
      { poNo: 1 },
      { unique: true, sparse: true, name: 'poNo_unique' }
    );
  },

  async down(db) {
    try {
      await db.collection('purchaseorders').dropIndex('poNo_unique');
    } catch (_) { /* index may not exist */ }
    await db.collection('counters').deleteOne({ _id: 'poNo' });
    await db.collection('counters').deleteMany({ _id: /^dc:/ });
  },
};
