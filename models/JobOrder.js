const mongoose = require("mongoose");
const AutoIncrement = require("mongoose-sequence")(mongoose);

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
      default: 0,
    },
  },
  { _id: false }
);

/**
 * 🧾 JOB ORDER SCHEMA
 */
const JobOrderSchema = new mongoose.Schema(
  {
    // 📅 BASIC INFO
    date: {
      type: Date,
      required: true,
    },

    // 🔗 LINK TO MAIN ORDER (IMPORTANT)
    order: {
      type: mongoose.Types.ObjectId,
      ref: "Order",
      required: true,
      index: true,
    },

    customer: {
      type: mongoose.Types.ObjectId,
      ref: "Customer",
      required: true,
    },

    // 🔢 AUTO INCREMENT
    jobOrderNo: {
      type: Number,
      immutable: true,
    },

    // 🏗 JOB STATUS (FLOW-BASED)
    status: {
      type: String,
      enum: [
        "preparatory",
        "weaving",
        "finishing",
        "checking",
        "packing",
        "completed",
        "cancelled",
      ],
      default: "preparatory",
    },

    // 🧵 PLANNED ELASTICS
    elastics: {
      type: [ElasticQtySchema],
      default: [],
    },

    // 🧵 PRODUCED ELASTICS
    producedElastic: {
      type: [ElasticQtySchema],
      default: [],
    },

    // 📦 PACKED ELASTICS
    packedElastic: {
      type: [ElasticQtySchema],
      default: [],
    },

    // ♻️ WASTAGE
    wastageElastic: {
      type: [ElasticQtySchema],
      default: [],
    },

    // 🏭 PROCESS REFERENCES
    warping: {
      type: mongoose.Types.ObjectId,
      ref: "Warping",
    },

    covering: {
      type: mongoose.Types.ObjectId,
      ref: "Covering",
    },

    machine: {
      type: mongoose.Types.ObjectId,
      ref: "Machine",
    },

    // ⏱ SHIFT-LEVEL TRACEABILITY
    shiftDetails: [
      {
        type: mongoose.Types.ObjectId,
        ref: "ShiftDetail",
      },
    ],

    // ♻️ WASTAGE LOG
    wastages: [
      {
        type: mongoose.Types.ObjectId,
        ref: "Wastage",
      },
    ],

    // 📦 PACKING DETAILS
    packingDetails: [
      {
        type: mongoose.Types.ObjectId,
        ref: "Packing",
      },
    ],
  },
  { timestamps: true }
);

/**
 * 🔢 AUTO-INCREMENT JOB ORDER NO
 */
JobOrderSchema.plugin(AutoIncrement, {
  inc_field: "jobOrderNo",
});

module.exports = mongoose.model("JobOrder", JobOrderSchema);
