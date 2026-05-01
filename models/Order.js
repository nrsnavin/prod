const mongoose = require("mongoose");
const AutoIncrement = require("mongoose-sequence")(mongoose);

const ElasticQtySchema = new mongoose.Schema(
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

    status: {
      type:    String,
      enum:    ["Open", "Approved", "InProgress", "Completed", "Cancelled"],
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

    // Auto-generated order number
    orderNo: { type: Number, immutable: true },
  },
  { timestamps: true }
);

OrderSchema.plugin(AutoIncrement, { inc_field: "orderNo" });

module.exports = mongoose.model("Order", OrderSchema);
