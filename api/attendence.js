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

const express    = require('express');
const mongoose   = require('mongoose');
const router     = express.Router();
const Attendance = require('../models/Attendence.js');
const Employee   = require('../models/Employee');
const ShiftDetail= require('../models/ShiftDetail');
const { isAuthenticated, isAdmin, selfOrAdmin, requireFeature, requireFeatureRead } = require('../middleware/auth');
const { maybeFireAttendanceCrashed } = require('../utils/attendanceAlerts');

router.use(isAuthenticated);

// GET /employee/:empId and GET /monthly/:empId are selfOrAdmin — a worker's
// own attendance history is answerable to their identity, not to whether
// the admin ticked their Attendance checkbox, so those two reads are
// exempt from the feature gate below. Everything else on this router
// (marking, editing, date/summary/latecomer views) needs '/attendance'.
router.use((req, res, next) => {
  const isSelfRead = (req.method === 'GET' || req.method === 'HEAD') &&
    (req.path.startsWith('/employee/') || req.path.startsWith('/monthly/'));
  if (isSelfRead) return next();
  requireFeature('/attendance')(req, res, (err) => {
    if (err) return next(err);
    requireFeatureRead('/attendance')(req, res, next);
  });
});

function toISODate(d) {
  return new Date(d).toISOString().split('T')[0];
}
function toDateLabel(d) {
  return new Date(d).toLocaleDateString('en-IN',
    { day: '2-digit', month: 'short', year: 'numeric' });
}
function toDayOfWeek(d) {
  return new Date(d).toLocaleDateString('en-IN', { weekday: 'short' });
}
function parseDateParam(s, h, m, sec, ms) {
  const d = new Date(s);
  if (isNaN(d.getTime())) throw new Error(`Invalid date: "${s}"`);
  d.setHours(h, m, sec, ms);
  return d;
}
function startOfDay(s)  { return parseDateParam(s,  0,  0,  0,   0); }
function endOfDay(s)    { return parseDateParam(s, 23, 59, 59, 999); }

// Minutes worked from manual "HH:mm" in/out times. Night shifts wrap past
// midnight (out ≤ in ⇒ +24h). Returns null when either time is missing/bad.
function minutesFromTimes(checkIn, checkOut) {
  if (!checkIn || !checkOut) return null;
  const toMin = (t) => {
    const [h, m] = String(t).split(':').map(Number);
    return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : NaN;
  };
  let inM = toMin(checkIn), outM = toMin(checkOut);
  if (!Number.isFinite(inM) || !Number.isFinite(outM)) return null;
  if (outM <= inM) outM += 24 * 60;
  return outM - inM;
}

function computeHours(shiftType, status, lateMinutes, workedMinutes) {
  const baseHours = 12; // DAY and NIGHT are both 12-hour shifts
  let hoursWorked;
  // A recorded worked duration (manual in/out or live timer) wins for a
  // worked shift — hours follow actual time, capped at the shift length.
  if (workedMinutes > 0 && (status === 'present' || status === 'late')) {
    hoursWorked = Math.min(workedMinutes, baseHours * 60) / 60;
    return { shiftHours: baseHours, hoursWorked };
  }
  switch (status) {
    case 'present':  hoursWorked = baseHours; break;
    case 'late':     hoursWorked = Math.max(0, baseHours - (lateMinutes || 0) / 60); break;
    case 'half_day': hoursWorked = baseHours / 2; break;
    case 'absent':
    case 'on_leave': hoursWorked = 0; break;
    default:         hoursWorked = baseHours;
  }
  return { shiftHours: baseHours, hoursWorked };
}

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
    lateMinutes:  a.lateMinutes,
    overtimeMinutes: a.overtimeMinutes ?? 0,
    leaveType:    a.leaveType,
    notes:        a.notes,
    markedBy:     a.markedBy,
    createdAt:    a.createdAt,
    updatedAt:    a.updatedAt,
  };
}

