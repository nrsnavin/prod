const mongoose = require("mongoose");
const AutoIncrement = require("mongoose-sequence")(mongoose);

/**
 * 🔹 Reusable sub-schema for Elastic quantity tracking
 */
const ElasticQtySchema = new mongoose.Schema(
  {
    elastic: {
      type: mongoose.Types.ObjectId,
      ref: "Elastic",
      required: true,
    },
    quantity: {
      type: Number,
      required: true,
      default: 0,
    },
  },
  { _id: false }
);

/**
 * 🔹 Raw material snapshot at order creation
 */
const RawMaterialRequirementSchema = new mongoose.Schema(
  {
    rawMaterial: {
      type: mongoose.Types.ObjectId,
      ref: "RawMaterial",
      required: true,
    },
    name: {
      type: String,
    },
    requiredWeight: {
      type: Number,
    },
    inStock: {
      type: Number,
    },
  },
  { _id: false }
);

/**
 * 🔹 Job reference schema
 */
const JobRefSchema = new mongoose.Schema(
  {
    job: {
      type: mongoose.Types.ObjectId,
      ref: "JobOrder",
      required: true,
    },
    no: {
      type: Number,
      required: true,
      default: 0,
    },
  },
  { _id: false }
);

/**
 * 🧾 ORDER SCHEMA
 */
const OrderSchema = new mongoose.Schema(
  {
    date: {
      type: Date,
      required: true,
    },

    po: {
      type: String,
      required: true,
      trim: true,
    },

    customer: {
      type: mongoose.Types.ObjectId,
      ref: "Customer",
      required: true,
    },

    supplyDate: {
      type: Date,
      required: true,
    },

    description: {
      type: String,
      default: "",
    },

    // 🧵 Elastic tracking
    elasticOrdered: {
      type: [ElasticQtySchema],
      default: [],
    },

    producedElastic: {
      type: [ElasticQtySchema],
      default: [],
    },

    packedElastic: {
      type: [ElasticQtySchema],
      default: [],
    },

    pendingElastic: {
      type: [ElasticQtySchema],
      default: [],
    },

    // 🧮 Raw material snapshot
    rawMaterialRequired: {
      type: [RawMaterialRequirementSchema],
      default: [],
    },

    // 🏭 Jobs created under this order
    jobs: {
      type: [JobRefSchema],
      default: [],
    },

    status: {
      type: String,
      enum: ["Open", "InProgress", "Completed", "Cancelled"],
      default: "Open",
    },

    // 🔢 Auto-generated
    orderNo: {
      type: Number,
      immutable: true,
    },
  },
  { timestamps: true }
);

/**
 * 🔢 Auto Increment Order Number
 */
OrderSchema.plugin(AutoIncrement, { inc_field: "orderNo" });

module.exports = mongoose.model("Order", OrderSchema);
