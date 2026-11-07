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

    // Client-generated idempotency key — a retried create must not cut
    // a second challan and double-move stock. sparse for legacy docs.
    requestId: {
      type: String,
      unique: true,
      sparse: true,
    },

    // An admin released this past a credit hold (services/creditControl.js).
    creditOverride: { type: mongoose.Schema.Types.Mixed, default: undefined },

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

    // The e-way bill for the goods' movement (CGST Rule 138).
    ewaybill: {
      status:        { type: String, enum: ["", "generated", "cancelled"], default: "" },
      number:        { type: String, default: "" },
      generatedAt:   { type: Date },
      validUpto:     { type: Date },
      vehicleNo:     { type: String, default: "" },
      transporterId: { type: String, default: "" },
      transporterName: { type: String, default: "" },
      transDocNo:    { type: String, default: "" },
      distanceKm:    { type: Number, default: 0 },
      mode:          { type: String, enum: ["road", "rail", "air", "ship"], default: "road" },
      provider:      { type: String, default: "" },
      cancelledAt:   { type: Date },
    },


    // ── Status ───────────────────────────────────────────────
    status: {
      type: String,
      enum: ["draft", "dispatched", "delivered", "cancelled"],
      default: "draft",
    },

    remarks: { type: String, default: "" },

    // Proof of delivery: when the customer took it, who, and what they
    // wrote on the copy. `source` says whether it was read from the
    // signed copy's photo or typed. A shortage or damage written there
    // can open a complaint (`complaint`).
    pod: {
      type: new mongoose.Schema({
        deliveredOn: Date,
        receivedBy:  { type: String, default: "" },
        remark:      { type: String, default: "" },
        issue:       { type: String, enum: ["", "short", "damaged", "wrong"], default: "" },
        stamped:     { type: Boolean, default: false },
        source:      { type: String, enum: ["photo", "typed"], default: "typed" },
        complaint:   { type: mongoose.Types.ObjectId, ref: "Complaint" },
        at:          Date,
        by:          { type: mongoose.Types.ObjectId, ref: "User" },
      }, { _id: false }),
      default: undefined,
    },

    // Shipped more than was in stock, on purpose and with a reason
    // (api/deliveryChallan.js _applyDcItems). Stock never goes below
    // zero, so `short` is what the challan says left beyond what the
    // shelf held; the reason says why that was right.
    stockShortfall: {
      type: new mongoose.Schema({
        reason: { type: String, trim: true },
        lines: [{
          _id: false,
          elastic: { type: mongoose.Types.ObjectId, ref: "Elastic" },
          name: String,
          shipping: Number,
          onHand: Number,
          short: Number,
        }],
        at: Date,
        by: { type: mongoose.Types.ObjectId, ref: "User" },
      }, { _id: false }),
      default: undefined,
    },

    fingerprints: {
      type:    [FingerprintSchema],
      default: [],
    },
  },
  { timestamps: true }
);

DeliveryChallanSchema.index({ type: 1, financialYear: 1, sequence: 1 });

module.exports = mongoose.model("DeliveryChallan", DeliveryChallanSchema);
