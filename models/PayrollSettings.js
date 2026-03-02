// ══════════════════════════════════════════════════════════════
//  PAYROLL SETTINGS  (single factory-wide document)
//  File: models/PayrollSettings.js
//
//  Only ONE document ever exists (upserted by POST /payroll/settings).
//  Controls leave quota, penalties, and bonus amounts.
//  Individual pay rate lives on Employee.hourlyRate.
// ══════════════════════════════════════════════════════════════
'use strict';

const mongoose = require('mongoose');

const PayrollSettingsSchema = new mongoose.Schema(
  {
    // ── Leave quota ───────────────────────────────────────────
    // Absences within quota → no penalty (employee just loses shift pay)
    // Absences beyond quota → penalty ON TOP of lost shift pay
    casualLeavesPerMonth: { type: Number, default: 2 },
    sickLeavesPerMonth:   { type: Number, default: 1 },

    // ── Late grace ────────────────────────────────────────────
    // Minutes late below this → treated as on-time (no deduction)
    lateGracePeriodMinutes: { type: Number, default: 10 },

    // ── Penalty ───────────────────────────────────────────────
    // Applied per absent shift that exceeds monthly quota.
    // This is ADDITIONAL to the lost shift pay.
    // e.g. ₹200 extra per excess absent shift.
    penaltyPerExcessAbsent: { type: Number, default: 200 },

    // ── Rewards ───────────────────────────────────────────────
    // Flat ₹ bonus added to net pay if earned.
    noLeaveBonus:             { type: Number, default: 300 },   // zero leaves all month
    perfectAttendanceBonus:   { type: Number, default: 500 },   // zero absents all month
    streakBonusPer7Shifts:    { type: Number, default: 100 },   // per 7-shift streak
  },
  { timestamps: true }
);

module.exports = mongoose.model('PayrollSettings', PayrollSettingsSchema);