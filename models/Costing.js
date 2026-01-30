const mongoose = require("mongoose");

/**
 * 🔹 Costing Detail (Material / Process breakup)
 */
const CostingDetailSchema = new mongoose.Schema(
  {
    type: {
      type: String, // material / labor / overhead
      required: true,
    },
    reference: {
      type: mongoose.Types.ObjectId,
      refPath: "details.typeRef",
    },
    description: {
      type: String,
    },
    quantity: {
      type: Number,
    },
    rate: {
      type: Number,
    },
    cost: {
      type: Number,
    },
  },
  { _id: false }
);

/**
 * 💰 COSTING SCHEMA
 */
const CostingSchema = new mongoose.Schema(
  {
    // 📅 COSTING DATE
    date: {
      type: Date,
      required: true,
      default: Date.now,
    },

    // 🧵 ELASTIC REFERENCE
    elastic: {
      type: mongoose.Types.ObjectId,
      ref: "Elastic",
      required: true,
      index: true,
    },

    // 🔧 CONVERSION COST (PER UNIT)
    conversionCost: {
      type: Number,
      required: true,
      default: 1.25,
    },

    // 🧶 TOTAL MATERIAL COST (AUTO-CALCULATED)
    materialCost: {
      type: Number,
      default: 0,
    },

    // 🧾 COST BREAKUP DETAILS
    details: {
      type: [CostingDetailSchema],
      default: [],
    },

    // 📊 TOTAL COST PER UNIT
    totalCost: {
      type: Number,
      default: 0,
    },

    // 🔄 STATUS
    status: {
      type: String,
      enum: ["Draft", "Final"],
      default: "Draft",
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Costing", CostingSchema);
