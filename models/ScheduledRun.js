'use strict';
// One row per scheduled job per day it ran. The unique key is the claim:
// whichever process inserts `morningDigest:2026-11-08` first sends it, and
// every other process (or an external crontab hitting the cron route)
// finds the row and stands down.
const mongoose = require('mongoose');

const ScheduledRunSchema = new mongoose.Schema({
  key:     { type: String, required: true, unique: true }, // `${job}:${YYYY-MM-DD}`
  job:     { type: String, required: true, index: true },
  day:     { type: String, required: true },
  trigger: { type: String, enum: ['timer', 'cron'], default: 'timer' },
  ok:      { type: Boolean, default: null },
  error:   { type: String, default: '' },
  at:      { type: Date, default: Date.now },
}, { timestamps: false });

module.exports = mongoose.models.ScheduledRun || mongoose.model('ScheduledRun', ScheduledRunSchema);
