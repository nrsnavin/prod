// ══════════════════════════════════════════════════════════════
//  LEAVE REQUEST MODEL
//  File: models/LeaveRequest.js
//
//  Flow:
//    Employee (or admin on behalf) submits a leave request.
//    Admin approves or rejects.
//    On approval, the matching Attendance record is updated:
//      status='on_leave', approvedLeave=true, leaveRequestId=this._id
//    Approved leaves are excluded from penalty computation.
// ══════════════════════════════════════════════════════════════
'use strict';

const mongoose = require('mongoose');

const LeaveRequestSchema = new mongoose.Schema(
  {
    // ── Who ──────────────────────────────────────────────
    employee:   { type: mongoose.Types.ObjectId, ref: 'Employee', required: true, index: true },

    // ── Period ───────────────────────────────────────────
    startDate:  { type: Date, required: true },
    endDate:    { type: Date, required: true },
    // shift can be 'DAY', 'NIGHT', or 'BOTH' (for full-day leave spanning both)
    shift:      { type: String, enum: ['DAY', 'NIGHT', 'BOTH'], default: 'BOTH' },

    // ── Type ─────────────────────────────────────────────
    leaveType:  { type: String, enum: ['casual', 'sick', 'unpaid'], required: true },

    // ── Reason / Proof ───────────────────────────────────
    reason:     { type: String, required: true },
    // Optional doc ref (e.g. medical certificate filename / URL)
    proofDoc:   { type: String, default: '' },

    // ── Status lifecycle: pending → approved | rejected ──
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected'],
      default: 'pending',
      index: true,
    },

    // ── Admin decision ───────────────────────────────────
    decidedBy:    { type: String, default: '' },
    decidedAt:    { type: Date,   default: null },
    adminRemarks: { type: String, default: '' },

    // ── Penalty exempt ───────────────────────────────────
    // Set true when approved so payroll engine skips penalty
    penaltyExempt: { type: Boolean, default: false },

    // Days count (computed on creation)
    totalDays: { type: Number, default: 1 },
  },
  { timestamps: true }
);

module.exports = mongoose.model('LeaveRequest', LeaveRequestSchema);