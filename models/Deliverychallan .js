const mongoose = require("mongoose");

// ── Line item sub-schema ──────────────────────────────────────
const DCItemSchema = new mongoose.Schema(
  {
    // ─ Elastic delivery fields ──────────────────────────────
    elastic: {
      type: mongoose.Types.ObjectId,
      ref: "Elastic",
    },
    elasticName: { type: String }, // snapshot — survives elastic rename

    // ─ Machine-part fields ──────────────────────────────────
    description: { type: String }, // free-text part / service name

    // ─ Common ───────────────────────────────────────────────
    unit:     { type: String, default: "m" }, // m / pcs / set / kg / nos
    quantity: { type: Number, required: true, min: 0 },
    rate:     { type: Number, default: 0 },   // per unit
    amount:   { type: Number, default: 0 },   // quantity × rate (computed)
  },
  { _id: false }
);

// ── Main schema ───────────────────────────────────────────────
const DeliveryChallanSchema = new mongoose.Schema(
  {
    // ── DC Identity ──────────────────────────────────────────
    // Format:  E/2425/001  |  M/2425/001
    dcNumber: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },

    // "elastic" or "machine_part"
    type: {
      type: String,
      enum: ["elastic", "machine_part"],
      required: true,
    },

    // Two-digit year pair: "2425" for FY 2024-25
    financialYear: {
      type: String,
      required: true,
    },

    // Raw incrementing counter used to build dcNumber
    sequence: {
      type: Number,
      required: true,
    },

    // ── Linked order (elastic DCs only) ─────────────────────
    order: {
      type: mongoose.Types.ObjectId,
      ref: "Order",
    },
    orderNo: { type: Number }, // snapshot

    // ── Customer snapshot (pre-filled from order) ────────────
    customerName:    { type: String, required: true, trim: true },
    customerPhone:   { type: String, default: "" },
    customerGstin:   { type: String, default: "" },
    customerAddress: { type: String, default: "" },

    // ── Dispatch / Transport ─────────────────────────────────
    dispatchDate: { type: Date, default: Date.now },
    vehicleNo:    { type: String, default: "" },
    driverName:   { type: String, default: "" },
    transporter:  { type: String, default: "" },
    lrNumber:     { type: String, default: "" }, // Lorry Receipt No

    // ── Items ────────────────────────────────────────────────
    items: {
      type: [DCItemSchema],
      default: [],
    },

    // ── Totals (denormalised for quick display) ───────────────
    totalQuantity: { type: Number, default: 0 },
    totalAmount:   { type: Number, default: 0 },

    // ── Status ───────────────────────────────────────────────
    status: {
      type: String,
      enum: ["draft", "dispatched", "delivered", "cancelled"],
      default: "draft",
    },

    remarks: { type: String, default: "" },
  },
  { timestamps: true }
);

// Compound index for quick sequence lookup per type + FY
DeliveryChallanSchema.index({ type: 1, financialYear: 1, sequence: 1 });

module.exports = mongoose.model("DeliveryChallan", DeliveryChallanSchema);