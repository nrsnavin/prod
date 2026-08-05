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

    // ── When ─────────────────────────────────────────────
    // ONE date plus a shift — not a range. Leave is applied for and
    // approved per calendar day per shift, which is what the router, the
    // HR page (LeaveCreateInput sends {date, shift}) and the approval's
    // per-shift Attendance sync all work in. This field previously read
    // startDate/endDate, which nothing ever wrote: every create failed
    // validation and the whole module 500'd.
    date:       { type: Date, required: true, index: true },
    // shift can be 'DAY', 'NIGHT', or 'BOTH' (for full-day leave spanning both)
    shift:      { type: String, enum: ['DAY', 'NIGHT', 'BOTH'], default: 'BOTH' },

    // ── Type ─────────────────────────────────────────────
    leaveType:  { type: String, enum: ['casual', 'sick', 'unpaid'], required: true },

    // ── Reason / Proof ───────────────────────────────────
    reason:     { type: String, required: true },
    // Optional doc ref (e.g. medical certificate filename / URL)
    documentUrl: { type: String, default: '' },

    // ── Status lifecycle: pending → approved | rejected ──
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected'],
      default: 'pending',
      index: true,
    },

    // ── Admin decision ───────────────────────────────────
    // The reviewer is the deciding USER (routes assign req.user._id), not
    // a free-text name.
    reviewedBy:   { type: mongoose.Types.ObjectId, ref: 'User', default: null },
    reviewedAt:   { type: Date,   default: null },
    reviewNotes:  { type: String, default: '' },

    // ── Penalty exempt ───────────────────────────────────
    // Set true when approved so payroll engine skips penalty
    penaltyExempt: { type: Boolean, default: false },

    // Set once payroll has consumed this leave; surfaced by the router's
    // response shape, so it has to exist on the document.
    payrollProcessed: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// One request per employee per date per shift. The routes already answer
// duplicate-key (11000) with "A leave request already exists for this date
// and shift" — without this index that branch could never fire and the
// same day could be requested repeatedly.
LeaveRequestSchema.index({ employee: 1, date: 1, shift: 1 }, { unique: true });

module.exports = mongoose.model('LeaveRequest', LeaveRequestSchema);