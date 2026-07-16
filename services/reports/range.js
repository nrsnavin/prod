"use strict";
// ═════════════════════════════════════════════════════════════════
//  Reports — date-range resolution.
//
//  Every report accepts either an explicit from/to or a named preset
//  (today / week / month / fy). resolveRange() normalises whatever the
//  client sent into a concrete [from, to) window with day-aligned
//  bounds, and previousWindow() returns the immediately-preceding
//  window of the SAME length for period-over-period comparison.
//
//  All bounds are half-open [from, to): from at 00:00:00.000 of the
//  start day, to at 00:00:00.000 of the day AFTER the end day — so a
//  "today" report includes everything up to end of today without a
//  fractional-second gap.
// ═════════════════════════════════════════════════════════════════

const DAY_MS = 86_400_000;

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

// Financial year in India starts 1 April. FY for a given date is the
// window [1 Apr of that FY, 1 Apr of the next year).
function fyStart(now) {
  const y = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  return new Date(y, 3, 1, 0, 0, 0, 0);
}

// Week starts Monday (ISO-ish) — most plant weeks run Mon–Sat.
function weekStart(now) {
  const s = startOfDay(now);
  const dow = (s.getDay() + 6) % 7; // 0 = Monday
  return new Date(s.getTime() - dow * DAY_MS);
}

/**
 * @param {object} q  { from, to, preset }  (strings, any may be absent)
 * @param {Date}   now  injectable clock for tests
 * @returns {{from: Date, to: Date, preset: string, label: string}}
 */
function resolveRange(q = {}, now = new Date()) {
  const preset = (q.preset || "").toLowerCase();

  // Explicit from/to wins over a preset.
  if (q.from || q.to) {
    const from = startOfDay(q.from ? new Date(q.from) : now);
    const toRaw = q.to ? new Date(q.to) : now;
    if (Number.isNaN(from.getTime()) || Number.isNaN(toRaw.getTime())) {
      throw Object.assign(new Error("Invalid from/to date"), { status: 400 });
    }
    // to is inclusive of the given day → advance to next midnight.
    const to = new Date(startOfDay(toRaw).getTime() + DAY_MS);
    if (to <= from) {
      throw Object.assign(new Error("`to` must be on or after `from`"), { status: 400 });
    }
    return { from, to, preset: "custom", label: "Custom range" };
  }

  const todayStart = startOfDay(now);
  const tomorrow = new Date(todayStart.getTime() + DAY_MS);

  switch (preset) {
    case "week":
      return { from: weekStart(now), to: tomorrow, preset: "week", label: "This week" };
    case "fy":
      return { from: fyStart(now), to: tomorrow, preset: "fy", label: "Financial year" };
    case "today":
      return { from: todayStart, to: tomorrow, preset: "today", label: "Today" };
    case "month":
    default:
      return {
        from: new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0),
        to: tomorrow,
        preset: "month",
        label: "This month",
      };
  }
}

/** The preceding window of identical length: [from - len, from). */
function previousWindow({ from, to }) {
  const len = to.getTime() - from.getTime();
  return { from: new Date(from.getTime() - len), to: new Date(from.getTime()) };
}

module.exports = { resolveRange, previousWindow, startOfDay, DAY_MS };
