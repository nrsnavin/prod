// ══════════════════════════════════════════════════════════════
//  ATTENDANCE ROUTES
//  Mount: app.use('/api/v2/attendance', require('./api/attendence.js'));
//
//  Endpoints (AUTH = login required; ADMIN = role 'admin'):
//    POST   /mark              — bulk upsert attendance (ADMIN)
//    PUT    /:id               — edit a single record (ADMIN)
//    GET    /date              — all employees for date+shift (ADMIN)
//    GET    /employee/:empId   — attendance history (AUTH)
//    GET    /summary           — aggregated stats (ADMIN)
//    GET    /monthly/:empId    — day-by-day calendar (AUTH)
// ══════════════════════════════════════════════════════════════
'use strict';

const factoryDay = require('../utils/factoryDay');
const express    = require('express');
const { sendError } = require('../utils/routeError');
const ErrorHandler = require('../utils/ErrorHandler');
const mongoose   = require('mongoose');
const router     = express.Router();
const Attendance = require('../models/Attendence.js');
const Employee   = require('../models/Employee');
const { employedFrom } = require('../utils/employeeStatus');
const { isAuthenticated, isAdmin, selfOrAdmin } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { maybeFireAttendanceCrashed } = require('../utils/attendanceAlerts');
const { saveIf, changedMeanwhile } = require('../utils/conditionalSave');
const attendanceForecast = require('../services/attendanceForecast');
const marks = require('../services/attendanceMarks');
const { monthOf, monthRange } = require('../utils/periods');

router.use(isAuthenticated);

// GET /employee/:empId and GET /monthly/:empId are selfOrAdmin — a worker's
// own attendance history is answerable to their identity, not to whether
// the admin ticked their Attendance checkbox, so those two reads are
// exempt from the feature gate below. Everything else on this router
// (marking, editing, date/summary/latecomer views) needs '/attendance'.
//
// Whose attendance it is matters (middleware/ownRecords.js): one's own
// passes on identity; someone else's needs Attendance — or Employees,
// whose page shows a person's attendance beside their record.
router.use(require('../middleware/ownRecords').ownRecordsOr({
  features: ['/attendance'],
  ownPrefixes: ['/employee/', '/monthly/'],
  alsoRead: ['/employees'],
}));

