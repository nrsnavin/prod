// ══════════════════════════════════════════════════════════════
//  PAYROLL ROUTE  v3
//  File: routes/payroll.js
//
//  Mount: app.use('/api/v2/payroll', require('./routes/payroll'));
//
//  New in v3:
//    • Fixed approved-leave deduction bug (was double-checking flag)
//    • Advance salary: request / approve / reject / deduct in payroll
//    • Yearly bonus: 10% of total annual salary, compute + pay
//    • Analytics: per-employee attendance + pay performance
//
//  Endpoints:
//    GET  /settings
//    POST /settings
//    GET  /employees
//    POST /employees/:id/rate
//    POST /generate
//    GET  /dashboard?year=&month=
//    GET  /slip/:empId?year=&month=
//    PUT  /:id/finalize
//    PUT  /:id/pay
//
//    GET  /advance?employeeId=&status=
//    POST /advance                          { employeeId, amount, reason }
//    PUT  /advance/:id/approve              { deductMonth, deductYear, adminNotes }
//    PUT  /advance/:id/reject               { adminNotes }
//
//    POST /yearly-bonus/compute?year=       compute all employees
//    GET  /yearly-bonus?year=               list
//    PUT  /yearly-bonus/:id/pay             { paidBy, paymentNote }
//
//    GET  /analytics?year=&month=           attendance + pay performance
// ══════════════════════════════════════════════════════════════
'use strict';

const express          = require('express');
const router           = express.Router();
const Attendance       = require('../models/Attendence');
const Employee         = require('../models/Employee');
const Payroll          = require('../models/Payroll');
const PayrollSettings  = require('../models/PayrollSettings');
const AdvanceRequest   = require('../models/Advance');
const YearlyBonus      = require('../models/YearlyBonus');
const Wastage          = require('../models/Wastage');          // wastage penalty

const SHIFT_HOURS = { DAY: 12, NIGHT: 8 };
const r2 = (n) => Math.round(n * 100) / 100;
const shiftHours = (s) => SHIFT_HOURS[s] ?? 8;

