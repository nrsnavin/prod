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

    // ── Where the plan came from ───────────────────────────
    // office  made in the app before the shift: the operators on it are
    //         the office's say, and the floor cannot change them.
    // floor   made on the floor tablet from the looms entered, one at a
    //         time (services/floorEntry.js). A draft, for the admin to
    //         confirm; `floor` records when it was created, which looms
    //         stood free that shift and which were being loaded (and by
    //         whom — an operator loading a loom is working too).
    // Plans from before this field count as the office's.
    source: {
      type: String,
      enum: ["office", "floor"],
      default: "office",
    },
    floor: {
      completedAt: { type: Date },
      completedBy: { type: String, default: "" },
      freeMachines: [
        {
          _id: false,
          machine: { type: mongoose.Types.ObjectId, ref: "Machine" },
          ID: { type: String },
          why: { type: String, default: "" },
        },
      ],
      loadingMachines: [
        {
          _id: false,
          machine: { type: mongoose.Types.ObjectId, ref: "Machine" },
          ID: { type: String },
          operatorName: { type: String, default: "" },
        },
      ],
    },
  },
  { timestamps: true }
);

// 🔒 Prevent duplicate shift plans for same date + shift
ShiftPlanSchema.index({ date: 1, shift: 1 }, { unique: true });

module.exports = mongoose.model("ShiftPlan", ShiftPlanSchema);