"use strict";
// ══════════════════════════════════════════════════════════════════
//  RECURRING EXPENSE — rent, electricity, a loan EMI, insurance
//
//  A template that drafts the expense on its day (waiting for approval,
//  like any expense) and moves its next date on. The drafting is
//  idempotent: the next date only moves forward by a conditional update,
//  so two requests at once cannot draft the same month twice. The
//  forecast reads the next dates as money going out.
// ══════════════════════════════════════════════════════════════════

const mongoose = require("mongoose");

const RecurringExpenseSchema = new mongoose.Schema(
  {
    name:        { type: String, required: true, trim: true, maxlength: 80 },
    category:    { type: mongoose.Types.ObjectId, ref: "ExpenseCategory", required: true },
    description: { type: String, required: true, trim: true, maxlength: 200 },
    supplier:    { type: mongoose.Types.ObjectId, ref: "Supplier" },
    payeeName:   { type: String, default: "", trim: true },
    amount:      { type: Number, required: true, min: 0.01 },
    gstPercent:  { type: Number, default: 0, min: 0, max: 100 },
    // Every `every` months, on `dayOfMonth` (28 at most, so February has it).
    every:       { type: Number, enum: [1, 3, 6, 12], default: 1 },
    dayOfMonth:  { type: Number, min: 1, max: 28, default: 1 },
    nextDate:    { type: Date, required: true },
    endDate:     { type: Date, default: null },
    active:      { type: Boolean, default: true },
    lastDrafted: { expense: { type: mongoose.Types.ObjectId, ref: "Expense" }, expenseNo: String, for: Date },
    createdBy:   { type: mongoose.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

RecurringExpenseSchema.index({ active: 1, nextDate: 1 });

module.exports = mongoose.model("RecurringExpense", RecurringExpenseSchema);
