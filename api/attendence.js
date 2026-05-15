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
const router     = express.Router();
const Attendance = require('../models/Attendence.js');
const Employee   = require('../models/Employee');
const ShiftDetail= require('../models/ShiftDetail');
const { isAuthenticated, isAdmin } = require('../middleware/auth');

router.use(isAuthenticated);

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

function computeHours(shiftType, status, lateMinutes) {
  const baseHours = shiftType === 'DAY' ? 12 : 8;
  let hoursWorked;
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
    lateMinutes:  a.lateMinutes,
    leaveType:    a.leaveType,
    notes:        a.notes,
    markedBy:     a.markedBy,
    createdAt:    a.createdAt,
    updatedAt:    a.updatedAt,
  };
}

router.post('/mark', isAdmin('admin'), async (req, res) => {
  try {
    const { date, shift, records = [], markedBy = 'admin' } = req.body;

    if (!date || !shift)
      return res.status(400).json({ success: false, message: 'date and shift required.' });
    if (!['DAY','NIGHT'].includes(shift.toUpperCase()))
      return res.status(400).json({ success: false, message: 'shift must be DAY or NIGHT.' });
    if (!Array.isArray(records) || records.length === 0)
      return res.status(400).json({ success: false, message: 'records array must not be empty.' });

    const dateObj  = startOfDay(date);
    const shiftUp  = shift.toUpperCase();

    const ops = records.map(r => {
      const status     = r.status || 'present';
      const lateMinutes = r.lateMinutes || 0;
      const { shiftHours, hoursWorked } = computeHours(shiftUp, status, lateMinutes);

      return {
        updateOne: {
          filter: { employee: r.employeeId, date: dateObj, shift: shiftUp },
          update: {
            $set: {
              status,
              checkIn:     r.checkIn   || '',
              checkOut:    r.checkOut  || '',
              lateMinutes,
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

    const result = await Attendance.bulkWrite(ops);

    return res.json({
      success:  true,
      message:  `Marked ${records.length} attendance record(s).`,
      upserted: result.upsertedCount,
      modified: result.modifiedCount,
    });

  } catch (err) {
    console.error('[POST /mark]', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.put('/:id', isAdmin('admin'), async (req, res) => {
  try {
    const { id } = req.params;
    const allowed = ['status','checkIn','checkOut','lateMinutes','leaveType','notes','markedBy'];
    const update  = {};
    for (const k of allowed) {
      if (req.body[k] !== undefined) update[k] = req.body[k];
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

router.get('/date', isAdmin('admin'), async (req, res) => {
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

router.get('/employee/:empId', async (req, res) => {
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
        lateMinutes: r.lateMinutes,
        leaveType:   r.leaveType,
        notes:       r.notes,
      })),
    });

  } catch (err) {
    console.error('[GET /employee/:empId]', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/summary', isAdmin('admin'), async (req, res) => {
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

router.get('/monthly/:empId', async (req, res) => {
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

module.exports = router;
