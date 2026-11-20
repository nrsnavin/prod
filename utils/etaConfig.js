'use strict';
/**
 * ETA configuration — the few constants the order-completion
 * predictor needs that aren't in any model. Tweak here, not in the
 * algorithm.
 */

const factoryDay = require('./factoryDay');

const DAY_MS = 86_400_000;
const SHIFTS_PER_DAY = 2;                 // DAY + NIGHT (both 12h per the user)
const WEEKLY_OFF     = [0];               // Sunday = 0, as Date.getUTCDay() numbers the week
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
//
// On the calendar in India, a day at a time. These took whatever Date
// they were handed and stepped it with the server's own clock, time of
// day and all. Two things followed. An estimate came out as "24 November,
// 14:10" and was compared with a promise of "24 November" (midnight): an
// order expected on the day it was promised was fourteen hours late, and
// shown as late by a working day. And between midnight and 05:30 in
// India the server is still on yesterday, so the first hours of a Sunday
// were a working Saturday, and of a Monday a Sunday off.
//
// A day here is the calendar day in India, kept at UTC midnight like
// every other calendar date (utils/factoryDay.js).
const dayOf = (d) => factoryDay.calendarDay(d);
/** No week is all rest days; a setting that says so must not hang the server. */
const MAX_SPAN_DAYS = 3660;

function isWorkingDay(d, weeklyOff = WEEKLY_OFF, holidays = HOLIDAYS) {
  const day = dayOf(d);
  if (!day) return false;
  if (weeklyOff.includes(day.getUTCDay())) return false;
  return !holidays.includes(day.toISOString().slice(0, 10));
}

/**
 * The day `workingDays` working days after the day `from` falls on
 * (skipping the weekly off and holidays). A fresh Date — `from` is not
 * changed — at that day's UTC midnight.
 */
function addWorkingDays(from, workingDays, weeklyOff = WEEKLY_OFF, holidays = HOLIDAYS) {
  let d = dayOf(from);
  if (!d) return new Date(NaN);
  let remaining = Math.ceil(workingDays);
  for (let i = 0; remaining > 0 && i < MAX_SPAN_DAYS; i++) {
    d = new Date(d.getTime() + DAY_MS);
    if (isWorkingDay(d, weeklyOff, holidays)) remaining -= 1;
  }
  return d;
}

/**
 * The working days after the day `from` falls on, up to and including
 * the day `to` falls on: none when they are the same day, or `to` is
 * the earlier.
 */
function workingDaysBetween(from, to, weeklyOff = WEEKLY_OFF, holidays = HOLIDAYS) {
  const a = from ? dayOf(from) : null;
  const b = to ? dayOf(to) : null;
  if (!a || !b || b <= a) return 0;
  let n = 0;
  for (let d = new Date(a.getTime() + DAY_MS), i = 0; d <= b && i < MAX_SPAN_DAYS; d = new Date(d.getTime() + DAY_MS), i++) {
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
