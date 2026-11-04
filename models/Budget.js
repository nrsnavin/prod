"use strict";
// ══════════════════════════════════════════════════════════════════
//  BUDGET  —  one expense head, one financial year
//
//  Twelve monthly figures, April to March. What was actually spent
//  under the head (expenses, and service bills booked to it) is read
//  beside it (services/budgets.js); nothing here is a posting.
// ══════════════════════════════════════════════════════════════════

const mongoose = require("mongoose");

const BudgetSchema = new mongoose.Schema(
  {
    fy:       { type: String, required: true },                  // "2026-27"
    category: { type: mongoose.Types.ObjectId, ref: "ExpenseCategory", required: true },
    // April first. Twelve entries, each 0 or more.
    amounts:  { type: [Number], default: () => Array(12).fill(0), validate: (v) => v.length === 12 && v.every((n) => Number.isFinite(n) && n >= 0) },
    note:     { type: String, default: "", trim: true, maxlength: 200 },
    updatedBy: { type: mongoose.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

BudgetSchema.index({ fy: 1, category: 1 }, { unique: true });

module.exports = mongoose.model("Budget", BudgetSchema);
