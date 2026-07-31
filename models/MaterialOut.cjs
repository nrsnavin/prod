// models/MaterialOut.js  — CommonJS (matches rest of codebase)
'use strict';

const mongoose = require('mongoose');

const materialOutwardSchema = new mongoose.Schema(
  {
    rawMaterial: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'RawMaterial',
      required: true,
    },

    quantity: {
      type: Number,
      required: true,
    },

    // ── Source reference (one of these will be set) ───────
    // Order approval deduction → order is set
    order: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Order',
    },
    // Job-level consumption → job is set
    job: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'JobOrder',
    },

    outwardDate: {
      type: Date,
      default: Date.now,
    },

    // STOCK_ADJUST (negative), ORDER_APPROVAL, JOB_CONSUMPTION
    type: {
      type: String,
      enum: ['ORDER_APPROVAL', 'JOB_CONSUMPTION', 'STOCK_ADJUST'],
      required: true,
    },

    remarks: {
      type: String,
      trim: true,
      default: '',
    },

    // Which dye lot the goods left. Set when a stock adjustment names
    // one, so writing yarn off draws down the lot it actually came from
    // rather than leaving the lot ledger to drift from the aggregate.
    // Optional throughout — untracked material has no lot to name.
    yarnLot: { type: mongoose.Schema.Types.ObjectId, ref: 'YarnLot' },
    lotNo:   { type: String, trim: true, default: '' },

    // Price per unit captured at issue time
    unitPrice: {
      type: Number,
      default: 0,
    },

    // ── Reversal bookkeeping ─────────────────────────────
    // Set when /order/cancel walks the outward log to refund
    // raw stock back. The original row stays in place for
    // history; the dedupe filter in _refundRawMaterialsForOrder
    // uses `reversed: { $ne: true }` so the same approval can't
    // be refunded twice.
    reversed: {
      type: Boolean,
      default: false,
      index: true,
    },
    reversedAt: { type: Date },
    reversedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

materialOutwardSchema.index({ rawMaterial: 1, outwardDate: -1 });
materialOutwardSchema.index({ order: 1, reversed: 1 });
materialOutwardSchema.index({ job:   1 });

module.exports = mongoose.model('MaterialOutward', materialOutwardSchema);