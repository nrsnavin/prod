'use strict';
// ══════════════════════════════════════════════════════════════════
//  A PHYSICAL COUNT
//
//  Adjusting stock one material at a time, from a screen, with a
//  reason box, is a correction. It is not a stock take. A stock take
//  is a programme: you decide what to count, you write down what the
//  system thinks is there BEFORE anybody walks the racks, somebody
//  counts, and then the differences are reviewed as a set and posted
//  together. The value of it is in the variance report — which is a
//  document about the whole exercise, not a column on one material.
//
//  ── Snapshot, not freeze ──────────────────────────────────────────
//  A textbook stock take freezes the warehouse: no issues, no
//  receipts, until the count is posted. On a floor that runs three
//  shifts that is not a control, it is a production stoppage — so it
//  gets skipped, and the count is done "live" anyway with nobody
//  admitting it.
//
//  So this does not freeze anything. It snapshots what the system
//  believed at the moment the count was opened (`systemQty`), and at
//  posting it re-reads the live figure and flags every line that moved
//  in between. The count is still valid for those lines: the counter
//  established the balance as at the freeze, and the movements since
//  are real. Which is why the posting applies
//
//      delta = countedQty − systemQty
//
//  as an INCREMENT and never sets stock to countedQty. Setting it
//  would erase every genuine issue and receipt made while the count
//  was open — a stock take that quietly reverses a shift's production
//  is worse than no stock take.
//
//  ── What it never touches ─────────────────────────────────────────
//  Cost. A count that finds 5 kg missing has not changed what the
//  remaining yarn cost. Variance is VALUED at the material's weighted
//  average (utils/materialValuation.js) so the loss has a number on
//  it, but the average itself does not move.
// ══════════════════════════════════════════════════════════════════

const mongoose = require('mongoose');
const AutoIncrement = require('mongoose-sequence')(mongoose);

// ── One material on the count sheet ────────────────────────────────
const StockCountLineSchema = new mongoose.Schema(
  {
    rawMaterial: {
      type: mongoose.Types.ObjectId,
      ref: 'RawMaterial',
      required: true,
    },

    // Snapshotted at open, beside the id. The sheet has to still read
    // correctly years later, and a material can be renamed or deleted.
    name:     { type: String, trim: true, default: '' },
    category: { type: String, trim: true, default: '' },

    // What the system believed when the count was opened. Never
    // recomputed — the whole point is that it is a record of the claim
    // being checked, not a live figure.
    systemQty: { type: Number, required: true, default: 0 },

    // What the material was worth per unit at the freeze, so the
    // variance can be valued at the cost that was current when the
    // difference arose rather than at whatever it is when someone
    // opens the report.
    unitCostAtFreeze: { type: Number, default: 0 },

    // What was actually on the rack. null — not 0 — until somebody has
    // counted it: "nothing there" and "nobody has been yet" are
    // different facts and a stock take that confuses them writes off
    // everything it did not get round to.
    countedQty: { type: Number, default: null },
    countedAt:  { type: Date },
    countedBy:  { type: mongoose.Types.ObjectId, ref: 'User' },

    // Why the difference. Demanded at posting for variances past the
    // threshold — see api/stockCount.js.
    reason: { type: String, trim: true, default: '' },

    // ── Filled in at posting ─────────────────────────────────────────
    // The live figure when the count was posted. Differs from
    // systemQty exactly when the material moved while the count was
    // open, which is the thing a reviewer needs to know about.
    stockAtPost: { type: Number, default: null },
    // The increment actually applied. Can be less than the variance
    // when stock floors at zero.
    appliedDelta: { type: Number, default: null },

    // How much of this line's discrepancy another count had already
    // corrected before this one posted. Recorded so a line showing a
    // variance of −10 and an applied delta of 0 can say WHY, rather
    // than leaving a reader to guess whether it was neutralised, or
    // floored at zero stock, or simply not applied.
    correctedElsewhere: { type: Number, default: 0 },
  },
  { _id: true }
);

const StockCountSchema = new mongoose.Schema(
  {
    countNo: { type: Number, immutable: true },

    // What this count covers, in words — "Warp yarn, Rack A",
    // "Full count March 2026". The scope filter below says it in
    // machine terms; this says it the way the person running it does.
    label: { type: String, trim: true, default: '' },

    // How the lines were chosen. Kept so the sheet can say what it
    // claimed to cover — a count of "everything" that silently skipped
    // a category is worse than one that never claimed to.
    scope: {
      kind: {
        type: String,
        enum: ['all', 'category', 'supplier', 'materials'],
        default: 'all',
      },
      category:  { type: String, trim: true, default: '' },
      supplier:  { type: mongoose.Types.ObjectId, ref: 'Supplier' },
      materials: [{ type: mongoose.Types.ObjectId, ref: 'RawMaterial' }],
    },

    // draft     — never used today; reserved for a sheet being built.
    // counting  — open, lines are being filled in.
    // review    — counting done, variances being looked at.
    // posted    — the differences have been applied to stock. Terminal.
    // cancelled — abandoned; nothing was applied. Terminal.
    status: {
      type: String,
      enum: ['draft', 'counting', 'review', 'posted', 'cancelled'],
      default: 'counting',
      index: true,
    },

    lines: { type: [StockCountLineSchema], default: [] },

    frozenAt:  { type: Date, default: Date.now },
    openedBy:  { type: mongoose.Types.ObjectId, ref: 'User' },

    postedAt:  { type: Date },
    postedBy:  { type: mongoose.Types.ObjectId, ref: 'User' },

    cancelledAt:     { type: Date },
    cancelledBy:     { type: mongoose.Types.ObjectId, ref: 'User' },
    cancelledReason: { type: String, trim: true, default: '' },

    // Totals written at posting, so the variance a count posted is a
    // record and not something recomputed later against costs that
    // have since moved.
    postedSummary: {
      linesCounted:  { type: Number, default: 0 },
      linesVaried:   { type: Number, default: 0 },
      gainQuantity:  { type: Number, default: 0 },
      lossQuantity:  { type: Number, default: 0 },
      gainValue:     { type: Number, default: 0 },
      lossValue:     { type: Number, default: 0 },
      netValue:      { type: Number, default: 0 },
      linesMovedSinceFreeze: { type: Number, default: 0 },
    },

    fingerprints: { type: Array, default: [] },
  },
  { timestamps: true }
);

// Listing is newest-first, usually filtered by status ("what is still
// open?" is the question somebody asks every morning during a count).
StockCountSchema.index({ status: 1, createdAt: -1 });
// "Has this material been counted recently, and what did it find?"
StockCountSchema.index({ 'lines.rawMaterial': 1 });

StockCountSchema.plugin(AutoIncrement, { inc_field: 'countNo' });

module.exports = mongoose.model('StockCount', StockCountSchema);
