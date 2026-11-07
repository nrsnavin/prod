"use strict";
// ══════════════════════════════════════════════════════════════════
//  A DEPOSIT SLIP — cheques in hand, and cash from the cash box, paid
//  into one bank account in one go, as the bank's counter takes them.
//
//  The cheques each move held → deposited on their voucher (the money
//  was booked when it was received); the cash goes as a contra from the
//  cash box. The slip is what ties them together, numbered
//  DEP/2026-27/0001, and what the bank's statement will show as one
//  credit (or one line per cheque, as some banks do).
// ══════════════════════════════════════════════════════════════════

const mongoose = require("mongoose");
const { FingerprintSchema } = require("./accountsShared");

const DepositSlipSchema = new mongoose.Schema(
  {
    slipNo:        { type: String, required: true, unique: true, trim: true },
    financialYear: { type: String, required: true },
    sequence:      { type: Number, required: true },
    requestId:     { type: String, unique: true, sparse: true },
    date:          { type: Date, required: true },
    account:       { type: mongoose.Types.ObjectId, ref: "BankAccount", required: true },
    accountName:   { type: String, default: "" },
    // The bank's own counterfoil number, when there is one.
    bankSlipNo:    { type: String, default: "", trim: true, maxlength: 30 },
    cheques: {
      type: [new mongoose.Schema({
        payment:   { type: mongoose.Types.ObjectId, ref: "Payment", required: true },
        voucherNo: { type: String, default: "" },
        chequeNo:  { type: String, default: "" },
        bank:      { type: String, default: "" },
        chequeDate: { type: Date },
        partyName: { type: String, default: "" },
        amount:    { type: Number, required: true },
      }, { _id: false })],
      default: [],
    },
    cash:       { type: Number, default: 0, min: 0 },
    cashFrom:   { type: mongoose.Types.ObjectId, ref: "BankAccount" },
    contra:     { type: mongoose.Types.ObjectId, ref: "Contra" },
    contraNo:   { type: String, default: "" },
    total:      { type: Number, required: true },
    createdBy:  { type: mongoose.Types.ObjectId, ref: "User" },
    fingerprints: { type: [FingerprintSchema], default: [] },
  },
  { timestamps: true }
);

DepositSlipSchema.index({ financialYear: 1, sequence: 1 });
DepositSlipSchema.index({ account: 1, date: -1 });

module.exports = mongoose.model("DepositSlip", DepositSlipSchema);
