// ══════════════════════════════════════════════════════════════
//  PAYROLL ROUTE  v2
//  File: routes/payroll.js  (replaces existing)
//
//  Mount: app.use('/api/v2/payroll', require('./routes/payroll'));
//
//  Key design change:
//    • No PayrollConfig per employee.
//    • Pay rate = Employee.hourlyRate  (₹/hr)
//    • DAY shift  = hourlyRate × 12 h
//    • NIGHT shift = hourlyRate × 8 h
//    • Bonus / penalty rules = ONE PayrollSettings document.
//
//  Endpoints:
//    GET  /settings                    factory-wide bonus/penalty config
//    POST /settings                    upsert factory-wide config
//    POST /employees/:id/rate          set / update one employee's hourly rate
//    GET  /employees                   all employees with their hourlyRate
//    POST /generate                    compute payroll  { year, month, all?, employeeId? }
//    GET  /dashboard?year=&month=      monthly factory summary + per-employee rows
//    GET  /slip/:empId?year=&month=    full payslip
//    PUT  /:id/finalize                draft → finalized
//    PUT  /:id/pay                     finalized → paid  { paidBy, paymentNote }
// ══════════════════════════════════════════════════════════════
'use strict';

const express          = require('express');
const router           = express.Router();
const Attendance       = require('../models/Attendence.js');
const Employee         = require('../models/Employee');
const Payroll          = require('../models/Payroll');
const PayrollSettings  = require('../models/PayrollSettings');

// ─────────────────────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────────────────────
const SHIFT_HOURS = { DAY: 12, NIGHT: 8 };

function shiftHours(shift) {
  return SHIFT_HOURS[shift] ?? 8;
}

// Round to 2 decimal places
const r2 = (n) => Math.round(n * 100) / 100;

