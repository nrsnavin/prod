"use strict";
// ══════════════════════════════════════════════════════════════════
//  PAYMENT VOUCHER / RECEIPT VOUCHER
//
//  Money that moved. A RECEIPT (RCT/2026-27/0001) is a customer paying
//  us; a PAYMENT (PAY/2026-27/0001) is us paying a supplier, settling
//  an expense, or any other outgoing. Every voucher names the account
//  the money went through, and the documents it settles — several at
//  once, each for part or all of what it owed. What is not allocated
//  stays on the party's account as an advance / on-account amount.
//
//  TDS, on a payment: the deductee is settled for the gross amount
//  (paid + deducted), and the deducted part is what the TDS register
//  reports and what is remitted to the government.
//
//  A voucher is never edited. Cancelling one reverses its allocations
//  inside the same transaction.
// ══════════════════════════════════════════════════════════════════

const mongoose = require("mongoose");
const { AttachmentSchema, FingerprintSchema } = require("./accountsShared");

const AllocationSchema = new mongoose.Schema(
  {
    docType: { type: String, enum: ["Invoice", "SupplierBill", "Expense"], required: true },
    doc:     { type: mongoose.Types.ObjectId, required: true },
    docNo:   { type: String, required: true },
    amount:  { type: Number, required: true, min: 0 },
    // The TDS deducted on this document's share of the voucher.
    tds:     { type: Number, default: 0, min: 0 },
  },
  { _id: false }
);

const PaymentSchema = new mongoose.Schema(
  {
    kind:          { type: String, enum: ["receipt", "payment"], required: true },
    voucherNo:     { type: String, required: true, unique: true, trim: true },
    financialYear: { type: String, required: true },
    sequence:      { type: Number, required: true },
    requestId:     { type: String, unique: true, sparse: true },

    date: { type: Date, required: true, default: Date.now },

    partyType: { type: String, enum: ["customer", "supplier", "other"], required: true },
    customer:  { type: mongoose.Types.ObjectId, ref: "Customer" },
    supplier:  { type: mongoose.Types.ObjectId, ref: "Supplier" },
    partyName: { type: String, required: true, trim: true },

    // The money itself.
    amount:    { type: Number, required: true, min: 0.01 },
    mode:      { type: String, enum: ["cash", "bank", "upi", "cheque"], required: true },
    account:   { type: mongoose.Types.ObjectId, ref: "BankAccount", required: true },
    accountName: { type: String, default: "" },
    // UTR / cheque number / UPI reference.
    reference: { type: String, default: "", trim: true, maxlength: 60 },

    // TDS on a payment: section, rate, and the total deducted.
    tds: {
      section: { type: String, default: "", trim: true },
      rate:    { type: Number, default: 0, min: 0, max: 100 },
      amount:  { type: Number, default: 0, min: 0 },
    },

    allocations: { type: [AllocationSchema], default: [] },
    // amount + tds − allocated: what stays on account.
    unallocated: { type: Number, default: 0 },

    status: { type: String, enum: ["posted", "cancelled"], default: "posted" },
    cancel: { reason: { type: String, default: "" }, at: { type: Date }, by: { type: mongoose.Types.ObjectId, ref: "User" } },

    narration:   { type: String, default: "", trim: true, maxlength: 300 },
    attachments: { type: [AttachmentSchema], default: [] },
    // "manual", or "statement" when posted from a bank statement line.
    source: { type: String, default: "manual" },
    statementLine: { type: String, default: "" },

    createdBy:    { type: mongoose.Types.ObjectId, ref: "User" },
    fingerprints: { type: [FingerprintSchema], default: [] },
  },
  { timestamps: true }
);

PaymentSchema.index({ kind: 1, financialYear: 1, sequence: 1 });
PaymentSchema.index({ customer: 1, date: -1 });
PaymentSchema.index({ supplier: 1, date: -1 });
PaymentSchema.index({ account: 1, date: -1 });
PaymentSchema.index({ status: 1, date: -1 });
PaymentSchema.index({ "allocations.doc": 1 });

module.exports = mongoose.model("Payment", PaymentSchema);
