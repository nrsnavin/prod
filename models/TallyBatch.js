"use strict";
// ══════════════════════════════════════════════════════════════════
//  TALLY BATCH — one export of vouchers to Tally
//
//  The period it covered, what went in it (each document is stamped
//  with the batch, so it never goes twice), the XML handed over, and
//  whether the books were locked up to its end when it was made.
// ══════════════════════════════════════════════════════════════════

const mongoose = require("mongoose");

const TallyBatchSchema = new mongoose.Schema(
  {
    batchNo:  { type: Number, required: true, unique: true },
    from:     { type: Date, required: true },
    to:       { type: Date, required: true },
    counts:   { type: mongoose.Schema.Types.Mixed, default: {} },
    vouchers: { type: Number, default: 0 },
    docs: {
      type: [new mongoose.Schema({
        docType: { type: String, required: true },
        doc:     { type: mongoose.Types.ObjectId, required: true },
        number:  { type: String, default: "" },
      }, { _id: false })],
      default: [],
    },
    ledgers:  { type: [String], default: [] },
    lockedUpTo: { type: Date, default: null },
    byName:   { type: String, default: "" },
    by:       { type: mongoose.Types.ObjectId, ref: "User" },
    // The file itself; read only when it is downloaded.
    xml:      { type: String, default: "", select: false },
  },
  { timestamps: true }
);

module.exports = mongoose.model("TallyBatch", TallyBatchSchema);
