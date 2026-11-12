"use strict";
// ══════════════════════════════════════════════════════════════════
//  JOURNAL VOUCHER
//
//  An entry with no cash in it: a customer who is also a supplier set
//  off, a balance written off, salary payable, depreciation, a
//  reclassification. Any number of debit and credit lines, which must
//  balance. A line is a party (customer or supplier: it posts to the
//  party ledger and can be set against their open documents, bill by
//  bill), a bank or cash account, an expense head, or a plain Tally
//  ledger named here. Goes to Tally as a Journal, like the others.
//
//  A journal is never edited: cancelling it reverses what it settled.
// ══════════════════════════════════════════════════════════════════

const mongoose = require("mongoose");
const { FingerprintSchema } = require("./accountsShared");

const RefSchema = new mongoose.Schema(
  {
    docType: { type: String, enum: ["Invoice", "SupplierBill", "Expense", "OpeningBalance"], required: true },
    doc:     { type: mongoose.Types.ObjectId, required: true },
    docNo:   { type: String, required: true },
    amount:  { type: Number, required: true, min: 0.01 },
  },
  { _id: false }
);

const LineSchema = new mongoose.Schema(
  {
    kind:      { type: String, enum: ["party", "bank", "head", "ledger"], required: true },
    ledger:    { type: String, required: true, trim: true, maxlength: 120 },   // the name Tally knows
    partyType: { type: String, enum: ["customer", "supplier"] },
    customer:  { type: mongoose.Types.ObjectId, ref: "Customer" },
    supplier:  { type: mongoose.Types.ObjectId, ref: "Supplier" },
    account:   { type: mongoose.Types.ObjectId, ref: "BankAccount" },
    category:  { type: mongoose.Types.ObjectId, ref: "ExpenseCategory" },
    debit:     { type: Number, default: 0, min: 0 },
    credit:    { type: Number, default: 0, min: 0 },
    // Bill-wise, for a party line: the open documents this amount settles.
    refs:      { type: [RefSchema], default: [] },
    note:      { type: String, default: "", trim: true, maxlength: 120 },
  },
  { _id: false }
);

const JournalSchema = new mongoose.Schema(
  {
    journalNo:     { type: String, required: true, unique: true, trim: true },
    financialYear: { type: String, required: true },
    sequence:      { type: Number, required: true },
    requestId:     { type: String, unique: true, sparse: true },
    date:      { type: Date, required: true },
    // What kind of entry, for the screen and the reports.
    purpose:   { type: String, enum: ["setoff", "writeoff", "accrual", "salary", "depreciation", "stock", "reclass", "other"], default: "other" },
    narration: { type: String, default: "", trim: true, maxlength: 300 },
    reason:    { type: String, required: true, trim: true, maxlength: 300 },
    lines:     { type: [LineSchema], default: [] },
    total:     { type: Number, required: true, min: 0.01 },   // Σ debits (= Σ credits)
    // Something else made this journal (payroll month, year-end stock).
    source:    { type: String, default: "manual" },
    sourceRef: { type: String, default: "" },
    status: { type: String, enum: ["posted", "cancelled"], default: "posted" },
    cancel: { reason: { type: String, default: "" }, at: { type: Date }, by: { type: mongoose.Types.ObjectId, ref: "User" } },
    tally:  { batch: { type: mongoose.Types.ObjectId, ref: "TallyBatch" }, at: { type: Date }, cancelBatch: { type: mongoose.Types.ObjectId, ref: "TallyBatch" }, cancelAt: { type: Date } },
    createdBy:     { type: mongoose.Types.ObjectId, ref: "User" },
    createdByName: { type: String, default: "" },
    fingerprints:  { type: [FingerprintSchema], default: [] },
  },
  { timestamps: true }
);

JournalSchema.index({ financialYear: 1, sequence: 1 });
JournalSchema.index({ date: -1 });
JournalSchema.index({ "lines.customer": 1 });
JournalSchema.index({ "lines.supplier": 1 });
JournalSchema.index({ source: 1, sourceRef: 1 });
// One posted journal for one thing another process posts (a payroll
// month, a year's depreciation, a day's closing stock): two requests
// together cannot both post it. Journals written by hand carry no
// sourceRef and are not in this index.
JournalSchema.index({ sourceRef: 1, source: 1 }, { unique: true, partialFilterExpression: { status: "posted", sourceRef: { $gt: "" } } });

module.exports = mongoose.model("Journal", JournalSchema);
