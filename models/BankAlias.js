"use strict";
// ══════════════════════════════════════════════════════════════════
//  A REMEMBERED PAYER OR PAYEE
//
//  Text a bank narration carries — a UPI id, the name the bank prints
//  for a customer who pays from a proprietor's account, "TNEB" — that a
//  person said, once, belongs to this party. The next statement's lines
//  carrying it are matched to that party (services/bankStatement.js),
//  still for a person to confirm: a remembered payer is never posted
//  without one.
// ══════════════════════════════════════════════════════════════════

const mongoose = require("mongoose");

const BankAliasSchema = new mongoose.Schema(
  {
    // Upper case, spaces folded: compared against the narration in upper case.
    text:      { type: String, required: true, trim: true, minlength: 4, maxlength: 80 },
    // Money in (a customer, or another party paying us) or out.
    direction: { type: String, enum: ["in", "out"], required: true },
    partyType: { type: String, enum: ["customer", "supplier", "other"], required: true },
    party:     { type: mongoose.Types.ObjectId, default: null },
    partyName: { type: String, required: true, trim: true, maxlength: 120 },
    // Someone not on file: the expense head a payment to them debits, or
    // the income a receipt from them is.
    head:      { type: mongoose.Types.ObjectId, ref: "ExpenseCategory", default: null },
    headName:  { type: String, default: "" },
    incomeLedger: { type: String, enum: ["", "interest"], default: "" },
    createdBy: { type: mongoose.Types.ObjectId, ref: "User" },
    createdByName: { type: String, default: "" },
    lastMatchedAt: { type: Date, default: null },
    // Lines it suggested that a person posted exactly as suggested, in a
    // row; any change starts it again. Enough of them and its lines post
    // themselves, when the books allow it (services/learnedPosting.js).
    acceptedUnchanged: { type: Number, default: 0, min: 0 },
    lastAcceptedAt:    { type: Date, default: null },
    changedAt:         { type: Date, default: null },
    autoPosted:        { type: Number, default: 0, min: 0 },
    lastAutoPostedAt:  { type: Date, default: null },
  },
  { timestamps: true }
);

BankAliasSchema.index({ text: 1, direction: 1 }, { unique: true });

module.exports = mongoose.model("BankAlias", BankAliasSchema);
