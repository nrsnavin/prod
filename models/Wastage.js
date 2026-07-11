const mongoose = require("mongoose");

const WastageSchema = new mongoose.Schema(
  {
    // Client-generated idempotency key — a retried submit must not
    // record the wastage (and its penalty) twice. sparse for legacy.
    requestId: {
      type: String,
      unique: true,
      sparse: true,
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

    employee: {
      type: mongoose.Types.ObjectId,
      ref: "Employee",
      required: true,
    },

    quantity: {
      type: Number,
      required: true,
    },

    penalty: {
      type: Number,
      default: 0,
    },

    reason: {
      type: String,
      required: true,
    },

  },
  { timestamps: true }
);

module.exports = mongoose.model("Wastage", WastageSchema);
