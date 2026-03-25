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
    type:     { type: String, required: true }, // ORDER_APPROVAL | PO_INWARD | STOCK_ADJUST
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
    },

    price:    { type: Number, default: 0 },  // per kg — current price

    stock:            { type: Number, default: 0 },
    minStock:         { type: Number, default: 0 },
    totalConsumption: { type: Number, default: 0 },

    // ── Price history (appended on every price change) ────────
    priceHistory: {
      type: [PriceHistorySchema],
      default: [],
    },

    // ── Running balance log (last 50 entries) ─────────────────
    stockMovements: {
      type: [StockMovementSchema],
      default: [],
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("RawMaterial", RawMaterialSchema);