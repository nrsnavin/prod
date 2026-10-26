const mongoose = require("mongoose");

// Skill knowledge levels from the "Elastic Manufacturing Employee Skill &
// Performance Questionnaire" filled when onboarding an operator.
const SKILL_LEVELS = ["not_known", "basic", "good", "expert"];
const skillLevel = { type: String, enum: SKILL_LEVELS, default: "not_known" };
const rating5 = { type: Number, min: 1, max: 5, default: null };

/** Why someone left. "absconded": stopped coming without notice. */
const OFFBOARD_REASONS = ["resigned", "terminated", "absconded", "retired", "contract_ended", "other"];

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
    // A national identity number: never returned unless a query asks for
    // it by name ("+aadhar"), sealed when AADHAAR_KEY is set, and masked
    // for everyone but an admin who asks. See utils/aadhaar.js.
    aadhar: {
      type: String,
      select: false,
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

    // ── OFFBOARDING ────────────────────────────────────────
    // Someone who has left is never deleted: their shifts, attendance,
    // pay and bonus stay theirs. They are marked, and from the day after
    // their last working day they are left out of the pickers and the
    // rosters (utils/employeeStatus.js), cannot be put on a shift, and
    // cannot sign in. Reinstating them (a rehire) moves the record of
    // leaving into pastOffboardings.
    // Documents written before this field existed have no status and
    // count as active.
    status: {
      type: String,
      enum: ["active", "offboarded"],
      default: "active",
      index: true,
    },
    offboarding: {
      lastWorkingDay: { type: Date },
      reason: { type: String, enum: OFFBOARD_REASONS },
      note: { type: String, default: "" },
      recordedBy: { type: mongoose.Types.ObjectId, ref: "User" },
      recordedByName: { type: String, default: "" },
      recordedAt: { type: Date },
    },
    pastOffboardings: [
      {
        _id: false,
        lastWorkingDay: Date,
        reason: String,
        note: String,
        recordedByName: String,
        recordedAt: Date,
        reinstatedAt: Date,
        reinstatedByName: String,
      },
    ],

    // NO LONGER WRITTEN. Kept so existing documents still load.
    //
    // A copy of "which shifts did this person work", one ref per shift,
    // forever — ~730 a year per operator. Nothing reads it any more: the
    // employee page reads ShiftDetail by its `employee` ref (indexed),
    // as the job and machine pages already did. It was also WRONG for
    // older data: the plan route once pushed a whole plan's shifts onto
    // every operator in it. Existing arrays can be dropped with
    // `$unset: { shifts: 1 }` once nobody needs to look at them.
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
module.exports.OFFBOARD_REASONS = OFFBOARD_REASONS;