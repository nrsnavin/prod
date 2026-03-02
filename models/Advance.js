'use strict';
const mongoose = require('mongoose');

// ── ADVANCE REQUEST ───────────────────────────────────────────
// Employee asks for advance salary.
// Admin approves → specifies which month/year to deduct from.
// Payroll engine deducts it when generating that month's payroll.
const AdvanceRequestSchema = new mongoose.Schema(
  {
    employee:   { type: mongoose.Types.ObjectId, ref: 'Employee', required: true, index: true },
    amount:     { type: Number, required: true, min: 1 },
    reason:     { type: String, default: '' },

    // Admin sets these on approval
    status:     { type: String, enum: ['pending','approved','rejected'], default: 'pending' },
    deductMonth:{ type: Number, default: null, min: 1, max: 12 },
    deductYear: { type: Number, default: null },
    adminNotes: { type: String, default: '' },
    approvedBy: { type: String, default: '' },
    approvedAt: { type: Date,   default: null },

    // Set by payroll engine when the deduction is applied
    deductedInPayroll: { type: Boolean, default: false },
  },
  { timestamps: true }
);

module.exports = mongoose.model('AdvanceRequest', AdvanceRequestSchema);