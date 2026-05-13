// models/EmployeeFeedback.js
//
// Two-way channel for workers to file complaints or suggestions.
// Distinct from the customer-facing `Complaint` model so the two
// don't fight over fields/lifecycles. Visible to admins on the
// admin console, status-tracked, with a free-text response.

const mongoose = require("mongoose");

const EmployeeFeedbackSchema = new mongoose.Schema(
  {
    employee: {
      type: mongoose.Types.ObjectId,
      ref: "Employee",
      required: true,
      index: true,
    },

    type: {
      type: String,
      enum: ["complaint", "suggestion"],
      required: true,
    },

    category: {
      type: String,
      enum: ["machine", "safety", "management", "facilities", "payroll", "other"],
      default: "other",
    },

    subject: { type: String, required: true, trim: true },
    body:    { type: String, required: true, trim: true },

    // Worker can flag if they want to stay anonymous in the admin UI.
    isAnonymous: { type: Boolean, default: false },

    status: {
      type: String,
      enum: ["open", "in_review", "resolved", "rejected", "closed"],
      default: "open",
      index: true,
    },

    // ── Admin reply ──────────────────────────────────────────
    response:    { type: String, default: "" },
    respondedBy: { type: mongoose.Types.ObjectId, ref: "User" },
    respondedAt: { type: Date },
  },
  { timestamps: true }
);

module.exports = mongoose.model("EmployeeFeedback", EmployeeFeedbackSchema);
