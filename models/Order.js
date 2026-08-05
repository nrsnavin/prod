const mongoose = require("mongoose");
const AutoIncrement = require("mongoose-sequence")(mongoose);

const ElasticQtySchema = new mongoose.Schema(
  {
    elastic:  { type: mongoose.Types.ObjectId, ref: "Elastic", required: true },
    // min: 0 — negative ordered/produced/packed quantities corrupt
    // the production math and stock counters downstream.
    quantity: { type: Number, required: true, default: 0, min: 0 },
  },
  { _id: false }
);

// What the customer ordered, and what they agreed to pay for it.
//
// The sale price existed nowhere on the order — the only rate in the
// system sat on a delivery challan line, which is cut at dispatch. So
// an order had no revenue figure until goods shipped, while its cost
// had been accumulating since approval. The order P&L reads the rate
// from here, and shows the invoiced DC value beside it.
//
// Only `elasticOrdered` uses this shape; produced / packed / pending
// stay plain quantities, because a rate on them would be a second
// place for the same number to live.
const OrderedElasticSchema = new mongoose.Schema(
  {
    elastic:  { type: mongoose.Types.ObjectId, ref: "Elastic", required: true },
    quantity: { type: Number, required: true, default: 0, min: 0 },
    // ₹ per unit (the elastic's own unit — meters for elastic).
    // 0 means "not priced yet", and the P&L says so out loud rather
    // than reporting the order as a total loss.
    rate: { type: Number, default: 0, min: 0 },
  },
  { _id: false }
);

// ── Reservation sub-schema ─────────────────────────────────
// Tracks how much of each elastic this order still has *reserved*
// against Elastic.reservedStock. Approval seeds it from
// elasticOrdered; DC create against the order decrements; cancel /
// complete releases whatever is left. Entries with quantity === 0
// are pruned by the routes that mutate them.
const ReservationSchema = new mongoose.Schema(
  {
    elastic:  { type: mongoose.Types.ObjectId, ref: "Elastic", required: true },
    quantity: { type: Number, required: true, default: 0 },
  },
  { _id: false }
);

const RawMaterialRequirementSchema = new mongoose.Schema(
  {
    rawMaterial:    { type: mongoose.Types.ObjectId, ref: "RawMaterial", required: true },
    name:           { type: String },
    requiredWeight: { type: Number },
    inStock:        { type: Number },
  },
  { _id: false }
);

const JobRefSchema = new mongoose.Schema(
  {
    job: { type: mongoose.Types.ObjectId, ref: "JobOrder", required: true },
    no:  { type: Number, required: true, default: 0 },
  },
  { _id: false }
);

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

const OrderSchema = new mongoose.Schema(
  {
    date:        { type: Date, required: true },
    po:          { type: String, required: true, trim: true },
    customer:    { type: mongoose.Types.ObjectId, ref: "Customer", required: true },
    supplyDate:  { type: Date, required: true },
    description: { type: String, default: "" },

    elasticOrdered:      { type: [OrderedElasticSchema], default: [] },
    producedElastic:     { type: [ElasticQtySchema], default: [] },
    packedElastic:       { type: [ElasticQtySchema], default: [] },
    pendingElastic:      { type: [ElasticQtySchema], default: [] },
    rawMaterialRequired: { type: [RawMaterialRequirementSchema], default: [] },
    jobs:                { type: [JobRefSchema], default: [] },

    // Elastic units committed to this order. Maintained by the
    // reservation lifecycle on /approve, /cancel, /complete, and
    // by DC create/cancel/delete against this order.
    reservations: { type: [ReservationSchema], default: [] },

    status: {
      type:    String,
      enum:    ["Open", "Approved", "InProgress", "Completed", "Cancelled", "Deleted"],
      default: "Open",
    },

    // Per-state fingerprints — set explicitly in each route handler
    approvedBy:  { type: mongoose.Types.ObjectId, ref: "User" },
    approvedAt:  { type: Date },
    // Provenance — how the approval was initiated. Used by the admin
    // app to surface a visible "via WhatsApp +91…" pill on the order
    // detail timeline and a small icon on the order list card.
    //   "admin"     → approved from the admin web/mobile app
    //   "whatsapp"  → owner replied APPROVE to a WhatsApp ping
    approvalVia:          { type: String, enum: ["admin", "whatsapp"], default: "admin" },
    approvalWhatsappFrom: { type: String }, // E.164 of the sender, when via=whatsapp
    cancelledBy: { type: mongoose.Types.ObjectId, ref: "User" },
    cancelledAt: { type: Date },
    startedBy:   { type: mongoose.Types.ObjectId, ref: "User" },
    startedAt:   { type: Date },
    completedBy: { type: mongoose.Types.ObjectId, ref: "User" },
    completedAt: { type: Date },
    deletedBy:   { type: mongoose.Types.ObjectId, ref: "User" },
    deletedAt:   { type: Date },
    updatedItemsAt: { type: Date },

    fingerprints: {
      type:    [FingerprintSchema],
      default: [],
    },

    orderNo: { type: Number, immutable: true },
  },
  { timestamps: true }
);

OrderSchema.plugin(AutoIncrement, { inc_field: "orderNo" });

// ── Indexes ─────────────────────────────────────────────────────────
// This collection had none, so every screen that lists orders was a full
// collection scan followed by an in-memory sort. The sort is the part that
// bites first: without an index Mongo caps it at 32 MB and then *errors*
// ("Sort exceeded memory limit") rather than degrading, so the order list
// stops working outright once the collection outgrows that.

// The order list: filter by status, newest first. Compound and in that
// order so the same index serves both the filter and the sort.
OrderSchema.index({ status: 1, createdAt: -1 });

// "All orders", newest first — the unfiltered variant of the same screen.
OrderSchema.index({ createdAt: -1 });

// Customer detail page: this customer's orders, newest first.
OrderSchema.index({ customer: 1, createdAt: -1 });

// Lookup by human-facing number (WhatsApp commands, search). Unique because
// mongoose-sequence is meant to guarantee it — this makes the database
// enforce it too, so a duplicate fails loudly instead of quietly existing.
OrderSchema.index({ orderNo: 1 }, { unique: true, sparse: true });

// Delivery-schedule views: what is due, soonest first, within a status.
OrderSchema.index({ status: 1, supplyDate: 1 });

// The elastic detail page: every order carrying one product, newest
// first. Multikey, because elasticOrdered is an array — an order is
// indexed once per product on it.
//
// Without this the query is the exact failure the note above describes:
// a full scan of every order ever placed, then an in-memory sort of
// whatever matched. That list is built to serve a product with hundreds
// of orders behind it, so it is the screen that would hit the 32 MB sort
// ceiling first — and it errors rather than degrading.
OrderSchema.index({ "elasticOrdered.elastic": 1, date: -1 });

module.exports = mongoose.model("Order", OrderSchema);
