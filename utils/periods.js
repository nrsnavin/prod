'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE MONTH OR YEAR A REQUEST ASKS FOR
//
//  Payroll, the bonus, attendance and leave each read "?year=&month="
//  for themselves: `+(req.query.month || new Date().getMonth() + 1)`.
//  Two things were wrong with that everywhere it was written. Asked for
//  nothing, it answered with the SERVER's month, which is still last
//  month in the factory until 05:30 on the 1st. And asked for something
//  that is not a month — 13, "June", 6.5 — it went and looked, found
//  nothing (or failed on the way), and said so in whatever words fell
//  out.
//
//  Here: the factory's month when none is asked for, and null when what
//  is asked for is not one, for the caller to refuse.
// ══════════════════════════════════════════════════════════════════

const factoryDay = require('./factoryDay');

const blank = (v) => v === undefined || v === null || v === '';
const isYear = (y) => Number.isInteger(y) && y >= 2000 && y <= 2100;

/** { year, month } as the factory's calendar has it now. */
function factoryMonth(now) {
  const [year, month] = (now === undefined ? factoryDay.ymd() : factoryDay.ymd(now)).split('-').map(Number);
  return { year, month };
}

/** The year asked for; the factory's when none is; null when it is not a year. */
function yearOf(raw) {
  if (blank(raw)) return factoryMonth().year;
  const y = Number(raw);
  return isYear(y) ? y : null;
}

/**
 * The month asked for as [year, month]; the factory's current one for
 * whichever half is not sent; null when what was sent is not a month.
 */
function monthOf(q) {
  const now = factoryMonth();
  const year  = blank(q?.year)  ? now.year  : Number(q.year);
  const month = blank(q?.month) ? now.month : Number(q.month);
  return isYear(year) && Number.isInteger(month) && month >= 1 && month <= 12 ? [year, month] : null;
}

/** The month before a month, as [year, month]. */
const monthBefore = ([year, month]) => (month === 1 ? [year - 1, 12] : [year, month - 1]);

/** A month's calendar dates as a range: its first and last, at UTC midnight and its end. */
function monthRange([year, month]) {
  return {
    start: new Date(Date.UTC(year, month - 1, 1)),
    end:   new Date(Date.UTC(year, month, 0, 23, 59, 59, 999)),
  };
}

module.exports = { factoryMonth, yearOf, monthOf, monthBefore, monthRange };
