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
//
// The counters are seeded into "doc_counters", not "counters". This
// migration originally wrote to "counters", and on a fresh database that
// worked — but the real database is not fresh: mongoose-sequence
// (Order.orderNo, JobOrder.jobOrderNo) already owns "counters" there and
// has put a UNIQUE index on { id, reference_value }. Our rows carry
// neither field, so they all index as (null, null): the poNo row went in
// and the first DC row died with E11000, taking the whole chain with it
// before a single migration was recorded.
//
// 20260725000002-move-doc-counters moves any rows an earlier run of this
// migration left in "counters", so a database that already applied the
// old version is unaffected — its counters are in "doc_counters" too,
// and this migration never runs again there.

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
    await db.collection('doc_counters').updateOne(
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
      await db.collection('doc_counters').updateOne(
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
    await db.collection('doc_counters').deleteOne({ _id: 'poNo' });
    await db.collection('doc_counters').deleteMany({ _id: /^dc:/ });
  },
};
