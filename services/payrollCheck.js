'use strict';
// ══════════════════════════════════════════════════════════════════
//  PAYROLL, CHECKED BEFORE THE MONEY GOES OUT
//
//  A month's payslips are generated from attendance and paid one by one;
//  nothing compared a slip with the worker's own recent months first.
//  This does, and says why in figures, so a slip that is 40% up, carries
//  forty hours of overtime, or pays someone who worked no shift is looked
//  at before it is paid — not found in the bank statement.
//
//  The rules are plain arithmetic on the slips themselves; nothing here
//  changes a slip. Severity: `high` (very likely wrong — negative pay,
//  pay with no shift worked), `check` (unusual for this worker), `info`
//  (worth knowing — a first month, a rate change).
// ══════════════════════════════════════════════════════════════════

const Payroll = require('../models/Payroll');

const LOOKBACK = 3;
const JUMP_PCT = 30;        // net pay this far from the recent average…
const JUMP_MIN = 2000;      // …and by at least this many rupees
const OT_FLOOR_MIN = 20 * 60;
const ABSENTS = 4;
const DEDUCTION_PCT = 50;

const inr = (n) => `₹${Math.round(Number(n) || 0).toLocaleString('en-IN')}`;
const hours = (m) => `${Math.round((Number(m) || 0) / 60)} h`;
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const monthIndex = (y, m) => y * 12 + (m - 1);

/** The flags for one slip against that worker's previous slips (newest first). */
function flagsFor(slip, history) {
  const out = [];
  const add = (code, severity, reason) => out.push({ code, severity, reason });
  const worked = (slip.presentShifts || 0) + (slip.halfDayShifts || 0);

  if ((slip.netPay || 0) < 0) add('negative', 'high', `Net pay is ${inr(slip.netPay)} — deductions are more than the pay`);
  if (worked === 0 && (slip.netPay || 0) > 0) add('no-work-pay', 'high', `Pays ${inr(slip.netPay)} with no shift worked this month`);

  if (!history.length) {
    add('first', 'info', 'First payslip for this worker — nothing to compare with');
  } else {
    const net = avg(history.map((h) => h.netPay || 0));
    const diff = (slip.netPay || 0) - net;
    if (net > 0 && Math.abs(diff) >= JUMP_MIN && Math.abs(diff) / net * 100 >= JUMP_PCT) {
      add('jump', 'check', `Net pay ${inr(slip.netPay)}, ${diff > 0 ? 'up' : 'down'} ${Math.round(Math.abs(diff) / net * 100)}% on the last ${history.length} month${history.length === 1 ? '' : 's'}' average of ${inr(net)}`);
    }
    const ot = avg(history.map((h) => h.totalOvertimeMinutes || 0));
    if ((slip.totalOvertimeMinutes || 0) > Math.max(OT_FLOOR_MIN, ot * 2)) {
      add('overtime', 'check', `Overtime ${hours(slip.totalOvertimeMinutes)}, against ${hours(ot)} a month usually`);
    }
    const last = history[0];
    if (last && (last.hourlyRate || 0) !== (slip.hourlyRate || 0)) {
      add('rate', 'info', `Hourly rate changed from ${inr(last.hourlyRate)} to ${inr(slip.hourlyRate)}`);
    }
  }
  if ((slip.unapprovedAbsents || 0) >= ABSENTS) add('absents', 'check', `${slip.unapprovedAbsents} absences without approved leave`);
  if ((slip.grossEarnings || 0) > 0 && (slip.totalDeductions || 0) / slip.grossEarnings * 100 > DEDUCTION_PCT) {
    add('deductions', 'check', `Deductions ${inr(slip.totalDeductions)} are ${Math.round(slip.totalDeductions / slip.grossEarnings * 100)}% of gross ${inr(slip.grossEarnings)}`);
  }
  const order = { high: 0, check: 1, info: 2 };
  return out.sort((a, b) => order[a.severity] - order[b.severity]);
}

/** Every slip of a month, checked. */
async function check({ year, month }) {
  const y = Number(year); const m = Number(month);
  if (!Number.isInteger(y) || !Number.isInteger(m) || m < 1 || m > 12) {
    const err = new Error('year and month are required'); err.statusCode = 400; throw err;
  }
  const slips = await Payroll.find({ year: y, month: m }).populate('employee', 'name department').lean();
  const ids = slips.map((s) => s.employee?._id || s.employee);
  const at = monthIndex(y, m);
  const earlier = await Payroll.find({
    employee: { $in: ids },
    $or: Array.from({ length: LOOKBACK }, (_, i) => { const k = at - 1 - i; return { year: Math.floor(k / 12), month: (k % 12) + 1 }; }),
  }).select('employee year month netPay totalOvertimeMinutes hourlyRate').lean();
  const byEmp = new Map();
  for (const h of earlier) {
    const k = String(h.employee);
    if (!byEmp.has(k)) byEmp.set(k, []);
    byEmp.get(k).push(h);
  }
  for (const list of byEmp.values()) list.sort((a, b) => monthIndex(b.year, b.month) - monthIndex(a.year, a.month));

  const rows = slips.map((s) => {
    const emp = s.employee || {};
    const flags = flagsFor(s, byEmp.get(String(emp._id || s.employee)) || []);
    return { payrollId: s._id, employeeId: emp._id || s.employee, name: emp.name || '', department: emp.department || '', status: s.status, netPay: s.netPay || 0, flags };
  }).filter((r) => r.flags.length);
  const count = (sev) => rows.filter((r) => r.flags.some((f) => f.severity === sev)).length;
  const lastTotal = earlier.filter((h) => monthIndex(h.year, h.month) === at - 1).reduce((t, h) => t + (h.netPay || 0), 0);
  return {
    year: y, month: m,
    summary: { slips: slips.length, high: count('high'), check: count('check'), info: count('info'), totalNet: Math.round(slips.reduce((t, s) => t + (s.netPay || 0), 0)), lastMonthNet: Math.round(lastTotal) },
    rows: rows.sort((a, b) => (a.flags[0].severity === 'high' ? 0 : a.flags[0].severity === 'check' ? 1 : 2) - (b.flags[0].severity === 'high' ? 0 : b.flags[0].severity === 'check' ? 1 : 2)),
  };
}

module.exports = { check, flagsFor };
