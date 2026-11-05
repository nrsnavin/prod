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
    docType: { type: String, enum: ["Invoice", "SupplierBill", "Expense", "OpeningBalance"], required: true },
    doc:     { type: mongoose.Types.ObjectId, required: true },
    docNo:   { type: String, required: true },
    amount:  { type: Number, required: true, min: 0 },
    // The TDS deducted on this document's share of the voucher, and the
    // value it was deducted on (the share net of GST).
    tds:     { type: Number, default: 0, min: 0 },
    tdsBase: { type: Number, default: 0, min: 0 },
    // Set when the allocation was made later, from what the voucher
    // left on account (an advance applied to a later invoice).
    appliedAt: { type: Date },
    // The Tally batch whose journal carried this later application.
    tallyBatch: { type: mongoose.Types.ObjectId, ref: "TallyBatch" },
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

    // A cheque, stage by stage: held (received and in the drawer — every
    // cheque received starts here, a post-dated one stays until its
    // date), deposited (handed to the bank, on a day, into an account),
    // cleared (the bank credited it; clearedOn on the voucher is set the
    // same day, for the reconciliation) or bounced. A bounced cheque
    // cancels the voucher (services/voucherCancel.js).
    cheque: {
      number:       { type: String, default: "", trim: true, maxlength: 20 },
      bank:         { type: String, default: "", trim: true, maxlength: 80 },
      date:         { type: Date },
      status:       { type: String, enum: ["", "held", "deposited", "cleared", "bounced"], default: "" },
      receivedOn:   { type: Date },
      depositedOn:  { type: Date },
      clearedOn:    { type: Date },
      bouncedOn:    { type: Date },
      bounceReason: { type: String, default: "", trim: true, maxlength: 200 },
      // What the bank charged for the return.
      charges:      { type: Number, default: 0, min: 0 },
    },

    // TDS on a payment: section, rate, and the total deducted.
    tds: {
      section: { type: String, default: "", trim: true },
      rate:    { type: Number, default: 0, min: 0, max: 100 },
      amount:  { type: Number, default: 0, min: 0 },
      // What it was deducted on: the bills' value net of GST.
      base:    { type: Number, default: 0, min: 0 },
    },

    // Settled besides the money: bank charges the bank kept, a discount,
    // TDS the customer deducted, a round-off, an amount written off.
    adjustments: {
      type: [new mongoose.Schema({
        kind:   { type: String, enum: ["bank_charges", "discount", "tds_by_customer", "round_off", "write_off"], required: true },
        label:  { type: String, default: "" },
        amount: { type: Number, required: true, min: 0 },
        note:   { type: String, default: "" },
      }, { _id: false })],
      default: [],
    },

    allocations: { type: [AllocationSchema], default: [] },
    // amount + tds + adjustments − allocated: what stays on account,
    // to be applied to a later document (POST /accounts/credits/apply).
    unallocated: { type: Number, default: 0 },

    // Bank reconciliation: the day the bank's statement showed it.
    clearedOn: { type: Date },

    status: { type: String, enum: ["posted", "cancelled"], default: "posted" },
    tally:  { batch: { type: mongoose.Types.ObjectId, ref: "TallyBatch" }, at: { type: Date }, cancelBatch: { type: mongoose.Types.ObjectId, ref: "TallyBatch" }, cancelAt: { type: Date } },
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
PaymentSchema.index({ "cheque.status": 1, "cheque.date": 1 });

module.exports = mongoose.model("Payment", PaymentSchema);
