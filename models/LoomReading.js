'use strict';
// ══════════════════════════════════════════════════════════════════
//  LOOM READING — one post from a loom's sensor (services/loomSensor.js)
//
//  The device's running totals as they stood at `at`: seconds the loom
//  has run, and picks when it counts them. Totals, not amounts since
//  the last post, so a lost post loses nothing — the next one carries
//  it. A device that restarts from zero is seen as a drop and counted
//  from zero. Dropped after READING_RETENTION_DAYS (default 120).
// ══════════════════════════════════════════════════════════════════

const mongoose = require('mongoose');

const LoomReadingSchema = new mongoose.Schema(
  {
    device: { type: mongoose.Types.ObjectId, ref: 'LoomDevice', required: true },
    machine: { type: mongoose.Types.ObjectId, ref: 'Machine', required: true },
    at: { type: Date, required: true },
    runSecondsTotal: { type: Number, required: true, min: 0 },
    picksTotal: { type: Number, default: null },
    running: { type: Boolean, default: null },
    expiresAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: 'receivedAt', updatedAt: false } }
);

LoomReadingSchema.index({ machine: 1, at: 1 });
// The same post sent twice (a retry after a lost reply) is one reading.
LoomReadingSchema.index({ device: 1, at: 1 }, { unique: true });
LoomReadingSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('LoomReading', LoomReadingSchema);
