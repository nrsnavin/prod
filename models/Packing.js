const mongoose = require("mongoose");

const PackingSchema = new mongoose.Schema(
  {
    date: {
      type: Date,
      default: Date.now,
    },

    job: {
      type: mongoose.Types.ObjectId,
      ref: "JobOrder",
      required: true,
    },

    elastic: {
      type: mongoose.Types.ObjectId,
      ref: "Elastic",
      required: true,
    },

    meter: {
      type: Number,
      required: true,
    },

    joints: {
      type: Number,
      default: 0,
    },

    tareWeight: {
      type: Number,
      required: true,
    },

    netWeight: {
      type: Number,
      required: true,
    },

    grossWeight: {
      type: Number,
      required: true,
    },

    stretch: {
      type: String,
    },

    size: {
      type: String,
    },

    checkedBy: {
      type: mongoose.Types.ObjectId,
      ref: "Employee",
      required: true,
    },

    packedBy: {
      type: mongoose.Types.ObjectId,
      ref: "Employee",
      required: true,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Packing", PackingSchema);
