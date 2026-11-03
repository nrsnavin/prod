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
    cancels:  { type: Number, default: 0 },
    company:  { type: String, default: "" },
    // One message per master, voucher, cancellation or applied credit,
    // with what it stamped — so a message Tally refuses comes off alone.
    messages: {
      type: [new mongoose.Schema({
        key:     { type: String, required: true },
        kind:    { type: String, enum: ["master", "voucher", "cancel", "application"], required: true },
        docType: { type: String, default: "" },
        doc:     { type: mongoose.Types.ObjectId },
        target:  { type: mongoose.Types.ObjectId },
        at:      { type: Date },
        number:  { type: String, default: "" },
        xml:     { type: String, default: "" },
      }, { _id: false })],
      default: [],
      select: false,
    },
    // How it reaches Tally: a file someone imports, or the connector,
    // which reports back message by message.
    delivery: {
      via:        { type: String, enum: ["file", "connector"], default: "file" },
      status:     { type: String, enum: ["file", "queued", "sending", "sent", "partial", "failed"], default: "file" },
      attempts:   { type: Number, default: 0 },
      startedAt:  { type: Date },
      finishedAt: { type: Date },
      sent:       { type: Number, default: 0 },
      failed:     { type: Number, default: 0 },
      errors:     { type: [new mongoose.Schema({ key: String, number: String, error: String }, { _id: false })], default: [] },
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("TallyBatch", TallyBatchSchema);