router.post('/mark', isAdmin('admin', 'accounts'), async (req, res) => {
  try {
    const { date, shift, records = [], markedBy = 'admin' } = req.body;

    if (!date || !shift)
      return res.status(400).json({ success: false, message: 'date and shift required.' });
    if (!['DAY','NIGHT'].includes(shift.toUpperCase()))
      return res.status(400).json({ success: false, message: 'shift must be DAY or NIGHT.' });
    if (!Array.isArray(records) || records.length === 0)
      return res.status(400).json({ success: false, message: 'records array must not be empty.' });
    if (records.length > 1000)
      return res.status(400).json({ success: false, message: 'records exceeds the 1000-item limit per request.' });

    const dateObj  = startOfDay(date);
    const shiftUp  = shift.toUpperCase();

    const ops = records.map(r => {
      const status     = r.status || 'present';
      const lateMinutes = r.lateMinutes || 0;
      const overtimeMinutes = Math.max(0, Number(r.overtimeMinutes) || 0);
      // Actual worked minutes from manual in/out times (or an explicit
      // workedMinutes value) — feeds actual-hours pay.
      const workedMinutes = Math.max(0,
        Number(r.workedMinutes) || minutesFromTimes(r.checkIn, r.checkOut) || 0);
      const { shiftHours, hoursWorked } = computeHours(shiftUp, status, lateMinutes, workedMinutes);

      return {
        updateOne: {
          filter: { employee: r.employeeId, date: dateObj, shift: shiftUp },
          update: {
            $set: {
              status,
              checkIn:     r.checkIn   || '',
              checkOut:    r.checkOut  || '',
              workedMinutes,
              lateMinutes,
              overtimeMinutes,
              leaveType:   r.leaveType || '',
              notes:       r.notes     || '',
              markedBy,
              shiftHours,
              hoursWorked,
            },
          },
          upsert: true,
        },
      };
    });

    // Atomic upsert: every row lands or none does. ordered:false
    // lets Mongo continue past benign per-row failures (duplicate
    // key etc.) so a single bad record doesn't poison the whole
    // batch — but everything still rolls back if the transaction
    // itself aborts.
    const session = await mongoose.startSession();
    let result;
    try {
      await session.withTransaction(async () => {
        result = await Attendance.bulkWrite(ops, { session, ordered: false });
      });
    } finally {
      await session.endSession();
    }

    res.json({
      success:  true,
      message:  `Marked ${records.length} attendance record(s).`,
      upserted: result.upsertedCount,
      modified: result.modifiedCount,
    });

    // Fire-and-forget — never blocks the marking response.
    maybeFireAttendanceCrashed({ date: dateObj, shift: shiftUp });
    return;

  } catch (err) {
    console.error('[POST /mark]', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// Live shift timer — clock-in / clock-out (supervisor terminal).
// The timer is the authoritative source for actual-hours pay: the
// worked duration between clock-in and clock-out drives base pay
// (capped at the 12h shift) with the remainder becoming overtime.
// ─────────────────────────────────────────────────────────────
function requireEmpAndShift(req, res) {
  const { employeeId, shift } = req.body;
  if (!employeeId || !shift) {
    res.status(400).json({ success: false, message: 'employeeId and shift required.' });
    return null;
  }
  const shiftUp = String(shift).toUpperCase();
  if (!['DAY', 'NIGHT'].includes(shiftUp)) {
    res.status(400).json({ success: false, message: 'shift must be DAY or NIGHT.' });
    return null;
  }
  const dateObj = startOfDay(req.body.date || new Date());
  return { employeeId, shiftUp, dateObj };
}

// POST /clock-in { employeeId, shift, date? } → stamps clockInAt = now.
router.post('/clock-in', isAdmin('admin', 'accounts'), async (req, res) => {
  try {
    const ctx = requireEmpAndShift(req, res);
    if (!ctx) return;
    const { employeeId, shiftUp, dateObj } = ctx;

    const existing = await Attendance.findOne({ employee: employeeId, date: dateObj, shift: shiftUp });
    if (existing?.clockInAt && !existing?.clockOutAt) {
      return res.status(409).json({ success: false, message: 'Already clocked in for this shift.' });
    }

    const doc = await Attendance.findOneAndUpdate(
      { employee: employeeId, date: dateObj, shift: shiftUp },
      { $set: {
          status: 'present',
          clockInAt: new Date(),
          clockOutAt: null,
          workedMinutes: 0,
          markedBy: req.user?.name || 'admin',
        } },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    ).populate('employee', 'name department skill role');

    return res.json({ success: true, data: fmtRecord(doc) });
  } catch (err) {
    console.error('[POST /clock-in]', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// POST /clock-out { employeeId, shift, date? } → stamps clockOutAt + workedMinutes.
router.post('/clock-out', isAdmin('admin', 'accounts'), async (req, res) => {
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
    doc.clockOutAt = now;
    doc.workedMinutes = Math.max(0, Math.round((now - doc.clockInAt) / 60000));
    await doc.save(); // pre-save recomputes hoursWorked from the worked duration
    await doc.populate('employee', 'name department skill role');

    return res.json({ success: true, data: fmtRecord(doc) });
  } catch (err) {
    console.error('[POST /clock-out]', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// GET /active?date=YYYY-MM-DD → shifts currently clocked in (running timers).
router.get('/active', isAdmin('admin', 'accounts'), async (req, res) => {
  try {
    const dateObj = startOfDay(req.query.date || new Date());
    const rows = await Attendance.find({
      date: dateObj, clockInAt: { $ne: null }, clockOutAt: null,
    }).populate('employee', 'name department skill role').lean();
    return res.json({ success: true, data: rows.map(fmtRecord) });
  } catch (err) {
    console.error('[GET /active]', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.put('/:id', isAdmin('admin', 'accounts'), async (req, res) => {
  try {
    const { id } = req.params;
    const allowed = ['status','checkIn','checkOut','workedMinutes','lateMinutes','overtimeMinutes','leaveType','notes','markedBy'];
    const update  = {};
    for (const k of allowed) {
      if (req.body[k] !== undefined) update[k] = req.body[k];
    }

    // If in/out times are edited without an explicit workedMinutes, recompute
    // the worked duration so pay stays in step with the corrected times.
    if (update.workedMinutes === undefined && (update.checkIn !== undefined || update.checkOut !== undefined)) {
      const existing = await Attendance.findById(id).select('checkIn checkOut').lean();
      const ci = update.checkIn ?? existing?.checkIn;
      const co = update.checkOut ?? existing?.checkOut;
      const mins = minutesFromTimes(ci, co);
      if (mins != null) update.workedMinutes = mins;
    }

    const doc = await Attendance.findByIdAndUpdate(id,
      { $set: update }, { new: true })
      .populate('employee', 'name department skill role');

    if (!doc)
      return res.status(404).json({ success: false, message: 'Record not found.' });

    return res.json({ success: true, data: fmtRecord(doc) });

  } catch (err) {
    console.error('[PUT /:id]', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/date', isAdmin('admin', 'accounts'), async (req, res) => {
  try {
    const { date, shift = 'all' } = req.query;
    if (!date)
      return res.status(400).json({ success: false, message: 'date required.' });

    const filter = { date: { $gte: startOfDay(date), $lte: endOfDay(date) } };
    if (shift !== 'all') filter.shift = shift.toUpperCase();

    const records = await Attendance.find(filter)
      .populate('employee', 'name department skill role')
      .sort({ 'employee.name': 1 })
      .lean();

    const allEmployees = await Employee.find({}, 'name department skill role').lean();
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
    return res.status(500).json({ success: false, message: err.message });
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
    if (shift !== 'all') filter.shift = shift.toUpperCase();

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
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/summary', isAdmin('admin', 'accounts'), async (req, res) => {
  try {
    const { startDate, endDate, shift = 'all' } = req.query;
    if (!startDate || !endDate)
      return res.status(400).json({ success: false, message: 'startDate and endDate required.' });

    const filter = { date: { $gte: startOfDay(startDate), $lte: endOfDay(endDate) } };
    if (shift !== 'all') filter.shift = shift.toUpperCase();

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
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/monthly/:empId', selfOrAdmin, async (req, res) => {
  try {
    const { empId } = req.params;
    const year  = parseInt(req.query.year,  10) || new Date().getFullYear();
    const month = parseInt(req.query.month, 10) || new Date().getMonth() + 1;

    const start = new Date(year, month-1, 1);
    const end   = new Date(year, month,   0, 23, 59, 59, 999);

    const [records, employee] = await Promise.all([
      Attendance.find({ employee:empId, date:{ $gte:start, $lte:end } })
        .sort({ date:1, shift:1 }).lean(),
      Employee.findById(empId, 'name department').lean(),
    ]);

    if (!employee)
      return res.status(404).json({ success:false, message:'Employee not found.' });

    const dayMap = {};
    const daysInMonth = new Date(year, month, 0).getDate();
    for (let d = 1; d <= daysInMonth; d++) {
      const key = `${year}-${String(month).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      dayMap[key] = {
        date: key, day: d,
        dayOfWeek: new Date(year, month-1, d).toLocaleDateString('en-IN',{weekday:'short'}),
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
    return res.status(500).json({ success:false, message:err.message });
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

    const since = new Date(Date.now() - days * 86_400_000);
    since.setHours(0, 0, 0, 0);

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
    return res.status(500).json({ success: false, message: err.message });
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

    const since = new Date(Date.now() - days * 86_400_000);
    since.setHours(0, 0, 0, 0);

    // 1. Pull every attendance row in the window, only the fields we
    // need. One round-trip; the dataset for a single week is tiny.
    const Employee = require('../models/Employee');
    const rows = await Attendance.find({ date: { $gte: since } })
      .select('employee date')
      .lean();

    // 2. Working-day set: distinct dates that had any attendance row.
    const dayKey = (d) => new Date(d).toISOString().slice(0, 10);
    const workingDays = new Set(rows.map((r) => dayKey(r.date)));
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
    const employees = await Employee.find({})
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
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
