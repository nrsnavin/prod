const mongoose = require("mongoose");

// Atomic document-number counters (poNo, DC sequences, …).
//
// One doc per sequence, keyed by a string _id like "poNo" or
// "dc:elastic:25/26". utils/sequence.js is the only writer — it
// allocates numbers with a single $inc findOneAndUpdate, which is
// race-free under concurrency (unlike the old read-max-then-+1
// pattern, which could hand two simultaneous requests the same
// number).
// IMPORTANT — this must NOT live in the default "counters" collection.
// mongoose-sequence (used for Order.orderNo / JobOrder.jobOrderNo) also
// writes to "counters" and puts a UNIQUE index on { id, reference_value }.
// Our documents carry neither field, so they all index as (null, null):
// the first one inserts, every later one fails with a duplicate key. The
// insert error was swallowed as "harmless", then the follow-up $inc found
// nothing and returned null — surfacing as
//     Cannot read properties of null (reading 'seq')
// on the SECOND distinct counter (e.g. creating a DC after a PO existed).
const CounterSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    seq: { type: Number, required: true, default: 0 },
  },
  { versionKey: false, collection: "doc_counters" }
);

module.exports = mongoose.model("Counter", CounterSchema);
