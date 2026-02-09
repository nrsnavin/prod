const mongoose = require("mongoose");

/**
 * 🔹 Elastic Quantity Sub-Schema
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
      default: 0,
      required: true,
    },
  },
  { _id: false }
);

/**
 * 🧵 COVERING SCHEMA
 */
const CoveringSchema = new mongoose.Schema(
  {
    // 📅 COVERING DATE
    date: {
      type: Date,
      required: true,
      default: Date.now,
    },

    // 🔗 LINK TO JOB ORDER
    job: {
      type: mongoose.Types.ObjectId,
      ref: "JobOrder",
      required: true,
      index: true,
    },

    // 🏭 MACHINE USED

    // 🧵 ELASTICS PLANNED FOR COVERING
    elasticPlanned: {
      type: [ElasticQtySchema],
      default: [],
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

    // 📝 REMARKS
    remarks: {
      type: String,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Covering", CoveringSchema);
