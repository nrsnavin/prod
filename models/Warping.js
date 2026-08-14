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

    // 🔒 HOW MANY BATCHES HAVE BEEN RAISED AGAINST THIS WARPING
    //
    // Kept for its own sake, but it also does a job: raising a batch
    // increments it inside the same transaction as the beam-clash check,
    // which gives two simultaneous batch creations a single document to
    // collide on. Without that they are write-skew — each reads the
    // other's beams as free, neither writes to anything the other
    // touched, and both land. Two batches on one beam means the yarn is
    // issued twice for it and the trail shows two lots inside a single
    // beam, which is the exact thing lot tracking exists to rule out.
    batchSeq: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Warping", WarpingSchema);