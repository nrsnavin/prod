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