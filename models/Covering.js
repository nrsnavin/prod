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
 * 🔹 Beam Entry Sub-Schema
 *    Records each individual beam produced during covering.
 *    weight is in kg. note is optional.
 */
const BeamEntrySchema = new mongoose.Schema(
  {
    beamNo: {
      type: Number,
      required: true,
    },
    weight: {
      type: Number,
      required: true,
      min: 0,
    },
    note: {
      type: String,
      default: "",
    },
    enteredAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: false }
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

    // 🧵 ELASTICS PLANNED FOR COVERING
    elasticPlanned: {
      type: [ElasticQtySchema],
      default: [],
    },

    // 🏗 BEAM ENTRIES (weight log per beam)
    beamEntries: {
      type: [BeamEntrySchema],
      default: [],
    },

    // ⚖️ TOTAL PRODUCED WEIGHT (kg) — auto-summed from beamEntries
    producedWeight: {
      type: Number,
      default: 0,
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