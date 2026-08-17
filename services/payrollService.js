'use strict';
//
// Payroll domain service — the pure monthly pay computation used by the
// /generate + /auto-generate routes. Read-only (Attendance / Employee /
// PayrollSettings / AdvanceRequest / Wastage / ShiftDetail); returns a
// plain payroll object plus an `_advanceRecoveries` plan the route applies
// transactionally.

const mongoose        = require('mongoose');
const Attendance      = require('../models/Attendence');
const Employee        = require('../models/Employee');
const PayrollSettings = require('../models/PayrollSettings');
const AdvanceRequest  = require('../models/Advance');
const Wastage         = require('../models/Wastage');
const ShiftDetail     = require('../models/ShiftDetail');

// Shared with the order P&L, which charges a job's labour against the
// same scheduled length payroll pays it at — see utils/shiftHours.js.
const { shiftHours } = require('../utils/shiftHours');

const r2 = (n) => Math.round(n * 100) / 100;

/**
 * A date as the factory sees it, not as UTC sees it.
 *
 * `toISOString().slice(0,10)` was used for every date key and every
 * payslip line label. Attendance and ShiftDetail dates are written at
 * LOCAL midnight, so on a server east of Greenwich — the factory runs
 * on IST — that conversion lands on the previous calendar day: a shift
 * worked on the 1st is labelled the last day of the previous month, and
 * the streak calculation groups by a day that is off by one. It is
 * invisible on a UTC box, which is why it survived.
 */
const ymd = (d) => {
  const x = new Date(d);
  const m = String(x.getMonth() + 1).padStart(2, '0');
  const day = String(x.getDate()).padStart(2, '0');
  return `${x.getFullYear()}-${m}-${day}`;
};

const dayKey = (d, sh) => `${ymd(d)}|${sh}`;

