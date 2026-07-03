// ══════════════════════════════════════════════════════════════
//  PAYROLL ROUTE  v3
//  Mount: app.use('/api/v2/payroll', require('./api/payroll.js'));
//
//  Auth (AUTH = login required; ADMIN = role 'admin'):
//    Worker-facing (AUTH): GET /slip/:empId, POST /advance
//    Everything else        ADMIN
// ══════════════════════════════════════════════════════════════
'use strict';

const express          = require('express');
const mongoose         = require('mongoose');
const router           = express.Router();
const Attendance       = require('../models/Attendence');
const Employee         = require('../models/Employee');
const Payroll          = require('../models/Payroll');
const PayrollSettings  = require('../models/PayrollSettings');
const AdvanceRequest   = require('../models/Advance');
const YearlyBonus      = require('../models/YearlyBonus');
const { isAuthenticated, isAdmin, selfOrAdmin } = require('../middleware/auth');
const { EMPLOYEE_CARD_FIELDS } = require('../utils/populateFields');

router.use(isAuthenticated);

const SHIFT_HOURS = { DAY: 12, NIGHT: 8 };
const r2 = (n) => Math.round(n * 100) / 100;
const shiftHours = (s) => SHIFT_HOURS[s] ?? 8;

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

    if (rec.isApprovedLeave === true) {
      approvedLeaveShifts++;
      const pay = fullPay;
      if (rec.shift === 'DAY')   { dayShiftsWorked++;   dayShiftEarnings   += pay; }
      if (rec.shift === 'NIGHT') { nightShiftsWorked++; nightShiftEarnings += pay; }
      lineItems.push({
        label:  `✅ Approved Leave — paid (${rec.shift} ${dateStr})`,
        amount: pay,
        type:   'earning',
      });
      continue;
    }

    if (rec.status === 'absent' || rec.status === 'on_leave') {
      unapprovedAbsents++;
      lineItems.push({
        label:  `Absent — pay lost (${rec.shift} ${dateStr})`,
        amount: -fullPay,
        type:   'deduction',
      });
      continue;
    }

    if (rec.status === 'half_day') {
      halfDayShifts++;
      const pay = fullPay / 2;
      if (rec.shift === 'DAY')   { dayShiftsWorked++;   dayShiftEarnings   += pay; }
      if (rec.shift === 'NIGHT') { nightShiftsWorked++; nightShiftEarnings += pay; }
      lineItems.push({ label: `Half Day (${rec.shift} ${dateStr})`, amount: pay, type: 'earning' });
      continue;
    }

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

  const presentDates = new Set(
    records
      .filter(r => ['present','late','half_day'].includes(r.status) || r.isApprovedLeave)
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
    _advanceIds: advances.map(a => a._id),
  };
}

