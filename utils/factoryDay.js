'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE FACTORY'S DAY, WHATEVER CLOCK THE SERVER KEEPS
//
//  The server runs on UTC. A day cut with setHours(0, 0, 0, 0) began at
//  05:30 in the factory, so between midnight and 05:30 "today" was still
//  yesterday: the dashboard, the evening report, leave and attendance
//  all looked at the wrong day.
//
//  Two kinds of value need two kinds of bound:
//
//    calendarDay(v)   a calendar date — shift dates, leave dates,
//                     voucher dates — kept, as everywhere in this app,
//                     at that day's UTC midnight. Compare those with it.
//    dayStart(v)      a moment — createdAt, inwardDate, dispatch times.
//                     00:00 in India, which is 18:30 UTC the day before.
//
//    moment(v)        a moment the request sent, read as the instant it
//                     was: a time with no zone is the factory's clock.
//
//    shiftDay(now)    the date of the shift running now. A night shift
//                     (20:00–08:00) keeps the date it started on, so
//                     until the day shift starts at 08:00 the floor is
//                     still on yesterday's date. For "what is running
//                     today" views; due dates use calendarDay.
//
//  Called with no argument, each means today. An argument that is
//  undefined, null or unreadable gives null — never quietly today.
//
//  Either takes "YYYY-MM-DD" (or a date and time with no zone) as that
//  day, or any moment as the day it falls on in India. A calendar date at UTC midnight falls on its own
//  day (05:30 there), so both read stored dates correctly. India keeps
//  no daylight saving, so the offset is fixed.
// ══════════════════════════════════════════════════════════════════

const DAY = 86_400_000;
const IST = 330 * 60_000;
// The day shift starts at 08:00 (services/machineLoading.js DAY_STARTS).
const DAY_SHIFT_STARTS = 8;

/** Whether year, month (0-11) and day name a day that exists. */
function isRealDay(y, m, d) {
  const x = new Date(Date.UTC(y, m, d));
  return x.getUTCFullYear() === y && x.getUTCMonth() === m && x.getUTCDate() === d;
}

/**
 * Whether text that begins "YYYY-MM-DD" names a day that exists.
 *
 * "2026-02-30" has the shape of a date, and JavaScript reads it as the
 * 2nd of March: any day number up to 31 rolls into the next month
 * without a word. A bill misread as "31 April" was saved as the 1st of
 * May. A date that is not a day is no date. Text that does not begin
 * that way is not judged here.
 */
function leadsWithRealDay(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?!\d)/.exec(String(text ?? '').trim());
  return !m || isRealDay(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** The India calendar day of a value as [y, m (0-11), d]; null if unreadable. */
function partsOf(v) {
  if (v == null || v === '') return null;
  const s = typeof v === 'string' ? v.trim() : '';
  // "2026-11-08", or a time with no zone ("2026-11-08T20:00:00.000", as
  // the phone app sends): wall-clock time in the factory, so that date.
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?$/.exec(s);
  // Only when it is a day: "2026-13-01" used to come back as January 2027.
  if (m) return isRealDay(Number(m[1]), Number(m[2]) - 1, Number(m[3])) ? [Number(m[1]), Number(m[2]) - 1, Number(m[3])] : null;
  if (!leadsWithRealDay(s)) return null;
  const t = new Date(v).getTime();
  if (Number.isNaN(t)) return null;
  // 23:59:59.999 UTC is how this app marks the end of a calendar date
  // (calendarDayEnd, a month's last day): that date, not the next one,
  // though the moment itself is 05:29 the next morning in India.
  if (t % DAY === DAY - 1) {
    const u = new Date(t);
    return [u.getUTCFullYear(), u.getUTCMonth(), u.getUTCDate()];
  }
  const x = new Date(t + IST);
  return [x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate()];
}

/** The day as a calendar date (its UTC midnight); null if unreadable. */
function calendarDay(...a) {
  const v = a.length ? a[0] : new Date();
  const p = partsOf(v);
  return p ? new Date(Date.UTC(p[0], p[1], p[2])) : null;
}

/** The last millisecond of that calendar date. */
function calendarDayEnd(...a) {
  const v = a.length ? a[0] : new Date();
  const d = calendarDay(v);
  return d ? new Date(d.getTime() + DAY - 1) : null;
}

/** 00:00 in India on that day, as a moment. */
function dayStart(...a) {
  const v = a.length ? a[0] : new Date();
  const d = calendarDay(v);
  return d ? new Date(d.getTime() - IST) : null;
}

/** 23:59:59.999 in India on that day, as a moment. */
function dayEnd(...a) {
  const v = a.length ? a[0] : new Date();
  const d = dayStart(v);
  return d ? new Date(d.getTime() + DAY - 1) : null;
}

/** The date of the shift running at that moment, as a calendar date. */
function shiftDay(...a) {
  const v = a.length ? a[0] : new Date();
  const t = new Date(v).getTime();
  if (typeof v === 'string' || Number.isNaN(t)) return calendarDay(v);
  return calendarDay(new Date(t - DAY_SHIFT_STARTS * 3_600_000));
}

/**
 * A moment (a receipt, a dispatch), as the instant it was; null if
 * unreadable. A date and time with no zone — "2026-11-08T20:00:00.000",
 * as the phone app sends its clock — is the wall clock in the factory.
 * `new Date()` takes that as the server's own zone (UTC), five and a half
 * hours late: anything entered after 18:30 landed on the next day.
 * A date alone stays what it is everywhere here, that day's UTC midnight.
 */
function moment(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'string') {
    const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?$/.exec(v.trim());
    if (m) {
      const [y, mo, d, h, mi, sec] = [m[1], m[2], m[3], m[4], m[5], m[6] || 0].map(Number);
      const ms = m[7] ? Math.floor(Number(`0.${m[7]}`) * 1000) : 0;
      const wall = new Date(Date.UTC(y, mo - 1, d, h, mi, sec, ms));
      // 31 February or 25:00 would roll over into another day: not a time.
      if (wall.getUTCMonth() !== mo - 1 || wall.getUTCDate() !== d || wall.getUTCHours() !== h || mi > 59 || sec > 59) return null;
      return new Date(wall.getTime() - IST);
    }
    // The same date on its own, or with a zone ("2026-02-30T10:00:00Z"),
    // went to JavaScript's reader, which rolls it into March.
    if (!leadsWithRealDay(v)) return null;
  }
  const t = new Date(typeof v === 'string' ? v.trim() : v).getTime();
  return Number.isNaN(t) ? null : new Date(t);
}

/** "YYYY-MM-DD" of the India day. */
function ymd(...a) {
  const v = a.length ? a[0] : new Date();
  const d = calendarDay(v);
  return d ? d.toISOString().slice(0, 10) : null;
}

/**
 * Whole days from the day of `from` to the day of `to` (negative when
 * `to` is the earlier day); null if either is unreadable.
 *
 * For "was it on time" and "is it overdue". A promised date is kept as
 * the first moment of its day, so compared with a MOMENT — when the
 * lorry left, when the order was closed — anything done on the promised
 * date itself reads as after it. Compare the days.
 */
function daysBetween(from, to) {
  const a = calendarDay(from);
  const b = calendarDay(to);
  return a && b ? Math.round((b.getTime() - a.getTime()) / DAY) : null;
}

module.exports = { DAY, IST, calendarDay, calendarDayEnd, dayStart, dayEnd, shiftDay, moment, ymd, daysBetween, leadsWithRealDay };