function toISODate(d) {
  return new Date(d).toISOString().split('T')[0];
}
// Read in UTC, like toISODate above: these are calendar dates kept at
// UTC midnight, and the server's own zone has no say in what day that is.
function toDateLabel(d) {
  return new Date(d).toLocaleDateString('en-IN',
    { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
}
function toDayOfWeek(d) {
  return new Date(d).toLocaleDateString('en-IN', { weekday: 'short', timeZone: 'UTC' });
}
// A shift's date is a calendar date, kept at that day's UTC midnight —
// the key every other reader of this collection uses (utils/factoryDay).
// These used to be cut with setHours(), which is the server's own zone:
// right only while the server keeps UTC, and "today" was the server's
// day, which is yesterday in the factory until 05:30.
function startOfDay(s) {
  const d = factoryDay.calendarDay(s);
  if (!d) throw new ErrorHandler('date is not a valid date.', 400);
  return d;
}
function endOfDay(s) {
  const d = factoryDay.calendarDayEnd(s);
  if (!d) throw new ErrorHandler('date is not a valid date.', 400);
  return d;
}
/** The day asked for, or the factory's today. */
const dayOrToday = (s) => (s == null || s === '' ? factoryDay.calendarDay() : startOfDay(s));

function fmtRecord(a) {
  return {
    id:           a._id,
    employeeId:   a.employee?._id ?? a.employee,
    name:         a.employee?.name        ?? '–',
    department:   a.employee?.department  ?? '–',
    skill:        a.employee?.skill       ?? '',
    role:         a.employee?.role        ?? '',
    date:         toISODate(a.date),
    dateLabel:    toDateLabel(a.date),
    dayOfWeek:    toDayOfWeek(a.date),
    shift:        a.shift,
    status:       a.status,
    checkIn:      a.checkIn,
    checkOut:     a.checkOut,
    clockInAt:    a.clockInAt ?? null,
    clockOutAt:   a.clockOutAt ?? null,
    workedMinutes: a.workedMinutes ?? 0,
    priorMinutes: a.priorMinutes ?? 0,
    lateMinutes:  a.lateMinutes,
    overtimeMinutes: a.overtimeMinutes ?? 0,
    leaveType:    a.leaveType,
    notes:        a.notes,
    markedBy:     a.markedBy,
    createdAt:    a.createdAt,
    updatedAt:    a.updatedAt,
  };
}

// POST /mark { date, shift, records: [{ employeeId, status, … }] }
//
// What each row becomes is services/attendanceMarks.js: only the fields
// a row carries are changed, and a row sent back as it already stands is
// not touched. The stored rows are read inside the transaction that
// writes them, so a clock-out landing meanwhile is retried against, not
// written over.
router.post('/mark', isAdmin('admin', 'accounts'), validate({ body: marks.MARK_DAY }), async (req, res) => {
  try {
    const { date, shift, records } = req.body;
    // Who marked it is whoever is signed in — it used to be read from
    // the request ("admin" unless the caller said otherwise).
    const markedBy = req.user?.name || 'admin';

    if (date == null || date === '' || !shift)
      return res.status(400).json({ success: false, message: 'date and shift required.' });
    if (!Array.isArray(records) || records.length === 0)
      return res.status(400).json({ success: false, message: 'records array must not be empty.' });

    const dateObj = startOfDay(date);
    const ids = records.map((r) => r.employeeId.toLowerCase());
    const twice = ids.find((id, i) => ids.indexOf(id) !== i);
    if (twice)
      return res.status(400).json({ success: false, message: 'The same employee is in records more than once.' });

    const session = await mongoose.startSession();
    let result = { upsertedCount: 0, modifiedCount: 0 };
    let unknown = null;
    try {
      await session.withTransaction(async () => {
        result = { upsertedCount: 0, modifiedCount: 0 };
        unknown = null;
        // One after the other: a transaction does not take two
        // operations at once (tests/architecture/noParallelSessionOps).
        const stored = await Attendance.find({ employee: { $in: ids }, date: dateObj, shift }).session(session).lean();
        const leaves = await marks.approvedLeaveByEmployee({ employeeIds: ids, date: dateObj, shift, session });
        const byEmployee = new Map(stored.map((a) => [String(a.employee), a]));

        // A row for somebody who is not an employee was stored as sent.
        const fresh = ids.filter((id) => !byEmployee.has(id));
        if (fresh.length) {
          const known = new Set((await Employee.find({ _id: { $in: fresh } }).select('_id').session(session).lean())
            .map((e) => String(e._id)));
          unknown = fresh.find((id) => !known.has(id)) || null;
          if (unknown) return;
        }

        const ops = [];
        records.forEach((r, i) => {
          const cur = byEmployee.get(ids[i]) || null;
          const set = marks.nextMark(cur, r, { shift, leave: leaves.get(ids[i]) || null, markedBy });
          if (!set) return;
          ops.push({
            updateOne: cur
              ? { filter: { _id: cur._id }, update: { $set: set } }
              : { filter: { employee: ids[i], date: dateObj, shift }, update: { $set: set }, upsert: true },
          });
        });
        if (ops.length) result = await Attendance.bulkWrite(ops, { session, ordered: false });
      });
    } finally {
      await session.endSession();
    }
    if (unknown) {
      return res.status(400).json({
        success: false,
        message: `records.${ids.indexOf(unknown)}.employeeId: no such employee.`,
      });
    }

    const written = (result.upsertedCount || 0) + (result.modifiedCount || 0);
    res.json({
      success:  true,
      message:  `Marked ${records.length} attendance record(s).`,
      upserted: result.upsertedCount || 0,
      modified: result.modifiedCount || 0,
      unchanged: records.length - written,
    });

    // Fire-and-forget — never blocks the marking response.
    maybeFireAttendanceCrashed({ date: dateObj, shift });
    return;

  } catch (err) {
    console.error('[POST /mark]', err);
    return sendError(req, res, err);
  }
});

// ─────────────────────────────────────────────────────────────
// Live shift timer — clock-in / clock-out (supervisor terminal).
// The timer is the authoritative source for actual-hours pay: the
// worked duration between clock-in and clock-out drives base pay
// (capped at the 12h shift) with the remainder becoming overtime.
// ─────────────────────────────────────────────────────────────
function requireEmpAndShift(req, res) {
  // Checked and upper-cased by the schema (marks.CLOCK) before this runs.
  const { employeeId, shift } = req.body;
  if (!employeeId || !shift) {
    res.status(400).json({ success: false, message: 'employeeId and shift required.' });
    return null;
  }
  return { employeeId, shiftUp: shift, dateObj: dayOrToday(req.body.date) };
}

// POST /clock-in { employeeId, shift, date? } → stamps clockInAt = now.
router.post('/clock-in', isAdmin('admin', 'accounts'), validate({ body: marks.CLOCK }), async (req, res) => {
  try {
    const ctx = requireEmpAndShift(req, res);
    if (!ctx) return;
    const { employeeId, shiftUp, dateObj } = ctx;

    const existing = await Attendance.findOne({ employee: employeeId, date: dateObj, shift: shiftUp });
    if (existing?.clockInAt && !existing?.clockOutAt) {
      return res.status(409).json({ success: false, message: 'Already clocked in for this shift.' });
    }

    // Back after clocking out (a break, an errand): a new stint starts,
    // and the minutes already worked this shift are carried, not reset —
    // resetting them paid only the last stint.
    const resuming = !!(existing?.clockInAt && existing?.clockOutAt);
    const carried = resuming ? Math.max(0, Number(existing.workedMinutes) || 0) : 0;

    // The check above, repeated in the write: only a shift not already
    // running is (re)started. A double tap read "not clocked in" twice
    // and the second moved the start time later, cutting the paid
    // minutes. A running one does not match, the upsert tries to insert,
    // and the unique (employee, date, shift) index refuses it. Resuming
    // matches only the stint read above, so two taps cannot both carry
    // the same minutes forward.
    let doc;
    try {
      doc = await Attendance.findOneAndUpdate(
        resuming
          ? { _id: existing._id, clockOutAt: existing.clockOutAt }
          : {
              employee: employeeId, date: dateObj, shift: shiftUp,
              $or: [{ clockInAt: null }, { clockOutAt: { $ne: null } }],
            },
        // They came in: a row put there by leave approved ahead of the
        // day stops being leave, or payroll would pay the leave over the
        // hours on the clock (and nothing at all, for unpaid leave).
        { $set: {
            status: 'present',
            ...marks.WORKED_AFTER_ALL,
            clockInAt: new Date(),
            clockOutAt: null,
            workedMinutes: carried,
            priorMinutes: carried,
            markedBy: req.user?.name || 'admin',
          } },
        { new: true, upsert: true, setDefaultsOnInsert: true }
      ).populate('employee', 'name department skill role');
    } catch (err) {
      if (err?.code === 11000) {
        return res.status(409).json({ success: false, message: 'Already clocked in for this shift.' });
      }
      throw err;
    }

    return res.json({ success: true, data: fmtRecord(doc) });
  } catch (err) {
    console.error('[POST /clock-in]', err);
    return sendError(req, res, err);
  }
});

// POST /clock-out { employeeId, shift, date? } → stamps clockOutAt + workedMinutes.
router.post('/clock-out', isAdmin('admin', 'accounts'), validate({ body: marks.CLOCK }), async (req, res) => {
  try {
    const ctx = requireEmpAndShift(req, res);
    if (!ctx) return;
    const { employeeId, shiftUp, dateObj } = ctx;

    const doc = await Attendance.findOne({ employee: employeeId, date: dateObj, shift: shiftUp });
    if (!doc || !doc.clockInAt) {
      return res.status(400).json({ success: false, message: 'Not clocked in for this shift.' });
    }
    if (doc.clockOutAt) {
      return res.status(409).json({ success: false, message: 'Already clocked out for this shift.' });
    }

    const now = new Date();
    const clockedInAt = doc.clockInAt;
    doc.clockOutAt = now;
    // This stint plus any before it on the same shift.
    doc.workedMinutes = Math.max(0, Math.round((now - doc.clockInAt) / 60000)) + (Number(doc.priorMinutes) || 0);
    // pre-save recomputes hoursWorked from the worked duration. Saved
    // only if this is still the same open shift: a double tap would
    // otherwise move the clock-out later, and a clock-in landing in
    // between would be closed against the old start time.
    if (!(await saveIf(doc, { clockInAt: clockedInAt, clockOutAt: null }))) {
      return res.status(409).json({ success: false, message: 'Already clocked out for this shift.' });
    }
    await doc.populate('employee', 'name department skill role');

    return res.json({ success: true, data: fmtRecord(doc) });
  } catch (err) {
    console.error('[POST /clock-out]', err);
    return sendError(req, res, err);
  }
});

// GET /active?date=YYYY-MM-DD → shifts currently clocked in (running timers).
router.get('/active', isAdmin('admin', 'accounts'), async (req, res) => {
  try {
    const dateObj = dayOrToday(req.query.date);
    const rows = await Attendance.find({
      date: dateObj, clockInAt: { $ne: null }, clockOutAt: null,
    }).populate('employee', 'name department skill role').lean();
    return res.json({ success: true, data: rows.map(fmtRecord) });
  } catch (err) {
    console.error('[GET /active]', err);
    return sendError(req, res, err);
  }
});

// PUT /:id { status?, checkIn?, checkOut?, workedMinutes?, lateMinutes?,
//            overtimeMinutes?, leaveType?, notes? }
//
// The same rules as a row of /mark. This used to $set whatever arrived,
// unchecked, and left the hours as they were: a shift changed from
// present to absent still read 12 hours worked.
router.put('/:id', isAdmin('admin', 'accounts'), validate({ body: marks.EDIT_MARK }), async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id))
      return res.status(404).json({ success: false, message: 'Record not found.' });
    const markedBy = req.user?.name || 'admin'; // the last to correct it, from the session

    // Read, work out what changes, save only if the row is still as it
    // was read. A clock-out between the two would otherwise have its
    // minutes put back; one more go covers that happening once.
    for (let attempt = 0; attempt < 2; attempt++) {
      const doc = await Attendance.findById(id);
      if (!doc)
        return res.status(404).json({ success: false, message: 'Record not found.' });

      const cur = doc.toObject();
      const leaves = await marks.approvedLeaveByEmployee({
        employeeIds: [doc.employee], date: doc.date, shift: doc.shift,
      });
      const set = marks.nextMark(cur, req.body, {
        shift: doc.shift, leave: leaves.get(String(doc.employee)) || null, markedBy,
      });
      if (set) {
        doc.set(set);
        if (!(await saveIf(doc, { updatedAt: cur.updatedAt ?? null }))) continue;
      }
      await doc.populate('employee', 'name department skill role');
      return res.json({ success: true, data: fmtRecord(doc) });
    }
    throw changedMeanwhile('This attendance record', 'changed');

  } catch (err) {
    console.error('[PUT /:id]', err);
    return sendError(req, res, err);
  }
});

