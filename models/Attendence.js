// ══════════════════════════════════════════════════════════════
//  ATTENDANCE MODEL  v2
//  File: models/Attendance.js  (replace existing)
//
//  Changes from v1:
//    + leaveRequestId  → links to approved LeaveRequest
//    + isApprovedLeave → true when leave was pre-approved
//    + hoursWorked     → actual hours (12 DAY / 8 NIGHT / 0 absent)
//    + penaltyAmount   → computed by payroll engine
//    + rewardAmount    → computed by payroll engine
//    + payrollId       → set when included in a payroll run
// ══════════════════════════════════════════════════════════════
'use strict';
const mongoose = require('mongoose');

const AttendanceSchema = new mongoose.Schema({
  employee:  { type: mongoose.Types.ObjectId, ref: 'Employee', required: true, index: true },
  date:      { type: Date, required: true, index: true },
  shift:     { type: String, enum: ['DAY', 'NIGHT'], required: true },

  // Status
  status: {
    type: String,
    enum: ['present', 'late', 'half_day', 'absent', 'on_leave'],
    required: true,
    default: 'present',
  },

  // Time tracking
  checkIn:     { type: String, default: '' },   // "HH:mm" — manual entry
  checkOut:    { type: String, default: '' },   // "HH:mm" — manual entry
  // Live shift timer — server-stamped when the operator clocks in / out.
  // These are the authoritative source for actual-hours pay when present.
  clockInAt:   { type: Date, default: null },
  clockOutAt:  { type: Date, default: null },
  // Actual minutes worked this shift, derived from the timer or manual
  // in/out. Payroll pays these (capped at the 12h shift); minutes beyond
  // the shift become overtime.
  workedMinutes: { type: Number, default: 0, min: 0 },
  lateMinutes: { type: Number, default: 0 },
  // Minutes worked BEYOND the shift's scheduled hours. Payroll pays these
  // (past an optional grace window) at PayrollSettings.overtimeMultiplier.
  overtimeMinutes: { type: Number, default: 0, min: 0 },

  // Shift hours (auto-computed on save: DAY=12, NIGHT=12, half=6, absent=0)
  shiftHours:  { type: Number, default: 0 },
  hoursWorked: { type: Number, default: 0 },   // actual hours after late deduction

  // Leave linkage
  leaveType:       { type: String, enum: ['casual','sick','emergency','personal','unpaid',''], default: '' },
  leaveRequestId:  { type: mongoose.Types.ObjectId, ref: 'LeaveRequest', default: null },
  isApprovedLeave: { type: Boolean, default: false },

  // Payroll
  penaltyAmount:   { type: Number, default: 0 },
  rewardAmount:    { type: Number, default: 0 },
  payrollId:       { type: mongoose.Types.ObjectId, ref: 'Payroll', default: null },

  notes:    { type: String, default: '' },
  markedBy: { type: String, default: 'admin' },
}, { timestamps: true });

AttendanceSchema.index({ employee: 1, date: 1, shift: 1 }, { unique: true });

// Auto-compute shiftHours and hoursWorked before save
AttendanceSchema.pre('save', function(next) {
  const baseHours = 12; // DAY and NIGHT are both 12-hour shifts
  this.shiftHours = baseHours;

  // A real worked duration (live timer or manual in/out) wins for a
  // worked shift — pay follows actual hours, capped at the shift length.
  let workedMin = this.workedMinutes;
  if ((!workedMin || workedMin <= 0) && this.clockInAt && this.clockOutAt) {
    workedMin = Math.max(0, (this.clockOutAt - this.clockInAt) / 60000);
  }
  if (workedMin > 0 && (this.status === 'present' || this.status === 'late')) {
    this.hoursWorked = Math.min(workedMin, baseHours * 60) / 60;
    return next();
  }

  switch (this.status) {
    case 'present':   this.hoursWorked = baseHours; break;
    case 'late':      this.hoursWorked = Math.max(0, baseHours - this.lateMinutes / 60); break;
    case 'half_day':  this.hoursWorked = baseHours / 2; break;
    case 'absent':    this.hoursWorked = 0; break;
    case 'on_leave':  this.hoursWorked = 0; break;
    default:          this.hoursWorked = baseHours;
  }
  next();
});

module.exports = mongoose.model('Attendance', AttendanceSchema);