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
const IST_MS = 330 * 60_000;

// ── Days are India's, whatever clock the server keeps ────────────
// The server runs on UTC, so "today" built from its local clock began
// at 05:30 in the factory: between midnight and 05:30 the dashboards
// showed yesterday, and "this month" on the 1st showed last month.
// Bounds are the start of the day in India (00:00 IST = 18:30 UTC the
// day before), which holds whether a record keeps a moment, a UTC
// midnight, or an older IST midnight.

/** The India calendar day of a moment, as { y, m (0-11), d, dow (0=Sun) }. */
function istParts(d) {
  const x = new Date(new Date(d).getTime() + IST_MS);
  return { y: x.getUTCFullYear(), m: x.getUTCMonth(), d: x.getUTCDate(), dow: x.getUTCDay() };
}
/** 00:00 in India on that calendar day. */
const istMidnight = (y, m, d) => new Date(Date.UTC(y, m, d) - IST_MS);

function startOfDay(d) {
  const p = istParts(d);
  return istMidnight(p.y, p.m, p.d);
}

// Financial year in India starts 1 April.
function fyStart(now) {
  const p = istParts(now);
  return istMidnight(p.m >= 3 ? p.y : p.y - 1, 3, 1);
}

// Week starts Monday (ISO-ish) — most plant weeks run Mon–Sat.
function weekStart(now) {
  const p = istParts(now);
  const back = (p.dow + 6) % 7; // 0 = Monday
  return new Date(istMidnight(p.y, p.m, p.d).getTime() - back * DAY_MS);
}

/** "2026-07-01" as that day in India; anything else as the India day it falls on. */
function dayOf(v) {
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) { const [y, m, d] = s.split("-").map(Number); return istMidnight(y, m - 1, d); }
  return startOfDay(new Date(v));
}

/**
 * @param {object} q  { from, to, preset }  (strings, any may be absent)
 * @param {Date}   now  injectable clock for tests
 * @returns {{from: Date, to: Date, preset: string, label: string}}
 */
function resolveRange(q = {}, now = new Date()) {
  const preset = (q.preset || "").toLowerCase();

  if (q.from || q.to) {
    const from = q.from ? dayOf(q.from) : startOfDay(now);
    const toDay = q.to ? dayOf(q.to) : startOfDay(now);
    if (Number.isNaN(from.getTime()) || Number.isNaN(toDay.getTime())) {
      throw Object.assign(new Error("Invalid from/to date"), { status: 400 });
    }
    const to = new Date(toDay.getTime() + DAY_MS);
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
    default: {
      const p = istParts(now);
      return { from: istMidnight(p.y, p.m, 1), to: tomorrow, preset: "month", label: "This month" };
    }
  }
}

/** The preceding window of identical length: [from - len, from). */
function previousWindow({ from, to }) {
  const len = to.getTime() - from.getTime();
  return { from: new Date(from.getTime() - len), to: new Date(from.getTime()) };
}

module.exports = { resolveRange, previousWindow, startOfDay, DAY_MS };
