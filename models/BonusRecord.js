// models/BonusRecord.js
//
// One document per employee per year, created when admin triggers
// the yearly bonus.
//
// Attendance tiers (multiplier applied to raw bonus):
//   S  ≥ 90%  →  ×1.00  (full bonus)
//   A  ≥ 75%  →  ×0.75
//   B  ≥ 60%  →  ×0.50
//   C  < 60%  →  ×0.25

const mongoose = require("mongoose");

const BonusRecordSchema = new mongoose.Schema(
  {
    employee: {
      type: mongoose.Types.ObjectId,
      ref: "Employee",
      required: true,
    },

    year: {
      type: Number,
      required: true,
    },

    // ── Pay basis ──────────────────────────────────────────
    hourlyRate: { type: Number, default: 0 },

    // Total hours actually worked in the year (from ShiftDetails)
    hoursWorked: { type: Number, default: 0 },

    // Gross annual earnings = hourlyRate × hoursWorked
    annualEarnings: { type: Number, default: 0 },

    // Per-employee bonus %  (copied at time of trigger)
    bonusPercent: { type: Number, default: 10 },

    // Raw bonus before attendance multiplier
    rawBonusAmount: { type: Number, default: 0 },

    // ── Attendance ─────────────────────────────────────────
    // Unique shift-days recorded in ShiftDetail for this employee
    attendanceDays: { type: Number, default: 0 },

    // From BonusConfig.yearlyWorkingDays at time of trigger
    totalWorkingDays: { type: Number, default: 300 },

    // attendanceDays / totalWorkingDays × 100 (capped at 100)
    attendanceRate: { type: Number, default: 0 },

    // 'S' | 'A' | 'B' | 'C'
    attendanceTier: { type: String, default: "C" },

    // 1.00 | 0.75 | 0.50 | 0.25
    multiplier: { type: Number, default: 0.25 },

    // ── Final ──────────────────────────────────────────────
    // rawBonusAmount × multiplier  (rounded to nearest ₹)
    bonusAmount: { type: Number, default: 0 },

    status: {
      type: String,
      enum: ["pending", "paid"],
      default: "pending",
    },

    paidAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// Compound unique index: one record per employee per year
BonusRecordSchema.index({ employee: 1, year: 1 }, { unique: true });

module.exports = mongoose.model("BonusRecord", BonusRecordSchema);