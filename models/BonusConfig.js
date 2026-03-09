// models/BonusConfig.js
//
// One document per year. Stores the admin-configured bonus trigger
// date (e.g. Diwali) and controls whether the bonus has been
// triggered for that year.
//
// yearlyWorkingDays is used as the denominator for attendance
// rate calculation.  Default 300 ≈ 25 shifts/month × 12 months.

const mongoose = require("mongoose");

const BonusConfigSchema = new mongoose.Schema(
  {
    year: {
      type: Number,
      required: true,
      unique: true,
      index: true,
    },

    // Human label for the occasion, e.g. "Diwali 2025"
    bonusLabel: {
      type: String,
      default: "",
    },

    // The date admin intends to trigger payout on.
    // Purely informational — actual trigger is a manual POST.
    bonusDate: {
      type: Date,
      default: null,
    },

    // Denominator for attendance %. Set this to the number of
    // working days expected in the year (shifts count, not calendar).
    yearlyWorkingDays: {
      type: Number,
      default: 300,
      min: 1,
    },

    // 'pending' → bonus not yet triggered
    // 'triggered' → BonusRecords created, some may still be unpaid
    // 'completed' → all records marked paid
    status: {
      type: String,
      enum: ["pending", "triggered", "completed"],
      default: "pending",
    },

    triggeredAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("BonusConfig", BonusConfigSchema);