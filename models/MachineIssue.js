// models/MachineIssue.js
//
// Workers report machine breakdowns / maintenance requests from the
// Worker Portal app. Supervisor / maintenance team picks them up,
// updates status, and (optionally) appends a service log on the
// Machine itself when they close the issue.

const mongoose = require("mongoose");

const MachineIssueSchema = new mongoose.Schema(
  {
    machine: {
      type: mongoose.Types.ObjectId,
      ref: "Machine",
      required: true,
      index: true,
    },

    employee: {
      type: mongoose.Types.ObjectId,
      ref: "Employee",
      required: true,
      index: true,
    },

    // Brief title for list views.
    title: { type: String, required: true, trim: true },

    // Full description from the worker.
    description: { type: String, required: true, trim: true },

    severity: {
      type: String,
      enum: ["low", "medium", "high", "critical"],
      default: "medium",
    },

    // Optional photo/voice URLs (uploaded elsewhere; URLs only here).
    attachments: [{ type: String }],

    status: {
      type: String,
      enum: ["open", "acknowledged", "in_progress", "resolved", "rejected"],
      default: "open",
      index: true,
    },

    // ── Resolution fields ─────────────────────────────────────
    resolvedBy:    { type: mongoose.Types.ObjectId, ref: "User" },
    resolvedAt:    { type: Date },
    resolutionNotes: { type: String, default: "" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("MachineIssue", MachineIssueSchema);
