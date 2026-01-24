const mongoose = require("mongoose");

const EmployeeSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      min: 2,
      max: 100,
    },
    phoneNumber: {
      type: String,
    },
    skill: {
      type: Number,
      required: true,
      default: 0,
    },
    role: {
      type: String,
    },
    department: {
      type: String,
      required: true,
      default: "weaving"
    },
    performance: {
      type: Number,
      default: 0
    }

    ,
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

const Employee = mongoose.model("Employee", EmployeeSchema);

module.exports = Employee;