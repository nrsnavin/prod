"use strict";
// ══════════════════════════════════════════════════════════════════
//  A PLACE MONEY SITS: a bank account, the cash box, a UPI handle.
//
//  Every receipt and payment names one, so the cash / bank book per
//  account is a sum over vouchers, and the bank statement matcher
//  knows which account a statement belongs to.
// ══════════════════════════════════════════════════════════════════

const mongoose = require("mongoose");

const BankAccountSchema = new mongoose.Schema(
  {
    name:      { type: String, required: true, trim: true, maxlength: 80 },
    kind:      { type: String, enum: ["bank", "cash", "upi"], required: true, default: "bank" },
    bankName:  { type: String, trim: true, default: "", maxlength: 80 },
    accountNo: { type: String, trim: true, default: "", maxlength: 30 },
    ifsc:      { type: String, trim: true, default: "", maxlength: 11 },
    upiId:     { type: String, trim: true, default: "", maxlength: 60 },
    // The balance on the day the books start in this app; the book
    // runs from here.
    openingBalance: { type: Number, default: 0 },
    openingDate:    { type: Date, default: null },
    // The petty-cash float: how much the cash box is topped up to.
    float:     { type: Number, default: 0, min: 0 },
    active:    { type: Boolean, default: true },
    isDefault: { type: Boolean, default: false },
    // The ledger this account is in Tally ("Kotak Bank CA", "Cash").
    tallyLedger: { type: String, trim: true, default: "", maxlength: 80 },
  },
  { timestamps: true }
);

BankAccountSchema.index({ active: 1, name: 1 });

module.exports = mongoose.model("BankAccount", BankAccountSchema);
