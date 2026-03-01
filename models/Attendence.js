// ══════════════════════════════════════════════════════════════
//  ATTENDANCE MODEL
//  File: models/Attendance.js
//
//  One document = one employee on one date for one shift.
//  Unique index: employee + date + shift  (no duplicates).
// ══════════════════════════════════════════════════════════════
'use strict';

const mongoose = require('mongoose');

const AttendanceSchema = new mongoose.Schema(
  {
    // ── Who ──────────────────────────────────────────────────
    employee: {
      type: mongoose.Types.ObjectId,
      ref:  'Employee',
      required: true,
      index: true,
    },

    // ── When ─────────────────────────────────────────────────
    date: {
      type:     Date,
      required: true,
      index:    true,
    },

    shift: {
      type:     String,
      enum:     ['DAY', 'NIGHT'],
      required: true,
    },

    // ── Status ───────────────────────────────────────────────
    //   present   → came on time
    //   late      → came but was late  (lateMinutes > 0)
    //   half_day  → worked half the shift
    //   absent    → did not come
    //   on_leave  → approved leave
    status: {
      type:     String,
      enum:     ['present', 'late', 'half_day', 'absent', 'on_leave'],
      required: true,
      default:  'present',
    },

    // ── Time details ─────────────────────────────────────────
    checkIn:  { type: String, default: '' },   // "HH:mm"
    checkOut: { type: String, default: '' },   // "HH:mm"

    // Minutes late (0 for on-time; >0 for late status)
    lateMinutes: { type: Number, default: 0 },

    // ── Leave metadata ───────────────────────────────────────
    leaveType: {
      type: String,
      enum: ['casual', 'sick', 'unpaid', ''],
      default: '',
    },

    // ── Notes ────────────────────────────────────────────────
    notes: { type: String, default: '' },

    // ── Audit ────────────────────────────────────────────────
    markedBy: { type: String, default: 'admin' },
  },
  { timestamps: true }
);

// Prevent duplicate records
AttendanceSchema.index({ employee: 1, date: 1, shift: 1 }, { unique: true });

module.exports = mongoose.model('Attendance', AttendanceSchema);