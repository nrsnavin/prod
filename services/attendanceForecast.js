'use strict';
// ══════════════════════════════════════════════════════════════════
//  HOW MANY PEOPLE WILL ACTUALLY BE HERE
//
//  The planner now respects what each loom is already busy with.
//  Staffing is the other constraint and it ignores it entirely — a
//  machine with nobody on it produces exactly as much as a machine with
//  a broken head.
//
//  The attendance register has been recording who turned up, on which
//  weekday, on which shift, for as long as it has existed. That is a
//  base rate, and a base rate is all this is: a table, not a model.
//
//  ── THE LINE THIS SERVICE DOES NOT CROSS ─────────────────────────
//  This is used to STAFF A PLAN. It is never used to rank, score,
//  discipline or compare people, and the API deliberately makes that
//  awkward: the plant-level forecast carries no names, and the
//  per-person view exists only so a supervisor can sanity-check a
//  number they were shown and is gated separately.
//
//  That is not squeamishness. A per-person attendance percentage on a
//  screen becomes a league table within a week of existing, and then it
//  becomes a reason somebody was let go — from a figure that cannot
//  tell an unreliable worker from one who had a sick child in April.
//  The register records absence, not why, and this service will not
//  pretend otherwise.
//
//  ── Recency weighting ────────────────────────────────────────────
//  Somebody who missed a fortnight last winter and has been steady
//  since is not the same as somebody who has missed a fortnight now.
//  Observations decay with a half-life so the recent past dominates,
//  and both the raw and weighted rates are reported so the difference
//  is visible rather than baked in.
// ══════════════════════════════════════════════════════════════════

const Attendance = require('../models/Attendence.js');
const Employee   = require('../models/Employee');

/** Statuses that mean a person was at work in some useful capacity. */
const PRESENT = new Set(['present', 'late']);
/** Half a day is half a person; counted as such rather than either/or. */
const HALF    = new Set(['half_day']);
/**
 * Approved leave is not absenteeism.
 *
 * It is planned, it is known in advance, and it is somebody's
 * entitlement. Folding it into an attendance rate would penalise people
 * for taking leave they were granted and would make the forecast worse,
 * because approved leave is already visible to whoever writes the plan.
 */
const EXCUSED = new Set(['on_leave']);

/** Days after which an observation counts half as much. */
const HALF_LIFE_DAYS = 60;
/** Below this many observations for a (person, weekday, shift) cell. */
const MIN_OBS = 4;
/** How far back the register is read. */
const DEFAULT_WINDOW_DAYS = 240;

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** The weight an observation from `ageDays` ago carries. */
const decay = (ageDays) => Math.pow(0.5, ageDays / HALF_LIFE_DAYS);

/**
 * What one attendance row is worth, as a fraction of a person.
 *
 * Returns null for rows that are not evidence about turning up — see
 * EXCUSED above.
 */
function attendanceValue(status) {
  if (EXCUSED.has(status)) return null;
  if (PRESENT.has(status)) return 1;
  if (HALF.has(status)) return 0.5;
  return 0;   // absent
}

/**
 * Weighted and raw attendance per (employee, weekday, shift).
 *
 * The unit of prediction is deliberately narrow: people are reliable on
 * different days. A Monday night is not a Wednesday day, and a single
 * per-person number would smooth away the pattern the plan needs.
 */
async function buildTable({ days = DEFAULT_WINDOW_DAYS, now = new Date() } = {}) {
  const since = new Date(now.getTime() - days * 86_400_000);

  const rows = await Attendance.find({ date: { $gte: since } })
    .select('employee date shift status')
    .lean();

  const cells = new Map();   // "emp|dow|shift" -> accumulator

  for (const r of rows) {
    const value = attendanceValue(r.status);
    if (value === null) continue;

    const d = new Date(r.date);
    // Local weekday, not UTC. The factory's Monday is the one that
    // matters, and toISOString would move it for half the year on a
    // server east of Greenwich.
    const dow = d.getDay();
    const ageDays = Math.max(0, (now - d) / 86_400_000);
    const w = decay(ageDays);

    const key = `${r.employee}|${dow}|${r.shift}`;
    if (!cells.has(key)) {
      cells.set(key, {
        employee: String(r.employee), dow, shift: r.shift,
        obs: 0, present: 0, weight: 0, weightedPresent: 0, lastSeen: d,
      });
    }
    const c = cells.get(key);
    c.obs += 1;
    c.present += value;
    c.weight += w;
    c.weightedPresent += w * value;
    if (d > c.lastSeen) c.lastSeen = d;
  }

  return cells;
}

/**
 * The expected attendance for one cell, and how much to believe it.
 *
 * A cell with three observations gets shrunk hard toward the plant
 * average — otherwise one person who happened to miss their only two
 * recorded Tuesdays reads as a 0% Tuesday attender for ever.
 */
function cellRate(cell, plantRate) {
  const weighted = cell.weight > 0 ? cell.weightedPresent / cell.weight : null;
  const raw = cell.obs > 0 ? cell.present / cell.obs : null;

  // Empirical-Bayes style shrinkage with a fixed prior strength. Not
  // clever, and deliberately so: the effect is that a thin cell says
  // roughly what the plant says, and confidence has to be earned.
  const PRIOR_STRENGTH = 6;
  const shrunk = weighted == null
    ? plantRate
    : (weighted * cell.weight + plantRate * PRIOR_STRENGTH) / (cell.weight + PRIOR_STRENGTH);

  return {
    rawRate: raw,
    weightedRate: weighted,
    expectedRate: shrunk,
    observations: cell.obs,
    confident: cell.obs >= MIN_OBS,
  };
}

