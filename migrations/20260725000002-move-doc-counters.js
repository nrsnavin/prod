'use strict';
//
// Move our document-number counters out of "counters" into "doc_counters".
//
// mongoose-sequence (Order.orderNo, JobOrder.jobOrderNo) owns "counters"
// and puts a UNIQUE index on { id, reference_value }. Our rows have
// neither field, so they all collide as (null, null) — only the first
// could ever be inserted. That surfaced as
//     Cannot read properties of null (reading 'seq')
// when allocating the second distinct counter (e.g. creating a DC once a
// PO counter existed).
//
// Our rows are identifiable: a STRING _id plus a numeric seq, and none of
// the plugin's fields. The plugin's own rows are left untouched.

module.exports = {
  async up(db) {
    const src = db.collection('counters');
    const dst = db.collection('doc_counters');

    const ours = await src.find({
      _id: { $type: 'string' },
      seq: { $type: 'number' },
      id: { $exists: false },
      reference_value: { $exists: false },
    }).toArray();

    for (const doc of ours) {
      // Keep the higher seq if a row somehow already exists at the target,
      // so numbers can never go backwards and re-issue a used number.
      const existing = await dst.findOne({ _id: doc._id });
      if (existing) {
        if ((doc.seq || 0) > (existing.seq || 0)) {
          await dst.updateOne({ _id: doc._id }, { $set: { seq: doc.seq } });
        }
      } else {
        await dst.insertOne({ _id: doc._id, seq: doc.seq });
      }
      await src.deleteOne({ _id: doc._id });
    }
  },

  async down(db) {
    const src = db.collection('doc_counters');
    const dst = db.collection('counters');
    for (const doc of await src.find({}).toArray()) {
      await dst.updateOne({ _id: doc._id }, { $set: { seq: doc.seq } }, { upsert: true });
    }
    await src.deleteMany({});
  },
};
