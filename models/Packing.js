const mongoose = require("mongoose");

const PackingSchema = new mongoose.Schema(
  {
    // 📅 PACKING DATE
    date: {
      type: Date,
      required: true,
      default: Date.now,
    },

    // 🧵 ELASTIC PACKED
    elastic: {
      type: mongoose.Types.ObjectId,
      ref: "Elastic",
      required: true,
      index: true,
    },

    // 📦 QUANTITY (METERS / PCS – DEFINE IN UI)
    quantity: {
      type: Number,
      required: true,
    },

    // ⚖️ TOTAL WEIGHT (KG / GRAMS – DEFINE UNIT)
    weight: {
      type: Number,
    },

    // 🔗 QUALITY / JOINT INFO
    noOfJoints: {
      type: Number,
      default: 0,
    },

    // 👷 PACKED BY
    packedBy: {
      type: mongoose.Types.ObjectId,
      ref: "Employee",
      required: true,
    },

    // ✅ QC CHECKED BY
    checkedBy: {
      type: mongoose.Types.ObjectId,
      ref: "Employee",
    },

    // 🏭 JOB LINK (VERY IMPORTANT)
    job: {
      type: mongoose.Types.ObjectId,
      ref: "JobOrder",
      required: true,
      index: true,
    },

    // 🔄 STATUS (OPTIONAL BUT RECOMMENDED)
    status: {
      type: String,
      enum: ["Packed", "Rejected", "Reworked"],
      default: "Packed",
    },

    // 📝 REMARKS
    remarks: {
      type: String,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Packing", PackingSchema);
