const mongoose = require("mongoose");

const ServiceLogSchema = new mongoose.Schema(
  {
    date: {
      type: Date,
      required: true,
      default: Date.now,
    },
    type: {
      type: String,
      enum: ["Preventive", "Corrective", "Breakdown", "Inspection", "Other"],
      required: true,
    },
    description: {
      type: String,
      required: true,
    },
    technician: {
      type: String,
      default: "",
    },
    cost: {
      type: Number,
      default: 0,
    },
    nextServiceDate: {
      type: Date,
      default: null,
    },
    resolved: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

const MachineSchema = new mongoose.Schema(
  {
    ID: {
      type: String,
      required: true,
      unique: true,
    },
    manufacturer: {
      type: String,
      required: true,
    },
    DateOfPurchase: {
      type: String,
    },
    NoOfHead: {
      type: Number,
      required: true,
    },
    NoOfHooks: {
      type: Number,
      required: true,
    },
    elastics: [{
      elastic: {
        type: mongoose.Types.ObjectId,
        ref: "Elastic",
        default: null,
      },
      head: {
        type: Number,
      },
    }],
    orderRunning: {
      type: mongoose.Types.ObjectId,
      ref: "JobOrder",
      default: null,
    },
    status: {
      type: String,
      enum: ["free", "running", "maintenance"],
      default: "free",
    },
    shifts: [
      {
        type: mongoose.Types.ObjectId,
        ref: "ShiftDetail",
        required: true,
        default: [],
      },
    ],
    serviceLogs: {
      type: [ServiceLogSchema],
      default: [],
    },
  },
  { timestamps: true }
);

const Machine = mongoose.model("Machine", MachineSchema);

module.exports = Machine;