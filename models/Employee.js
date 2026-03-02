// ══════════════════════════════════════════════════════════════
//  EMPLOYEE MODEL  v2
//  File: models/Employee.js  (replaces existing)
//
//  Change from v1:  +hourlyRate field
//  Payroll reads Employee.hourlyRate directly — no separate
//  PayrollConfig document needed per employee.
// ══════════════════════════════════════════════════════════════
'use strict';

const mongoose = require('mongoose');

const EmployeeSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      min: 2,
      max: 100,
    },

    phoneNumber: { type: String },
    aadhar:      { type: String },

    skill: {
      type: Number,
      required: true,
      default: 0,
    },

    role:       { type: String },
    department: { type: String, required: true, default: 'weaving' },
    performance:{ type: Number, default: 0 },

    // ── SALARY ───────────────────────────────────────────────
    // Rate in ₹ per hour.
    // DAY shift  = hourlyRate × 12 h
    // NIGHT shift = hourlyRate × 8 h
    // Set once per employee; payroll engine reads this at
    // generation time and snapshots it into the Payroll doc.
    hourlyRate: {
      type:    Number,
      default: 0,
      min:     0,
    },

    shifts: [
      {
        type:    mongoose.Types.ObjectId,
        ref:     'ShiftDetail',
        default: [],
      },
    ],
  },
  { timestamps: true }
);

module.exports = mongoose.model('Employee', EmployeeSchema);