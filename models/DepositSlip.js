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
//
//  A slip made by mistake is cancelled as a whole: its cheques go back
//  in hand (into the account each was entered against) and its cash
//  contra is cancelled with it. The contra cannot be cancelled by
//  itself — that left a slip saying cash went in that the books no
//  longer showed.
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
        // Where the cheque's voucher stood before the deposit moved it
        // into this bank: where it goes back to if the slip is cancelled.
        accountBefore:     { type: mongoose.Types.ObjectId, ref: "BankAccount" },
        accountNameBefore: { type: String, default: "" },
      }, { _id: false })],
      default: [],
    },
    cash:       { type: Number, default: 0, min: 0 },
    cashFrom:   { type: mongoose.Types.ObjectId, ref: "BankAccount" },
    contra:     { type: mongoose.Types.ObjectId, ref: "Contra" },
    contraNo:   { type: String, default: "" },
    total:      { type: Number, required: true },
    // A slip stored before it could be cancelled has no status: it is posted.
    status:     { type: String, enum: ["posted", "cancelled"], default: "posted" },
    cancel:     { reason: String, at: Date, by: { type: mongoose.Types.ObjectId, ref: "User" } },
    createdBy:  { type: mongoose.Types.ObjectId, ref: "User" },
    fingerprints: { type: [FingerprintSchema], default: [] },
  },
  { timestamps: true }
);

DepositSlipSchema.index({ financialYear: 1, sequence: 1 });
DepositSlipSchema.index({ account: 1, date: -1 });

module.exports = mongoose.model("DepositSlip", DepositSlipSchema);
