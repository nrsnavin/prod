// models/ShiftDetail.js
const mongoose = require("mongoose");

const HeadElasticSchema = new mongoose.Schema(
  {
    head: { type: Number, required: true },
    elastic: {
      type: mongoose.Types.ObjectId,
      ref: "Elastic",
      required: true,
    },
  },
  { _id: false }
);

const ShiftDetailSchema = new mongoose.Schema(
  {
    // 📅 BASIC INFO
    date: {
      type: Date,
      required: true,
    },

    shift: {
      type: String,
      enum: ["DAY", "NIGHT"],
      required: true,
    },

    description: {
      type: String,
      default: "",
    },

    feedback: {
      type: String,
      default: "",
    },

    // 🔄 STATUS
    //   open                 – created, no submission yet
    //   running              – legacy in-progress
    //   pending_verification – worker submitted; awaiting admin verify
    //   closed               – admin verified; canonical numbers cascaded
    status: {
      type: String,
      enum: ["open", "running", "pending_verification", "closed"],
      default: "open",
    },


    job: {
      type: mongoose.Types.ObjectId,
      ref: "JobOrder",
      required: true,
    },

    // ⏱ TIMER (HH:mm:ss)
    timer: {
      type: String,
      required: true,
      default: "00:00:00",
    },

    // 📏 TOTAL PRODUCTION (METERS) — admin-blessed canonical value
    productionMeters: {
      type: Number,
      default: 0,
    },

    // ── Worker's submitted (pending) values ──────────────────
    // Captured at worker submit time but NOT cascaded into
    // JobOrder/Order/ShiftPlan until an admin verifies.
    submittedProductionMeters: { type: Number },
    submittedTimer:            { type: String },
    submittedFeedback:         { type: String },
    submittedAt:               { type: Date   },
    submittedBy: {
      type: mongoose.Types.ObjectId,
      ref: "User",
    },

    // ── Admin verification audit ─────────────────────────────
    verifiedAt: { type: Date },
    verifiedBy: {
      type: mongoose.Types.ObjectId,
      ref: "User",
    },

    // 🧵 HEAD → ELASTIC MAP (IMPORTANT)
    elastics: {
      type: [HeadElasticSchema],
      required: true,
      default: [],
    },

    // 👷 OPERATOR
    employee: {
      type: mongoose.Types.ObjectId,
      ref: "Employee",
      required: true,
    },

    // 🔗 PARENT SHIFT PLAN
    shiftPlan: {
      type: mongoose.Types.ObjectId,
      ref: "ShiftPlan",
      required: true,
      index: true,
    },

    // 🏭 MACHINE
    machine: {
      type: mongoose.Types.ObjectId,
      ref: "Machine",
      required: true,
    },
  },
  { timestamps: true }
);

// Serves the machine detail page's "recent shifts" lookup
// (find by machine, newest first) without a collection scan.
ShiftDetailSchema.index({ machine: 1, date: -1 });

module.exports = mongoose.model("ShiftDetail", ShiftDetailSchema);
