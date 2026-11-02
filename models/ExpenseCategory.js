"use strict";
// What an expense is for. Seeded with the usual factory heads
// (services/accountsSeed.js); the office adds its own.

const mongoose = require("mongoose");

const ExpenseCategorySchema = new mongoose.Schema(
  {
    name:   { type: String, required: true, trim: true, maxlength: 60, unique: true },
    // The ledger head in Tally this maps to, printed on exports.
    ledger: { type: String, trim: true, default: "", maxlength: 80 },
    // Whether bills under this head usually carry GST that can be
    // claimed as input credit (electricity cannot; job work can).
    itcEligible: { type: Boolean, default: false },
    // Expenses above this need an approver; 0 = always.
    approvalAbove: { type: Number, default: 0, min: 0 },
    // TDS section that usually applies to payees under this head
    // ("194C" job work / transport, "194I" rent, "194J" professional).
    tdsSection: { type: String, trim: true, default: "", maxlength: 8 },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("ExpenseCategory", ExpenseCategorySchema);