// ─────────────────────────────────────────────────────────────
//  PAYROLL ENGINE
// ─────────────────────────────────────────────────────────────
async function computePayroll(empId, year, month) {

  const emp = await Employee.findById(empId, 'name department hourlyRate').lean();
  if (!emp) throw new Error(`Employee ${empId} not found`);
  const hourlyRate = emp.hourlyRate ?? 0;

  let s = await PayrollSettings.findOne({}).lean() ?? {};
  const settings = {
    casualLeavesPerMonth:   s.casualLeavesPerMonth   ?? 2,
    sickLeavesPerMonth:     s.sickLeavesPerMonth     ?? 1,
    lateGracePeriodMinutes: s.lateGracePeriodMinutes ?? 10,
    penaltyPerExcessAbsent: s.penaltyPerExcessAbsent ?? 200,
    noLeaveBonus:           s.noLeaveBonus           ?? 300,
    perfectAttendanceBonus: s.perfectAttendanceBonus ?? 500,
    streakBonusPer7Shifts:  s.streakBonusPer7Shifts  ?? 100,
  };
  const leaveQuota = settings.casualLeavesPerMonth + settings.sickLeavesPerMonth;

  const start   = new Date(year, month - 1, 1);
  const end     = new Date(year, month,     0, 23, 59, 59, 999);
  const records = await Attendance.find({
    employee: empId,
    date: { $gte: start, $lte: end },
  }).sort({ date: 1, shift: 1 }).lean();

  const lineItems         = [];
  let totalShifts         = records.length;
  let presentShifts       = 0;
  let halfDayShifts       = 0;
  let unapprovedAbsents   = 0;
  let approvedLeaveShifts = 0;
  let totalLateMinutes    = 0;
  let dayShiftsWorked     = 0;
  let nightShiftsWorked   = 0;
  let dayShiftEarnings    = 0;
  let nightShiftEarnings  = 0;
  let lateDeductionTotal  = 0;

  for (const rec of records) {
    const sh      = shiftHours(rec.shift);
    const fullPay = hourlyRate * sh;
    const dateStr = new Date(rec.date).toISOString().slice(0, 10);

    // ── APPROVED LEAVE: full shift pay credited, no deduction ──
    // An approved leave means the employee gets paid for the shift
    // even though they were absent. Admin approved it.
    if (rec.approvedLeave === true) {
      approvedLeaveShifts++;
      const pay = fullPay; // PAID — no deduction for approved leave
      if (rec.shift === 'DAY')   { dayShiftsWorked++;   dayShiftEarnings   += pay; }
      if (rec.shift === 'NIGHT') { nightShiftsWorked++; nightShiftEarnings += pay; }
      lineItems.push({
        label:  `✅ Approved Leave — paid (${rec.shift} ${dateStr})`,
        amount: pay,
        type:   'earning',
      });
      continue;
    }

    // ── UNAPPROVED ABSENT / UNAPPROVED ON_LEAVE ───────────────
    if (rec.status === 'absent' || rec.status === 'on_leave') {
      unapprovedAbsents++;
      lineItems.push({
        label:  `Absent — pay lost (${rec.shift} ${dateStr})`,
        amount: -fullPay,
        type:   'deduction',
      });
      continue;
    }

    // ── HALF DAY ─────────────────────────────────────────────
    if (rec.status === 'half_day') {
      halfDayShifts++;
      const pay = fullPay / 2;
      if (rec.shift === 'DAY')   { dayShiftsWorked++;   dayShiftEarnings   += pay; }
      if (rec.shift === 'NIGHT') { nightShiftsWorked++; nightShiftEarnings += pay; }
      lineItems.push({ label: `Half Day (${rec.shift} ${dateStr})`, amount: pay, type: 'earning' });
      continue;
    }

    // ── PRESENT / LATE ────────────────────────────────────────
    presentShifts++;
    let pay = fullPay;
    const lateMins     = rec.lateMinutes ?? 0;
    const billableMins = Math.max(0, lateMins - settings.lateGracePeriodMinutes);
    if (billableMins > 0) {
      const ded        = (billableMins / 60) * hourlyRate;
      pay             -= ded;
      totalLateMinutes += lateMins;
      lateDeductionTotal += ded;
      lineItems.push({
        label:  `Late deduction ${billableMins}m (${rec.shift} ${dateStr})`,
        amount: -ded,
        type:   'deduction',
      });
    }
    if (rec.shift === 'DAY')   { dayShiftsWorked++;   dayShiftEarnings   += pay; }
    if (rec.shift === 'NIGHT') { nightShiftsWorked++; nightShiftEarnings += pay; }
    lineItems.push({
      label:  `${rec.shift} Shift (${dateStr})`,
      amount: pay,
      type:   'earning',
    });
  }

  const grossEarnings = r2(dayShiftEarnings + nightShiftEarnings);

  // Excess absent penalty
  const excessAbsents = Math.max(0, unapprovedAbsents - leaveQuota);
  const excessPenalty = excessAbsents * settings.penaltyPerExcessAbsent;
  if (excessAbsents > 0) {
    lineItems.push({
      label:  `Excess absent penalty (${excessAbsents} × ₹${settings.penaltyPerExcessAbsent})`,
      amount: -excessPenalty,
      type:   'deduction',
    });
  }

  let lateDeductions   = r2(lateDeductionTotal);
  let totalDeductions  = r2(lateDeductionTotal + excessPenalty);

  // Bonuses
  let noLeaveBonusAmt       = 0;
  let perfectAttBonusAmt    = 0;
  let streakBonusTotal      = 0;
  let longestStreak         = 0;
  let perfectAttendance     = false;

  if (approvedLeaveShifts === 0 && unapprovedAbsents === 0 && settings.noLeaveBonus > 0) {
    noLeaveBonusAmt = settings.noLeaveBonus;
    lineItems.push({ label: '🌟 No-Leave Bonus', amount: noLeaveBonusAmt, type: 'bonus' });
  }

  if (unapprovedAbsents === 0 && totalShifts > 0 && settings.perfectAttendanceBonus > 0) {
    perfectAttendance  = true;
    perfectAttBonusAmt = settings.perfectAttendanceBonus;
    lineItems.push({ label: '🏆 Perfect Attendance Bonus', amount: perfectAttBonusAmt, type: 'bonus' });
  }

  // Streak bonus — count consecutive calendar days with any attendance
  const presentDates = new Set(
    records
      .filter(r => ['present','late','half_day'].includes(r.status) || r.approvedLeave)
      .map(r => new Date(r.date).toISOString().slice(0,10))
  );
  const sortedDates = [...presentDates].sort();
  let cur = 0, best = 0, streakSetsPaid = 0, prevD = null;
  for (const d of sortedDates) {
    const isConsec = prevD && (new Date(d) - new Date(prevD)) === 86400000;
    cur = isConsec ? cur + 1 : 1;
    if (cur > best) best = cur;
    const sets = Math.floor(cur / 7);
    if (sets > streakSetsPaid && settings.streakBonusPer7Shifts > 0) {
      const newSets = sets - streakSetsPaid;
      streakSetsPaid = sets;
      const amt = newSets * settings.streakBonusPer7Shifts;
      streakBonusTotal += amt;
      lineItems.push({ label: `🔥 ${sets * 7}-Day Streak Bonus`, amount: amt, type: 'bonus' });
    }
    prevD = d;
  }
  longestStreak = best;

  const bonusBeforeAdvance = r2(noLeaveBonusAmt + perfectAttBonusAmt + streakBonusTotal);

  // ── WASTAGE PENALTY ───────────────────────────────────────
  // Sum all Wastage.penalty > 0 entries for this employee this month.
  const wastageRecords = await Wastage.find({
    employee:  empId,
    createdAt: { $gte: start, $lte: end },
    penalty:   { $gt: 0 },
  }).lean();

  const wastageDeduction    = r2(wastageRecords.reduce((s, w) => s + (w.penalty || 0), 0));
  const wastageRecordCount  = wastageRecords.length;

  if (wastageDeduction > 0) {
    lineItems.push({
      label:  `⚠️ Wastage Penalty (${wastageRecordCount} record${wastageRecordCount !== 1 ? 's' : ''})`,
      amount: -wastageDeduction,
      type:   'deduction',
    });
    totalDeductions = r2(totalDeductions + wastageDeduction);
  }

  // ── ADVANCE DEDUCTION ─────────────────────────────────────
  // Check for approved advances scheduled to be deducted this month
  const advances = await AdvanceRequest.find({
    employee:          empId,
    status:            'approved',
    deductMonth:       month,
    deductYear:        year,
    deductedInPayroll: false,
  }).lean();

  let totalAdvanceDeduction = 0;
  for (const adv of advances) {
    totalAdvanceDeduction += adv.amount;
    lineItems.push({
      label:  `Advance Salary Recovery (requested ${new Date(adv.createdAt).toISOString().slice(0,10)})`,
      amount: -adv.amount,
      type:   'deduction',
    });
  }

  if (totalAdvanceDeduction > 0) {
    totalDeductions = r2(totalDeductions + totalAdvanceDeduction);
  }

  const netPay = r2(Math.max(0, grossEarnings - totalDeductions + bonusBeforeAdvance));

  return {
    employee: empId, year, month, hourlyRate,
    totalShifts, presentShifts, halfDayShifts,
    absentShifts: unapprovedAbsents,
    approvedLeaveShifts, totalLateMinutes,
    unapprovedAbsents, excessAbsents,
    wastageDeduction, wastageRecordCount,
    dayShiftsWorked, nightShiftsWorked,
    dayShiftEarnings:    r2(dayShiftEarnings),
    nightShiftEarnings:  r2(nightShiftEarnings),
    grossEarnings,
    totalDeductions,
    totalBonuses:        bonusBeforeAdvance,
    noLeaveBonus:        noLeaveBonusAmt,
    perfectAttendanceBonus: perfectAttBonusAmt,
    totalStreakBonus:    r2(streakBonusTotal),
    totalAdvanceDeduction: r2(totalAdvanceDeduction),
    longestStreak, perfectAttendance,
    netPay, lineItems, status: 'draft',
    // Store advance ids so engine can mark them deducted after upsert
    _advanceIds: advances.map(a => a._id),
  };
}

