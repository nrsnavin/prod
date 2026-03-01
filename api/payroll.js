// ══════════════════════════════════════════════════════════════
//  PAYROLL ROUTES
//  File: routes/payroll.js
//  Mount: app.use('/api/v2/payroll', require('./routes/payroll'));
//
//  POST   /config/:empId        — set/update employee pay config
//  GET    /config/:empId        — get employee pay config
//  POST   /generate             — generate/regenerate monthly payroll
//  GET    /slip/:empId          — get payslip for employee+month+year
//  GET    /monthly              — all payslips for a month (admin)
//  PUT    /finalise/:payrollId  — finalise (lock) a payroll
//  PUT    /mark-paid/:payrollId — mark as paid
//  GET    /summary              — factory payroll summary for a month
// ══════════════════════════════════════════════════════════════
'use strict';
const express           = require('express');
const router            = express.Router();
const Payroll           = require('../models/Payroll');
const Attendance        = require('../models/Attendance');
const Employee          = require('../models/Employee');
const EmployeePayConfig = require('../models/EmployeePayConfig');
const LeaveRequest      = require('../models/LeaveRequest');

// ── Helpers ───────────────────────────────────────────────────
const SHIFT_HOURS = { DAY: 12, NIGHT: 8 };

function toDateLabel(d) {
  return new Date(d).toLocaleDateString('en-IN',
    { day:'2-digit', month:'short', year:'numeric' });
}

// Resolve hourly rate from config
function resolveHourlyRate(cfg) {
  // If explicit hourly rate set, use it
  if (cfg.hourlyRate > 0) return cfg.hourlyRate;
  // Else compute from day/night flat rates if available
  if (cfg.dayShiftRate > 0 && cfg.nightShiftRate > 0)
    return (cfg.dayShiftRate + cfg.nightShiftRate) / 20; // avg per hour
  return 0;
}

// Compute shift gross pay
function shiftGross(shift, hoursWorked, cfg) {
  const flatRate = shift === 'DAY' ? cfg.dayShiftRate : cfg.nightShiftRate;
  if (flatRate > 0) {
    // Proportional: flat_rate × (hoursWorked / shiftHours)
    return Math.round(flatRate * (hoursWorked / SHIFT_HOURS[shift]));
  }
  return Math.round(cfg.hourlyRate * hoursWorked);
}

// ─────────────────────────────────────────────────────────────
//  POST /config/:empId  — upsert pay config
// ─────────────────────────────────────────────────────────────
router.post('/config/:empId', async (req, res) => {
  try {
    const { empId } = req.params;
    const emp = await Employee.findById(empId, 'name department').lean();
    if (!emp) return res.status(404).json({ success:false, message:'Employee not found.' });

    const allowed = ['hourlyRate','dayShiftRate','nightShiftRate',
      'monthlyLeaveQuota','monthlySickQuota','penaltyPerExcessAbsent',
      'lateDeductionPerMin','perfectAttendanceBonus','streakBonus',
      'noLeaveBonus','effectiveFrom','notes'];
    const update = {};
    for (const k of allowed) {
      if (req.body[k] !== undefined) update[k] = req.body[k];
    }

    const cfg = await EmployeePayConfig.findOneAndUpdate(
      { employee: empId },
      { $set: update },
      { new:true, upsert:true }
    );

    return res.json({ success:true, data:cfg });
  } catch(err) {
    console.error('[POST /config]', err);
    return res.status(500).json({ success:false, message:err.message });
  }
});

// ─────────────────────────────────────────────────────────────
//  GET /config/:empId
// ─────────────────────────────────────────────────────────────
router.get('/config/:empId', async (req, res) => {
  try {
    const cfg = await EmployeePayConfig.findOne({ employee:req.params.empId }).lean();
    return res.json({ success:true, data:cfg || null });
  } catch(err) {
    return res.status(500).json({ success:false, message:err.message });
  }
});

