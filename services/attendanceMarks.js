'use strict';
// ══════════════════════════════════════════════════════════════════
//  WHAT A MARK BECOMES
//
//  Two screens mark attendance. The web marks the people not yet marked;
//  the admin app sends the whole day back — every row, with the fields
//  it knows about. The route wrote each row as sent, with a default for
//  whatever was missing. So saving the day from the admin app set the
//  overtime entered on the web back to 0, set the minutes the timer had
//  recorded back to 0 (and the hours shown back to a full shift), and
//  named whoever pressed Save as the marker of every row. Nothing checked
//  the values either: a bulk write skips the schema, so a status the
//  model does not know was stored as sent and paid as a full shift.
//
//  And leave: approving a request marked the shift as approved leave
//  only if the shift had already been marked. Leave is asked for ahead
//  of the day, so there was usually nothing to mark — the day was later
//  marked "on leave" with no approval on it, and payroll took it as an
//  absence: pay lost, and counted towards the excess-absence penalty.
//  The same leave approved after the day was marked was paid.
//
//  One place, for /mark, the single edit, the timer and leave approval:
//
//    MARK        what a mark may carry, checked before anything is read;
//    nextMark    what a row becomes — only what was sent changes, and a
//                row sent back as it already is changes nothing;
//    leave       a shift is approved leave exactly when it is marked
//                "on leave" and an approved request covers it, whichever
//                came first. Marked as worked (or clocked in), it is not.
// ══════════════════════════════════════════════════════════════════

const factoryDay   = require('../utils/factoryDay');
const Attendance   = require('../models/Attendence.js');
const LeaveRequest = require('../models/LeaveRequest');
const { z, fields: { text, objectId } } = require('../middleware/validate');

const { STATUSES, LEAVE_TYPES, minutesBetween, hoursFor } = Attendance;

const DAY_MINUTES = 24 * 60;
/** Who a row is marked by when approving leave created it. */
const BY_LEAVE_APPROVAL = 'leave_approval';

const oneOf = (values, what) =>
  z.enum(values, { errorMap: () => ({ message: `must be ${what}` }) });

/** "08:30", or empty for none. */
const clockTime = z.string().max(5).regex(/^$|^([01]?\d|2[0-3]):[0-5]\d$/, 'must be a time like 08:30');

/** Whole minutes, from nothing to a day. A number, or one sent as text. */
const minutes = z.union([z.number(), z.string().max(10)])
  .transform((v) => (typeof v === 'string' ? (v.trim() === '' ? 0 : Number(v)) : v))
  .pipe(z.number()
    .min(0, 'cannot be less than 0')
    .max(DAY_MINUTES, `cannot be more than a day (${DAY_MINUTES} minutes)`))
  .transform((v) => Math.round(v));

/** The fields of a mark. Every one optional: what is not sent is not changed. */
const MARK = {
  status:          oneOf(STATUSES, 'present, late, half_day, absent or on_leave').nullish(),
  checkIn:         clockTime.nullish(),
  checkOut:        clockTime.nullish(),
  workedMinutes:   minutes.nullish(),
  lateMinutes:     minutes.nullish(),
  overtimeMinutes: minutes.nullish(),
  leaveType:       oneOf(LEAVE_TYPES, 'casual, sick, emergency, personal, unpaid or empty').nullish(),
  notes:           text(500).nullish(),
};

const shiftName = z.string().max(10).transform((v) => v.toUpperCase())
  .pipe(oneOf(['DAY', 'NIGHT'], 'DAY or NIGHT'));
const dayText = z.union([z.string().max(40), z.number()]);

const MARK_DAY = z.object({
  date:  dayText.nullish(),
  shift: shiftName.nullish(),
  records: z.array(z.object({ employeeId: objectId, ...MARK }))
    .max(1000, 'exceeds the 1000-item limit per request').nullish(),
});
const EDIT_MARK = z.object(MARK);
const CLOCK = z.object({
  employeeId: objectId.nullish(),
  shift: shiftName.nullish(),
  date: dayText.nullish(),
});

/** Minutes the timer recorded on a finished shift: the last stint and those before it. */
function timerMinutes(row) {
  if (!row?.clockInAt || !row?.clockOutAt) return null;
  const last = Math.max(0, Math.round((new Date(row.clockOutAt) - new Date(row.clockInAt)) / 60000));
  return last + (Number(row.priorMinutes) || 0);
}

// What a field reads as when a stored row does not carry it (rows from
// before the field existed), so that sending the default back is not
// taken for a change.
const UNSET = Object.freeze({
  status: 'present', checkIn: '', checkOut: '', notes: '', leaveType: '',
  workedMinutes: 0, lateMinutes: 0, overtimeMinutes: 0,
  isApprovedLeave: false, leaveRequestId: null, shiftHours: 0, hoursWorked: 0,
});
// Worked out from the rest. Putting one right is not somebody marking the row.
const DERIVED = new Set(['shiftHours', 'hoursWorked']);
const same = (a, b) => String(a ?? '') === String(b ?? '');

/**
 * What a row becomes when it is marked.
 *
 * @param {object|null} cur   the stored row (plain object), or null for a new one
 * @param {object} sent       the request's fields for it, already checked against MARK
 * @param {object} ctx        { shift, leave, markedBy } — `leave` is the approved
 *                            request covering this employee's shift, if there is one
 * @returns {object|null}     the fields to set; null when nothing would change
 */
