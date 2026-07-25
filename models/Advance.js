'use strict';
const mongoose = require('mongoose');

// ── ADVANCE REQUEST ───────────────────────────────────────────
// Lifecycle:
//   requested → approved → paid_out → recovered
//                    ↘ rejected
//
//   requested  employee asked for an advance
//   approved   admin agreed and set the month/year that recovers it —
//              no cash has moved yet
//   paid_out   cash actually handed over; the employee now owes it back,
//              and this is when it hits their ledger
//   recovered  fully recovered out of pay (remainingBalance = 0)
//
// 'pending' is the legacy name for 'requested' and is still accepted so
// existing rows keep working (see the backfill migration).
const ADVANCE_STATUSES = ['requested','approved','paid_out','recovered','rejected','pending'];
// Money is with the employee → payroll may recover against it.
const RECOVERABLE_STATUSES = ['paid_out','approved'];

const AdvanceRequestSchema = new mongoose.Schema(
  {
    employee:   { type: mongoose.Types.ObjectId, ref: 'Employee', required: true, index: true },
    amount:     { type: Number, required: true, min: 1 },
    reason:     { type: String, default: '' },

    status:     { type: String, enum: ADVANCE_STATUSES, default: 'requested' },
    // Set when the cash is actually handed over.
    paidOutAt:  { type: Date,   default: null },
    paidOutBy:  { type: String, default: '' },
    recoveredAt:{ type: Date,   default: null },
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
module.exports.ADVANCE_STATUSES    = ADVANCE_STATUSES;
module.exports.RECOVERABLE_STATUSES = RECOVERABLE_STATUSES;