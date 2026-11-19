'use strict';
// ══════════════════════════════════════════════════════════════════
//  AN EMPLOYEE'S HOURLY RATE: WHAT IT MAY BE, WHO MAY SET IT, AND THE
//  RECORD OF EACH CHANGE
//
//  The rate is what every payslip is worked out from, and it could be
//  set through three doors that agreed on nothing:
//
//    POST /payroll/employees/:id/rate   admin or accounts; `Number()` of
//                                       whatever was sent
//    PUT  /employee/update              admin, accounts OR a floor
//                                       supervisor's login — so a
//                                       supervisor could set any rate,
//                                       their own included; any number,
//                                       a negative one too
//    POST /employee/create-employee     an unreadable rate became ₹0
//                                       without a word
//
//  and none of them kept anything: who changed whose pay, from what to
//  what, was written down nowhere.
//
//  Here: a rate is a number from ₹0 to ₹1,00,000 an hour; it is set by
//  the admin or accounts, as the payroll route always said; and every
//  change is kept (models/AccessEvent.js), where the audit page and the
//  weekly "changes worth a look" read it.
// ══════════════════════════════════════════════════════════════════

const { parseMoney } = require('./money');
const { recordAccess } = require('./accessLog');
const { ACTION_CODES } = require('./fingerprint');

/** More than anybody is paid an hour: catches a slipped decimal point. */
const MAX_HOURLY_RATE = 100000;

/** The roles that may set a rate. */
const PAY_ROLES = ['admin', 'accounts'];
const maySetPay = (user) => PAY_ROLES.includes(user?.role);

/** Nothing was sent for the rate: leave it as it is. */
const blank = (v) => v === undefined || v === null || v === '';

/**
 * A rate as sent. { ok: true, value } or { ok: false, reason }.
 * A blank is not a rate — callers decide what no rate means for them.
 */
function readHourlyRate(value) {
  return parseMoney(value, { max: MAX_HOURLY_RATE, label: 'The hourly rate' });
}

/**
 * The same rate, give or take arithmetic. The web form shows a rate as a
 * 12-hour shift's pay and sends it back divided by 12, and (x × 12) ÷ 12
 * is not always x: ₹85.35 an hour comes back as 85.34999999999998. That
 * is the rate it loaded, not a pay change.
 */
const sameRate = (a, b) => Math.abs((Number(a) || 0) - (Number(b) || 0)) < 0.0005;

/** Keep the change. After it is saved; never fails the request (utils/accessLog.js). */
async function recordRateChange(req, employee, from, to) {
  const was = Number(from) || 0;
  const now = Number(to) || 0;
  if (sameRate(was, now)) return;
  await recordAccess(req, ACTION_CODES.PAY_RATE_CHANGED, { _id: employee._id, name: employee.name }, { from: was, to: now });
}

module.exports = { MAX_HOURLY_RATE, PAY_ROLES, maySetPay, blank, sameRate, readHourlyRate, recordRateChange };
