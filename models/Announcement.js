// models/Announcement.js
//
// Factory-floor notice board. Supervisors post; workers read on
// the Worker Portal home screen. Targeted at "all" or a specific
// department, with optional pin + validity window.

const mongoose = require("mongoose");

const AnnouncementSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    body:  { type: String, required: true, trim: true },

    // Visual category — drives the icon/colour on the worker UI.
    type: {
      type: String,
      enum: ["info", "warning", "safety", "policy", "celebration"],
      default: "info",
    },

    // Audience scope.
    audience: {
      type: String,
      enum: ["all", "department"],
      default: "all",
    },

    // When audience === 'department', this is the target department
    // string (matches Employee.department, e.g. 'weaving').
    department: { type: String, default: "" },

    // Pinned items always show first regardless of date.
    isPinned: { type: Boolean, default: false },

    // Validity window. validUntil is enforced by the GET filter.
    validFrom:  { type: Date, default: Date.now },
    validUntil: { type: Date },

    attachmentUrl: { type: String, default: "" },

    isActive: { type: Boolean, default: true, index: true },
  },
  { timestamps: true }
);

AnnouncementSchema.index({ isActive: 1, validUntil: 1 });
AnnouncementSchema.index({ audience: 1, department: 1 });

module.exports = mongoose.model("Announcement", AnnouncementSchema);