router.get('/settings', isAdmin('admin'), async (req, res) => {
  try {
    const s = await PayrollSettings.findOne({}).lean() ?? {};
    res.json({ success: true, data: s });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.post('/settings', isAdmin('admin'), async (req, res) => {
  try {
    const allowed = ['casualLeavesPerMonth','sickLeavesPerMonth','lateGracePeriodMinutes',
                     'penaltyPerExcessAbsent','noLeaveBonus','perfectAttendanceBonus','streakBonusPer7Shifts'];
    const update = {};
    for (const k of allowed) if (req.body[k] !== undefined) update[k] = Number(req.body[k]);
    const s = await PayrollSettings.findOneAndUpdate({}, { $set: update }, { upsert: true, new: true });
    res.json({ success: true, data: s });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.get('/employees', isAdmin('admin'), async (req, res) => {
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

router.post('/employees/:id/rate', isAdmin('admin'), async (req, res) => {
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

router.post('/generate', isAdmin('admin'), async (req, res) => {
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
      const session = await mongoose.startSession();
      try {
        // Payroll upsert + advance flip must land or roll back as one
        // unit. Without a transaction, two parallel /generate calls
        // could each see the same advance unflagged and deduct it
        // twice. The advance flip filter additionally re-asserts
        // `deductedInPayroll: { $ne: true }` so a stale read on this
        // side becomes a no-op instead of a double write.
        await session.withTransaction(async () => {
          const data   = await computePayroll(id, +year, +month);
          const advIds = data._advanceIds || [];
          delete data._advanceIds;

          await Payroll.findOneAndUpdate(
            { employee: id, year: +year, month: +month },
            { $set: data },
            { upsert: true, new: true, session }
          );

          if (advIds.length) {
            await AdvanceRequest.updateMany(
              { _id: { $in: advIds }, deductedInPayroll: { $ne: true } },
              { $set: { deductedInPayroll: true } },
              { session }
            );
          }

          results.push({ employeeId: id, netPay: data.netPay, status: data.status });
        });
      } catch (err) {
        errors.push({ employeeId: id, error: err.message });
      } finally {
        await session.endSession();
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

router.get('/dashboard', isAdmin('admin'), async (req, res) => {
  try {
    const year  = +(req.query.year  || new Date().getFullYear());
    const month = +(req.query.month || new Date().getMonth() + 1);
    const payrolls = await Payroll.find({ year, month })
      .populate('employee', 'name department hourlyRate').lean();

    // One corrupt row used to poison every total via NaN propagation;
    // skip any field that isn't a finite number.
    const sum = (key) => payrolls.reduce(
      (s, p) => s + (Number.isFinite(p[key]) ? p[key] : 0), 0
    );
    const totalNetPay     = sum('netPay');
    const totalGross      = sum('grossEarnings');
    const totalDeductions = sum('totalDeductions');
    const totalBonuses    = sum('totalBonuses');

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

// Worker-facing — employees view their own payslip.
// selfOrAdmin blocks one worker from reading another's slip by id swap.
router.get('/slip/:empId', selfOrAdmin, async (req, res) => {
  try {
    const year  = +(req.query.year  || new Date().getFullYear());
    const month = +(req.query.month || new Date().getMonth() + 1);
    const p = await Payroll.findOne({ employee: req.params.empId, year, month })
      .populate('employee', EMPLOYEE_CARD_FIELDS).lean();
    if (!p) return res.status(404).json({ success: false, message: 'Not generated yet' });
    res.json({ success: true, data: p });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.put('/:id/finalize', isAdmin('admin'), async (req, res) => {
  try {
    const p = await Payroll.findByIdAndUpdate(req.params.id,
      { $set: { status: 'finalized', finalizedAt: new Date() } }, { new: true })
      .populate('employee','name');
    if (!p) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true, data: p });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.put('/:id/pay', isAdmin('admin'), async (req, res) => {
  try {
    const { paidBy = 'admin', paymentNote = '' } = req.body;
    const p = await Payroll.findByIdAndUpdate(req.params.id,
      { $set: { status: 'paid', paidAt: new Date(), paidBy, paymentNote } }, { new: true })
      .populate('employee','name');
    if (!p) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true, data: p });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.get('/advance', isAdmin('admin'), async (req, res) => {
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

// Worker-facing — any authenticated employee can request an advance.
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

router.put('/advance/:id/approve', isAdmin('admin'), async (req, res) => {
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

router.put('/advance/:id/reject', isAdmin('admin'), async (req, res) => {
  try {
    const adv = await AdvanceRequest.findByIdAndUpdate(req.params.id, {
      $set: { status: 'rejected', adminNotes: req.body.adminNotes || '' },
    }, { new: true }).populate('employee', 'name');
    if (!adv) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true, data: adv });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.post('/yearly-bonus/compute', isAdmin('admin'), async (req, res) => {
  try {
    const year = +(req.query.year || req.body.year || new Date().getFullYear());
    const payrolls = await Payroll.find({ year, status: { $in: ['finalized','paid'] } }).lean();

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

router.get('/yearly-bonus', isAdmin('admin'), async (req, res) => {
  try {
    const year = +(req.query.year || new Date().getFullYear());
    const docs = await YearlyBonus.find({ year })
      .populate('employee', 'name department').sort({ bonusAmount: -1 }).lean();
    res.json({ success: true, data: docs });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.put('/yearly-bonus/:id/pay', isAdmin('admin'), async (req, res) => {
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

router.get('/analytics', isAdmin('admin'), async (req, res) => {
  try {
    const year  = +(req.query.year  || new Date().getFullYear());
    const month = req.query.month ? +req.query.month : null;

    const filter = { year };
    if (month) filter.month = month;
    const payrolls = await Payroll.find(filter)
      .populate('employee', 'name department hourlyRate').lean();

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

    list.sort((a, b) => b.attendanceRate - a.attendanceRate);
    list.forEach((item, i) => { item.rank = i + 1; });

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

router.get('/attendance', isAdmin('admin'), async (req, res) => {
  try {
    const { employeeId, year, month } = req.query;
    if (!employeeId || !year || !month)
      return res.status(400).json({ success: false, message: 'employeeId, year and month are required' });

    const start = new Date(+year, +month - 1, 1);
    const end   = new Date(+year, +month,     0, 23, 59, 59, 999);

    const records = await Attendance.find({
      employee: employeeId,
      date: { $gte: start, $lte: end },
    }).sort({ date: 1, shift: 1 }).lean();

    const s = await PayrollSettings.findOne({}).lean() ?? {};
    const graceMinutes = s.overtimeGraceMinutes ?? 60;

    const days = records.map((r) => {
      const rawOt       = r.overtimeMinutes ?? 0;
      const billableOt  = Math.max(0, rawOt - graceMinutes);
      return {
        date:             new Date(r.date).toISOString().slice(0, 10),
        shift:            r.shift,
        status:           r.status,
        approvedLeave:    r.isApprovedLeave ?? false,
        lateMinutes:      r.lateMinutes   ?? 0,
        overtimeMinutes:  rawOt,
        billableOtMinutes: billableOt,
        hasOvertime:      rawOt > 0,
        overtimePaid:     billableOt > 0,
      };
    });

    const summary = {
      present:       days.filter(d => ['present','late'].includes(d.status) && !d.approvedLeave).length,
      absent:        days.filter(d => ['absent','on_leave'].includes(d.status) && !d.approvedLeave).length,
      halfDay:       days.filter(d => d.status === 'half_day').length,
      approvedLeave: days.filter(d => d.approvedLeave).length,
      overtime:      days.filter(d => d.hasOvertime).length,
      overtimePaid:  days.filter(d => d.overtimePaid).length,
      totalOtMinutes: days.reduce((s, d) => s + d.overtimeMinutes, 0),
    };

    res.json({ success: true, days, summary });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});


// ══════════════════════════════════════════════════════════════
//  AUTO-GENERATE  (idempotent)
//  POST /auto-generate?period=YYYY-MM
//
//  Designed for unattended calls — from a future cron, from the
//  Flutter AIAdvisor on the 1st of the month, or from a manual
//  retry. Safe to call repeatedly.
//
//  Decision tree:
//    1. period defaults to LAST completed month (so calling on
//       Jun 1 generates May's payroll, which is what the user
//       actually wants).
//    2. If every active operator already has a Payroll row for
//       the period → reason: ALREADY_GENERATED, triggered: false.
//    3. Else compute attendance completeness for the period:
//         coveredDays / (employees × workingDays).
//       If < 0.9 → reason: ATTENDANCE_INCOMPLETE.
//    4. Else run the same per-employee computePayroll loop the
//       existing /generate uses. Re-runs only employees who don't
//       yet have a payroll row (so a partial prior run can finish
//       cleanly on retry).
// ══════════════════════════════════════════════════════════════
router.post('/auto-generate', isAdmin('admin'), async (req, res) => {
  try {
    // Default to the last completed month so the typical "1st of
    // the month" trigger does the right thing without the client
    // having to subtract.
    let year, month;
    const period = (req.query.period || req.body?.period || '').trim();
    if (period) {
      const m = period.match(/^(\d{4})-(\d{2})$/);
      if (!m) return res.status(400).json({
        success: false, message: 'period must be YYYY-MM',
      });
      year = +m[1]; month = +m[2];
    } else {
      const now  = new Date();
      const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      year  = prev.getFullYear();
      month = prev.getMonth() + 1;
    }

    const empIds = (await Employee
      .find({ hourlyRate: { $gt: 0 } }, '_id')
      .lean()).map((e) => e._id.toString());

    if (empIds.length === 0) {
      return res.json({
        success: false,
        triggered: false,
        reason: 'NO_ACTIVE_EMPLOYEES',
        period: `${year}-${String(month).padStart(2, '0')}`,
      });
    }

    // Already-generated check: count existing payroll rows in scope.
    const existing = await Payroll.find(
      { year, month, employee: { $in: empIds } },
      '_id employee'
    ).lean();

    if (existing.length >= empIds.length) {
      return res.json({
        success: true,
        triggered: false,
        reason: 'ALREADY_GENERATED',
        period: `${year}-${String(month).padStart(2, '0')}`,
        existingCount: existing.length,
      });
    }

    // Completeness gate. Working days = distinct dates in the period
    // that have at least one attendance record (same heuristic as
    // /repeatedly-unmarked, keeps us off a hardcoded holiday model).
    const periodStart = new Date(year, month - 1, 1);
    const periodEnd   = new Date(year, month, 1);
    const att = await Attendance.find({
      date: { $gte: periodStart, $lt: periodEnd },
      employee: { $in: empIds },
    }).select('employee date').lean();

    const dayKey      = (d) => new Date(d).toISOString().slice(0, 10);
    const workingDays = new Set(att.map((r) => dayKey(r.date)));
    const denom       = empIds.length * workingDays.size;
    const completenessPct = denom > 0
      ? Math.round((att.length / denom) * 100)
      : 0;

    if (workingDays.size === 0 || completenessPct < 90) {
      return res.json({
        success: true,
        triggered: false,
        reason: 'ATTENDANCE_INCOMPLETE',
        period: `${year}-${String(month).padStart(2, '0')}`,
        completenessPct,
      });
    }

    // Run only employees that don't yet have a row — supports
    // resuming a partial prior run.
    const haveRow = new Set(existing.map((p) => String(p.employee)));
    const todo    = empIds.filter((id) => !haveRow.has(id));

    const results = [], errors = [];
    for (const id of todo) {
      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          const data   = await computePayroll(id, year, month);
          const advIds = data._advanceIds || [];
          delete data._advanceIds;

          await Payroll.findOneAndUpdate(
            { employee: id, year, month },
            { $set: data },
            { upsert: true, new: true, session }
          );

          if (advIds.length) {
            await AdvanceRequest.updateMany(
              { _id: { $in: advIds }, deductedInPayroll: { $ne: true } },
              { $set: { deductedInPayroll: true } },
              { session }
            );
          }

          results.push({ employeeId: id, netPay: data.netPay });
        });
      } catch (err) {
        errors.push({ employeeId: id, error: err.message });
      } finally {
        await session.endSession();
      }
    }

    return res.json({
      success: true,
      triggered: true,
      period: `${year}-${String(month).padStart(2, '0')}`,
      completenessPct,
      result: {
        generated:       results.length,
        skippedExisting: existing.length,
        errors:          errors.length ? errors : undefined,
      },
    });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  GET /outstanding-advances
//  Approved advances whose deduct month/year has already passed
//  but `deductedInPayroll` is still false — payroll either didn't
//  run for that period or skipped them. Powers the AIAdvisor
//  card pointing back at the payroll module so the admin can
//  re-run / investigate.
// ══════════════════════════════════════════════════════════════
router.get('/outstanding-advances', isAdmin('admin'), async (_req, res) => {
  try {
    const now = new Date();
    const curYear  = now.getFullYear();
    const curMonth = now.getMonth() + 1;

    const advances = await AdvanceRequest.find({
      status: 'approved',
      deductedInPayroll: false,
      // deductYear/deductMonth strictly earlier than current period.
      // Note: an advance approved for current month is not "overdue"
      // until next month — current-period skips might be a payroll
      // not yet run, not a missed deduction.
      $or: [
        { deductYear: { $lt: curYear } },
        { deductYear: curYear, deductMonth: { $lt: curMonth } },
      ],
    })
      .populate('employee', 'name department')
      .sort({ deductYear: 1, deductMonth: 1 })
      .lean();

    const out = advances
      .filter((a) => a.deductYear && a.deductMonth)
      .map((a) => {
        const monthsOverdue =
          (curYear - a.deductYear) * 12 + (curMonth - a.deductMonth);
        return {
          advanceId:    a._id,
          employeeId:   a.employee?._id ?? a.employee,
          name:         a.employee?.name ?? '—',
          department:   a.employee?.department ?? '',
          amount:       a.amount,
          deductMonth:  a.deductMonth,
          deductYear:   a.deductYear,
          monthsOverdue,
        };
      });

    const totalAmount = out.reduce((s, a) => s + (a.amount || 0), 0);

    return res.json({
      success:     true,
      advances:    out,
      count:       out.length,
      totalAmount,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