router.get('/date', isAdmin('admin', 'accounts'), async (req, res) => {
  try {
    const { date, shift = 'all' } = req.query;
    if (!date)
      return res.status(400).json({ success: false, message: 'date required.' });

    const filter = { date: { $gte: startOfDay(date), $lte: endOfDay(date) } };
    if (shift !== 'all') filter.shift = String(shift).toUpperCase();

    const records = await Attendance.find(filter)
      .populate('employee', 'name department skill role')
      .sort({ 'employee.name': 1 })
      .lean();

    // Only people still here on that day can be missing from it.
    const allEmployees = await Employee.find(employedFrom(date), 'name department skill role').lean();
    const markedIds    = new Set(records.map(r => r.employee?._id?.toString() ?? r.employee?.toString()));
    const unmarked     = allEmployees.filter(e => !markedIds.has(e._id.toString()));

    const breakdown = { present:0, late:0, half_day:0, absent:0, on_leave:0 };
    for (const r of records) breakdown[r.status] = (breakdown[r.status]||0)+1;

    return res.json({
      success: true,
      date,
      dateLabel: toDateLabel(date),
      shift: shift,
      data: {
        records:        records.map(fmtRecord),
        unmarked:       unmarked.map(e => ({ id:e._id, name:e.name, department:e.department, skill:e.skill, role:e.role })),
        totalMarked:    records.length,
        totalUnmarked:  unmarked.length,
        breakdown,
      },
    });

  } catch (err) {
    console.error('[GET /date]', err);
    return sendError(req, res, err);
  }
});

