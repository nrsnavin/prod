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

    // ── Overtime ──────────────────────────────────────────────
    // Minutes beyond the shift, past the grace window, are paid at
    // rate × overtimeMultiplier. Multiplier 1 = straight time.
    overtimeMultiplier:   { type: Number, default: 1.5, min: 0 },
    overtimeGraceMinutes: { type: Number, default: 0,   min: 0 },

    // ── Statutory deductions (default OFF — 0% deducts nothing) ─
    // PF: pfPercent of the wage, capped at pfWageCeiling (0 = no cap).
    // ESI: esiPercent of the wage, only when wage ≤ esiWageCeiling
    //      (0 ceiling = always applies). Fill these with YOUR rates;
    //      nothing is deducted until you do.
    pfPercent:      { type: Number, default: 0, min: 0, max: 100 },
    pfWageCeiling:  { type: Number, default: 0, min: 0 },
    esiPercent:     { type: Number, default: 0, min: 0, max: 100 },
    esiWageCeiling: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model('PayrollSettings', PayrollSettingsSchema);