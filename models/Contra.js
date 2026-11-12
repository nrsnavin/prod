"use strict";
// ══════════════════════════════════════════════════════════════════
//  CONTRA — money moved between our own accounts
//
//  Cash drawn from the bank into the cash box, cash deposited, a
//  transfer between two banks. No party, no document settled: one
//  account goes down and the other up by the same amount, and both
//  cash books show it. Numbered CTR/2026-27/0001; cancelled, never
//  edited.
// ══════════════════════════════════════════════════════════════════

const mongoose = require("mongoose");
const { FingerprintSchema } = require("./accountsShared");

const ContraSchema = new mongoose.Schema(
  {
    contraNo:      { type: String, required: true, unique: true, trim: true },
    financialYear: { type: String, required: true },
    sequence:      { type: Number, required: true },
    requestId:     { type: String, unique: true, sparse: true },

    date:     { type: Date, required: true },
    from:     { type: mongoose.Types.ObjectId, ref: "BankAccount", required: true },
    fromName: { type: String, default: "" },
    to:       { type: mongoose.Types.ObjectId, ref: "BankAccount", required: true },
    toName:   { type: String, default: "" },
    amount:   { type: Number, required: true, min: 0.01 },
    mode:     { type: String, enum: ["cash", "bank", "upi", "cheque", "card"], default: "bank" },
    reference: { type: String, default: "", trim: true, maxlength: 60 },
    narration: { type: String, default: "", trim: true, maxlength: 300 },

    // Bank reconciliation: when each side showed on its statement.
    fromClearedOn: { type: Date },
    toClearedOn:   { type: Date },
    // The bank line each side answers, on that account's statement
    // (services/bankLines.js): one line, one contra side.
    bankLineFrom: { type: String },
    bankLineTo:   { type: String },

    status: { type: String, enum: ["posted", "cancelled"], default: "posted" },
    cancel: { reason: { type: String, default: "" }, at: { type: Date }, by: { type: mongoose.Types.ObjectId, ref: "User" } },
    tally:  { batch: { type: mongoose.Types.ObjectId, ref: "TallyBatch" }, at: { type: Date }, cancelBatch: { type: mongoose.Types.ObjectId, ref: "TallyBatch" }, cancelAt: { type: Date } },

    createdBy:    { type: mongoose.Types.ObjectId, ref: "User" },
    fingerprints: { type: [FingerprintSchema], default: [] },
  },
  { timestamps: true }
);

ContraSchema.index({ financialYear: 1, sequence: 1 });
ContraSchema.index({ from: 1, date: -1 });
ContraSchema.index({ to: 1, date: -1 });
ContraSchema.index({ bankLineFrom: 1 }, { unique: true, partialFilterExpression: { bankLineFrom: { $gt: "" } } });
ContraSchema.index({ bankLineTo: 1 }, { unique: true, partialFilterExpression: { bankLineTo: { $gt: "" } } });

module.exports = mongoose.model("Contra", ContraSchema);
