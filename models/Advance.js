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

    // Set by payroll engine when the advance is FULLY recovered.
    deductedInPayroll: { type: Boolean, default: false },

    // Amount still to be recovered. Starts equal to `amount`; each payroll
    // run that recovers this advance decrements it. When it reaches 0 the
    // advance is fully recovered (deductedInPayroll = true). A larger-than-
    // net-pay advance recovers what fits each month and carries the rest
    // forward — no more silent write-offs.
    remainingBalance: { type: Number, default: null, min: 0 },
  },
  { timestamps: true }
);

// New advances start with the full amount outstanding.
AdvanceRequestSchema.pre('save', function (next) {
  if (this.remainingBalance == null) this.remainingBalance = this.amount;
  next();
});

module.exports = mongoose.model('AdvanceRequest', AdvanceRequestSchema);