// ─────────────────────────────────────────────────────────────
//  PAYROLL ENGINE
//  Reads Employee.hourlyRate + PayrollSettings.
//  Returns a plain object ready to upsert into Payroll.
// ─────────────────────────────────────────────────────────────
async function computePayroll(empId, year, month) {

  // 1. Load employee (need hourlyRate)
  const emp = await Employee.findById(empId, 'name department hourlyRate').lean();
  if (!emp) throw new Error(`Employee ${empId} not found`);

  const hourlyRate = emp.hourlyRate ?? 0;

  // 2. Load factory settings (fall back to defaults if not configured yet)
  let s = await PayrollSettings.findOne({}).lean();
  if (!s) s = {};
  const settings = {
    casualLeavesPerMonth:   s.casualLeavesPerMonth   ?? 2,
    sickLeavesPerMonth:     s.sickLeavesPerMonth     ?? 1,
    lateGracePeriodMinutes: s.lateGracePeriodMinutes ?? 10,
    penaltyPerExcessAbsent: s.penaltyPerExcessAbsent ?? 200,
    noLeaveBonus:             s.noLeaveBonus             ?? 300,
    perfectAttendanceBonus:   s.perfectAttendanceBonus   ?? 500,
    streakBonusPer7Shifts:    s.streakBonusPer7Shifts    ?? 100,
  };
  const leaveQuota = settings.casualLeavesPerMonth + settings.sickLeavesPerMonth;

  // 3. Fetch all attendance records for this employee × month
  const start = new Date(year, month - 1, 1);
  const end   = new Date(year, month,     0, 23, 59, 59, 999);
  const records = await Attendance.find({
    employee: empId,
    date: { $gte: start, $lte: end },
  }).sort({ date: 1, shift: 1 }).lean();

  // 4. Iterate records — build earnings and collect counters
  const lineItems            = [];
  let totalShifts            = records.length;
  let presentShifts          = 0;   // present + late (any partial hours)
  let halfDayShifts          = 0;
  let unapprovedAbsents      = 0;   // absent / unapproved on_leave
  let approvedLeaveShifts    = 0;
  let totalLateMinutes       = 0;
  let dayShiftsWorked        = 0;
  let nightShiftsWorked      = 0;
  let dayShiftEarnings       = 0;
  let nightShiftEarnings     = 0;
  let lateDeductionTotal     = 0;

  for (const rec of records) {
    const sh      = shiftHours(rec.shift);             // 12 or 8
    const fullPay = hourlyRate * sh;                   // full shift gross
    const dateStr = new Date(rec.date).toISOString().slice(0, 10);
    const label   = `${rec.shift} ${dateStr}`;

    // ── Approved leave: count + no pay + no penalty ──────────
    if (rec.approvedLeave || (rec.status === 'on_leave' && rec.approvedLeave)) {
      approvedLeaveShifts++;
      lineItems.push({ label: `Approved Leave (${label})`, amount: 0, type: 'deduction' });
      continue;
    }

    // ── Unapproved absent / unapproved on_leave ──────────────
    if (rec.status === 'absent' || rec.status === 'on_leave') {
      unapprovedAbsents++;
      // Shift pay is lost (not added). Excess penalty added later.
      lineItems.push({ label: `Absent — shift pay lost (${label})`, amount: -fullPay, type: 'deduction' });
      continue;
    }

    // ── Half day: half shift pay ──────────────────────────────
    if (rec.status === 'half_day') {
      halfDayShifts++;
      const pay = fullPay / 2;
      if (rec.shift === 'DAY')   { dayShiftsWorked++;   dayShiftEarnings   += pay; }
      if (rec.shift === 'NIGHT') { nightShiftsWorked++; nightShiftEarnings += pay; }
      lineItems.push({ label: `Half Day (${label})`, amount: pay, type: 'earning' });
      continue;
    }

    // ── Present / Late ────────────────────────────────────────
    presentShifts++;
    let pay = fullPay;

    // Late deduction beyond grace period
    const lateMins    = rec.lateMinutes ?? 0;
    const billableMins = Math.max(0, lateMins - settings.lateGracePeriodMinutes);
    if (billableMins > 0) {
      const deduction = (billableMins / 60) * hourlyRate;
      pay             -= deduction;
      totalLateMinutes += lateMins;
      lateDeductionTotal += deduction;
      lineItems.push({
        label:  `Late deduction ${billableMins}m (${label})`,
        amount: -deduction,
        type:   'deduction',
      });
    }

    if (rec.shift === 'DAY')   { dayShiftsWorked++;   dayShiftEarnings   += pay; }
    if (rec.shift === 'NIGHT') { nightShiftsWorked++; nightShiftEarnings += pay; }
    lineItems.push({ label: `${rec.shift} Shift (${dateStr})`, amount: pay, type: 'earning' });
  }

  // 5. Gross = sum of all positive line items (before excess penalties + bonuses)
  const grossEarnings = r2(dayShiftEarnings + nightShiftEarnings);

  // 6. Excess absent penalty
  //    First `leaveQuota` unapproved absents are "free" — employee just loses shift pay.
  //    Every absent beyond quota gets an EXTRA flat penalty on top.
  const excessAbsents   = Math.max(0, unapprovedAbsents - leaveQuota);
  const excessPenalty   = excessAbsents * settings.penaltyPerExcessAbsent;
  if (excessAbsents > 0) {
    lineItems.push({
      label:  `Excess absent penalty (${excessAbsents} × ₹${settings.penaltyPerExcessAbsent})`,
      amount: -excessPenalty,
      type:   'deduction',
    });
  }

  const totalDeductions = r2(lateDeductionTotal + excessPenalty);

  // 7. Bonuses
  let bonusTotal    = 0;
  let noLeaveBonusAmt         = 0;
  let perfectAttBonusAmt      = 0;
  let streakBonusTotal        = 0;
  let longestStreak           = 0;
  let perfectAttendance       = false;

  // No-leave bonus: employee took zero leaves (approved or unapproved) all month
  const tookNoLeave = approvedLeaveShifts === 0 && unapprovedAbsents === 0;
  if (tookNoLeave && settings.noLeaveBonus > 0) {
    noLeaveBonusAmt = settings.noLeaveBonus;
    lineItems.push({ label: '🌟 No-Leave Bonus', amount: noLeaveBonusAmt, type: 'bonus' });
  }

  // Perfect attendance bonus: zero unapproved absents (approved leaves allowed)
  const zeroBadAbsents = unapprovedAbsents === 0 && totalShifts > 0;
  if (zeroBadAbsents && settings.perfectAttendanceBonus > 0) {
    perfectAttendance   = true;
    perfectAttBonusAmt  = settings.perfectAttendanceBonus;
    lineItems.push({ label: '🏆 Perfect Attendance Bonus', amount: perfectAttBonusAmt, type: 'bonus' });
  }

  // Streak bonus: count consecutive present/late days
  // Group records by date so half-days on same day don't double-count
  const presentDates = new Set();
  for (const rec of records) {
    if (['present', 'late', 'half_day'].includes(rec.status)) {
      presentDates.add(new Date(rec.date).toISOString().slice(0, 10));
    }
  }
  const sortedDates = [...presentDates].sort();
  let currentStreak = 0;
  let best          = 0;
  let prevDate      = null;
  let streakSetsPaid = 0;

  for (const d of sortedDates) {
    const cur  = new Date(d);
    const prev = prevDate ? new Date(prevDate) : null;
    const isConsec = prev && (cur - prev) === 86400000; // exactly 1 day apart

    if (isConsec || !prev) {
      currentStreak++;
    } else {
      currentStreak = 1;
    }
    if (currentStreak > best) best = currentStreak;

    const fullSets = Math.floor(currentStreak / 7);
    if (fullSets > streakSetsPaid && settings.streakBonusPer7Shifts > 0) {
      const newSets  = fullSets - streakSetsPaid;
      streakSetsPaid = fullSets;
      const amt      = newSets * settings.streakBonusPer7Shifts;
      streakBonusTotal += amt;
      lineItems.push({
        label:  `🔥 ${fullSets * 7}-Day Streak Bonus (${fullSets}×)`,
        amount: amt,
        type:   'bonus',
      });
    }
    prevDate = d;
  }
  longestStreak = best;

  bonusTotal = r2(noLeaveBonusAmt + perfectAttBonusAmt + streakBonusTotal);

  // 8. Net pay (floor at 0)
  const netPay = r2(Math.max(0, grossEarnings - totalDeductions + bonusTotal));

  return {
    employee:             empId,
    year, month,
    hourlyRate,
    totalShifts,
    presentShifts,
    halfDayShifts,
    absentShifts:         unapprovedAbsents,   // field kept as absentShifts for compatibility
    approvedLeaveShifts,
    totalLateMinutes,
    unapprovedAbsents,
    excessAbsents,
    dayShiftsWorked,
    nightShiftsWorked,
    dayShiftEarnings:     r2(dayShiftEarnings),
    nightShiftEarnings:   r2(nightShiftEarnings),
    grossEarnings,
    totalDeductions,
    totalBonuses:         bonusTotal,
    noLeaveBonus:         noLeaveBonusAmt,
    perfectAttendanceBonus: perfectAttBonusAmt,
    totalStreakBonus:     r2(streakBonusTotal),
    longestStreak,
    perfectAttendance,
    netPay,
    lineItems,
    status: 'draft',
  };
}

