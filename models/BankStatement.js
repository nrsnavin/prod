"use strict";
// ══════════════════════════════════════════════════════════════════
//  BANK STATEMENT — one uploaded statement and what became of each line
//
//  Kept so the reconciliation can say what the bank shows that the books
//  do not, and so the same statement uploaded twice does not ask the
//  same questions twice. A line is:
//    recorded   a voucher or contra already in the books matched it
//    posted     a voucher was posted from it
//    unmatched  still to be placed
//    ignored    set aside by a person, with a reason
// ══════════════════════════════════════════════════════════════════

const mongoose = require("mongoose");

const LineSchema = new mongoose.Schema(
  {
    index:     { type: Number, required: true },
    date:      { type: Date, required: true },
    narration: { type: String, default: "" },
    ref:       { type: String, default: "" },
    amount:    { type: Number, required: true },
    direction: { type: String, enum: ["in", "out"], required: true },
    balance:   { type: Number, default: null },
    // Same date, amount, direction, narration and reference: the same line.
    key:       { type: String, required: true },
    status:    { type: String, enum: ["recorded", "posted", "unmatched", "matched", "ignored"], default: "unmatched" },
    voucherType: { type: String, enum: ["Payment", "Contra", null], default: null },
    voucher:   { type: mongoose.Types.ObjectId, default: null },
    voucherNo: { type: String, default: "" },
    note:      { type: String, default: "" },
    // What the matcher proposed when it was read — the party and the
    // documents it settles — so the line can be confirmed and posted from
    // the stored statement, without uploading it again.
    suggestion: { type: mongoose.Schema.Types.Mixed, default: null },
    candidates: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { _id: false }
);

const BankStatementSchema = new mongoose.Schema(
  {
    account:     { type: mongoose.Types.ObjectId, ref: "BankAccount", required: true },
    accountName: { type: String, default: "" },
    file:        { type: String, default: "" },
    from:        { type: Date },
    to:          { type: Date },
    // The bank's balance after the last line, when the statement has a balance column.
    closingBalance: { type: Number, default: null },
    lines:       { type: [LineSchema], default: [] },
    uploadedBy:  { type: mongoose.Types.ObjectId, ref: "User" },
    uploadedByName: { type: String, default: "" },
    // "upload": a person; "email": the bank's scheduled statement, read
    // from the statements mailbox (messageId says which mail).
    source:      { type: String, enum: ["upload", "email", "sftp"], default: "upload" },
    messageId:   { type: String, default: "" },
  },
  { timestamps: true }
);

BankStatementSchema.index({ account: 1, to: -1 });
BankStatementSchema.index({ account: 1, "lines.key": 1 });

module.exports = mongoose.model("BankStatement", BankStatementSchema);
