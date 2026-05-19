// models/StockMovement.js
// ─────────────────────────────────────────────────────────────
//  Elastic stock-movement ledger.
//
//  Replaces the embedded Elastic.stockMovements array. One row per
//  movement; the running Elastic.stock is the sum of `applied`
//  across all rows for that elastic. `requested` records the
//  caller's intent so the UI can show the clamp delta when the
//  request would have driven stock below zero.
//
//  RESERVATION_HOLD / RESERVATION_RELEASE are info-only rows. They
//  do not modify Elastic.stock — they sit on the ledger so the
//  reservation lifecycle is visible in the audit trail.
//
//  WASTAGE_RETURN is the symmetric reversal of WASTAGE_OUT (admin
//  un-doing a wastage entry); kept distinct from WASTAGE_OUT so
//  type-grouped reports don't conflate the two directions.
// ─────────────────────────────────────────────────────────────
"use strict";

const mongoose = require("mongoose");

const StockMovementSchema = new mongoose.Schema(
  {
    elastic: {
      type: mongoose.Types.ObjectId,
      ref: "Elastic",
      required: true,
      index: true,
    },
    date: { type: Date, default: Date.now, index: true },
    type: {
      type: String,
      enum: [
        "PACKING_INWARD",
        "PACKING_REVERSE",
        "DC_OUT",
        "DC_CANCEL_RETURN",
        "WASTAGE_OUT",
        "WASTAGE_RETURN",
        "MANUAL_ADJUST",
        "RESERVATION_HOLD",
        "RESERVATION_RELEASE",
      ],
      required: true,
      index: true,
    },
    requested: { type: Number, required: true },
    applied:   { type: Number, required: true },
    balance:   { type: Number, required: true },
    refType:   { type: String },
    refId:     { type: mongoose.Types.ObjectId, index: true },
    reason:    { type: String },
    by:        { type: mongoose.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

StockMovementSchema.index({ elastic: 1, date: -1 });
StockMovementSchema.index({ refType: 1, refId: 1 });

module.exports = mongoose.model("StockMovement", StockMovementSchema);
