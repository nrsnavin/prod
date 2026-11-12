'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE BOOKS' CALENDAR
//
//  A document's date is kept as the UTC midnight of its day in India
//  (utils/factoryDay.js calendarDay; accountsHelpers.businessDay). What
//  is asked of such a date — its month, its quarter, its financial
//  year, the window of a month to query — was asked in three ways
//  across the accounts: `new Date(y, m, 1)` and getMonth() read the
//  SERVER's zone, a few helpers read UTC, and each report built its own
//  window. They agreed while the server sat on UTC or India time. On a
//  machine west of UTC every month window started hours late, and the
//  first day's documents fell into the month before.
//
//  Here it is asked once, in the calendar the dates are kept in:
//
//    today()             the India day now, at UTC midnight
//    parts(d)            { y, m (1–12), d } of the India day `d` falls on
//    at(y, m, d)         that day at UTC midnight (m is 1–12; a day past
//                        the month's end rolls on, day 0 is the last day
//                        of the month before)
//    dayOfMonth(y, m, d) that day, or the month's last when it has none
//    endOf(day)          the last millisecond of a day
//    monthKey(d)         "2026-10"
//    monthRange(key)     { y, m, from, to }: first day to last millisecond
//    monthsBetween(a, b) the month keys from a's month to b's
//    shiftMonth(key, n)  the month n months on (or back)
//    fyOf(d)             "2026-27" (April to March)
//    fyRange(fy)         { y1, from, to }
//    quarterOf(d)        "Q1".."Q4" of the financial year
//    quarterRange(fy, q) { from, to }
//    dmy(d, sep)         "05-11-2026": the India day of a date or a moment
//
//  Statement parsing (services/bankStatement.js parseDate, lineKey) is
//  deliberately not here: a stored line's key was built with its own
//  reading and must keep being read the same way.
// ══════════════════════════════════════════════════════════════════

const factoryDay = require('./factoryDay');

const DAY = 86_400_000;
const pad = (n) => String(n).padStart(2, '0');

/** The India day now, at UTC midnight. */
const today = () => factoryDay.calendarDay();

/** The India day a date or a moment falls on, at UTC midnight (null when unreadable). */
const dayOf = (d) => (d === undefined ? today() : factoryDay.calendarDay(d));

function parts(d) {
  const x = dayOf(d);
  if (!x) return null;
  return { y: x.getUTCFullYear(), m: x.getUTCMonth() + 1, d: x.getUTCDate() };
}

const at = (y, m, d = 1) => new Date(Date.UTC(y, m - 1, d));
const endOf = (day) => new Date(day.getTime() + DAY - 1);
const daysIn = (y, m) => at(y, m + 1, 0).getUTCDate();
const dayOfMonth = (y, m, d) => { const first = at(y, m, 1); return at(first.getUTCFullYear(), first.getUTCMonth() + 1, Math.min(d, daysIn(first.getUTCFullYear(), first.getUTCMonth() + 1))); };

const monthKey = (d) => { const p = parts(d); return `${p.y}-${pad(p.m)}`; };

function monthRange(key) {
  const [y, m] = String(key).split('-').map(Number);
  return { y, m, from: at(y, m, 1), to: endOf(at(y, m + 1, 0)) };
}

function shiftMonth(key, n) {
  const [y, m] = String(key).split('-').map(Number);
  const x = at(y, m + n, 1);
  return `${x.getUTCFullYear()}-${pad(x.getUTCMonth() + 1)}`;
}

function monthsBetween(a, b) {
  const out = [];
  const last = monthKey(b);
  for (let k = monthKey(a); k <= last; k = shiftMonth(k, 1)) out.push(k);
  return out;
}

function fyOf(d) {
  const p = parts(d);
  const y = p.m >= 4 ? p.y : p.y - 1;
  return `${y}-${String(y + 1).slice(2)}`;
}
const fyStartYear = (fy) => Number(String(fy).slice(0, 4));
function fyRange(fy) {
  const y1 = fyStartYear(fy);
  return { y1, from: at(y1, 4, 1), to: endOf(at(y1 + 1, 3, 31)) };
}

function quarterOf(d) {
  const { m } = parts(d);
  return m >= 4 && m <= 6 ? 'Q1' : m >= 7 && m <= 9 ? 'Q2' : m >= 10 ? 'Q3' : 'Q4';
}
function quarterRange(fy, q) {
  const y1 = fyStartYear(fy);
  const [y, m] = { Q1: [y1, 4], Q2: [y1, 7], Q3: [y1, 10], Q4: [y1 + 1, 1] }[q];
  return { from: at(y, m, 1), to: endOf(at(y, m + 3, 0)) };
}

function dmy(d, sep = '-') {
  if (d === undefined || d === null || d === '') return '';
  const p = parts(d);
  return p ? `${pad(p.d)}${sep}${pad(p.m)}${sep}${p.y}` : '';
}

module.exports = { DAY, today, dayOf, parts, at, endOf, daysIn, dayOfMonth, monthKey, monthRange, shiftMonth, monthsBetween, fyOf, fyStartYear, fyRange, quarterOf, quarterRange, dmy };
