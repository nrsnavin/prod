"use strict";
// ══════════════════════════════════════════════════════════════════
//  PRODUCTION SETTINGS — one row, key "production"
//
//  autoVerify     an entry the floor or a worker saves is verified
//                 without a person when everything checks: the run time
//                 read from a photo of the timer, no remark, and the
//                 metres a head within `tolerancePct` of what this loom
//                 makes in that run time (services/productionModel.js),
//                 learned from at least `minShifts` of its own shifts.
//                 Off until an admin turns it on.
//  shiftEndNudge  a WhatsApp message to the supervisors, `minutesBefore`
//                 the shift ends, naming the looms still to enter.
//  sensors        loom sensors posting run minutes (api/loomSensor.js).
// ══════════════════════════════════════════════════════════════════

const mongoose = require("mongoose");

const ProductionSettingsSchema = new mongoose.Schema(
  {
    key: { type: String, default: "production", unique: true },
    autoVerify: {
      enabled:      { type: Boolean, default: false },
      tolerancePct: { type: Number, default: 10, min: 1, max: 50 },
      minShifts:    { type: Number, default: 8, min: 1, max: 200 },
    },
    shiftEndNudge: {
      enabled:       { type: Boolean, default: false },
      minutesBefore: { type: Number, default: 30, min: 5, max: 240 },
      // Numbers to message, E.164; empty means every user with the production role and a phone.
      phones:        { type: [String], default: [] },
      // "YYYY-MM-DD:DAY" sent last, so a shift is nudged once.
      lastSent:      { type: String, default: "" },
    },
    // The handover note for the shift just ended (services/shiftHandover.js),
    // sent in the first `withinMinutes` of the next one.
    shiftHandover: {
      enabled:       { type: Boolean, default: false },
      withinMinutes: { type: Number, default: 60, min: 10, max: 240 },
      phones:        { type: [String], default: [] },
      lastSent:      { type: String, default: "" },
    },
    updatedBy: { type: mongoose.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("ProductionSettings", ProductionSettingsSchema);
