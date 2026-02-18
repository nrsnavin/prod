// models/ShiftDetail.js
const mongoose = require("mongoose");

const HeadElasticSchema = new mongoose.Schema(
  {
    head: { type: Number, required: true },
    elastic: {
      type: mongoose.Types.ObjectId,
      ref: "Elastic",
      required: true,
    },
  },
  { _id: false }
);

const ShiftDetailSchema = new mongoose.Schema(
  {
    // 📅 BASIC INFO
    date: {
      type: Date,
      required: true,
    },

    shift: {
      type: String,
      enum: ["DAY", "NIGHT"],
      required: true,
    },

    description: {
      type: String,
      default: "",
    },

    feedback: {
      type: String,
      default: "",
    },

    // 🔄 STATUS
    status: {
      type: String,
      enum: ["open", "running", "closed"],
      default: "open",
    },


    job: {
      type: mongoose.Types.ObjectId,
      ref: "JobOrder",
      required: true,
    },

    // ⏱ TIMER (HH:mm:ss)
    timer: {
      type: String,
      required: true,
      default: "00:00:00",
    },

    // 📏 TOTAL PRODUCTION (METERS)
    productionMeters: {
      type: Number,
      default: 0,
    },

    // 🧵 HEAD → ELASTIC MAP (IMPORTANT)
    elastics: {
      type: [HeadElasticSchema],
      required: true,
      default: [],
    },

    // 👷 OPERATOR
    employee: {
      type: mongoose.Types.ObjectId,
      ref: "Employee",
      required: true,
    },

    // 🔗 PARENT SHIFT PLAN
    shiftPlan: {
      type: mongoose.Types.ObjectId,
      ref: "ShiftPlan",
      required: true,
      index: true,
    },

    // 🏭 MACHINE
    machine: {
      type: mongoose.Types.ObjectId,
      ref: "Machine",
      required: true,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("ShiftDetail", ShiftDetailSchema);