function nextMark(cur, sent, ctx) {
  const was = cur || {};
  const has = (k) => sent[k] != null;
  const stored = (k) => was[k] ?? UNSET[k];
  const keep = (k) => (has(k) ? sent[k] : stored(k));

  const next = {
    status:          keep('status'),
    checkIn:         keep('checkIn'),
    checkOut:        keep('checkOut'),
    lateMinutes:     keep('lateMinutes'),
    overtimeMinutes: keep('overtimeMinutes'),
    leaveType:       keep('leaveType'),
    notes:           keep('notes'),
  };

  // Minutes worked. A figure sent is that figure. Otherwise they follow
  // the manual in/out times when those change, and are left alone when
  // they do not — the timer's minutes are not the marking screen's to
  // reset. Times cleared fall back to what the timer recorded.
  const timesChanged = !cur || next.checkIn !== stored('checkIn') || next.checkOut !== stored('checkOut');
  const fromTimes = () => minutesBetween(next.checkIn, next.checkOut);
  if (has('workedMinutes') && sent.workedMinutes > 0) next.workedMinutes = sent.workedMinutes;
  else if (has('workedMinutes')) next.workedMinutes = fromTimes() ?? 0;
  else if (timesChanged) next.workedMinutes = fromTimes() ?? timerMinutes(was) ?? (was.clockInAt ? stored('workedMinutes') : 0);
  else next.workedMinutes = stored('workedMinutes');

  // Leave. Marked "on leave" with an approved request for the shift: it
  // is that leave, and its type is the one that was approved. Marked as
  // something else: it is not leave any more, whatever it was before.
  // A row sent back with the status it already has keeps what it has.
  const remarked = !cur || next.status !== stored('status');
  if (next.status === 'on_leave' && ctx.leave) {
    next.isApprovedLeave = true;
    next.leaveRequestId  = ctx.leave._id;
    next.leaveType       = ctx.leave.leaveType;
  } else if (remarked && next.status !== 'on_leave') {
    next.leaveType = '';
    if (was.isApprovedLeave) next.isApprovedLeave = false;
  }

  Object.assign(next, hoursFor({ ...was, ...next, shift: ctx.shift }));

  const changed = {};
  for (const [k, v] of Object.entries(next)) {
    if (!cur || !same(stored(k), v)) changed[k] = v;
  }
  const fields = Object.keys(changed);
  if (cur && fields.length === 0) return null;
  if (!cur || fields.some((k) => !DERIVED.has(k))) changed.markedBy = ctx.markedBy;
  return changed;
}

/**
 * The approved leave requests covering a shift on a day, by employee id.
 * A request for BOTH shifts covers either.
 */
async function approvedLeaveByEmployee({ employeeIds, date, shift, session = null }) {
  if (!employeeIds.length) return new Map();
  const leaves = await LeaveRequest.find({
    employee: { $in: employeeIds },
    date,
    status: 'approved',
    shift: { $in: [shift, 'BOTH'] },
  }).select('employee leaveType shift').session(session).lean();
  return new Map(leaves.map((l) => [String(l.employee), l]));
}

/**
 * An approved request, written onto the shifts it covers — creating the
 * row when the day has not been marked yet, which is the usual case.
 *
 * A shift the person clocked in for is left as it is: the clock is
 * evidence they worked, and a leave day written over it would replace
 * the hours they are owed (with nothing at all, for unpaid leave).
 *
 * Call it inside the transaction that approves the request.
 */
async function markLeaveApproved(leave, { session = null } = {}) {
  const shifts = leave.shift === 'BOTH' ? ['DAY', 'NIGHT'] : [leave.shift];
  const employee = leave.employee?._id ?? leave.employee;
  const date = factoryDay.calendarDay(leave.date);
  for (const shift of shifts) {
    const row = await Attendance.findOne({ employee, date, shift })
      .select('clockInAt').session(session).lean();
    if (row?.clockInAt) continue;
    await Attendance.updateOne(
      { employee, date, shift },
      {
        $set: {
          status:          'on_leave',
          leaveType:       leave.leaveType,
          leaveRequestId:  leave._id,
          isApprovedLeave: true,
          ...hoursFor({ shift, status: 'on_leave' }),
        },
        $setOnInsert: { markedBy: BY_LEAVE_APPROVAL },
      },
      { upsert: true, session, setDefaultsOnInsert: true }
    );
  }
}

/**
 * A shift worked after all. Leave approved ahead of the day puts an
 * "on leave" row there; clocking in, or production verified for that
 * operator, says they came. These are the fields that take the leave
 * off the row, for the write that records the work.
 */
const WORKED_AFTER_ALL = Object.freeze({ isApprovedLeave: false, leaveType: '' });

const dayKeyOf = (d) => new Date(d).toISOString().slice(0, 10);

/**
 * The days the factory worked, read off the register: every date on
 * which somebody was marked as something other than on leave. (There is
 * no holiday calendar; a date nobody was marked on is taken as closed.)
 * A date whose only rows are leave — approved ahead of its day, or for
 * a day the factory turned out to be shut — is not one everybody else
 * went unmarked on.
 *
 * @param {Array<{date: Date, status: string}>} rows
 * @returns {Set<string>} "YYYY-MM-DD" keys
 */
function workingDayKeys(rows) {
  return new Set(rows.filter((r) => r.status !== 'on_leave').map((r) => dayKeyOf(r.date)));
}

module.exports = {
  dayKeyOf, workingDayKeys,
  MARK_DAY, EDIT_MARK, CLOCK,
  BY_LEAVE_APPROVAL, WORKED_AFTER_ALL,
  nextMark, timerMinutes, approvedLeaveByEmployee, markLeaveApproved,
};
