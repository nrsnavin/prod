'use strict';
// ══════════════════════════════════════════════════════════════════
//  A DATE, AS THE FACTORY WOULD WRITE IT
//
//  The server runs on UTC (utils/factoryDay.js). `toLocaleDateString()`
//  with no time zone writes a date in the SERVER's zone, so:
//
//    • a moment — createdAt, paidAt, "now" — between midnight and 05:30
//      in India was written as the day before;
//    • a day that begins at 00:00 in India (factoryDay.dayStart) is
//      18:30 UTC the evening before, and was written as the day before
//      at any hour: the wastage alert named the wrong day every time;
//    • a time of day was written five and a half hours behind — every
//      "Generated 18 Nov 2026, 08:35 am" printed at 2:05 in the afternoon.
//
//  Adding `timeZone: 'Asia/Kolkata'` to each call is not the fix either:
//  a calendar date's last millisecond (23:59:59.999 UTC, how this app
//  marks the end of a day or a month) is 05:29 the NEXT morning there.
//
//    indiaDay(v, opts)       the India day `v` falls on — a calendar
//                            date, a moment, a day's start or its end —
//                            written out. '' when `v` is not a date.
//    indiaDateTime(v, opts)  a moment as date and time on the factory's
//                            clock. '' when `v` is not a date.
//
//  `opts` are Intl's (day, month, year, weekday, hour…); the zone is
//  set here and cannot be passed. tests/utils/indiaLabel.test.js holds
//  the whole server to this: no date is written without a zone.
// ══════════════════════════════════════════════════════════════════

const factoryDay = require('./factoryDay');

const LOCALE = 'en-IN';
const TZ = 'Asia/Kolkata';
const DAY = { day: '2-digit', month: 'short', year: 'numeric' };
const DAY_TIME = { ...DAY, hour: '2-digit', minute: '2-digit' };

/** "18 Nov 2026" — the India day of a date or a moment. */
function indiaDay(v, opts = DAY) {
  const d = factoryDay.calendarDay(v);
  // The day is held at its UTC midnight, so it is written in UTC.
  return d ? d.toLocaleDateString(LOCALE, { ...opts, timeZone: 'UTC' }) : '';
}

/** "18 Nov 2026, 02:05 pm" — a moment on the factory's clock. */
function indiaDateTime(v = new Date(), opts = DAY_TIME) {
  const t = v instanceof Date ? v : new Date(v);
  if (v == null || v === '' || Number.isNaN(t.getTime())) return '';
  return t.toLocaleString(LOCALE, { ...opts, timeZone: TZ });
}

module.exports = { indiaDay, indiaDateTime };
