const mongoose = require("mongoose");

const PackingSchema = new mongoose.Schema(
  {
    // Client-generated idempotency key. Factory networks retry: without
    // this, a resubmitted create lands a second box and double-counts
    // stock. sparse — legacy records and callers that don't send one.
    requestId: {
      type: String,
      unique: true,
      sparse: true,
    },

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
      default: "697755809a83e2490a7f3855",
    },

    packedBy: {
      type: mongoose.Types.ObjectId,
      ref: "Employee",
      default: "697755809a83e2490a7f3855",
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Packing", PackingSchema);
