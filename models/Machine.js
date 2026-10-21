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
    // A job just put on the loom is being LOADED (beam up, heads drawn
    // in) before it weaves. The machine is the job's ("running"), but
    // nothing is produced: its shifts are marked loading and left out of
    // production and efficiency until someone marks it running
    // (services/machineLoading.js). Meaningful only while running.
    loading: {
      type: Boolean,
      default: false,
    },
    loadingSince: {
      type: Date,
      default: null,
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