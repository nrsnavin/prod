"use strict";
// ══════════════════════════════════════════════════════════════════
//  EXPENSE
//
//  Money spent that is not a stock purchase: transport, electricity,
//  rent, repairs, tea. Entered by whoever spent it (with the receipt
//  photographed), approved by the office when the category or the
//  amount asks for it, and paid — from the petty-cash box at once, or
//  later by a payment voucher that settles it like a bill.
//
//    pending → approved → paid
//            ↘ rejected       (and any of them → cancelled)
//
//  GST on the expense is kept per line so the input credit is known
//  where the category allows it.
// ══════════════════════════════════════════════════════════════════

const mongoose = require("mongoose");
const { TaxLineSchema, TotalsSchema, AttachmentSchema, FingerprintSchema } = require("./accountsShared");

const ExpenseSchema = new mongoose.Schema(
  {
    expenseNo:     { type: String, required: true, unique: true, trim: true },
    financialYear: { type: String, required: true },
    sequence:      { type: Number, required: true },
    requestId:     { type: String, unique: true, sparse: true },

    date:     { type: Date, required: true, default: Date.now },
    // When it is to be paid — the payee's terms, or the date on the bill.
    dueDate:  { type: Date },
    category: { type: mongoose.Types.ObjectId, ref: "ExpenseCategory", required: true },
    categoryName: { type: String, default: "" },
    description:  { type: String, required: true, trim: true, maxlength: 200 },

    // Who was paid: a supplier on file, or just a name.
    supplier:   { type: mongoose.Types.ObjectId, ref: "Supplier" },
    payeeName:  { type: String, default: "", trim: true, maxlength: 120 },
    payeeGstin: { type: String, default: "", trim: true },
    // The payee's bill / receipt number, when there is one.
    refNo:      { type: String, default: "", trim: true, maxlength: 40 },
    // Booked to a cost centre: the order it was bought for, a machine, or a
    // department (services/costCentres.js). At most one.
    costCentre: {
      kind:        { type: String, enum: ["order", "machine", "department"] },
      order:       { type: mongoose.Types.ObjectId, ref: "Order" },
      orderNo:     { type: Number },
      machine:     { type: mongoose.Types.ObjectId, ref: "Machine" },
      department:  { type: String, default: "", trim: true, maxlength: 60 },
      name:        { type: String, default: "", trim: true },
    },

    supplyType: { type: String, enum: ["intra", "inter"], default: "intra" },
    lines:  { type: [TaxLineSchema], default: [] },
    totals: { type: TotalsSchema, default: () => ({}) },
    itc: {
      eligible: { type: Boolean, default: false },
      amount:   { type: Number, default: 0 },
    },

    status: { type: String, enum: ["pending", "approved", "rejected", "paid", "cancelled"], default: "pending" },
    approval: {
      required: { type: Boolean, default: true },
      by:       { type: mongoose.Types.ObjectId, ref: "User" },
      byName:   { type: String, default: "" },
      at:       { type: Date },
      note:     { type: String, default: "" },
    },
    // Paid at once (petty cash, UPI from the phone) — the voucher that
    // records it; or settled later by a payment voucher's allocation.
    paidAmount: { type: Number, default: 0 },
    paidFrom:   { type: mongoose.Types.ObjectId, ref: "BankAccount" },
    paidAt:     { type: Date },

    // A claim: someone spent their own money and is to be paid back.
    claimant: {
      user: { type: mongoose.Types.ObjectId, ref: "User" },
      name: { type: String, default: "" },
    },
    submittedBy:     { type: mongoose.Types.ObjectId, ref: "User" },
    submittedByName: { type: String, default: "" },
    notes:       { type: String, default: "", trim: true, maxlength: 500 },
    attachments: { type: [AttachmentSchema], default: [] },
    tally:  { batch: { type: mongoose.Types.ObjectId, ref: "TallyBatch" }, at: { type: Date }, cancelBatch: { type: mongoose.Types.ObjectId, ref: "TallyBatch" }, cancelAt: { type: Date } },
    source:      { type: String, default: "manual" },
    aiSuggestion: { type: mongoose.Types.ObjectId, ref: "AiSuggestion" },

    fingerprints: { type: [FingerprintSchema], default: [] },
  },
  { timestamps: true }
);

ExpenseSchema.index({ financialYear: 1, sequence: 1 });
ExpenseSchema.index({ status: 1, date: -1 });
ExpenseSchema.index({ category: 1, date: -1 });
ExpenseSchema.index({ supplier: 1, date: -1 });
ExpenseSchema.index({ "costCentre.order": 1 });

ExpenseSchema.methods.outstanding = function outstanding() {
  return Math.round(((this.totals?.grand || 0) - this.paidAmount) * 100) / 100;
};

module.exports = mongoose.model("Expense", ExpenseSchema);
