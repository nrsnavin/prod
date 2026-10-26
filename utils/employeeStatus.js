'use strict';
// ══════════════════════════════════════════════════════════════════
//  WHO STILL WORKS HERE
//
//  An employee who has left is marked offboarded (models/Employee.js)
//  with a last working day, never deleted. These are the filters every
//  list and picker uses, so "who works here" means one thing:
//
//    ACTIVE                 not offboarded at all
//    stillHere()            still working here today (someone serving
//                           notice is, until their last day) — the
//                           pickers, rosters and counts
//    employedFrom(day)      still here on `day` or later — a period's
//                           pay, bonus or attendance includes someone
//                           who left part way through it
//    assertCanWork(ids, day) refuses putting someone on a shift after
//                           their last working day
//
//  Days are calendar days at UTC midnight, the way shift plans store
//  their dates. Documents with no status at all are active.
// ══════════════════════════════════════════════════════════════════

const Employee = require('../models/Employee');
const ErrorHandler = require('./ErrorHandler');

const ACTIVE = Object.freeze({ status: { $ne: 'offboarded' } });
const FACTORY_TZ = process.env.FACTORY_TZ || 'Asia/Kolkata';

/** Today's date in factory time, "YYYY-MM-DD", whatever the server's zone. */
function factoryToday(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: FACTORY_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** The calendar day of a Date or "YYYY-MM-DD", at UTC midnight; null if unreadable. */
function dayOf(value) {
  if (value == null || value === '') return null;
  const d = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? new Date(`${value}T00:00:00.000Z`)
    : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** Everyone still here on `day` or after it: active, or left on/after that day. */
function employedFrom(day) {
  const d = dayOf(day);
  if (!d) return { ...ACTIVE };
  return { $or: [{ status: { $ne: 'offboarded' } }, { 'offboarding.lastWorkingDay': { $gte: d } }] };
}

/** Everyone still working here today. */
const stillHere = (now = new Date()) => employedFrom(factoryToday(now));

/** Did this employee (a lean doc with status/offboarding) leave before `day`? */
function leftBefore(emp, day) {
  if (!emp || emp.status !== 'offboarded') return false;
  const last = dayOf(emp.offboarding?.lastWorkingDay);
  const d = dayOf(day);
  if (!last || !d) return true;
  return d.getTime() > last.getTime();
}

const fmt = (d) => dayOf(d)?.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }) || '—';

/**
 * Refuse a shift on `day` for anyone in `ids` who had left by then.
 * Unknown ids are left to the caller's own "not on record" check.
 */
async function assertCanWork(ids, day, { session } = {}) {
  const list = [...new Set((ids || []).filter(Boolean).map(String))];
  if (!list.length) return;
  let q = Employee.find({ _id: { $in: list }, status: 'offboarded' }).select('name status offboarding.lastWorkingDay').lean();
  if (session) q = q.session(session);
  const gone = (await q).filter((e) => leftBefore(e, day));
  if (!gone.length) return;
  const err = new ErrorHandler(
    gone.map((e) => `${e.name} left on ${fmt(e.offboarding?.lastWorkingDay)}`).join('; ') +
    ' — choose someone else for this shift.', 409);
  err.code = 'EMPLOYEE_OFFBOARDED';
  err.details = { employees: gone.map((e) => ({ id: String(e._id), name: e.name, lastWorkingDay: e.offboarding?.lastWorkingDay })) };
  throw err;
}

module.exports = { ACTIVE, dayOf, factoryToday, employedFrom, stillHere, leftBefore, assertCanWork, fmtDay: fmt };
