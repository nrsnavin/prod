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


    /**
     * The job this shift ran. Taken from the machine's running job when
     * the plan is written.
     *
     * Optional, because a machine can legitimately be manned with no job
     * on it. It used to be required, and the plan route met that by
     * falling back to the MACHINE's id — so `job`, declared here as a
     * JobOrder, held an id from the wrong collection. That resolves to
     * nothing, which is worse than empty: the shift is not merely
     * unattributed, it is filed against a job that does not exist.
     *
     * Every reader already handles a missing job (`shift.job ? … : null`,
     * `d.job?.jobOrderNo ?? "—"`), so honest emptiness is what they were
     * written for.
     */
    job: {
      type: mongoose.Types.ObjectId,
      ref: "JobOrder",
      default: null,
    },

    // The job detail page lists the shifts run on one job.
    // See api/job.js — read by this ref, not off a denormalised array.

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
// The job detail page: this job's shifts, oldest first. Reading them by
// ref is what replaced a denormalised array on the job that nothing ever
// maintained, so this is now a hot path.
ShiftDetailSchema.index({ job: 1, date: 1 });

module.exports = mongoose.model("ShiftDetail", ShiftDetailSchema);
