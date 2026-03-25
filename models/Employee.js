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
    aadhar: {
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
      default: "weaving",
    },
    performance: {
      type: Number,
      default: 0,
    },
    hourlyRate: {
      type: Number,
      default: 0,
    },

    // ── BONUS ──────────────────────────────────────────────
    // Configurable per employee; defaults to factory-wide 10%.
    // Admin can set a higher % for senior/skilled employees.
    bonusPercent: {
      type: Number,
      default: 10,
      min: 0,
      max: 100,
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

const Employee = mongoose.model("Employee", EmployeeSchema);

module.exports = Employee;