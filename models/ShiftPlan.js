// models/ShiftPlan.js
const mongoose = require("mongoose");

const ShiftPlanSchema = new mongoose.Schema(
  {
    date: {
      type: Date,
      required: true,
      index: true,
    },

    shift: {
      type: String,
      enum: ["DAY", "NIGHT"],
      required: true,
      index: true,
    },

    description: {
      type: String,
      default: "",
    },

    totalProduction: {
      type: Number,
      default: 0,
    },

    // ── Draft / Confirm lifecycle ──────────────────────────
    // draft     → saved from the create form; not yet active.
    // confirmed → supervisor confirmed in the detail page.
    status: {
      type: String,
      enum: ["draft", "confirmed"],
      default: "draft",
    },

    // ── Finalisation (post-verification lock) ──────────────
    // After the admin has verified every production entry, the shift
    // can be FINALISED: corrections, deletions and new entries are
    // rejected from then on, freezing the day's numbers for payroll
    // and reports. Reversible only by an admin (unfinalize).
    finalized:   { type: Boolean, default: false },
    finalizedAt: { type: Date },
    finalizedBy: { type: String },

    plan: [
      {
        type: mongoose.Types.ObjectId,
        ref: "ShiftDetail",
      },
    ],
  },
  { timestamps: true }
);

// 🔒 Prevent duplicate shift plans for same date + shift
ShiftPlanSchema.index({ date: 1, shift: 1 }, { unique: true });

module.exports = mongoose.model("ShiftPlan", ShiftPlanSchema);