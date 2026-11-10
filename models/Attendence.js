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
const { shiftHours } = require('../utils/shiftHours');

// The values a mark may carry. The routes check against these too: a
// bulk write does not run the schema's validators, so a status outside
// this list used to be stored as sent and paid as a full shift.
const STATUSES    = Object.freeze(['present', 'late', 'half_day', 'absent', 'on_leave']);
const LEAVE_TYPES = Object.freeze(['casual', 'sick', 'emergency', 'personal', 'unpaid', '']);

/**
 * Minutes between manual "HH:mm" in and out times. A night shift runs
 * past midnight, so an out time at or before the in time is the next
 * day. null when either is missing or unreadable.
 */
function minutesBetween(checkIn, checkOut) {
  if (!checkIn || !checkOut) return null;
  const toMin = (t) => {
    const [h, m] = String(t).split(':').map(Number);
    return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : NaN;
  };
  const inM = toMin(checkIn);
  let outM = toMin(checkOut);
  if (!Number.isFinite(inM) || !Number.isFinite(outM)) return null;
  if (outM <= inM) outM += 24 * 60;
  return outM - inM;
}

/**
 * The scheduled and the worked hours of a mark — the one definition.
 * The save hook below and the attendance routes each kept their own
 * copy, and the routes' copy never looked at the timer.
 *
 * A recorded worked duration (the live timer, or manual in/out times)
 * wins for a worked shift: hours follow the time actually worked, up to
 * the length of the shift.
 */
function hoursFor(mark) {
  const base = shiftHours(mark.shift);
  let worked = Number(mark.workedMinutes) || 0;
  if (worked <= 0 && mark.clockInAt && mark.clockOutAt) {
    worked = Math.max(0, (new Date(mark.clockOutAt) - new Date(mark.clockInAt)) / 60000);
  }
  if (worked > 0 && (mark.status === 'present' || mark.status === 'late')) {
    return { shiftHours: base, hoursWorked: Math.min(worked, base * 60) / 60 };
  }
  let hoursWorked;
  switch (mark.status) {
    case 'present':  hoursWorked = base; break;
    case 'late':     hoursWorked = Math.max(0, base - (Number(mark.lateMinutes) || 0) / 60); break;
    case 'half_day': hoursWorked = base / 2; break;
    case 'absent':
    case 'on_leave': hoursWorked = 0; break;
    default:         hoursWorked = base;
  }
  return { shiftHours: base, hoursWorked };
}

const AttendanceSchema = new mongoose.Schema({
  employee:  { type: mongoose.Types.ObjectId, ref: 'Employee', required: true, index: true },
  date:      { type: Date, required: true, index: true },
  shift:     { type: String, enum: ['DAY', 'NIGHT'], required: true },

  // Status
  status: {
    type: String,
    enum: STATUSES,
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
  // Minutes from stints already clocked out of, before the running one.
  // Clocking out and back in (a break, an errand) starts a new stint at
  // clockInAt; this keeps the time before it, so the shift's total is
  // priorMinutes + (clockOutAt − clockInAt) and nothing earlier is lost.
  priorMinutes: { type: Number, default: 0, min: 0 },
  lateMinutes: { type: Number, default: 0, min: 0 },
  // Minutes worked BEYOND the shift's scheduled hours. Payroll pays these
  // (past an optional grace window) at PayrollSettings.overtimeMultiplier.
  overtimeMinutes: { type: Number, default: 0, min: 0 },

  // Shift hours (auto-computed on save: DAY=12, NIGHT=12, half=6, absent=0)
  shiftHours:  { type: Number, default: 0 },
  hoursWorked: { type: Number, default: 0 },   // actual hours after late deduction

  // Leave linkage
  leaveType:       { type: String, enum: LEAVE_TYPES, default: '' },
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
  const { shiftHours: scheduled, hoursWorked } = hoursFor(this);
  this.shiftHours  = scheduled;
  this.hoursWorked = hoursWorked;
  next();
});

AttendanceSchema.statics.hoursFor       = hoursFor;
AttendanceSchema.statics.minutesBetween = minutesBetween;
AttendanceSchema.statics.STATUSES       = STATUSES;
AttendanceSchema.statics.LEAVE_TYPES    = LEAVE_TYPES;

module.exports = mongoose.model('Attendance', AttendanceSchema);