// Resolve a shift's actual worked minutes for actual-hours pay. Priority:
//   1. live timer (clockInAt → clockOutAt)  — server-stamped, authoritative
//   2. a stored workedMinutes value          — persisted at clock-out
//   3. manual times (checkIn/checkOut "HH:mm") — night shifts wrap past midnight
// Returns null when no duration is known, so the caller falls back to the
// scheduled-hours model (a plain "present" mark with no timer still pays a
// full shift, keeping legacy data unchanged).
function resolveWorkedMinutes(rec) {
  if (rec.clockInAt && rec.clockOutAt) {
    const mins = (new Date(rec.clockOutAt) - new Date(rec.clockInAt)) / 60000;
    if (mins > 0) return mins;
  }
  if (Number.isFinite(rec.workedMinutes) && rec.workedMinutes > 0) return rec.workedMinutes;
  if (rec.checkIn && rec.checkOut) {
    const toMin = (t) => {
      const [h, m] = String(t).split(':').map(Number);
      return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : NaN;
    };
    let inM = toMin(rec.checkIn), outM = toMin(rec.checkOut);
    if (Number.isFinite(inM) && Number.isFinite(outM)) {
      if (outM <= inM) outM += 24 * 60; // crossed midnight (night shift)
      return outM - inM;
    }
  }
  return null;
}

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
    overtimeMultiplier:     s.overtimeMultiplier     ?? 1.25,
    overtimeGraceMinutes:   s.overtimeGraceMinutes   ?? 120,
    maxOvertimeMinutesPerShift: s.maxOvertimeMinutesPerShift ?? 240,
    pfPercent:      s.pfPercent      ?? 0,
    pfWageCeiling:  s.pfWageCeiling  ?? 0,
    esiPercent:     s.esiPercent     ?? 0,
    esiWageCeiling: s.esiWageCeiling ?? 0,
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
  let totalOvertimeMinutes = 0;
  let overtimeEarnings     = 0;

  for (const rec of records) {
    const sh      = shiftHours(rec.shift);
    const fullPay = hourlyRate * sh;
    const dateStr = ymd(rec.date);

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
    const capMinutes = sh * 60;
    const worked     = resolveWorkedMinutes(rec);
    // Minutes that feed overtime: when a shift timer / manual in-out is
    // recorded, overtime is whatever was worked beyond the 12h shift;
    // otherwise fall back to the manually-entered overtimeMinutes field.
    let otSourceMinutes;

    if (worked != null) {
      // Actual-hours pay: the timer is the source of truth. Base pay is the
      // worked time capped at the shift length; a short shift simply pays
      // less, and lateness is already reflected (no separate late cut).
      const basePaidMin = Math.min(worked, capMinutes);
      pay = r2((basePaidMin / 60) * hourlyRate);
      otSourceMinutes = Math.max(0, worked - capMinutes);
      lineItems.push({
        label:  `${rec.shift} Shift ${r2(basePaidMin / 60)}h worked (${dateStr})`,
        amount: pay,
        type:   'earning',
      });
    } else {
      // Legacy path: no timer recorded → pay the full scheduled shift and
      // apply the late-minutes deduction as before.
      const lateMins     = rec.lateMinutes ?? 0;
      const billableMins = Math.max(0, lateMins - settings.lateGracePeriodMinutes);
      if (billableMins > 0) {
        // Cap the cut at the shift's pay — a data-entry error (or being
        // later than the shift is long) must never produce a NEGATIVE
        // shift earning that silently eats other shifts' pay.
        const ded        = Math.min(fullPay, (billableMins / 60) * hourlyRate);
        pay             -= ded;
        totalLateMinutes += lateMins;
        lateDeductionTotal += ded;
        lineItems.push({
          label:  `Late deduction ${billableMins}m (${rec.shift} ${dateStr})`,
          amount: -ded,
          type:   'deduction',
        });
      }
      otSourceMinutes = rec.overtimeMinutes ?? 0;
      lineItems.push({
        label:  `${rec.shift} Shift (${dateStr})`,
        amount: pay,
        type:   'earning',
      });
    }
    if (rec.shift === 'DAY')   { dayShiftsWorked++;   dayShiftEarnings   += pay; }
    if (rec.shift === 'NIGHT') { nightShiftsWorked++; nightShiftEarnings += pay; }

    // Overtime — minutes beyond the shift, past the grace window, paid at
    // rate × multiplier. Tracked separately from base shift earnings.
    //
    // ── And CAPPED, which it was not ──────────────────────────────────
    // Base pay above takes `Math.min(worked, capMinutes)`, so a worked
    // duration longer than the shift costs nothing there. The overtime
    // derived from the very same figure had no ceiling: a clock-in with
    // no clock-out until somebody noticed days later gave `worked` in
    // days, and every minute past the shift was paid at 1.25×. Measured:
    // one forgotten clock-out turned a ₹1,200 day into ₹9,250 of net
    // pay, and it read on the payslip as an ordinary overtime line.
    //
    // A cap is the honest treatment because the input is not overtime,
    // it is a missing clock-out — but silently dropping it would hide a
    // data problem somebody needs to fix, so the label says it was
    // capped and by how much.
    const rawOtMins = Math.max(0, otSourceMinutes - settings.overtimeGraceMinutes);
    const maxOt     = settings.maxOvertimeMinutesPerShift;
    const otMins    = maxOt > 0 ? Math.min(rawOtMins, maxOt) : rawOtMins;
    const wasCapped = otMins < rawOtMins;

    if (otMins > 0 && hourlyRate > 0) {
      const otPay = (otMins / 60) * hourlyRate * settings.overtimeMultiplier;
      totalOvertimeMinutes += otMins;
      overtimeEarnings     += otPay;
      lineItems.push({
        label: wasCapped
          ? `Overtime ${otMins}m ×${settings.overtimeMultiplier} (${rec.shift} ${dateStr})` +
            ` — capped from ${Math.round(rawOtMins)}m; check the clock-out`
          : `Overtime ${otMins}m ×${settings.overtimeMultiplier} (${rec.shift} ${dateStr})`,
        amount: otPay,
        type:   'earning',
      });
    }
  }

  // ── Unmarked scheduled shifts count as unapproved absents ────────────
  // A ShiftDetail (the employee was on a scheduled shift) with no matching
  // Attendance row means attendance was never recorded — treat it as an
  // absent so the pay isn't silently skipped. De-duped to unique (date,shift).
  //
  // Only ELAPSED, CLOSED shifts count: a shift whose day hasn't finished
  // yet (generating mid-month) or that is still open/running/awaiting
  // verification is not "unmarked" — it just hasn't happened / been closed
  // — so it must never be penalised as an absent.
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const attSet = new Set(records.map((r) => dayKey(r.date, r.shift)));
  const scheduled = await ShiftDetail.find({
    employee: empId,
    date: { $gte: start, $lte: end, $lt: startOfToday }, // only fully-past days
    status: 'closed',                                    // only completed shifts
  }).select('date shift').lean();
  const schedSeen = new Set();
  for (const sd of scheduled) {
    const k = dayKey(sd.date, sd.shift);
    if (schedSeen.has(k) || attSet.has(k)) continue;
    schedSeen.add(k);
    unapprovedAbsents++;
    totalShifts++;
    const fullPay = hourlyRate * shiftHours(sd.shift);
    lineItems.push({
      label:  `Absent — no attendance for scheduled ${sd.shift} (${ymd(sd.date)})`,
      amount: -fullPay,
      type:   'deduction',
    });
  }

  const grossEarnings = r2(dayShiftEarnings + nightShiftEarnings + overtimeEarnings);

  const excessAbsents = Math.max(0, unapprovedAbsents - leaveQuota);
  const excessPenalty = excessAbsents * settings.penaltyPerExcessAbsent;
  if (excessAbsents > 0) {
    lineItems.push({
      label:  `Excess absent penalty (${excessAbsents} × ₹${settings.penaltyPerExcessAbsent})`,
      amount: -excessPenalty,
      type:   'deduction',
    });
  }

  // Wastage penalties attributed to the pay month by INCIDENT date
  // (falls back to createdAt for legacy rows that never set incidentDate).
  const wastageAgg = await Wastage.aggregate([
    { $match: { employee: new mongoose.Types.ObjectId(String(empId)), penalty: { $gt: 0 } } },
    { $addFields: { effDate: { $ifNull: ['$incidentDate', '$createdAt'] } } },
    { $match: { effDate: { $gte: start, $lte: end } } },
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

  // Statutory deductions (0 unless configured). PF on wage capped at the
  // PF ceiling; ESI only when wage is within the ESI ceiling.
  const pfBase = settings.pfWageCeiling > 0 ? Math.min(grossEarnings, settings.pfWageCeiling) : grossEarnings;
  const pfDeduction = settings.pfPercent > 0 ? r2(pfBase * settings.pfPercent / 100) : 0;
  const esiApplies  = settings.esiPercent > 0 && (settings.esiWageCeiling <= 0 || grossEarnings <= settings.esiWageCeiling);
  const esiDeduction = esiApplies ? r2(grossEarnings * settings.esiPercent / 100) : 0;
  if (pfDeduction > 0)  lineItems.push({ label: `PF (${settings.pfPercent}%)`,  amount: -pfDeduction,  type: 'deduction' });
  if (esiDeduction > 0) lineItems.push({ label: `ESI (${settings.esiPercent}%)`, amount: -esiDeduction, type: 'deduction' });

  // Late deductions are ALREADY reflected in grossEarnings (each late
  // shift's pay was reduced before summing), so they are NOT added to
  // totalDeductions — only the penalties/statutory that live outside gross.
  let totalDeductions = r2(excessPenalty + wastagePenalty + pfDeduction + esiDeduction);

  let noLeaveBonusAmt       = 0;
  let perfectAttBonusAmt    = 0;
  let streakBonusTotal      = 0;
  let longestStreak         = 0;
  let perfectAttendance     = false;

  if (approvedLeaveShifts === 0 && unapprovedAbsents === 0 && settings.noLeaveBonus > 0) {
    noLeaveBonusAmt = settings.noLeaveBonus;
    lineItems.push({ label: '🌟 No-Leave Bonus', amount: noLeaveBonusAmt, type: 'bonus' });
  }

  // "Perfect attendance" requires actually working — an all-approved-
  // leave month has zero absents and non-zero shifts but nobody showed
  // up, so it must not earn the bonus.
  if (unapprovedAbsents === 0 && totalShifts > 0 && (presentShifts > 0 || halfDayShifts > 0)
      && settings.perfectAttendanceBonus > 0) {
    perfectAttendance  = true;
    perfectAttBonusAmt = settings.perfectAttendanceBonus;
    lineItems.push({ label: '🏆 Perfect Attendance Bonus', amount: perfectAttBonusAmt, type: 'bonus' });
  }

  const presentDates = new Set(
    records
      .filter(r => ['present','late','half_day'].includes(r.status) || r.isApprovedLeave)
      .map(r => ymd(r.date))
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

  // ── Advance recovery with carry-forward (installments) ───────────────
  // Recover from every approved advance whose deduct period has ARRIVED
  // (this month or earlier) and still has an outstanding balance, oldest
  // first, but only up to what this month's pay can absorb. Whatever can't
  // be recovered stays as remainingBalance and carries into next month —
  // no more silent write-offs when an advance exceeds a month's net.
  const advances = await AdvanceRequest.find({
    employee: empId,
    // Recover only what the employee actually holds: paid-out advances
    // (and legacy 'approved' rows from before the paid_out state existed).
    status:   { $in: AdvanceRequest.RECOVERABLE_STATUSES },
    $or: [
      { deductYear: { $lt: year } },
      { deductYear: year, deductMonth: { $lte: month } },
    ],
  }).sort({ deductYear: 1, deductMonth: 1, createdAt: 1 }).lean();

  let available = Math.max(0, grossEarnings - totalDeductions + bonusBeforeAdvance);
  let totalAdvanceDeduction = 0;
  const advanceRecoveries = [];
  for (const adv of advances) {
    const remaining = adv.remainingBalance != null ? adv.remainingBalance : adv.amount;
    if (remaining <= 0) continue;
    if (available <= 0) break;
    const rec = r2(Math.min(remaining, available));
    available = r2(available - rec);
    totalAdvanceDeduction = r2(totalAdvanceDeduction + rec);
    advanceRecoveries.push({ id: adv._id, recovered: rec, remaining: r2(remaining - rec) });
    lineItems.push({
      label:  `Advance Salary Recovery ₹${rec}${remaining - rec > 0 ? ` (₹${r2(remaining - rec)} carried forward)` : ''}`,
      amount: -rec,
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
    totalOvertimeMinutes,
    overtimeEarnings:    r2(overtimeEarnings),
    grossEarnings,
    totalDeductions,
    pfDeduction,
    esiDeduction,
    totalBonuses:        bonusBeforeAdvance,
    noLeaveBonus:        noLeaveBonusAmt,
    perfectAttendanceBonus: perfectAttBonusAmt,
    totalStreakBonus:    r2(streakBonusTotal),
    totalAdvanceDeduction: r2(totalAdvanceDeduction),
    longestStreak, perfectAttendance,
    netPay, lineItems, status: 'draft',
    _advanceRecoveries: advanceRecoveries,
  };
}

module.exports = { computePayroll };
