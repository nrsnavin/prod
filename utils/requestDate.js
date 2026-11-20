'use strict';
// ══════════════════════════════════════════════════════════════════
//  A DATE THE REQUEST SENT
//
//  Seven handlers wrote `value ? new Date(value) : fallback` and passed
//  the result on. A value that is not a date makes an Invalid Date, which
//  the database then refuses on its own terms — "Cast to date failed for
//  value "Invalid Date" (type Date) at path "billDate"" — or, in a search,
//  quietly matches nothing. Here it is refused where it was sent, in the
//  field's own name, before anything is written.
// ══════════════════════════════════════════════════════════════════

const ErrorHandler = require('./ErrorHandler');
const factoryDay = require('./factoryDay');

/**
 * The date a request sent, as sent; `fallback` when it sent none.
 *
 * @param {*} value            what arrived (text, a number of milliseconds, a Date)
 * @param {string} label       the field, as the sender knows it
 * @param {*} [fallback=null]  what "nothing sent" becomes
 * @throws {ErrorHandler} 400 when something was sent and it is not a date
 */
function dateFrom(value, label, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  const sent = Array.isArray(value) ? value[0] : value;
  const d = sent instanceof Date ? sent : new Date(typeof sent === 'string' ? sent.trim() : sent);
  if (typeof sent === 'object' && !(sent instanceof Date)) throw new ErrorHandler(`${label} is not a date`, 400);
  // "2026-02-30" is read by JavaScript as the 2nd of March: not a date.
  if (typeof sent === 'string' && !factoryDay.leadsWithRealDay(sent)) throw new ErrorHandler(`${label} is not a date`, 400);
  if (Number.isNaN(d.getTime())) throw new ErrorHandler(`${label} is not a date`, 400);
  return d;
}

const oneOf = (value) => (Array.isArray(value) ? value[0] : value);
const refuse = (label) => new ErrorHandler(`${label} is not a date`, 400);

/**
 * A calendar date the request sent — an order date, a promised date —
 * as that day in India, kept at its UTC midnight like every calendar
 * date here. The web sends "2026-11-18"; the phone app sends its clock
 * with no zone ("2026-11-18T21:15:30.123"), which `new Date` reads as
 * UTC and so, after 18:30, as the next day.
 *
 * @throws {ErrorHandler} 400 when something was sent and it is not a date
 */
function dayFrom(value, label, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  const sent = oneOf(value);
  if (typeof sent === 'object' && !(sent instanceof Date)) throw refuse(label);
  const d = factoryDay.calendarDay(sent);
  if (!d) throw refuse(label);
  return d;
}

/**
 * A moment the request sent — when goods came in, when something left —
 * as the instant it was. A time with no zone is the factory's clock
 * (utils/factoryDay.js moment).
 *
 * @throws {ErrorHandler} 400 when something was sent and it is not a date
 */
function momentFrom(value, label, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  const sent = oneOf(value);
  if (typeof sent === 'object' && !(sent instanceof Date)) throw refuse(label);
  const d = factoryDay.moment(sent);
  if (!d) throw refuse(label);
  return d;
}

module.exports = { dateFrom, dayFrom, momentFrom };
