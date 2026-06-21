'use strict';
//
// Workforce-floor alerts. Today's attendance is judged against the
// trailing 30-day baseline for the same shift; a sharp drop is worth
// pinging the owner. notify() handles the throttle (24h per
// (date,shift)) so re-marking the same shift doesn't spam.

const Attendance = require("../models/Attendence.js");
const { notify } = require("./notify.js");

const CRASH_THRESHOLD_PCT = 60;   // <60% of 30d baseline = crashed
const MIN_BASELINE        = 5;    // ignore tiny teams (avoids noise)

function _effective(rows) {
  let n = 0;
  for (const r of rows) {
    if (r.status === "present" || r.status === "late") n += 1;
    else if (r.status === "half_day") n += 0.5;
  }
  return n;
}

async function maybeFireAttendanceCrashed({ date, shift }) {
  try {
    const day = new Date(date);
    day.setHours(0, 0, 0, 0);
    const dayEnd = new Date(day);
    dayEnd.setHours(23, 59, 59, 999);

    const todayRows = await Attendance.find({
      date: { $gte: day, $lte: dayEnd },
      shift,
    }).select("status").lean();
    if (!todayRows.length) return;

    const today = _effective(todayRows);

    // 30d trailing baseline: same shift, excluding today. Average
    // per distinct date so a thinly-marked day doesn't pull the
    // baseline down.
    const since = new Date(day);
    since.setDate(since.getDate() - 30);
    const histRows = await Attendance.find({
      date: { $gte: since, $lt: day },
      shift,
    }).select("status date").lean();
    if (histRows.length < MIN_BASELINE) return;

    const byDay = new Map();
    for (const r of histRows) {
      const k = new Date(r.date).toISOString().slice(0, 10);
      if (!byDay.has(k)) byDay.set(k, []);
      byDay.get(k).push(r);
    }
    const dailyEffectives = [...byDay.values()].map(_effective);
    const baseline = dailyEffectives.reduce((a, b) => a + b, 0) / dailyEffectives.length;
    if (baseline < MIN_BASELINE) return;

    const pct = (today / baseline) * 100;
    if (pct >= CRASH_THRESHOLD_PCT) return;

    const dateKey = day.toISOString().slice(0, 10);
    await notify("attendanceCrashedToday", {
      dateLabel:         day.toLocaleDateString("en-IN",
                           { day: "2-digit", month: "short", year: "numeric" }),
      shift,
      present:           today,
      baseline:          Math.round(baseline * 10) / 10,
      percentOfBaseline: pct,
      _entity: { type: "AttendanceShift", id: `${dateKey}:${shift}` },
    });
  } catch (err) {
    console.warn(`[attendanceAlerts] check failed: ${err.message}`);
  }
}

module.exports = {
  maybeFireAttendanceCrashed,
  _effective,
  CRASH_THRESHOLD_PCT,
  MIN_BASELINE,
};
