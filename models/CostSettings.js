// ══════════════════════════════════════════════════════════════
//  COST SETTINGS  (single factory-wide document)
//  File: models/CostSettings.js
//
//  The conversion rate card the order P&L costs production against.
//  Finishing, checking and packing are real money the factory spends
//  and nothing recorded them — there is no per-job entry for either,
//  so the P&L would otherwise have shown a margin that quietly
//  omitted the back half of the process.
//
//  Every rate is ₹ per METER of produced elastic, applied to a job's
//  produced meters. A job that actually cost something different
//  carries an absolute override on JobOrder.costOverrides, which
//  wins over the rate — the rate is the default, not the truth.
//
//  All rates default to 0: nothing is charged until you fill them in,
//  and the P&L says so rather than silently costing production at zero.
// ══════════════════════════════════════════════════════════════
'use strict';

const mongoose = require('mongoose');

const CostSettingsSchema = new mongoose.Schema(
  {
    // Singleton discriminator — mirrors DocumentSettings' `key`.
    key: { type: String, default: 'cost', unique: true, immutable: true },

    // ── Conversion rate card (₹ per produced meter) ──────────
    finishingRatePerMeter: { type: Number, default: 0, min: 0 },
    checkingRatePerMeter:  { type: Number, default: 0, min: 0 },
    packingRatePerMeter:   { type: Number, default: 0, min: 0 },

    // ── Factory overhead (₹ per produced meter) ──────────────
    // Power, rent, depreciation — the costs that belong to every
    // meter but sit on no document. Without it every order reads
    // better than it is.
    overheadRatePerMeter: { type: Number, default: 0, min: 0 },

    notes: { type: String, default: '' },

    // ── Who moved the card ───────────────────────────────────
    // These four figures cost every metre ever made: change one and
    // the margin on every order, past ones too, changes with it. The
    // card kept the time of its last save and nothing else. Each change
    // of a figure is kept here — who, when, from what to what — the
    // last fifty of them (api/pnl.js).
    changes: {
      type: [new mongoose.Schema({
        at:     { type: Date, required: true },
        by:     { type: mongoose.Types.ObjectId, ref: 'User', default: null },
        byName: { type: String, default: '' },
        from:   { type: mongoose.Schema.Types.Mixed, default: {} },
        to:     { type: mongoose.Schema.Types.Mixed, default: {} },
      }, { _id: false })],
      default: [],
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('CostSettings', CostSettingsSchema);
