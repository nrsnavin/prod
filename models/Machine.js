const mongoose = require("mongoose");


const MachineSchema = new mongoose.Schema(
  {
    ID: {
      type: String,
      required: true,
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
    elastics: {
      type: String,
    },

    status: {
      type: String,
      required: true,
      default: "free"
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