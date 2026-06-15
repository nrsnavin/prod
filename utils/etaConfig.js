'use strict';
/**
 * ETA configuration — the few constants the order-completion
 * predictor needs that aren't in any model. Tweak here, not in the
 * algorithm.
 */

const SHIFTS_PER_DAY = 2;                 // DAY + NIGHT (both 12h per the user)
const WEEKLY_OFF     = [0];               // Sunday = 0 in JS Date.getDay()
const HOLIDAYS       = [];                // YYYY-MM-DD strings — empty for v1, wired for later

// Fixed lead-time buffers (working days) for the non-weaving stages.
// Weaving is the rate-driven bottleneck; warping/finishing/checking/packing
// add roughly fixed time per the domain note in the plan. Conservative
// defaults — easy to revisit once we have measured stage durations from
// JobOrder timestamps (Phase B tier 2).
const STAGE_BUFFER_DAYS = { prep: 2, finish: 2 };

// Cold-start fallback: meters per head per active day, used only when an
// elastic/machine pair has essentially no closed-shift history. Multiplied
// by machine.NoOfHead and the standard ~0.85 narrow-fabric loom efficiency.
// Calibrate this once with the first real export of /production/analytics.
const COLDSTART_METERS_PER_HEAD_DAY = 150;
const LOOM_EFFICIENCY               = 0.85;

// Bounds on the forward adjustment factors so they nudge — never
// dominate — the empirical rate.
const ATTENDANCE_MOMENTUM_MIN = 0.8;
const ATTENDANCE_MOMENTUM_MAX = 1.1;
const MACHINE_HEALTH_MIN      = 0.8;
const MACHINE_HEALTH_MAX      = 1.0;

// Trailing window the rate engine reads from. 30 working days is long
// enough to smooth daily variance, short enough to track real plant
// drift.
const RATE_LOOKBACK_DAYS = 30;

// What-if curve: ETA assuming M machines dedicated, for M = 1..MAX.
const WHATIF_MAX_MACHINES = 6;

// ── working-day arithmetic ────────────────────────────────────────
function isWorkingDay(d, weeklyOff = WEEKLY_OFF, holidays = HOLIDAYS) {
  if (weeklyOff.includes(d.getDay())) return false;
  const iso = d.toISOString().slice(0, 10);
  if (holidays.includes(iso)) return false;
  return true;
}

/**
 * Advance `from` by `workingDays` working days (skipping weekly off +
 * holidays). Returns a fresh Date — does not mutate `from`.
 */
function addWorkingDays(from, workingDays, weeklyOff = WEEKLY_OFF, holidays = HOLIDAYS) {
  const d = new Date(from);
  let remaining = Math.ceil(workingDays);
  while (remaining > 0) {
    d.setDate(d.getDate() + 1);
    if (isWorkingDay(d, weeklyOff, holidays)) remaining -= 1;
  }
  return d;
}

/**
 * Count working days strictly between two dates (excludes `from`,
 * includes any working `to`). Used for back-tests.
 */
function workingDaysBetween(from, to, weeklyOff = WEEKLY_OFF, holidays = HOLIDAYS) {
  if (!from || !to || to <= from) return 0;
  const d = new Date(from);
  let n = 0;
  while (d < to) {
    d.setDate(d.getDate() + 1);
    if (isWorkingDay(d, weeklyOff, holidays)) n += 1;
  }
  return n;
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

module.exports = {
  SHIFTS_PER_DAY,
  WEEKLY_OFF,
  HOLIDAYS,
  STAGE_BUFFER_DAYS,
  COLDSTART_METERS_PER_HEAD_DAY,
  LOOM_EFFICIENCY,
  ATTENDANCE_MOMENTUM_MIN,
  ATTENDANCE_MOMENTUM_MAX,
  MACHINE_HEALTH_MIN,
  MACHINE_HEALTH_MAX,
  RATE_LOOKBACK_DAYS,
  WHATIF_MAX_MACHINES,
  isWorkingDay,
  addWorkingDays,
  workingDaysBetween,
  clamp,
};
