'use strict';
const mongoose = require('mongoose');

// ── YEARLY BONUS ──────────────────────────────────────────────
// Generated once per employee per year.
// bonusAmount = 10% of sum of all monthly netPay for that year.
// Separate from monthly payroll so it can be paid at year end.
const YearlyBonusSchema = new mongoose.Schema(
  {
    employee:       { type: mongoose.Types.ObjectId, ref: 'Employee', required: true },
    year:           { type: Number, required: true },
    totalAnnualPay: { type: Number, default: 0 },   // sum of 12 monthly netPay
    bonusAmount:    { type: Number, default: 0 },   // 10% of totalAnnualPay
    monthsCounted:  { type: Number, default: 0 },   // how many months had payroll
    status:         { type: String, enum: ['computed','paid'], default: 'computed' },
    paidAt:         { type: Date,   default: null },
    paidBy:         { type: String, default: '' },
    paymentNote:    { type: String, default: '' },
  },
  { timestamps: true }
);

YearlyBonusSchema.index({ employee: 1, year: 1 }, { unique: true });

module.exports = mongoose.model('YearlyBonus', YearlyBonusSchema);