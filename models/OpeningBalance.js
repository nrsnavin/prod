"use strict";
// ══════════════════════════════════════════════════════════════════
//  OPENING BALANCE — what a party owed, or had paid ahead, on the day
//  the office started keeping accounts here
//
//  Brought over from Tally, one row per open bill so the ageing is
//  right from the first day (or one row for the whole balance when the
//  bill-wise breakup is not to hand). Numbered OB/2026-27/0001.
//
//    kind "due"      a customer owes us / we owe a supplier. Settled by
//                    vouchers like an invoice or a bill.
//    kind "advance"  a customer paid ahead / we paid a supplier ahead.
//                    Sits as a credit to apply against later documents.
//
//  On the party ledger from its date like any other document, kept by a
//  ledger rebuild, and cancelled (never edited) while nothing is set
//  against it.
// ══════════════════════════════════════════════════════════════════

const mongoose = require("mongoose");
const { FingerprintSchema } = require("./accountsShared");

const ApplicationSchema = new mongoose.Schema(
  {
    docType: { type: String, enum: ["Invoice", "SupplierBill", "Expense", "OpeningBalance"], required: true },
    doc:     { type: mongoose.Types.ObjectId, required: true },
    docNo:   { type: String, required: true },
    amount:  { type: Number, required: true, min: 0 },
    at:      { type: Date, default: Date.now },
    by:      { type: mongoose.Types.ObjectId, ref: "User" },
    // The Tally batch whose journal carried this application.
    tallyBatch: { type: mongoose.Types.ObjectId, ref: "TallyBatch" },
  },
  { _id: false }
);

const OpeningBalanceSchema = new mongoose.Schema(
  {
    docNo:         { type: String, required: true, unique: true, trim: true },
    financialYear: { type: String, required: true },
    sequence:      { type: Number, required: true },
    requestId:     { type: String, unique: true, sparse: true },

    partyType: { type: String, enum: ["customer", "supplier"], required: true },
    customer:  { type: mongoose.Types.ObjectId, ref: "Customer" },
    supplier:  { type: mongoose.Types.ObjectId, ref: "Supplier" },
    partyName: { type: String, required: true, trim: true },

    kind:    { type: String, enum: ["due", "advance"], required: true },
    // The original bill or receipt number in the old books.
    refNo:   { type: String, default: "", trim: true, maxlength: 40 },
    date:    { type: Date, required: true },
    dueDate: { type: Date },
    amount:  { type: Number, required: true, min: 0.01 },

    // A due: what vouchers have settled. An advance: what is left to apply.
    settledAmount: { type: Number, default: 0 },
    unapplied:     { type: Number, default: 0 },
    applications:  { type: [ApplicationSchema], default: [] },

    status: { type: String, enum: ["posted", "cancelled"], default: "posted" },
    cancel: { reason: { type: String, default: "" }, at: { type: Date }, by: { type: mongoose.Types.ObjectId, ref: "User" } },
    notes:  { type: String, default: "", trim: true, maxlength: 300 },
    // Rows posted by one spreadsheet import share this.
    importBatch: { type: String, default: "" },

    createdBy:    { type: mongoose.Types.ObjectId, ref: "User" },
    fingerprints: { type: [FingerprintSchema], default: [] },
  },
  { timestamps: true }
);

OpeningBalanceSchema.index({ financialYear: 1, sequence: 1 });
OpeningBalanceSchema.index({ customer: 1, status: 1 });
OpeningBalanceSchema.index({ supplier: 1, status: 1 });

module.exports = mongoose.model("OpeningBalance", OpeningBalanceSchema);
module.exports.ApplicationSchema = ApplicationSchema;
