'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE FLOOR PIN FOR ONE SHIFT
//
//  A supervisor on the floor tablet does not sign in: the admin reads
//  this shift's PIN off the shift card and gives it to them. Entering
//  it opens the floor-entry screen for that date and shift only
//  (services/floorEntry.js), for the length of a shift.
//
//  Kept in clear, because the admin has to be able to read it out; it
//  is a four-digit floor code that opens one shift's entry screen, not
//  a password, and a wrong guess is rate-limited and recorded. Rotating
//  it ends every session that was opened with the old one.
// ══════════════════════════════════════════════════════════════════

const mongoose = require('mongoose');

const ShiftPinSchema = new mongoose.Schema(
  {
    dateKey: { type: String, required: true },          // YYYY-MM-DD
    shift:   { type: String, enum: ['DAY', 'NIGHT'], required: true },
    pin:     { type: String, required: true },
    /** Bumped on rotate; a floor token carries the generation it was opened with. */
    generation: { type: Number, default: 1 },
    createdBy: { type: mongoose.Types.ObjectId, ref: 'User', default: null },
    rotatedAt: { type: Date, default: null },
    rotatedBy: { type: mongoose.Types.ObjectId, ref: 'User', default: null },
    /** Who opened the floor with it, most recent last. */
    opens: {
      type: [new mongoose.Schema({
        at:   { type: Date, default: Date.now },
        name: { type: String, default: '' },
        ip:   { type: String, default: '' },
      }, { _id: false })],
      default: [],
    },
    failedAttempts: { type: Number, default: 0 },
  },
  { timestamps: true }
);

ShiftPinSchema.index({ dateKey: 1, shift: 1 }, { unique: true });

module.exports = mongoose.model('ShiftPin', ShiftPinSchema);
