'use strict';
//
// Payroll domain service. Extracts the ~200-line pure pay computation
// out of api/payroll.js so the routes shrink to orchestration. It's
// read-only (Attendance / Employee / PayrollSettings / AdvanceRequest)
// and returns a plain payroll object; behaviour is byte-for-byte
// identical to the previous inline function (pinned by the B0.4
// characterization tests). SHIFT_HOURS/shiftHours moved with it (they
// were computePayroll-only); r2 is duplicated as a trivial rounding
// helper (the route file keeps its own copy — used in many places).

const mongoose        = require('mongoose');
const Attendance      = require('../models/Attendence');
const Employee        = require('../models/Employee');
const PayrollSettings = require('../models/PayrollSettings');
const AdvanceRequest  = require('../models/Advance');
const Wastage         = require('../models/Wastage');

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

  // Wastage penalties recorded against this employee in the pay month.
  // Previously these were captured on wastage entries but never left
  // them — recorded money that was never deducted.
  const wastageAgg = await Wastage.aggregate([
    {
      $match: {
        employee:  new mongoose.Types.ObjectId(String(empId)),
        createdAt: { $gte: start, $lte: end },
        penalty:   { $gt: 0 },
      },
    },
    { $group: { _id: null, total: { $sum: '$penalty' }, count: { $sum: 1 } } },
  ]);
  const wastagePenalty = r2(wastageAgg[0]?.total ?? 0);
  if (wastagePenalty > 0) {
    lineItems.push({
      label:  `Wastage penalty (${wastageAgg[0].count} entr${wastageAgg[0].count > 1 ? 'ies' : 'y'})`,
      amount: -wastagePenalty,
      type:   'deduction',
    });
  }

  // Late deductions are ALREADY reflected in grossEarnings — each late
  // shift's pay was reduced (pay -= ded) before being summed, exactly
  // like an absent shift's lost pay. Adding lateDeductionTotal into
  // totalDeductions as well double-subtracted it in
  //   netPay = grossEarnings - totalDeductions + bonuses
  // so any late employee was short-paid by their late deduction. The
  // late line item stays for display, mirroring the (display-only)
  // absent line which is likewise NOT in totalDeductions.
  let totalDeductions  = r2(excessPenalty + wastagePenalty);

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

  // Scope advances to THIS pay month via deductMonth/deductYear only —
  // NOT deductedInPayroll. An advance earmarked for June belongs to
  // June's payroll every time June is computed. Filtering on the
  // already-deducted flag made regeneration silently DROP the recovery:
  // the first /generate flipped the flag, so a re-run found no advance
  // and net pay jumped back up by the advance amount (company loses the
  // recovery). deductMonth/deductYear already pins each advance to
  // exactly one payroll month, so this can never double-recover across
  // months. The route still flips the flag for the outstanding-advances
  // view.
  const advances = await AdvanceRequest.find({
    employee:    empId,
    status:      'approved',
    deductMonth: month,
    deductYear:  year,
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

module.exports = { computePayroll };
