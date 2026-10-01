const mongoose = require("mongoose");

// ══════════════════════════════════════════════════════════════════
//  WHO CHANGED WHOSE ACCESS
//
//  One append-only record per change to a login: created, edited (and
//  what changed), deleted, and a worker's phone sign-in set, reset or
//  turned off. Also each time an admin views an employee's full Aadhaar
//  number (subject = the employee). Business records carry their audit fingerprints on the
//  document itself; a login can't, because deleting it would delete its
//  own history. So these live here, and the audit feed reads them
//  alongside the rest (api/audit.js).
//
//  Nothing ever updates or deletes these. Passwords and PINs never
//  appear in them, only the fact that one was set.
// ══════════════════════════════════════════════════════════════════

const AccessEventSchema = new mongoose.Schema(
  {
    code:    { type: String, required: true },
    label:   { type: String },
    hash:    { type: String },
    shortId: { type: String },
    at:      { type: Date, required: true, index: -1 },
    actor:   { type: Object },
    // The login the change was made to, as it was at the time: a deleted
    // login is still named in its own history.
    subject: {
      id:    { type: String },
      name:  { type: String },
      email: { type: String },
    },
    meta:    { type: Object, default: {} },
  },
  { versionKey: false }
);

module.exports = mongoose.model("AccessEvent", AccessEventSchema);
