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
    overtimeMultiplier:   { type: Number, default: 1.25, min: 0 },
    overtimeGraceMinutes: { type: Number, default: 120,  min: 0 },

    // The most overtime ONE attendance record can be paid for.
    //
    // Base pay is capped at the shift length, so a worked duration
    // longer than the shift costs nothing there — but the overtime
    // derived from the SAME figure had no ceiling at all. A clock-in
    // with no clock-out until someone notices days later produced a
    // worked duration of days, and payroll paid every minute past the
    // shift as overtime at 1.25×: one forgotten clock-out turned a
    // ₹1,200 day into ₹9,250. Nothing errored and the payslip read as a
    // legitimate overtime line.
    //
    // 4 hours by default — long enough for any real overtime on a 12h
    // shift, short enough that a missing clock-out is a rounding error
    // rather than a month's wages. Set 0 to disable the cap.
    maxOvertimeMinutesPerShift: { type: Number, default: 240, min: 0 },

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