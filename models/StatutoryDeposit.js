"use strict";
// ══════════════════════════════════════════════════════════════════
//  PF / ESI / PROFESSIONAL TAX DEPOSITED FOR A PAYROLL MONTH
//
//  Due by the 15th of the next month. The employees' share deposited
//  after the due day is not an expense of the year (s.36(1)(va)), so
//  the date matters as much as the amount.
// ══════════════════════════════════════════════════════════════════

const mongoose = require("mongoose");

const StatutoryDepositSchema = new mongoose.Schema(
  {
    kind:        { type: String, enum: ["pf", "esi", "pt"], required: true },
    month:       { type: String, required: true },      // payroll month, "2026-10"
    amount:      { type: Number, required: true, min: 0.01 },
    challanNo:   { type: String, trim: true, default: "", maxlength: 40 },
    depositedOn: { type: Date, required: true },
    account:     { type: mongoose.Types.ObjectId, ref: "BankAccount" },
    note:        { type: String, trim: true, default: "", maxlength: 200 },
    // The request that recorded it: the same request sent twice records it once.
    requestId:   { type: String, unique: true, sparse: true },
    createdBy:   { type: mongoose.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

StatutoryDepositSchema.index({ month: 1, kind: 1 });
// One challan is recorded once for a month (a deposit saved twice showed the month paid twice over).
StatutoryDepositSchema.index(
  { kind: 1, month: 1, challanNo: 1, depositedOn: 1, amount: 1 },
  { unique: true, partialFilterExpression: { challanNo: { $gt: "" } } }
);

module.exports = mongoose.model("StatutoryDeposit", StatutoryDepositSchema);
