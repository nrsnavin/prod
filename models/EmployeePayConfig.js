// ══════════════════════════════════════════════════════════════
//  EMPLOYEE PAY CONFIG
//  File: models/EmployeePayConfig.js
//
//  One document per employee. Stores their pay rates.
//  DAY shift  = 12 hours
//  NIGHT shift =  8 hours
//  Base pay is per-hour; system computes shift pay automatically.
// ══════════════════════════════════════════════════════════════
'use strict';
const mongoose = require('mongoose');

const EmployeePayConfigSchema = new mongoose.Schema({
  employee: {
    type: mongoose.Types.ObjectId,
    ref: 'Employee',
    required: true,
    unique: true,
    index: true,
  },

  // ── Pay rates ─────────────────────────────────────────────
  hourlyRate: { type: Number, required: true, default: 0 },
  // Overrides: if set, used instead of hourlyRate × hours
  dayShiftRate:   { type: Number, default: 0 },  // 12h flat rate
  nightShiftRate: { type: Number, default: 0 },  // 8h flat rate

  // ── Leave quota per month ─────────────────────────────────
  // Absences within quota = no penalty; beyond = penalty
  monthlyLeaveQuota: { type: Number, default: 2 },   // casual/unexcused
  monthlySickQuota:  { type: Number, default: 1 },

  // ── Penalty config ────────────────────────────────────────
  // Per absent shift BEYOND quota (flat ₹ deduction)
  penaltyPerExcessAbsent: { type: Number, default: 200 },
  // Per late minute deduction (₹/minute)
  lateDeductionPerMin:    { type: Number, default: 10 },

  // ── Reward config ─────────────────────────────────────────
  // Bonus for zero absent + zero unexcused in the month
  perfectAttendanceBonus: { type: Number, default: 500 },
  // Bonus per 7-day attendance streak (rewarded once per streak)
  streakBonus:            { type: Number, default: 100 },

  // ── Effective from ────────────────────────────────────────
  effectiveFrom: { type: Date, default: Date.now },
  notes:         { type: String, default: '' },
}, { timestamps: true });

module.exports = mongoose.model('EmployeePayConfig', EmployeePayConfigSchema);