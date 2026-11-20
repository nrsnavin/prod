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

    // Who checked and who packed. The route asks for both; neither has
    // a default — one employee's id used to be written in here, so a
    // packing saved any other way was filed under that one person.
    checkedBy: {
      type: mongoose.Types.ObjectId,
      ref: "Employee",
    },

    packedBy: {
      type: mongoose.Types.ObjectId,
      ref: "Employee",
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Packing", PackingSchema);
