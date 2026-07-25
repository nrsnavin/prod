// ══════════════════════════════════════════════════════════════
//  EMPLOYEE LEDGER
//  File: models/LedgerEntry.js
//
//  An append-only money trail per employee. Every event that changes
//  what the factory owes a worker (or what the worker owes back) lands
//  here as one row, so a ledger view can be rendered without recomputing
//  payroll.
//
//  Sign convention (from the EMPLOYEE's perspective):
//    +ve  the factory owes the employee more  (earnings, bonuses)
//    -ve  reduces what the factory owes       (penalties, statutory,
//                                              advance recovery, payments
//                                              handed over, advance issued)
//
//  So a running sum of `amount` = balance still payable to the employee.
//  Entries are written inside the same DB transaction as the change that
//  caused them, and are idempotent per (employee, source, sourceId, kind).
// ══════════════════════════════════════════════════════════════
'use strict';

const mongoose = require('mongoose');

const KINDS = [
  'shift_salary',      // a worked shift's base pay
  'overtime',          // OT earnings
  'bonus',             // attendance/no-leave/streak bonuses
  'diwali_bonus',      // festival bonus (dated on the Diwali date)
  'penalty',           // excess-absent / late / wastage penalties
  'absence',           // pay lost to an unapproved absence
  'statutory',         // PF / ESI employee share
  'advance_issued',    // cash given up front (employee owes it back)
  'advance_recovered', // advance taken back out of pay
  'payment',           // salary actually handed over
  'adjustment',        // manual correction
];

const LedgerEntrySchema = new mongoose.Schema(
  {
    employee: { type: mongoose.Types.ObjectId, ref: 'Employee', required: true, index: true },
    // The business date the entry belongs to (shift date, payment date,
    // Diwali date …) — NOT necessarily when the row was written.
    date:   { type: Date, required: true, index: true },
    kind:   { type: String, enum: KINDS, required: true, index: true },
    amount: { type: Number, required: true },          // signed, see above
    label:  { type: String, default: '' },

    // Period this entry is attributed to (payroll month), when applicable.
    year:  { type: Number, default: null },
    month: { type: Number, default: null, min: 1, max: 12 },

    // Provenance — lets us rebuild/reverse a source document's entries.
    source:   { type: String, enum: ['payroll', 'advance', 'bonus', 'manual'], required: true },
    sourceId: { type: mongoose.Types.ObjectId, default: null, index: true },

    meta:      { type: mongoose.Schema.Types.Mixed, default: {} },
    postedBy:  { type: String, default: '' },  // display name of who triggered it
  },
  { timestamps: true }
);

// Ledger reads are always "one employee, ordered by date".
LedgerEntrySchema.index({ employee: 1, date: 1 });
// Re-posting the same source must not duplicate rows.
LedgerEntrySchema.index({ source: 1, sourceId: 1, kind: 1 });

module.exports = mongoose.model('LedgerEntry', LedgerEntrySchema);
module.exports.KINDS = KINDS;