// ══════════════════════════════════════════════════════════════
//  SETTINGS
// ══════════════════════════════════════════════════════════════
router.get('/settings', async (req, res) => {
  try {
    const s = await PayrollSettings.findOne({}).lean() ?? {};
    res.json({ success: true, data: s });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.post('/settings', async (req, res) => {
  try {
    const allowed = ['casualLeavesPerMonth','sickLeavesPerMonth','lateGracePeriodMinutes',
                     'penaltyPerExcessAbsent','noLeaveBonus','perfectAttendanceBonus','streakBonusPer7Shifts'];
    const update = {};
    for (const k of allowed) if (req.body[k] !== undefined) update[k] = Number(req.body[k]);
    const s = await PayrollSettings.findOneAndUpdate({}, { $set: update }, { upsert: true, new: true });
    res.json({ success: true, data: s });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ══════════════════════════════════════════════════════════════
//  EMPLOYEES
// ══════════════════════════════════════════════════════════════
router.get('/employees', async (req, res) => {
  try {
    const emps = await Employee.find({})
      .select('name department role skill hourlyRate').sort({ name: 1 }).lean();
    res.json({
      success: true,
      data: emps.map(e => ({
        id: e._id, name: e.name, department: e.department,
        role: e.role ?? '', skill: e.skill ?? 0,
        hourlyRate: e.hourlyRate ?? 0,
        dayShiftPay:   (e.hourlyRate ?? 0) * 12,
        nightShiftPay: (e.hourlyRate ?? 0) * 8,
      })),
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.post('/employees/:id/rate', async (req, res) => {
  try {
    const rate = Number(req.body.hourlyRate);
    if (isNaN(rate) || rate < 0)
      return res.status(400).json({ success: false, message: 'hourlyRate must be ≥ 0' });
    const emp = await Employee.findByIdAndUpdate(
      req.params.id, { $set: { hourlyRate: rate } }, { new: true }
    ).select('name department hourlyRate');
    if (!emp) return res.status(404).json({ success: false, message: 'Employee not found' });
    res.json({
      success: true,
      message: `Rate updated for ${emp.name}`,
      data: { id: emp._id, name: emp.name, department: emp.department,
              hourlyRate: emp.hourlyRate, dayShiftPay: emp.hourlyRate * 12,
              nightShiftPay: emp.hourlyRate * 8 },
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ══════════════════════════════════════════════════════════════
//  GENERATE
// ══════════════════════════════════════════════════════════════
router.post('/generate', async (req, res) => {
  try {
    const { year, month, employeeId } = req.body;
    if (!year || !month)
      return res.status(400).json({ success: false, message: 'year and month required' });

    let empIds = employeeId
      ? [employeeId]
      : (await Employee.find({ hourlyRate: { $gt: 0 } }, '_id').lean()).map(e => e._id.toString());

    if (!empIds.length)
      return res.status(400).json({ success: false, message: 'No employees with hourlyRate set' });

    const results = [], errors = [];
    for (const id of empIds) {
      try {
        const data       = await computePayroll(id, +year, +month);
        const advIds     = data._advanceIds || [];
        delete data._advanceIds;

        await Payroll.findOneAndUpdate(
          { employee: id, year: +year, month: +month },
          { $set: data },
          { upsert: true, new: true }
        ).populate('employee', 'name department');

        // Mark advances as deducted
        if (advIds.length) {
          await AdvanceRequest.updateMany(
            { _id: { $in: advIds } },
            { $set: { deductedInPayroll: true } }
          );
        }

        results.push({ employeeId: id, netPay: data.netPay, status: data.status });
      } catch (err) {
        errors.push({ employeeId: id, error: err.message });
      }
    }

    res.json({
      success: true,
      message: `Generated ${results.length} payroll(s)`,
      data: results,
      errors: errors.length ? errors : undefined,
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  DASHBOARD
// ══════════════════════════════════════════════════════════════
router.get('/dashboard', async (req, res) => {
  try {
    const year  = +(req.query.year  || new Date().getFullYear());
    const month = +(req.query.month || new Date().getMonth() + 1);
    const payrolls = await Payroll.find({ year, month })
      .populate('employee', 'name department hourlyRate').lean();

    const totalNetPay     = payrolls.reduce((s,p) => s + p.netPay,        0);
    const totalGross      = payrolls.reduce((s,p) => s + p.grossEarnings, 0);
    const totalDeductions = payrolls.reduce((s,p) => s + p.totalDeductions,0);
    const totalBonuses    = payrolls.reduce((s,p) => s + p.totalBonuses,  0);

    res.json({
      success: true, year, month,
      summary: {
        totalEmployees:   payrolls.length,
        totalNetPay:      r2(totalNetPay),
        totalGross:       r2(totalGross),
        totalDeductions:  r2(totalDeductions),
        totalBonuses:     r2(totalBonuses),
        perfectCount:     payrolls.filter(p => p.perfectAttendance).length,
        paidCount:        payrolls.filter(p => p.status === 'paid').length,
        finalizedCount:   payrolls.filter(p => p.status === 'finalized').length,
        draftCount:       payrolls.filter(p => p.status === 'draft').length,
      },
      employees: payrolls.map(p => ({
        employeeId:      p.employee?._id ?? p.employee,
        name:            p.employee?.name ?? '–',
        department:      p.employee?.department ?? '–',
        hourlyRate:      p.hourlyRate,
        totalShifts:     p.totalShifts,
        presentShifts:   p.presentShifts,
        absentShifts:    p.absentShifts,
        excessAbsents:   p.excessAbsents ?? 0,
        wastageDeduction: p.wastageDeduction ?? 0,
        grossEarnings:   p.grossEarnings,
        totalDeductions: p.totalDeductions,
        totalBonuses:    p.totalBonuses,
        totalAdvanceDeduction: p.totalAdvanceDeduction ?? 0,
        netPay:          p.netPay,
        perfectAttendance: p.perfectAttendance,
        status:          p.status,
      })).sort((a,b) => b.netPay - a.netPay),
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ══════════════════════════════════════════════════════════════
//  PAYSLIP
// ══════════════════════════════════════════════════════════════
router.get('/slip/:empId', async (req, res) => {
  try {
    const year  = +(req.query.year  || new Date().getFullYear());
    const month = +(req.query.month || new Date().getMonth() + 1);
    const p = await Payroll.findOne({ employee: req.params.empId, year, month })
      .populate('employee', 'name department role phoneNumber hourlyRate').lean();
    if (!p) return res.status(404).json({ success: false, message: 'Not generated yet' });
    res.json({ success: true, data: p });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.put('/:id/finalize', async (req, res) => {
  try {
    const p = await Payroll.findByIdAndUpdate(req.params.id,
      { $set: { status: 'finalized', finalizedAt: new Date() } }, { new: true })
      .populate('employee','name');
    if (!p) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true, data: p });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.put('/:id/pay', async (req, res) => {
  try {
    const { paidBy = 'admin', paymentNote = '' } = req.body;
    const p = await Payroll.findByIdAndUpdate(req.params.id,
      { $set: { status: 'paid', paidAt: new Date(), paidBy, paymentNote } }, { new: true })
      .populate('employee','name');
    if (!p) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true, data: p });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ══════════════════════════════════════════════════════════════
//  LEAVE  (re-exported here for convenience; also in /leave route)
//  These are minimal wrappers — main leave logic stays in /api/v2/leave
// ══════════════════════════════════════════════════════════════
// Leave routes are handled by the separate /leave router.
// The payroll engine already reads Attendance.approvedLeave directly.

// ══════════════════════════════════════════════════════════════
//  ADVANCE SALARY
// ══════════════════════════════════════════════════════════════

// GET /advance?employeeId=&status=&page=&limit=
router.get('/advance', async (req, res) => {
  try {
    const filter = {};
    if (req.query.employeeId) filter.employee = req.query.employeeId;
    if (req.query.status)     filter.status   = req.query.status;
    const advances = await AdvanceRequest.find(filter)
      .populate('employee', 'name department')
      .sort({ createdAt: -1 })
      .limit(+(req.query.limit || 100))
      .lean();
    res.json({ success: true, data: advances });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /advance  — employee submits request (admin can also submit on behalf)
// Body: { employeeId, amount, reason }
router.post('/advance', async (req, res) => {
  try {
    const { employeeId, amount, reason = '' } = req.body;
    if (!employeeId || !amount)
      return res.status(400).json({ success: false, message: 'employeeId and amount required' });
    const emp = await Employee.findById(employeeId, 'name').lean();
    if (!emp) return res.status(404).json({ success: false, message: 'Employee not found' });

    const adv = await AdvanceRequest.create({ employee: employeeId, amount: +amount, reason });
    res.json({ success: true, message: `Advance request submitted for ${emp.name}`, data: adv });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// PUT /advance/:id/approve
// Body: { deductMonth, deductYear, adminNotes? }
router.put('/advance/:id/approve', async (req, res) => {
  try {
    const { deductMonth, deductYear, adminNotes = '', approvedBy = 'admin' } = req.body;
    if (!deductMonth || !deductYear)
      return res.status(400).json({ success: false, message: 'deductMonth and deductYear required' });
    const adv = await AdvanceRequest.findByIdAndUpdate(req.params.id, {
      $set: {
        status: 'approved', deductMonth: +deductMonth, deductYear: +deductYear,
        adminNotes, approvedBy, approvedAt: new Date(),
      },
    }, { new: true }).populate('employee', 'name');
    if (!adv) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true, message: `Approved ₹${adv.amount} for ${adv.employee?.name}`, data: adv });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// PUT /advance/:id/reject
router.put('/advance/:id/reject', async (req, res) => {
  try {
    const adv = await AdvanceRequest.findByIdAndUpdate(req.params.id, {
      $set: { status: 'rejected', adminNotes: req.body.adminNotes || '' },
    }, { new: true }).populate('employee', 'name');
    if (!adv) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true, data: adv });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ══════════════════════════════════════════════════════════════
//  YEARLY BONUS  (10% of total annual salary)
// ══════════════════════════════════════════════════════════════

// POST /yearly-bonus/compute?year=  — compute/recompute for all employees
router.post('/yearly-bonus/compute', async (req, res) => {
  try {
    const year = +(req.query.year || req.body.year || new Date().getFullYear());
    const payrolls = await Payroll.find({ year, status: { $in: ['finalized','paid'] } }).lean();

    // Group by employee
    const empMap = {};
    for (const p of payrolls) {
      const id = p.employee.toString();
      if (!empMap[id]) empMap[id] = { total: 0, count: 0 };
      empMap[id].total += p.netPay;
      empMap[id].count++;
    }

    const results = [];
    for (const [empId, { total, count }] of Object.entries(empMap)) {
      const bonus = r2(total * 0.10);
      const doc   = await YearlyBonus.findOneAndUpdate(
        { employee: empId, year },
        { $set: { totalAnnualPay: r2(total), bonusAmount: bonus, monthsCounted: count } },
        { upsert: true, new: true }
      ).populate('employee', 'name department');
      results.push({
        employeeId:     empId,
        name:           doc.employee?.name ?? '–',
        totalAnnualPay: r2(total),
        bonusAmount:    bonus,
        monthsCounted:  count,
        status:         doc.status,
      });
    }

    res.json({
      success: true,
      message: `Yearly bonus computed for ${results.length} employee(s) (${year})`,
      data:    results.sort((a,b) => b.bonusAmount - a.bonusAmount),
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /yearly-bonus?year=
router.get('/yearly-bonus', async (req, res) => {
  try {
    const year = +(req.query.year || new Date().getFullYear());
    const docs = await YearlyBonus.find({ year })
      .populate('employee', 'name department').sort({ bonusAmount: -1 }).lean();
    res.json({ success: true, data: docs });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// PUT /yearly-bonus/:id/pay
router.put('/yearly-bonus/:id/pay', async (req, res) => {
  try {
    const { paidBy = 'admin', paymentNote = '' } = req.body;
    const doc = await YearlyBonus.findByIdAndUpdate(req.params.id,
      { $set: { status: 'paid', paidAt: new Date(), paidBy, paymentNote } },
      { new: true }
    ).populate('employee', 'name');
    if (!doc) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true, data: doc });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ══════════════════════════════════════════════════════════════
//  ANALYTICS
//  GET /analytics?year=&month=
//  Returns per-employee attendance + earnings performance
// ══════════════════════════════════════════════════════════════
router.get('/analytics', async (req, res) => {
  try {
    const year  = +(req.query.year  || new Date().getFullYear());
    const month = req.query.month ? +req.query.month : null;

    // Fetch payrolls for the period
    const filter = { year };
    if (month) filter.month = month;
    const payrolls = await Payroll.find(filter)
      .populate('employee', 'name department hourlyRate').lean();

    // Group by employee
    const empStats = {};
    for (const p of payrolls) {
      const id  = (p.employee?._id ?? p.employee).toString();
      const name = p.employee?.name ?? '–';
      const dept = p.employee?.department ?? '–';
      if (!empStats[id]) {
        empStats[id] = {
          employeeId: id, name, department: dept,
          hourlyRate: p.hourlyRate ?? 0,
          months: 0, totalShifts: 0, presentShifts: 0,
          absentShifts: 0, approvedLeaveShifts: 0,
          totalLateMinutes: 0, totalGross: 0, totalBonuses: 0,
          totalDeductions: 0, totalNetPay: 0, perfectMonths: 0,
          longestStreak: 0,
        };
      }
      const s = empStats[id];
      s.months++;
      s.totalShifts          += p.totalShifts         ?? 0;
      s.presentShifts        += p.presentShifts        ?? 0;
      s.absentShifts         += p.absentShifts         ?? 0;
      s.approvedLeaveShifts  += p.approvedLeaveShifts  ?? 0;
      s.totalLateMinutes     += p.totalLateMinutes     ?? 0;
      s.totalGross           += p.grossEarnings        ?? 0;
      s.totalBonuses         += p.totalBonuses         ?? 0;
      s.totalDeductions      += p.totalDeductions      ?? 0;
      s.totalNetPay          += p.netPay               ?? 0;
      if (p.perfectAttendance) s.perfectMonths++;
      if ((p.longestStreak ?? 0) > s.longestStreak) s.longestStreak = p.longestStreak;
    }

    const list = Object.values(empStats).map(s => ({
      ...s,
      attendanceRate: s.totalShifts > 0
        ? r2((s.presentShifts + s.approvedLeaveShifts) / s.totalShifts * 100) : 0,
      totalGross:      r2(s.totalGross),
      totalBonuses:    r2(s.totalBonuses),
      totalDeductions: r2(s.totalDeductions),
      totalNetPay:     r2(s.totalNetPay),
    }));

    // Sort by attendance rate descending
    list.sort((a, b) => b.attendanceRate - a.attendanceRate);

    // Rank 1-based
    list.forEach((item, i) => { item.rank = i + 1; });

    // Summary
    const totalPayout = r2(list.reduce((s, e) => s + e.totalNetPay, 0));
    const avgAttRate  = list.length
      ? r2(list.reduce((s, e) => s + e.attendanceRate, 0) / list.length) : 0;

    res.json({
      success: true, year, month: month ?? 'all',
      summary: { totalEmployees: list.length, totalPayout, avgAttendanceRate: avgAttRate },
      data:    list,
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

module.exports = router;