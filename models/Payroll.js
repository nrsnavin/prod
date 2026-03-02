// ══════════════════════════════════════════════════════════════
//  PAYROLL MODEL  v2
//  File: models/Payroll.js  (replaces existing)
//
//  One document per employee per calendar month.
//  hourlyRate is snapshotted from Employee at generation time.
//  No per-employee PayrollConfig needed.
// ══════════════════════════════════════════════════════════════
'use strict';

const mongoose = require('mongoose');

const LineItemSchema = new mongoose.Schema({
  label:  { type: String, required: true },
  amount: { type: Number, required: true },  // + = earning/bonus, − = deduction
  type:   { type: String, enum: ['earning', 'deduction', 'bonus'], default: 'earning' },
}, { _id: false });

const PayrollSchema = new mongoose.Schema(
  {
    // ── Who / When ────────────────────────────────────────────
    employee: {
      type: mongoose.Types.ObjectId,
      ref: 'Employee',
      required: true,
      index: true,
    },
    year:  { type: Number, required: true },
    month: { type: Number, required: true, min: 1, max: 12 },

    // ── Rate snapshot ─────────────────────────────────────────
    // Copied from Employee.hourlyRate at generation time.
    // Stored so historical payslips are unaffected by future rate changes.
    hourlyRate: { type: Number, default: 0 },

    // ── Attendance summary ─────────────────────────────────────
    totalShifts:         { type: Number, default: 0 },
    presentShifts:       { type: Number, default: 0 },  // present + late
    halfDayShifts:       { type: Number, default: 0 },
    absentShifts:        { type: Number, default: 0 },  // unapproved absents
    approvedLeaveShifts: { type: Number, default: 0 },  // approved leave (no penalty)
    totalLateMinutes:    { type: Number, default: 0 },

    // ── Shift breakdown ────────────────────────────────────────
    dayShiftsWorked:    { type: Number, default: 0 },
    nightShiftsWorked:  { type: Number, default: 0 },
    dayShiftEarnings:   { type: Number, default: 0 },
    nightShiftEarnings: { type: Number, default: 0 },

    // ── Pay components ─────────────────────────────────────────
    grossEarnings:    { type: Number, default: 0 },  // raw hours × rate
    totalDeductions:  { type: Number, default: 0 },  // late cuts + excess absent penalty
    totalBonuses:     { type: Number, default: 0 },  // no-leave + perfect + streak
    netPay:           { type: Number, default: 0 },  // gross − deductions + bonuses

    // ── Leave detail ───────────────────────────────────────────
    unapprovedAbsents:  { type: Number, default: 0 },  // absents with no approved leave
    excessAbsents:      { type: Number, default: 0 },  // absents beyond monthly quota

    // ── Bonus flags ────────────────────────────────────────────
    noLeaveBonus:           { type: Number, default: 0 },
    perfectAttendanceBonus: { type: Number, default: 0 },
    totalStreakBonus:        { type: Number, default: 0 },
    longestStreak:          { type: Number, default: 0 },
    perfectAttendance:      { type: Boolean, default: false },

    // ── Itemised lines for payslip ─────────────────────────────
    lineItems: { type: [LineItemSchema], default: [] },

    // ── Workflow status ────────────────────────────────────────
    status: {
      type: String,
      enum: ['draft', 'finalized', 'paid'],
      default: 'draft',
    },
    finalizedAt:  { type: Date, default: null },
    paidAt:       { type: Date, default: null },
    paidBy:       { type: String, default: '' },
    paymentNote:  { type: String, default: '' },
  },
  { timestamps: true }
);

PayrollSchema.index({ employee: 1, year: 1, month: 1 }, { unique: true });

module.exports = mongoose.model('Payroll', PayrollSchema);