'use strict';
// ══════════════════════════════════════════════════════════════
//  SCHEDULED SHIFT LENGTH — one definition
//
//  Payroll pays a worked shift against this, and the order P&L
//  charges a job's labour against it. They were about to hold the
//  number separately, which is the shape of drift that makes a job
//  cost more (or less) than the wage it was paid from.
//
//  Both shifts are 12 hours. The `NIGHT = 8` in the comment block on
//  EmployeePayConfig is stale — nothing reads it, and payroll has
//  always used 12.
// ══════════════════════════════════════════════════════════════

const SHIFT_HOURS = Object.freeze({ DAY: 12, NIGHT: 12 });

/** Scheduled hours for a shift name; unknown names fall back to 12. */
const shiftHours = (s) => SHIFT_HOURS[s] ?? 12;

module.exports = { SHIFT_HOURS, shiftHours };
