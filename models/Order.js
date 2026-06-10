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

    elasticOrdered:      { type: [ElasticQtySchema], default: [] },
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

module.exports = mongoose.model("Order", OrderSchema);