// ══════════════════════════════════════════════════════════════
//  GET /settings  — fetch factory-wide settings
// ══════════════════════════════════════════════════════════════
router.get('/settings', async (req, res) => {
  try {
    let s = await PayrollSettings.findOne({}).lean();
    if (!s) s = {};                        // return empty — UI shows defaults
    res.json({ success: true, data: s });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  POST /settings  — upsert factory-wide settings
//  Body: { casualLeavesPerMonth, sickLeavesPerMonth,
//          lateGracePeriodMinutes, penaltyPerExcessAbsent,
//          noLeaveBonus, perfectAttendanceBonus, streakBonusPer7Shifts }
// ══════════════════════════════════════════════════════════════
router.post('/settings', async (req, res) => {
  try {
    const allowed = [
      'casualLeavesPerMonth', 'sickLeavesPerMonth',
      'lateGracePeriodMinutes', 'penaltyPerExcessAbsent',
      'noLeaveBonus', 'perfectAttendanceBonus', 'streakBonusPer7Shifts',
    ];
    const update = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) update[key] = Number(req.body[key]);
    }
    const s = await PayrollSettings.findOneAndUpdate(
      {},
      { $set: update },
      { upsert: true, new: true }
    );
    res.json({ success: true, data: s });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  GET /employees  — all employees with their hourlyRate
// ══════════════════════════════════════════════════════════════
router.get('/employees', async (req, res) => {
  try {
    const emps = await Employee.find({})
      .select('name department role skill hourlyRate')
      .sort({ name: 1 })
      .lean();
    res.json({
      success: true,
      data: emps.map(e => ({
        id:          e._id,
        name:        e.name,
        department:  e.department,
        role:        e.role ?? '',
        skill:       e.skill ?? 0,
        hourlyRate:  e.hourlyRate ?? 0,
        dayShiftPay: (e.hourlyRate ?? 0) * 12,
        nightShiftPay: (e.hourlyRate ?? 0) * 8,
      })),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  POST /employees/:id/rate  — set one employee's hourly rate
//  Body: { hourlyRate: 85 }
// ══════════════════════════════════════════════════════════════
router.post('/employees/:id/rate', async (req, res) => {
  try {
    const rate = Number(req.body.hourlyRate);
    if (isNaN(rate) || rate < 0)
      return res.status(400).json({ success: false, message: 'hourlyRate must be a non-negative number' });

    const emp = await Employee.findByIdAndUpdate(
      req.params.id,
      { $set: { hourlyRate: rate } },
      { new: true }
    ).select('name department hourlyRate');

    if (!emp) return res.status(404).json({ success: false, message: 'Employee not found' });

    res.json({
      success: true,
      message: `Rate updated for ${emp.name}`,
      data: {
        id: emp._id, name: emp.name,
        department: emp.department,
        hourlyRate: emp.hourlyRate,
        dayShiftPay:   emp.hourlyRate * 12,
        nightShiftPay: emp.hourlyRate * 8,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  POST /generate
//  Body: { year, month, employeeId? }
//  Omit employeeId (or pass all:true) to run for ALL employees.
// ══════════════════════════════════════════════════════════════
router.post('/generate', async (req, res) => {
  try {
    const { year, month, employeeId, all = false } = req.body;
    if (!year || !month)
      return res.status(400).json({ success: false, message: 'year and month are required' });

    let empIds = [];
    if (employeeId) {
      empIds = [employeeId];
    } else {
      const emps = await Employee.find({ hourlyRate: { $gt: 0 } }, '_id').lean();
      empIds = emps.map(e => e._id.toString());
    }

    if (empIds.length === 0)
      return res.status(400).json({ success: false, message: 'No employees with hourlyRate set' });

    const results = [];
    const errors  = [];

    for (const id of empIds) {
      try {
        const data    = await computePayroll(id, +year, +month);
        const payroll = await Payroll.findOneAndUpdate(
          { employee: id, year: +year, month: +month },
          { $set: data },
          { upsert: true, new: true }
        ).populate('employee', 'name department');
        results.push({
          employeeId: id,
          name:       payroll.employee?.name ?? '–',
          netPay:     payroll.netPay,
          status:     payroll.status,
        });
      } catch (err) {
        errors.push({ employeeId: id, error: err.message });
      }
    }

    res.json({
      success: true,
      message: `Payroll generated for ${results.length} employee(s)`,
      data:    results,
      errors:  errors.length ? errors : undefined,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  GET /dashboard?year=&month=
//  Factory-wide monthly summary + per-employee rows
// ══════════════════════════════════════════════════════════════
router.get('/dashboard', async (req, res) => {
  try {
    const year  = +(req.query.year  || new Date().getFullYear());
    const month = +(req.query.month || new Date().getMonth() + 1);

    const payrolls = await Payroll.find({ year, month })
      .populate('employee', 'name department hourlyRate')
      .lean();

    // Aggregate
    const totalNetPay      = payrolls.reduce((s, p) => s + p.netPay, 0);
    const totalGross       = payrolls.reduce((s, p) => s + p.grossEarnings, 0);
    const totalDeductions  = payrolls.reduce((s, p) => s + p.totalDeductions, 0);
    const totalBonuses     = payrolls.reduce((s, p) => s + p.totalBonuses, 0);
    const perfectCount     = payrolls.filter(p => p.perfectAttendance).length;
    const paidCount        = payrolls.filter(p => p.status === 'paid').length;
    const finalizedCount   = payrolls.filter(p => p.status === 'finalized').length;
    const draftCount       = payrolls.filter(p => p.status === 'draft').length;

    res.json({
      success: true,
      year, month,
      summary: {
        totalEmployees:   payrolls.length,
        totalNetPay:      r2(totalNetPay),
        totalGross:       r2(totalGross),
        totalDeductions:  r2(totalDeductions),
        totalBonuses:     r2(totalBonuses),
        perfectCount,
        paidCount,
        finalizedCount,
        draftCount,
      },
      employees: payrolls
        .map(p => ({
          employeeId:     p.employee?._id ?? p.employee,
          name:           p.employee?.name ?? '–',
          department:     p.employee?.department ?? '–',
          hourlyRate:     p.hourlyRate,
          totalShifts:    p.totalShifts,
          presentShifts:  p.presentShifts,
          absentShifts:   p.absentShifts,
          excessAbsents:  p.excessAbsents ?? 0,
          grossEarnings:  p.grossEarnings,
          totalDeductions:p.totalDeductions,
          totalBonuses:   p.totalBonuses,
          netPay:         p.netPay,
          perfectAttendance: p.perfectAttendance,
          status:         p.status,
          paidAt:         p.paidAt ?? null,
        }))
        .sort((a, b) => b.netPay - a.netPay),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  GET /slip/:empId?year=&month=  — detailed payslip
// ══════════════════════════════════════════════════════════════
router.get('/slip/:empId', async (req, res) => {
  try {
    const year  = +(req.query.year  || new Date().getFullYear());
    const month = +(req.query.month || new Date().getMonth() + 1);

    const payroll = await Payroll.findOne({
      employee: req.params.empId, year, month,
    }).populate('employee', 'name department role phoneNumber hourlyRate').lean();

    if (!payroll)
      return res.status(404).json({
        success: false,
        message: 'Payroll not generated yet for this employee / month.',
      });

    res.json({ success: true, data: payroll });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  PUT /:id/finalize
// ══════════════════════════════════════════════════════════════
router.put('/:id/finalize', async (req, res) => {
  try {
    const p = await Payroll.findByIdAndUpdate(
      req.params.id,
      { $set: { status: 'finalized', finalizedAt: new Date() } },
      { new: true }
    ).populate('employee', 'name');
    if (!p) return res.status(404).json({ success: false, message: 'Payroll not found' });
    res.json({ success: true, message: `Finalized for ${p.employee?.name}`, data: p });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  PUT /:id/pay   Body: { paidBy?, paymentNote? }
// ══════════════════════════════════════════════════════════════
router.put('/:id/pay', async (req, res) => {
  try {
    const { paidBy = 'admin', paymentNote = '' } = req.body;
    const p = await Payroll.findByIdAndUpdate(
      req.params.id,
      { $set: { status: 'paid', paidAt: new Date(), paidBy, paymentNote } },
      { new: true }
    ).populate('employee', 'name');
    if (!p) return res.status(404).json({ success: false, message: 'Payroll not found' });
    res.json({ success: true, message: `Payment recorded for ${p.employee?.name}`, data: p });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;