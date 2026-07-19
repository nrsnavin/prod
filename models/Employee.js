const mongoose = require("mongoose");

// Skill knowledge levels from the "Elastic Manufacturing Employee Skill &
// Performance Questionnaire" filled when onboarding an operator.
const SKILL_LEVELS = ["not_known", "basic", "good", "expert"];
const skillLevel = { type: String, enum: SKILL_LEVELS, default: "not_known" };
const rating5 = { type: Number, min: 1, max: 5, default: null };

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

    // ── SKILL PROFILE ──────────────────────────────────────
    // Answers from the onboarding skill & performance questionnaire.
    // Editable later from the employee detail page.
    skillProfile: {
      machineType:       { type: String, default: "" },
      yearsOfExperience: { type: Number, min: 0, default: 0 },
      knotting: {
        time100YarnsMin: { type: Number, min: 0, default: null }, // minutes to knot 100 yarns
        quality:         { type: String, enum: ["", "poor", "average", "good", "excellent"], default: "" },
        maxYarnsAtOnce:  { type: Number, min: 0, default: null },
      },
      production: {
        minPerShift:          { type: Number, min: 0, default: null }, // meters/kg assured per shift
        avgEfficiencyPct:     { type: Number, min: 0, max: 100, default: null },
        machinesSimultaneous: { type: Number, min: 0, default: null },
      },
      skills: {
        drawing:              skillLevel,
        knotting:             skillLevel,
        tapeSetting:          skillLevel,
        chainLinkSetting:     skillLevel,
        chainDesign:          skillLevel,
        jacquardHookModule:   skillLevel, // Module-type jacquard hook problem
        jacquardHookKarampal: skillLevel, // Karampal-type jacquard hook problem
        timingBeltChange:     skillLevel,
        timingSetting:        skillLevel,
        machineRepair:        skillLevel,
      },
      supervisor: {
        skillLevel:        rating5,
        machineEfficiency: rating5,
        problemSolving:    rating5,
        discipline:        rating5,
      },
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