// selfOrAdmin: workers can only fetch their own attendance.
router.get('/employee/:empId', selfOrAdmin, async (req, res) => {
  try {
    const { empId } = req.params;
    const { startDate, endDate, shift = 'all' } = req.query;

    if (!startDate || !endDate)
      return res.status(400).json({ success: false, message: 'startDate and endDate required.' });

    const filter = {
      employee: empId,
      date: { $gte: startOfDay(startDate), $lte: endOfDay(endDate) },
    };
    if (shift !== 'all') filter.shift = String(shift).toUpperCase();

    const [records, employee] = await Promise.all([
      Attendance.find(filter).sort({ date: 1, shift: 1 }).lean(),
      Employee.findById(empId, 'name department skill role phoneNumber').lean(),
    ]);

    if (!employee)
      return res.status(404).json({ success: false, message: 'Employee not found.' });

    const total     = records.length;
    const present   = records.filter(r => r.status==='present').length;
    const late      = records.filter(r => r.status==='late').length;
    const halfDay   = records.filter(r => r.status==='half_day').length;
    const absent    = records.filter(r => r.status==='absent').length;
    const onLeave   = records.filter(r => r.status==='on_leave').length;
    const totalLateMin = records.reduce((s,r)=>s+(r.lateMinutes||0),0);
    const effectivePresentDays = present + late + (halfDay * 0.5);
    const attendancePct = total > 0
      ? Math.round(effectivePresentDays / total * 100) : 0;

    return res.json({
      success:  true,
      employee: { id:employee._id, name:employee.name, department:employee.department,
        skill:employee.skill, role:employee.role, phone:employee.phoneNumber },
      period:   { startDate, endDate, shift },
      summary:  { total, present, late, halfDay, absent, onLeave,
        attendancePct, totalLateMinutes:totalLateMin },
      records:  records.map(r => ({
        id:          r._id,
        date:        toISODate(r.date),
        dateLabel:   toDateLabel(r.date),
        dayOfWeek:   toDayOfWeek(r.date),
        shift:       r.shift,
        status:      r.status,
        checkIn:     r.checkIn,
        checkOut:    r.checkOut,
        clockInAt:   r.clockInAt ?? null,
        clockOutAt:  r.clockOutAt ?? null,
        workedMinutes: r.workedMinutes ?? 0,
        lateMinutes: r.lateMinutes,
        overtimeMinutes: r.overtimeMinutes ?? 0,
        leaveType:   r.leaveType,
        notes:       r.notes,
      })),
    });

  } catch (err) {
    console.error('[GET /employee/:empId]', err);
    return sendError(req, res, err);
  }
});

