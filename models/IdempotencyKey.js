const mongoose = require("mongoose");

// Generic idempotency claims for batch/aggregate writes that can't carry
// a per-document requestId (e.g. inward-stock creates N MaterialInward
// rows in one request). The key is claimed by inserting a doc with
// _id = requestId INSIDE the business transaction: a replay's insert
// fails with E11000, aborting its transaction before anything applies.
//
// TTL: claims only need to outlive the client's retry window; 30 days
// is generous and keeps the collection from growing forever.
const IdempotencyKeySchema = new mongoose.Schema(
  {
    _id:       { type: String, required: true },
    purpose:   { type: String, default: "" },
    createdAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 * 30 },
  },
  { versionKey: false }
);

module.exports = mongoose.model("IdempotencyKey", IdempotencyKeySchema);