// ─────────────────────────────────────────────────────────────
//  POST /generate  — compute/regenerate payroll for a month
//
//  Body: { month, year, employeeIds? (array; all if omitted) }
//
//  Payroll formula:
//    grossPay       = Σ shiftGross(shift, hoursWorked, cfg)
//    lateDeductions = Σ lateMinutes × lateDeductionPerMin
//    absentPenalty  = max(0, unapprovedAbsents - leaveQuota) × penaltyPerExcessAbsent
//    totalDeductions= lateDeductions + absentPenalty
//    bonuses:
//      perfectAttendance → absentShifts==0 && unapprovedAbsents==0
//      noLeave           → approvedLeaves==0
//      streakBonus       → floor(longestStreak / 7) × streakBonus
//    netPay = grossPay - totalDeductions + totalBonus
// ─────────────────────────────────────────────────────────────
router.post('/generate', async (req, res) => {
  try {
    let { month, year, employeeIds } = req.body;
    month = Number(month); year = Number(year);
    if (!month || !year || month<1 || month>12 || year<2020)
      return res.status(400).json({ success:false, message:'Valid month (1-12) and year required.' });

    const start = new Date(year, month-1, 1);
    const end   = new Date(year, month,   0, 23, 59, 59, 999);

    // Fetch employees
    let employees;
    if (employeeIds && employeeIds.length > 0) {
      employees = await Employee.find({ _id:{ $in:employeeIds } }, 'name department skill role').lean();
    } else {
      employees = await Employee.find({}, 'name department skill role').lean();
    }

    const results = [];

    for (const emp of employees) {
      // Get pay config (skip if none)
      const cfg = await EmployeePayConfig.findOne({ employee:emp._id }).lean();
      if (!cfg) continue;

      // Get attendance records for month
      const records = await Attendance.find({
        employee: emp._id,
        date:     { $gte:start, $lte:end },
      }).lean();

      if (records.length === 0) continue;

      // Summarise
      let totalShifts=0, presentShifts=0, lateShifts=0, halfDayShifts=0;
      let absentShifts=0, approvedLeaves=0, unapprovedAbsents=0;
      let totalHoursWorked=0;
      let grossPay=0, lateDeductions=0;
      let dayCount=0, dayHours=0, dayGross=0;
      let nightCount=0, nightHours=0, nightGross=0;

      // For streak calculation: sorted list of dates where employee was present/late/halfday
      const presentDates = new Set();

      for (const r of records) {
        totalShifts++;
        const hw  = r.hoursWorked ?? 0;
        const sg  = shiftGross(r.shift, hw, cfg);
        totalHoursWorked += hw;

        if (r.shift === 'DAY')   { dayCount++; dayHours += hw; dayGross += sg; }
        if (r.shift === 'NIGHT') { nightCount++; nightHours += hw; nightGross += sg; }
        grossPay += sg;

        const dateStr = new Date(r.date).toISOString().split('T')[0];

        switch(r.status) {
          case 'present':
            presentShifts++;
            presentDates.add(dateStr);
            break;
          case 'late':
            lateShifts++;
            lateDeductions += (r.lateMinutes||0) * (cfg.lateDeductionPerMin||0);
            presentDates.add(dateStr);
            break;
          case 'half_day':
            halfDayShifts++;
            presentDates.add(dateStr);
            break;
          case 'absent':
            absentShifts++;
            unapprovedAbsents++;
            break;
          case 'on_leave':
            if (r.isApprovedLeave) approvedLeaves++;
            else                   unapprovedAbsents++;
            break;
        }
      }

      // Excess absence penalty (beyond quota)
      const effectiveQuota = (cfg.monthlyLeaveQuota||2) + (cfg.monthlySickQuota||1);
      const leavesUsed     = approvedLeaves;
      const excessAbsents  = Math.max(0, unapprovedAbsents - (cfg.monthlyLeaveQuota||2));
      const absentPenalty  = excessAbsents * (cfg.penaltyPerExcessAbsent||0);

      // Bonuses
      let perfectAttBonus = 0, noLeaveBonus = 0, streakBonusAmt = 0;

      if (absentShifts === 0 && unapprovedAbsents === 0)
        perfectAttBonus = cfg.perfectAttendanceBonus || 0;

      if (approvedLeaves === 0 && unapprovedAbsents === 0)
        noLeaveBonus = cfg.noLeaveBonus || 0;

      // Longest consecutive present streak (days, not shifts)
      const sortedDates = [...presentDates].sort();
      let maxStreak = 0, curStreak = 1;
      for (let i=1; i<sortedDates.length; i++) {
        const prev = new Date(sortedDates[i-1]);
        const curr = new Date(sortedDates[i]);
        const diff = (curr - prev) / 86400000;
        if (diff === 1) { curStreak++; maxStreak = Math.max(maxStreak, curStreak); }
        else            { curStreak = 1; }
      }
      if (sortedDates.length === 1) maxStreak = 1;
      const streakWeeks = Math.floor(maxStreak / 7);
      streakBonusAmt = streakWeeks * (cfg.streakBonus || 0);

      const totalDeductions = Math.round(lateDeductions + absentPenalty);
      const totalBonus      = Math.round(perfectAttBonus + noLeaveBonus + streakBonusAmt);
      const netPay          = Math.max(0, Math.round(grossPay - totalDeductions + totalBonus));
      const attendancePct   = totalShifts > 0
        ? Math.round((presentShifts + lateShifts + halfDayShifts * 0.5 + approvedLeaves) / totalShifts * 100)
        : 0;

      const hourlyRate = resolveHourlyRate(cfg);

      const payrollDoc = await Payroll.findOneAndUpdate(
        { employee:emp._id, month, year },
        {
          $set: {
            totalShifts, presentShifts, lateShifts, halfDayShifts,
            absentShifts, approvedLeaves, unapprovedAbsents,
            totalHoursWorked, attendancePct,
            dayBreakdown:   { shift:'DAY',   count:dayCount,   hours:dayHours,   grossPay:dayGross },
            nightBreakdown: { shift:'NIGHT', count:nightCount, hours:nightHours, grossPay:nightGross },
            hourlyRate,
            grossPay: Math.round(grossPay),
            lateDeductions: Math.round(lateDeductions),
            absentPenalty:  Math.round(absentPenalty),
            perfectAttendanceBonus: perfectAttBonus,
            streakBonus:    streakBonusAmt,
            noLeaveBonus,
            totalDeductions, totalBonus, netPay,
            leaveQuota:     cfg.monthlyLeaveQuota||2,
            sickQuota:      cfg.monthlySickQuota||1,
            leavesUsed,
            excessAbsents,
            generatedAt:    new Date(),
          },
        },
        { new:true, upsert:true }
      );

      results.push({
        employeeId:   emp._id,
        employeeName: emp.name,
        payrollId:    payrollDoc._id,
        netPay,
        attendancePct,
      });
    }

    return res.json({
      success: true,
      message: `Payroll generated for ${results.length} employee(s).`,
      month, year,
      data: results,
    });
  } catch(err) {
    console.error('[POST /generate]', err);
    return res.status(500).json({ success:false, message:err.message });
  }
});

