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
//  Two balances, because a stock ledger answers two questions:
//
//    applied / balance                 — goods. What is in the building.
//    reservedApplied / reservedBalance — promises. How much of it is
//                                        already sold to an approved
//                                        order.
//
//  Available to promise is balance − reservedBalance, derived, never
//  stored.
//
//  A reservation is a claim, not inventory: RESERVATION_HOLD and
//  RESERVATION_RELEASE move the reserved balance and leave the goods
//  alone. A dispatch moves both — the goods go out AND the promise is
//  kept — which is why DC_OUT carries a reserved figure too. Treating
//  the reservation as a second pile of goods to ship from is how a
//  warehouse ends up listing stock that is on a lorry.
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
    // The promise side of the same movement. Defaulted rather than
    // required: rows written before the reserved balance was tracked
    // carry no figure, and a zero there would be a claim about history
    // this code cannot make.
    //
    // BOTH halves, for the same reason the goods side has both. The
    // reserved balance floors at zero, so releasing 400 against 250
    // held releases 250 — and with only `reservedApplied` on the row
    // there was nothing to say the other 150 had been asked for and
    // could not be given. A promise that quietly shrinks is exactly the
    // kind of thing this ledger exists to make visible.
    reservedRequested: { type: Number, default: 0 },
    reservedApplied:   { type: Number, default: 0 },
    reservedBalance:   { type: Number, default: null },
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
