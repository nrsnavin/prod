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
  if (Number.isNaN(d.getTime())) throw new ErrorHandler(`${label} is not a date`, 400);
  return d;
}

module.exports = { dateFrom };
