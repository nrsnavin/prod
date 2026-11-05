'use strict';
// ══════════════════════════════════════════════════════════════════
//  LOOM DEVICE — a sensor on one loom (services/loomSensor.js)
//
//  A small board on the loom counts the seconds the loom runs and posts
//  the running total. It proves who it is with its own key: only a hash
//  is kept here, the key itself is shown once, when the device is added
//  or its key replaced. `keyId` is the public half, sent with the key so
//  the hash to check is found without trying every device.
// ══════════════════════════════════════════════════════════════════

const mongoose = require('mongoose');

const LoomDeviceSchema = new mongoose.Schema(
  {
    machine: { type: mongoose.Types.ObjectId, ref: 'Machine', required: true, index: true },
    name: { type: String, default: '', trim: true, maxlength: 80 },
    keyId: { type: String, required: true, unique: true },
    keyHash: { type: String, required: true, select: false },
    active: { type: Boolean, default: true, index: true },
    lastSeenAt: { type: Date, default: null },
    lastReading: {
      at: { type: Date },
      runSecondsTotal: { type: Number },
      picksTotal: { type: Number },
      running: { type: Boolean },
    },
    /** The firmware's own version string, as it reports it. */
    firmware: { type: String, default: '' },
    createdBy: { type: mongoose.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('LoomDevice', LoomDeviceSchema);
