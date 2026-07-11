const mongoose = require("mongoose");

// Atomic document-number counters (poNo, DC sequences, …).
//
// One doc per sequence, keyed by a string _id like "poNo" or
// "dc:elastic:25/26". utils/sequence.js is the only writer — it
// allocates numbers with a single $inc findOneAndUpdate, which is
// race-free under concurrency (unlike the old read-max-then-+1
// pattern, which could hand two simultaneous requests the same
// number).
const CounterSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    seq: { type: Number, required: true, default: 0 },
  },
  { versionKey: false }
);

module.exports = mongoose.model("Counter", CounterSchema);
