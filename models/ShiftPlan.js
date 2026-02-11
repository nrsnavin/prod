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

    plan: [
      {
        type: mongoose.Types.ObjectId,
        ref: "ShiftDetail",
      },
    ],

    status: {
      type: String,
      enum: ["planned", "running", "completed"],
      default: "planned",
    },
  },
  { timestamps: true }
);

// 🔒 Prevent duplicate shift plans
ShiftPlanSchema.index({ date: 1, shift: 1 }, { unique: true });

module.exports = mongoose.model("ShiftPlan", ShiftPlanSchema);
