const mongoose = require("mongoose");

/**
 * 🔹 Reusable Elastic Quantity Sub-Schema
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
 * 🧶 WARPING SCHEMA
 */
const WarpingSchema = new mongoose.Schema(
  {
    // 📅 WARPING DATE
    date: {
      type: Date,
      required: true,
      default: Date.now,
    },

    // 🧵 ELASTICS PLANNED FOR WARPING
    elasticOrdered: {
      type: [ElasticQtySchema],
      default: [],
    },

    // 🔗 LINK TO JOB ORDER
    job: {
      type: mongoose.Types.ObjectId,
      ref: "JobOrder",
      required: true,
      index: true,
    },

    // 📄 WARPING PLAN (NEW)
    warpingPlan: {
      type: mongoose.Types.ObjectId,
      ref: "WarpingPlan",
      default: null,
    },

    // 🔄 STATUS FLOW
    status: {
      type: String,
      enum: ["open", "in_progress", "completed", "cancelled"],
      default: "open",
    },

    // ✅ COMPLETION DATE
    completedDate: {
      type: Date,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Warping", WarpingSchema);