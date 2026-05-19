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

    // ─ Reservation split (elastic DCs against a reserved order) ─
    // Populated at /create when the parent DC has an order and that
    // order has matching reservations. Sum of the two equals
    // `quantity`. Pre-PR-E DCs have both fields absent → readers
    // should treat them as { consumedFromReservation: 0,
    // consumedFromStock: item.quantity }.
    consumedFromReservation: { type: Number, default: 0 },
    consumedFromStock:       { type: Number, default: 0 },
  },
  { _id: false }
);

// ── Fingerprint sub-schema (audit timeline) ───────────────────
const FingerprintSchema = new mongoose.Schema(
  {
    code:    { type: String, required: true },
    label:   { type: String, required: true },
    hash:    { type: String, required: true },
    shortId: { type: String, required: true },
    at:      { type: Date,   required: true, default: Date.now },
    actor:   {
      type:    mongoose.Schema.Types.Mixed,
      default: { id: "system", name: "System", role: "system" },
    },
    meta:    { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { _id: false }
);

// ── Main schema ───────────────────────────────────────────────
const DeliveryChallanSchema = new mongoose.Schema(
  {
    // ── DC Identity ──────────────────────────────────────────
    dcNumber: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },

    type: {
      type: String,
      enum: ["elastic", "machine_part"],
      required: true,
    },

    financialYear: {
      type: String,
      required: true,
    },

    sequence: {
      type: Number,
      required: true,
    },

    // ── Linked order (elastic DCs only) ─────────────────────
    order: {
      type: mongoose.Types.ObjectId,
      ref: "Order",
    },
    orderNo: { type: Number },

    // ── Customer snapshot ────────────────────────────────────
    customerName:    { type: String, required: true, trim: true },
    customerPhone:   { type: String, default: "" },
    customerGstin:   { type: String, default: "" },
    customerAddress: { type: String, default: "" },

    // ── Dispatch / Transport ─────────────────────────────────
    dispatchDate: { type: Date, default: Date.now },
    vehicleNo:    { type: String, default: "" },
    driverName:   { type: String, default: "" },
    transporter:  { type: String, default: "" },
    lrNumber:     { type: String, default: "" },

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

    fingerprints: {
      type:    [FingerprintSchema],
      default: [],
    },
  },
  { timestamps: true }
);

DeliveryChallanSchema.index({ type: 1, financialYear: 1, sequence: 1 });

module.exports = mongoose.model("DeliveryChallan", DeliveryChallanSchema);
