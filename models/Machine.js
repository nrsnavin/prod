const mongoose = require("mongoose");


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
        type: Number
      }

    }]
    ,
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

  },
  { timestamps: true }
);

const Machine = mongoose.model("Machine", MachineSchema);


module.exports = Machine;