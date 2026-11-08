'use strict';
// One row per scheduled job per day it ran. The unique key is the claim:
// whichever process inserts `morningDigest:2026-11-08` first sends it, and
// every other process (or an external crontab hitting the cron route)
// finds the row and stands down.
const mongoose = require('mongoose');

const ScheduledRunSchema = new mongoose.Schema({
  key:     { type: String, required: true, unique: true }, // `${task}:${YYYY-MM-DD}`
  // `task`, not `job`: `job` is a reference to a JobOrder everywhere else
  // (utils/blankRefs.js treats a name that is text anywhere as ambiguous).
  task:    { type: String, required: true, index: true },
  day:     { type: String, required: true },
  trigger: { type: String, enum: ['timer', 'cron'], default: 'timer' },
  ok:      { type: Boolean, default: null },
  error:   { type: String, default: '' },
  at:      { type: Date, default: Date.now },
}, { timestamps: false });

module.exports = mongoose.models.ScheduledRun || mongoose.model('ScheduledRun', ScheduledRunSchema);
