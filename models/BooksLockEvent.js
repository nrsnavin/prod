// ══════════════════════════════════════════════════════════════════
//  WHAT HAPPENED TO THE BOOKS LOCK, AND WHO DID IT
//
//  One row each time the books are closed, the closing date is moved,
//  the books are opened again, or an admin lets one entry through a
//  closed period. The settings row only knows the lock as it stands
//  now; this is how it got there.
//
//    closed     the books had no lock and now have one
//    moved      the lock date moved later (the next month was closed)
//    reopened   the lock was taken off or moved earlier; `reason` says why
//    override   an admin posted or cancelled an entry dated inside the
//               closed period; `reason` is what they typed, `entry`
//               what was let through
//
//  Rows are only ever added (services/booksLock.js).
// ══════════════════════════════════════════════════════════════════
const mongoose = require("mongoose");

const BooksLockEventSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ["closed", "moved", "reopened", "override"], required: true },
    // The lock date once this had happened (for an override: the lock in force).
    lockDate: { type: Date, default: null },
    previousLockDate: { type: Date, default: null },
    reason: { type: String, default: "", trim: true, maxlength: 300 },
    // Where it was done: the settings screen, or a Tally export sent with "lock" ticked.
    via: { type: String, default: "" },
    by: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    byName: { type: String, default: "" },
    at: { type: Date, default: Date.now },
    // An override: the entry that was let through.
    entry: {
      date: { type: Date },
      cancelling: { type: Boolean },
      method: { type: String },
      path: { type: String },
    },
  },
  { timestamps: false }
);

BooksLockEventSchema.index({ at: -1 });
BooksLockEventSchema.index({ kind: 1, at: -1 });

module.exports = mongoose.models.BooksLockEvent || mongoose.model("BooksLockEvent", BooksLockEventSchema);
