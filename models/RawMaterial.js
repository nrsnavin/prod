// models/RawMaterial.js
const mongoose = require("mongoose");

// ── Price history entry ───────────────────────────────────────
// Appended every time the price field is changed (via edit or
// bulk-update). Gives a full audit trail of price changes.
const PriceHistorySchema = new mongoose.Schema(
  {
    price:     { type: Number, required: true },   // new price
    oldPrice:  { type: Number, required: true },   // previous price
    changedAt: { type: Date,   default: Date.now },
    reason:    { type: String, default: "" },       // e.g. "Bulk update Mar 2026"
  },
  { _id: false }
);

// ── Running stock movement ────────────────────────────────────
const StockMovementSchema = new mongoose.Schema(
  {
    date:     { type: Date,   required: true },
    type:     { type: String, required: true }, // ORDER_APPROVAL | PO_INWARD | STOCK_ADJUST | ORDER_CANCEL_REFUND
    order:    { type: mongoose.Types.ObjectId, ref: "Order" },
    quantity: { type: Number, required: true },
    balance:  { type: Number },
  },
  { _id: false }
);

const RawMaterialSchema = new mongoose.Schema(
  {
    name:     { type: String, required: true },
    category: { type: String, required: true },

    supplier: {
      type: mongoose.Types.ObjectId,
      ref: "Supplier",
      default:"697e40c4e79c50e10e17ab61"
    },

    // min: 0 — schema-level floor so a stray negative from a missed
    // route validation can never persist into money / stock math.
    price:    { type: Number, default: 0, min: 0 },  // per kg — current price


    stock:            { type: Number, default: 0, min: 0 },
    minStock:         { type: Number, default: 0, min: 0 },

    totalConsumption: { type: Number, default: 0, min: 0 },

    // ── Price history (appended on every price change) ────────
    priceHistory: {
      type: [PriceHistorySchema],
      default: [],
    },

    // ── Running balance log (last 50 entries) ─────────────────
    stockMovements: {
      type: [StockMovementSchema],
      default: [],
      // Excluded from every query unless asked for with select("+stockMovements").
      // Mongo cannot return part of a document, so without this a list of 40
      // materials drags 40 full movement histories across the wire — and the
      // MRP, forecast and category pickers all list every material.
      select: false,
    },
  },
  { timestamps: true }
);

// ── Indexes ─────────────────────────────────────────────────────────
// Materials are looked up by name (search, import matching) and grouped by
// category (warp/weft/covering pickers on the MRP and job forms).
RawMaterialSchema.index({ name: 1 });
RawMaterialSchema.index({ category: 1, name: 1 });

/**
 * Cap on the embedded stockMovements ledger.
 *
 * This array is append-only and was unbounded: every order approval, cancel
 * refund, inward and outward pushed a row onto the material document, so a
 * material used by every order grew forever. Two problems, and the second
 * arrives long before the first:
 *
 *   1. It marches toward MongoDB's 16 MB per-document limit, after which
 *      every write to that material fails — including ones that have
 *      nothing to do with stock.
 *   2. Mongo has no way to read "part of" a document, so every load of the
 *      material drags the whole history with it, and the whole document is
 *      rewritten on each append.
 *
 * The authoritative history lives in the MaterialInward / MaterialOutward
 * collections — which is what the stock-movements report actually reads —
 * so this array is a convenience tail, not a system of record. The detail
 * endpoint already only ever displays the newest 50.
 */
const MAX_EMBEDDED_MOVEMENTS = 500;

RawMaterialSchema.pre("save", function trimStockMovements(next) {
  const moves = this.stockMovements;
  if (Array.isArray(moves) && moves.length > MAX_EMBEDDED_MOVEMENTS) {
    // Keep the newest; entries are appended in chronological order.
    this.stockMovements = moves.slice(-MAX_EMBEDDED_MOVEMENTS);
  }
  next();
});

const RawMaterial = mongoose.model("RawMaterial", RawMaterialSchema);

module.exports = RawMaterial;
module.exports.MAX_EMBEDDED_MOVEMENTS = MAX_EMBEDDED_MOVEMENTS;