// ─────────────────────────────────────────────────────────────
//  GET /slip/:empId  — single payslip
// ─────────────────────────────────────────────────────────────
router.get('/slip/:empId', async (req, res) => {
  try {
    const { month, year } = req.query;
    if (!month || !year)
      return res.status(400).json({ success:false, message:'month and year required.' });

    const [payroll, emp] = await Promise.all([
      Payroll.findOne({ employee:req.params.empId, month:Number(month), year:Number(year) }).lean(),
      Employee.findById(req.params.empId,'name department skill role phoneNumber').lean(),
    ]);

    if (!payroll) return res.status(404).json({ success:false, message:'Payroll not generated yet.' });

    return res.json({ success:true, employee: {
      id:emp._id, name:emp.name, department:emp.department,
      skill:emp.skill, role:emp.role, phone:emp.phoneNumber,
    }, payroll });
  } catch(err) {
    return res.status(500).json({ success:false, message:err.message });
  }
});

// ─────────────────────────────────────────────────────────────
//  GET /monthly  — all payslips for a month
// ─────────────────────────────────────────────────────────────
router.get('/monthly', async (req, res) => {
  try {
    const { month, year } = req.query;
    if (!month || !year)
      return res.status(400).json({ success:false, message:'month and year required.' });

    const payrolls = await Payroll.find({ month:Number(month), year:Number(year) })
      .populate('employee','name department skill role')
      .sort({ netPay:-1 }).lean();

    const totalNetPay   = payrolls.reduce((s,p)=>s+p.netPay, 0);
    const totalGrossPay = payrolls.reduce((s,p)=>s+p.grossPay, 0);
    const avgAttendance = payrolls.length > 0
      ? Math.round(payrolls.reduce((s,p)=>s+p.attendancePct,0)/payrolls.length) : 0;

    return res.json({
      success: true,
      month: Number(month), year: Number(year),
      summary: { count:payrolls.length, totalNetPay, totalGrossPay, avgAttendance },
      data: payrolls.map(p => ({
        payrollId:    p._id,
        employeeId:   p.employee?._id,
        employeeName: p.employee?.name    ?? '–',
        department:   p.employee?.department ?? '–',
        totalShifts:  p.totalShifts,
        attendancePct:p.attendancePct,
        grossPay:     p.grossPay,
        totalDeductions: p.totalDeductions,
        totalBonus:   p.totalBonus,
        netPay:       p.netPay,
        status:       p.status,
        excessAbsents:p.excessAbsents,
      })),
    });
  } catch(err) {
    return res.status(500).json({ success:false, message:err.message });
  }
});

