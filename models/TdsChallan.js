"use strict";
// ══════════════════════════════════════════════════════════════════
//  TDS DEPOSITED  (one challan, ITNS 281)
//
//  What was deducted in a month goes to the government by the 7th of
//  the next (30 April for March). The challan's BSR code, serial and
//  date go on the quarterly return (26Q) and on every Form 16A.
// ══════════════════════════════════════════════════════════════════

const mongoose = require("mongoose");

const TdsChallanSchema = new mongoose.Schema(
  {
    month:       { type: String, required: true },      // the month deducted, "2026-10"
    section:     { type: String, required: true, trim: true, uppercase: true },
    amount:      { type: Number, required: true, min: 0.01 },
    interest:    { type: Number, default: 0, min: 0 },
    bsrCode:     { type: String, trim: true, default: "", maxlength: 7 },
    challanNo:   { type: String, trim: true, default: "", maxlength: 10 },
    depositedOn: { type: Date, required: true },
    account:     { type: mongoose.Types.ObjectId, ref: "BankAccount" },
    note:        { type: String, trim: true, default: "", maxlength: 200 },
    createdBy:   { type: mongoose.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

TdsChallanSchema.index({ month: 1, section: 1 });

module.exports = mongoose.model("TdsChallan", TdsChallanSchema);