router.get('/summary', isAdmin('admin', 'accounts'), async (req, res) => {
  try {
    const { startDate, endDate, shift = 'all' } = req.query;
    if (!startDate || !endDate)
      return res.status(400).json({ success: false, message: 'startDate and endDate required.' });

    const filter = { date: { $gte: startOfDay(startDate), $lte: endOfDay(endDate) } };
    if (shift !== 'all') filter.shift = String(shift).toUpperCase();

    const records = await Attendance.find(filter)
      .populate('employee', 'name department skill role')
      .lean();

    const empMap = new Map();
    for (const r of records) {
      const id   = r.employee?._id?.toString() ?? r.employee?.toString();
      const name = r.employee?.name ?? '–';
      if (!empMap.has(id)) {
        empMap.set(id, {
          employeeId:  id, name,
          department:  r.employee?.department ?? '–',
          skill:       r.employee?.skill ?? '',
          role:        r.employee?.role ?? '',
          total:0, present:0, late:0, halfDay:0, absent:0, onLeave:0,
          totalLateMin:0,
        });
      }
      const e = empMap.get(id);
      e.total++;
      e[r.status === 'half_day' ? 'halfDay' : r.status]++;
      e.totalLateMin += r.lateMinutes || 0;
    }

    const list = [...empMap.values()].map(e => {
      const effective = e.present + e.late + e.halfDay * 0.5;
      return { ...e, attendancePct: e.total > 0 ? Math.round(effective / e.total * 100) : 0 };
    }).sort((a,b) => a.attendancePct - b.attendancePct);

    const totalShifts  = records.length;
    const presentCount = records.filter(r=>r.status==='present').length;
    const lateCount    = records.filter(r=>r.status==='late').length;
    const absentCount  = records.filter(r=>r.status==='absent').length;
    const onLeaveCount = records.filter(r=>r.status==='on_leave').length;
    const halfDayCount = records.filter(r=>r.status==='half_day').length;

    return res.json({
      success: true,
      period:  { startDate, endDate, shift },
      factory: {
        totalShifts, presentCount, lateCount, absentCount, onLeaveCount, halfDayCount,
        attendancePct: totalShifts > 0
          ? Math.round((presentCount + lateCount + halfDayCount*0.5) / totalShifts * 100) : 0,
      },
      employees: list,
    });

  } catch (err) {
    console.error('[GET /summary]', err);
    return sendError(req, res, err);
  }
});

