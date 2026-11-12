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
    // The request that recorded it: the same request sent twice records it once.
    requestId:   { type: String, unique: true, sparse: true },
    createdBy:   { type: mongoose.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

TdsChallanSchema.index({ month: 1, section: 1 });
// One challan is recorded once. A challan is known by its bank code,
// its serial and its date; one paid for two months is entered against
// each month for that month's part, so the month, the section and the
// amount are part of what makes an entry the same entry. (A challan
// saved twice doubled what the register showed as deposited, and hid
// the balance still to pay.)
TdsChallanSchema.index(
  { month: 1, section: 1, bsrCode: 1, challanNo: 1, depositedOn: 1, amount: 1 },
  { unique: true, partialFilterExpression: { challanNo: { $gt: "" } } }
);

module.exports = mongoose.model("TdsChallan", TdsChallanSchema);
