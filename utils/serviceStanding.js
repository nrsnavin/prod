'use strict';
// ══════════════════════════════════════════════════════════════════
//  WHERE A MACHINE'S NEXT SERVICE STANDS
//
//  A service is due on a DAY. Compared with the moment somebody looks,
//  one due today was overdue from 05:30 that morning (the day is kept at
//  its first moment, UTC). The machine page counted days; the morning
//  digest had its own copy, which compared moments — so the message said
//  OVERDUE for a loom the app said was due today.
//
//    serviceStanding(nextServiceDate, now) → { next, daysUntil, overdue }
//      next       the day, as a calendar date
//      daysUntil  whole days from today in India: 0 today, negative once past
//      overdue    the day has gone
//    null when there is no readable date.
// ══════════════════════════════════════════════════════════════════

const factoryDay = require('./factoryDay');

function serviceStanding(nextServiceDate, now = new Date()) {
  const next = factoryDay.calendarDay(nextServiceDate);
  if (!next) return null;
  const today = factoryDay.calendarDay(now);
  const daysUntil = Math.round((next.getTime() - today.getTime()) / factoryDay.DAY);
  return { next, daysUntil, overdue: daysUntil < 0 };
}

module.exports = { serviceStanding };