router.get('/monthly/:empId', selfOrAdmin, async (req, res) => {
  try {
    const { empId } = req.params;
    // With nothing asked for: the factory's month, not the server's.
    const asked = monthOf(req.query);
    if (!asked)
      return res.status(400).json({ success:false, message:'year and month are not a valid month.' });
    const [year, month] = asked;

    // The month as calendar dates (UTC midnights), whatever the server's zone.
    const { start, end } = monthRange(asked);

    const [records, employee] = await Promise.all([
      Attendance.find({ employee:empId, date:{ $gte:start, $lte:end } })
        .sort({ date:1, shift:1 }).lean(),
      Employee.findById(empId, 'name department').lean(),
    ]);

    if (!employee)
      return res.status(404).json({ success:false, message:'Employee not found.' });

    const dayMap = {};
    const daysInMonth = end.getUTCDate();
    for (let d = 1; d <= daysInMonth; d++) {
      const key = `${year}-${String(month).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      dayMap[key] = {
        date: key, day: d,
        dayOfWeek: toDayOfWeek(Date.UTC(year, month-1, d)),
        dayShift: null, nightShift: null, summary: 'untracked',
      };
    }

    for (const r of records) {
      const key = toISODate(r.date);
      if (!dayMap[key]) continue;
      const slot = {
        id: r._id, status: r.status, checkIn: r.checkIn, checkOut: r.checkOut,
        clockInAt: r.clockInAt ?? null, clockOutAt: r.clockOutAt ?? null,
        workedMinutes: r.workedMinutes ?? 0,
        lateMinutes: r.lateMinutes, leaveType: r.leaveType, notes: r.notes,
      };
      if (r.shift === 'DAY')   dayMap[key].dayShift   = slot;
      if (r.shift === 'NIGHT') dayMap[key].nightShift = slot;
    }

    for (const v of Object.values(dayMap)) {
      const statuses = [v.dayShift?.status, v.nightShift?.status].filter(Boolean);
      if (statuses.length === 0)      v.summary = 'untracked';
      else if (statuses.length === 1) v.summary = statuses[0];
      else if (statuses.every(s=>s==='present')) v.summary = 'present';
      else if (statuses.some(s=>s==='absent'))   v.summary = 'mixed';
      else                                        v.summary = statuses[0];
    }

    const allSlots = records;
    const stats = {
      total: allSlots.length,
      present: allSlots.filter(r=>r.status==='present').length,
      late:    allSlots.filter(r=>r.status==='late').length,
      halfDay: allSlots.filter(r=>r.status==='half_day').length,
      absent:  allSlots.filter(r=>r.status==='absent').length,
      onLeave: allSlots.filter(r=>r.status==='on_leave').length,
      totalLateMin: allSlots.reduce((s,r)=>s+(r.lateMinutes||0),0),
    };

    return res.json({
      success:  true,
      employee: { id:employee._id, name:employee.name, department:employee.department },
      year, month, daysInMonth, stats,
      calendar: Object.values(dayMap),
    });

  } catch (err) {
    console.error('[GET /monthly/:empId]', err);
    return sendError(req, res, err);
  }
});

// ─────────────────────────────────────────────────────────────
// GET /recurring-latecomers
// Employees with > `threshold` `late` attendance marks in the
// last `days` window. Powers the AIAdvisor latecomer card.
// Defaults match the gap-audit recommendation: > 3 in 30 days.
// ─────────────────────────────────────────────────────────────
router.get('/recurring-latecomers', isAdmin('admin', 'accounts'), async (req, res) => {
  try {
    const days      = Math.max(1, parseInt(req.query.days, 10)      || 30);
    const threshold = Math.max(1, parseInt(req.query.threshold, 10) || 3);

    const since = factoryDay.calendarDay(new Date(Date.now() - days * 86_400_000));

    const rows = await Attendance.aggregate([
      { $match: { status: 'late', date: { $gte: since } } },
      { $group: { _id: '$employee', lateCount: { $sum: 1 } } },
      { $match: { lateCount: { $gt: threshold } } },
      { $lookup: {
          from:         'employees',
          localField:   '_id',
          foreignField: '_id',
          as:           'emp',
        } },
      { $unwind: '$emp' },
      { $project: {
          _id:        0,
          employeeId: '$_id',
          name:       '$emp.name',
          department: '$emp.department',
          lateCount:  1,
        } },
      { $sort: { lateCount: -1 } },
    ]);

    return res.json({
      success:   true,
      windowDays: days,
      threshold,
      employees: rows,
      count:     rows.length,
    });
  } catch (err) {
    return sendError(req, res, err);
  }
});

// ─────────────────────────────────────────────────────────────
// GET /repeatedly-unmarked
// Employees missing attendance on > `threshold` working days in
// the last `days` window. "Working day" = any date in the window
// where the system has at least one attendance record (this
// approximates the actual operating calendar without us having
// to encode a separate holiday model).
// Defaults match the audit recommendation: > 2 missed in 7 days.
// ─────────────────────────────────────────────────────────────
router.get('/repeatedly-unmarked', isAdmin('admin', 'accounts'), async (req, res) => {
  try {
    const days      = Math.max(1, parseInt(req.query.days, 10)      || 7);
    const threshold = Math.max(1, parseInt(req.query.threshold, 10) || 2);

    const since = factoryDay.calendarDay(new Date(Date.now() - days * 86_400_000));

    // 1. Pull every attendance row in the window, only the fields we
    // need. One round-trip; the dataset for a single week is tiny.
    // Up to today: leave approved ahead of its day puts a row on a date
    // that has not happened yet.
    const rows = await Attendance.find({ date: { $gte: since, $lte: factoryDay.calendarDayEnd() } })
      .select('employee date status')
      .lean();

    // 2. Working-day set: the dates somebody was marked on, other than
    // as on leave (services/attendanceMarks.js).
    const dayKey = marks.dayKeyOf;
    const workingDays = marks.workingDayKeys(rows);
    if (workingDays.size === 0) {
      return res.json({
        success: true, windowDays: days, threshold,
        employees: [], count: 0,
      });
    }

    // 3. Per-employee marked-day set.
    const markedByEmp = new Map();
    for (const r of rows) {
      const id = String(r.employee);
      if (!markedByEmp.has(id)) markedByEmp.set(id, new Set());
      markedByEmp.get(id).add(dayKey(r.date));
    }

    // 4. Compute unmarked = workingDays - markedDays per active employee.
    const employees = await Employee.find(employedFrom(since))
      .select('name department')
      .lean();

    const out = [];
    for (const e of employees) {
      const marked = markedByEmp.get(String(e._id)) || new Set();
      let unmarked = 0;
      for (const d of workingDays) if (!marked.has(d)) unmarked++;
      if (unmarked > threshold) {
        out.push({
          employeeId:   e._id,
          name:         e.name,
          department:   e.department,
          unmarkedDays: unmarked,
          workingDays:  workingDays.size,
        });
      }
    }
    out.sort((a, b) => b.unmarkedDays - a.unmarkedDays);

    return res.json({
      success: true,
      windowDays: days,
      threshold,
      employees: out,
      count:     out.length,
    });
  } catch (err) {
    return sendError(req, res, err);
  }
});

// ── GET /forecast — how many people will actually be here ──────────
//
//  The planner respects what each loom is busy with and ignores
//  staffing entirely. This is the other constraint: expected heads per
//  (weekday, shift) from the register's own base rates.
//
//  Carries NO NAMES, by construction — see services/attendanceForecast.js
//  for why that is a design rule rather than an omission.
router.get('/forecast', isAdmin('admin', 'accounts', 'production'), async (req, res) => {
  try {
    const days = Number(req.query.days);
    const out = await attendanceForecast.forecast({
      days: Number.isFinite(days) && days > 0 ? Math.min(days, 1095) : undefined,
    });
    res.json({ success: true, ...out });
  } catch (err) {
    console.error('[attendance/forecast]', err);
    sendError(req, res, err);
  }
});

// ── GET /forecast/:empId — one person's own pattern ────────────────
//
//  selfOrAdmin, matching /employee/:empId and /monthly/:empId above: a
//  worker may see their own record, an admin may see anyone's, and
//  nobody else can enumerate the workforce by reliability. The plant
//  forecast above is the one people plan from; this exists so a
//  supervisor can check a number WITH somebody.
router.get('/forecast/:empId', selfOrAdmin, async (req, res) => {
  try {
    const { empId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(empId)) {
      return res.status(400).json({ success: false, message: 'A valid employee id is required' });
    }
    const out = await attendanceForecast.forEmployee(empId);
    if (!out) {
      return res.json({ success: true, employeeId: empId, slots: [], note: 'No attendance recorded yet.' });
    }
    res.json({ success: true, ...out });
  } catch (err) {
    console.error('[attendance/forecast/:empId]', err);
    sendError(req, res, err);
  }
});

module.exports = router;
