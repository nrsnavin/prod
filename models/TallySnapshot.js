"use strict";
// ══════════════════════════════════════════════════════════════════
//  WHAT TALLY SAID ITS LEDGERS WERE
//
//  The connector on the Tally computer reads every ledger — its name,
//  group, GSTIN and closing balance — and sends it here, now and then.
//  The ERP compares it with its own books: parties whose balance differs,
//  ledgers an export needs that Tally does not have, parties in one and
//  not the other. Only the last few are kept; they are a reading, not a
//  record.
//
//  `closing` keeps Tally's own sign: a debit balance is negative.
// ══════════════════════════════════════════════════════════════════

const mongoose = require("mongoose");

const TallySnapshotSchema = new mongoose.Schema(
  {
    company: { type: String, default: "" },
    ledgers: {
      type: [new mongoose.Schema({
        name:    { type: String, required: true },
        parent:  { type: String, default: "" },
        gstin:   { type: String, default: "" },
        closing: { type: Number, default: 0 },
      }, { _id: false })],
      default: [],
    },
    count: { type: Number, default: 0 },
  },
  { timestamps: true }
);

TallySnapshotSchema.index({ createdAt: -1 });

module.exports = mongoose.model("TallySnapshot", TallySnapshotSchema);
