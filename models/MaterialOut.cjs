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

    // Price per unit captured at issue time
    unitPrice: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true }
);

materialOutwardSchema.index({ rawMaterial: 1, outwardDate: -1 });
materialOutwardSchema.index({ order: 1 });
materialOutwardSchema.index({ job:   1 });

module.exports = mongoose.model('MaterialOutward', materialOutwardSchema);