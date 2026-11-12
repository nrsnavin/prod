// ══════════════════════════════════════════════════════════════════
//  A DOCUMENT NUMBER THAT WAS DRAWN AND NEVER USED
//
//  A number is drawn from its series before the document is written.
//  When the write then fails (the books were closed meanwhile, a figure
//  no longer fits, the database refused), the number is gone: the next
//  document takes the one after it. For a tax invoice or a credit or
//  debit note that gap has to be accounted for — GSTR-1's document
//  summary lists the series from its first number to its last, and
//  every number in between is either a document or a cancelled one.
//
//  One row per number lost, with why, so the gap can be shown as
//  cancelled in the return and explained to an auditor
//  (services/docNumbers.js burn(), services/gstr1.js).
// ══════════════════════════════════════════════════════════════════
const mongoose = require("mongoose");

const BurntNumberSchema = new mongoose.Schema(
  {
    // "invoice", "credit-note", "debit-note" — the series the return knows.
    series:        { type: String, required: true },
    number:        { type: String, required: true },
    financialYear: { type: String, default: "" },
    sequence:      { type: Number },
    // The date the document would have carried: the return period the gap falls in.
    date:          { type: Date, required: true },
    reason:        { type: String, default: "", maxlength: 300 },
    by:            { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    byName:        { type: String, default: "" },
  },
  { timestamps: true }
);

BurntNumberSchema.index({ series: 1, number: 1 }, { unique: true });
BurntNumberSchema.index({ series: 1, date: 1 });

module.exports = mongoose.models.BurntNumber || mongoose.model("BurntNumber", BurntNumberSchema);
