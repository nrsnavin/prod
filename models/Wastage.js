const mongoose = require("mongoose");

const WastageSchema = new mongoose.Schema(
  {
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
