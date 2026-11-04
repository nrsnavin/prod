"use strict";
// ══════════════════════════════════════════════════════════════════
//  BALANCE CONFIRMATION
//
//  At the year end (or any day) the auditor wants each party's word
//  that the balance in our books is the balance in theirs. One row per
//  party per day: the balance we said, when and how the letter went,
//  and what they replied — agreed, or their figure and the gap to
//  reconcile. The letter itself is written when asked for
//  (services/confirmations.js), from the ledger as it stands.
// ══════════════════════════════════════════════════════════════════

const mongoose = require("mongoose");
const { FingerprintSchema } = require("./accountsShared");

const BalanceConfirmationSchema = new mongoose.Schema(
  {
    confirmationNo: { type: String, required: true, unique: true, trim: true },
    financialYear:  { type: String, required: true },
    sequence:       { type: Number, required: true },

    asOf:      { type: Date, required: true },
    partyType: { type: String, enum: ["customer", "supplier"], required: true },
    customer:  { type: mongoose.Types.ObjectId, ref: "Customer" },
    supplier:  { type: mongoose.Types.ObjectId, ref: "Supplier" },
    partyName: { type: String, required: true, trim: true },
    partyGstin: { type: String, default: "", trim: true },

    // Our books on the day: positive = the party owes us (customer) /
    // we owe them (supplier), as the ledger reads.
    balance:   { type: Number, required: true },
    // The open documents that make it up, for the letter.
    openCount: { type: Number, default: 0 },

    status: { type: String, enum: ["draft", "sent", "confirmed", "disputed"], default: "draft" },
    sent: {
      at:      { type: Date },
      by:      { type: mongoose.Types.ObjectId, ref: "User" },
      channel: { type: String, enum: ["", "email", "whatsapp", "print"], default: "" },
      to:      { type: String, default: "", trim: true },
      result:  { type: String, default: "" },
    },
    reply: {
      at:           { type: Date },
      by:           { type: mongoose.Types.ObjectId, ref: "User" },
      theirBalance: { type: Number },
      // theirBalance − balance; 0 when they agree.
      difference:   { type: Number, default: 0 },
      note:         { type: String, default: "", trim: true, maxlength: 500 },
    },

    createdBy:    { type: mongoose.Types.ObjectId, ref: "User" },
    fingerprints: { type: [FingerprintSchema], default: [] },
  },
  { timestamps: true }
);

BalanceConfirmationSchema.index({ asOf: 1, partyType: 1, customer: 1, supplier: 1 });
BalanceConfirmationSchema.index({ status: 1, asOf: -1 });

module.exports = mongoose.model("BalanceConfirmation", BalanceConfirmationSchema);