/**
 * Expected heads per (weekday, shift), across the whole roster.
 *
 * This is the number the plan is built against, and it carries NO
 * names — see the header. A supervisor who needs to know who is thin on
 * Thursday nights asks the roster, not this.
 */
async function forecast({ days = DEFAULT_WINDOW_DAYS, now = new Date() } = {}) {
  const cells = await buildTable({ days, now });

  const employees = await Employee.find({ department: 'production' })
    .select('name')
    .lean();
  const roster = employees.length;

  // Plant-wide weighted attendance, the prior every thin cell leans on.
  let totalW = 0, totalWP = 0, totalObs = 0;
  for (const c of cells.values()) { totalW += c.weight; totalWP += c.weightedPresent; totalObs += c.obs; }
  const plantRate = totalW > 0 ? totalWP / totalW : null;

  if (totalObs === 0) {
    return {
      windowDays: days,
      roster,
      plantAttendancePct: null,
      slots: [],
      note: 'No attendance recorded in this window — nothing to forecast from.',
      method: METHOD,
    };
  }

  // ── Roll the cells up per (weekday, shift) ──
  const slots = [];
  for (const shift of ['DAY', 'NIGHT']) {
    for (let dow = 0; dow < 7; dow++) {
      const forSlot = [...cells.values()].filter((c) => c.dow === dow && c.shift === shift);
      if (forSlot.length === 0) continue;

      let expected = 0;
      let confidentPeople = 0;
      for (const c of forSlot) {
        const r = cellRate(c, plantRate);
        expected += r.expectedRate;
        if (r.confident) confidentPeople += 1;
      }

      const people = forSlot.length;
      slots.push({
        dayOfWeek: dow,
        day: DAY_NAMES[dow],
        shift,
        // People who have EVER worked this slot, and how many of them
        // are expected to be there.
        peopleRostered: people,
        expectedHeads: Math.round(expected * 10) / 10,
        expectedAttendancePct: people > 0 ? Math.round((expected / people) * 1000) / 10 : null,
        // Rounded DOWN for planning. A plan built on 8.7 people needs
        // eight to work; the ninth turning up is a good day, not a
        // requirement, and rounding up is how a plan quietly assumes
        // full attendance again.
        planningHeads: Math.floor(expected),
        confidentPeople,
        thin: confidentPeople < people * 0.5,
      });
    }
  }

  slots.sort((a, b) => (a.dayOfWeek - b.dayOfWeek) || a.shift.localeCompare(b.shift));

  const weakest = [...slots]
    .filter((s) => s.expectedAttendancePct != null)
    .sort((a, b) => a.expectedAttendancePct - b.expectedAttendancePct)[0] || null;

  return {
    windowDays: days,
    roster,
    plantAttendancePct: plantRate != null ? Math.round(plantRate * 1000) / 10 : null,
    slots,
    weakestSlot: weakest && {
      day: weakest.day, shift: weakest.shift,
      expectedAttendancePct: weakest.expectedAttendancePct,
    },
    method: METHOD,
    note: null,
  };
}

/**
 * One employee's own pattern.
 *
 * Separate from forecast() on purpose, and separately gated at the
 * route. This exists so a supervisor can check a person's own record
 * with them — the same way a payslip is theirs to see — not so that
 * anybody can sort the workforce by reliability.
 */
async function forEmployee(employeeId, { days = DEFAULT_WINDOW_DAYS, now = new Date() } = {}) {
  const cells = await buildTable({ days, now });
  const mine = [...cells.values()].filter((c) => c.employee === String(employeeId));
  if (mine.length === 0) return null;

  let totalW = 0, totalWP = 0;
  for (const c of cells.values()) { totalW += c.weight; totalWP += c.weightedPresent; }
  const plantRate = totalW > 0 ? totalWP / totalW : 1;

  return {
    employeeId: String(employeeId),
    windowDays: days,
    slots: mine
      .map((c) => ({ day: DAY_NAMES[c.dow], dayOfWeek: c.dow, shift: c.shift, ...cellRate(c, plantRate) }))
      .map((s) => ({
        ...s,
        rawRate: s.rawRate != null ? Math.round(s.rawRate * 1000) / 10 : null,
        weightedRate: s.weightedRate != null ? Math.round(s.weightedRate * 1000) / 10 : null,
        expectedRate: Math.round(s.expectedRate * 1000) / 10,
      }))
      .sort((a, b) => (a.dayOfWeek - b.dayOfWeek) || a.shift.localeCompare(b.shift)),
    note: 'Approved leave is excluded — it is planned time off, not absence.',
  };
}

const METHOD =
  `Attendance per (person, weekday, shift) over the last window, weighted with a ` +
  `${HALF_LIFE_DAYS}-day half-life so the recent past counts for more, and shrunk toward ` +
  'the plant average where a person has few observations for that slot. Approved leave is ' +
  'excluded. Expected heads are rounded DOWN for planning.';

module.exports = {
  forecast, forEmployee,
  _internals: {
    buildTable, cellRate, attendanceValue, decay,
    PRESENT, HALF, EXCUSED, HALF_LIFE_DAYS, MIN_OBS, DAY_NAMES,
  },
};
