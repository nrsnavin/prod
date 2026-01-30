const mongoose = require("mongoose");

const WastageSchema = new mongoose.Schema(
  {
    // 🧵 ELASTIC
    elastic: {
      type: mongoose.Types.ObjectId,
      ref: "Elastic",
      required: true,
      index: true,
    },

    // 🔗 JOB ORDER
    job: {
      type: mongoose.Types.ObjectId,
      ref: "JobOrder",
      required: true,
      index: true,
    },

    // 👷 RESPONSIBLE EMPLOYEE
    employee: {
      type: mongoose.Types.ObjectId,
      ref: "Employee",
      required: true,
    },

    // 📉 WASTED QUANTITY (meters / kg – define unit in UI)
    quantity: {
      type: Number,
      required: true,
      min: 0,
    },

    // ❗ WASTAGE REASON
    reason: {
      type: String,
      required: true,
      trim: true,
    },

    // 🔄 STATUS FLOW
    status: {
      type: String,
      enum: ["open", "approved", "rejected"],
      default: "open",
      required: true,
    },

    // 🧑‍🏭 APPROVED BY (SUPERVISOR / ADMIN)
    approvedBy: {
      type: mongoose.Types.ObjectId,
      ref: "Employee",
    },

    // 📝 REMARKS
    remarks: {
      type: String,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Wastage", WastageSchema);
