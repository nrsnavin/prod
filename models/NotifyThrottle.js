// models/NotifyThrottle.js
//
// One row per (event, entity) while its throttle window is open.
//
// utils/notify.js used to throttle by asking "was this sent in the last
// N seconds?" and then sending. Two outbox workers (cluster mode) could
// both ask before either had written its "sent" row, and both send.
// Claiming this row is the atomic version of that question: the unique
// `key` lets only one of them open the window.
//
// Rows expire on their own once the window has closed.
const mongoose = require("mongoose");

const NotifyThrottleSchema = new mongoose.Schema({
  key:   { type: String, required: true, unique: true }, // `${event}:${entityId}`
  at:    { type: Date, required: true },                 // when the window opened
  until: { type: Date, required: true },                 // when it closes; only for expiry
});

NotifyThrottleSchema.index({ until: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model("NotifyThrottle", NotifyThrottleSchema);