// ─────────────────────────────────────────────────────────────
//  PUT /finalise/:payrollId
// ─────────────────────────────────────────────────────────────
router.put('/finalise/:payrollId', async (req, res) => {
  try {
    const p = await Payroll.findByIdAndUpdate(
      req.params.payrollId,
      { $set:{ status:'finalised', finalisedAt:new Date() } },
      { new:true }
    );
    if (!p) return res.status(404).json({ success:false, message:'Payroll not found.' });
    return res.json({ success:true, data:p });
  } catch(err) {
    return res.status(500).json({ success:false, message:err.message });
  }
});

// ─────────────────────────────────────────────────────────────
//  PUT /mark-paid/:payrollId
// ─────────────────────────────────────────────────────────────
router.put('/mark-paid/:payrollId', async (req, res) => {
  try {
    const p = await Payroll.findByIdAndUpdate(
      req.params.payrollId,
      { $set:{ status:'paid', paidAt:new Date() } },
      { new:true }
    );
    if (!p) return res.status(404).json({ success:false, message:'Payroll not found.' });
    return res.json({ success:true, data:p });
  } catch(err) {
    return res.status(500).json({ success:false, message:err.message });
  }
});

// ─────────────────────────────────────────────────────────────
//  GET /summary  — factory-wide month summary
// ─────────────────────────────────────────────────────────────
router.get('/summary', async (req, res) => {
  try {
    const { month, year } = req.query;
    const payrolls = await Payroll.find({ month:Number(month), year:Number(year) }).lean();
    if (payrolls.length === 0)
      return res.json({ success:true, data:{ totalNetPay:0, totalGrossPay:0,
        totalDeductions:0, totalBonus:0, count:0, avgAttendancePct:0 } });

    const totalNetPay     = payrolls.reduce((s,p)=>s+p.netPay, 0);
    const totalGrossPay   = payrolls.reduce((s,p)=>s+p.grossPay, 0);
    const totalDeductions = payrolls.reduce((s,p)=>s+p.totalDeductions, 0);
    const totalBonus      = payrolls.reduce((s,p)=>s+p.totalBonus, 0);
    const avgAtt          = Math.round(payrolls.reduce((s,p)=>s+p.attendancePct,0)/payrolls.length);

    return res.json({ success:true, data:{
      count: payrolls.length, totalNetPay, totalGrossPay,
      totalDeductions, totalBonus, avgAttendancePct:avgAtt,
    }});
  } catch(err) {
    return res.status(500).json({ success:false, message:err.message });
  }
});

module.exports = router;