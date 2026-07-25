'use strict';
//
// CHARACTERIZATION test for api/payroll.js computePayroll — the ~200-line
// pay computation the /generate + /auto-generate routes build on. Pins
// the CURRENT pay math, bonus rules, and deductions before the planned
// PayrollService extraction (Phase B2/B4).
//
// computePayroll is read-only (Employee, PayrollSettings, Attendance,
// AdvanceRequest) — no transactions — so a standalone MongoMemoryServer
// is enough. Attendance rows are inserted raw (only the fields the
// function reads) to avoid unrelated schema-required noise.

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongo, computePayroll, Employee, Attendance, PayrollSettings, AdvanceRequest;

const YEAR = 2026, MONTH = 6; // June 2026
const RATE = 100;             // ₹/hour → DAY(12h)=₹1200, NIGHT(12h)=₹1200

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  Employee        = require('../../models/Employee');
  Attendance      = require('../../models/Attendence.js');
  PayrollSettings = require('../../models/PayrollSettings');
  AdvanceRequest  = require('../../models/Advance');
  computePayroll  = require('../../api/payroll.js').computePayroll;
}, 60_000);

afterAll(async () => {
  if (mongo) { await mongoose.disconnect(); await mongo.stop(); }
});
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    await c.deleteMany({});
  }
});

async function makeEmp() {
  return Employee.create({ name: 'Ravi', department: 'Weaving', hourlyRate: RATE });
}
// day = day-of-month in June 2026.
async function att(empId, day, over = {}) {
  return Attendance.collection.insertOne({
    employee: empId,
    date: new Date(YEAR, MONTH - 1, day),
    shift: 'DAY',
    status: 'present',
    lateMinutes: 0,
    ...over,
  });
}

describe('computePayroll — core pay math', () => {
  test('present DAY shifts pay hourlyRate × 12 each', async () => {
    const emp = await makeEmp();
    await att(emp._id, 2);
    await att(emp._id, 3);
    const p = await computePayroll(emp._id, YEAR, MONTH);
    expect(p.presentShifts).toBe(2);
    expect(p.dayShiftEarnings).toBe(2400);   // 2 × ₹1200
    expect(p.grossEarnings).toBe(2400);
  });

  test('NIGHT shift pays hourlyRate × 12 (same as DAY)', async () => {
    const emp = await makeEmp();
    await att(emp._id, 2, { shift: 'NIGHT' });
    const p = await computePayroll(emp._id, YEAR, MONTH);
    expect(p.nightShiftEarnings).toBe(1200);  // ₹100 × 12
  });

  test('half_day pays half', async () => {
    const emp = await makeEmp();
    await att(emp._id, 2, { status: 'half_day' });
    const p = await computePayroll(emp._id, YEAR, MONTH);
    expect(p.halfDayShifts).toBe(1);
    expect(p.grossEarnings).toBe(600);       // ₹1200 / 2
  });

  test('late beyond the grace period deducts pro-rata', async () => {
    const emp = await makeEmp();
    // 40 late mins, 10 grace → 30 billable → (30/60)×₹100 = ₹50 off ₹1200.
    // The late cut is applied to the shift's pay, so it shows up in
    // grossEarnings (there is no separate `lateDeductions` field returned).
    await att(emp._id, 2, { status: 'present', lateMinutes: 40 });
    const p = await computePayroll(emp._id, YEAR, MONTH);
    expect(p.totalLateMinutes).toBe(40);
    expect(p.grossEarnings).toBeCloseTo(1150, 2);
  });
});

describe('computePayroll — absences + penalties', () => {
  test('unapproved absent loses the shift pay and counts an absent', async () => {
    const emp = await makeEmp();
    await att(emp._id, 2, { status: 'present' });
    await att(emp._id, 3, { status: 'absent' });
    const p = await computePayroll(emp._id, YEAR, MONTH);
    expect(p.unapprovedAbsents).toBe(1);
    // The absent shift's pay is simply never earned (its -₹1200 line is
    // display-only and NOT added to totalDeductions). Below the leave
    // quota there's no penalty, so netPay == the one present shift.
    expect(p.grossEarnings).toBe(1200);
    expect(p.netPay).toBe(1200);
  });

  test('excess absents beyond the leave quota incur a penalty', async () => {
    const emp = await makeEmp();
    // default quota = casual(2)+sick(1) = 3. 4 absents → 1 excess × ₹200.
    for (const d of [2, 3, 4, 5]) await att(emp._id, d, { status: 'absent' });
    const p = await computePayroll(emp._id, YEAR, MONTH);
    expect(p.excessAbsents).toBe(1);
    expect(p.totalDeductions).toBeGreaterThanOrEqual(200);
  });

  test('approved leave is PAID', async () => {
    const emp = await makeEmp();
    await att(emp._id, 2, { status: 'absent', isApprovedLeave: true });
    const p = await computePayroll(emp._id, YEAR, MONTH);
    expect(p.approvedLeaveShifts).toBe(1);
    expect(p.grossEarnings).toBe(1200); // paid like a worked shift
  });
});

describe('computePayroll — bonuses', () => {
  test('no-leave + perfect-attendance bonuses when clean', async () => {
    const emp = await makeEmp();
    await att(emp._id, 2);
    await att(emp._id, 3);
    const p = await computePayroll(emp._id, YEAR, MONTH);
    // defaults: noLeaveBonus 300 + perfectAttendanceBonus 500
    expect(p.noLeaveBonus).toBe(300);
    expect(p.perfectAttendanceBonus).toBe(500);
    expect(p.perfectAttendance).toBe(true);
  });

  test('7 consecutive present days earn a streak bonus', async () => {
    const emp = await makeEmp();
    for (let d = 1; d <= 7; d++) await att(emp._id, d);
    const p = await computePayroll(emp._id, YEAR, MONTH);
    expect(p.longestStreak).toBe(7);
    expect(p.totalStreakBonus).toBe(100); // default streakBonusPer7Shifts
  });

  test('an absent breaks the no-leave + perfect bonuses', async () => {
    const emp = await makeEmp();
    await att(emp._id, 2);
    await att(emp._id, 3, { status: 'absent' });
    const p = await computePayroll(emp._id, YEAR, MONTH);
    expect(p.noLeaveBonus).toBe(0);
    expect(p.perfectAttendance).toBe(false);
  });
});

describe('computePayroll — advance recovery + netPay', () => {
  test('approved advance for the month is recovered from net pay', async () => {
    const emp = await makeEmp();
    await att(emp._id, 2);
    await att(emp._id, 3);
    await AdvanceRequest.create({
      employee: emp._id, amount: 500, status: 'approved',
      deductMonth: MONTH, deductYear: YEAR, deductedInPayroll: false,
    });
    const p = await computePayroll(emp._id, YEAR, MONTH);
    expect(p.totalAdvanceDeduction).toBe(500);
    // gross 2400 + bonuses(300+500=800) − advance 500 = 2700
    expect(p.netPay).toBe(2700);
    expect(p._advanceRecoveries).toHaveLength(1);
    expect(p._advanceRecoveries[0].recovered).toBe(500);
  });

  test('netPay is floored at 0', async () => {
    const emp = await makeEmp();
    await att(emp._id, 2, { status: 'absent' }); // pure deduction, no earnings
    const p = await computePayroll(emp._id, YEAR, MONTH);
    expect(p.netPay).toBe(0);
  });
});

describe('computePayroll — regression guards (bug fixes)', () => {
  // Bug 1: the late cut was reflected in grossEarnings AND added to
  // totalDeductions, so netPay = gross - deductions + bonus subtracted it
  // twice. A late employee was short-paid by exactly the late amount.
  test('late deduction is NOT double-counted in netPay', async () => {
    const emp = await makeEmp();
    // 40 late, 10 grace → 30 billable → ₹50 off the ₹1200 DAY shift.
    await att(emp._id, 2, { status: 'present', lateMinutes: 40 });
    const p = await computePayroll(emp._id, YEAR, MONTH);
    expect(p.grossEarnings).toBeCloseTo(1150, 2); // late already applied here
    // No excess-absent / wastage deductions, so totalDeductions must be 0 —
    // the late must not appear here a second time.
    expect(p.totalDeductions).toBe(0);
    // one clean shift → no-leave(300) + perfect(500) bonuses.
    // net = 1150 (gross, late already off) + 800 bonus = 1950.
    expect(p.netPay).toBeCloseTo(1950, 2);
  });

  // Edge: the late cut is capped at the shift's own pay — a garbage
  // lateMinutes value (longer than the shift) must not go negative and
  // eat other shifts' earnings.
  test('late deduction never exceeds the shift pay', async () => {
    const emp = await makeEmp();
    await att(emp._id, 2, { status: 'present', lateMinutes: 2000 }); // > 12h late
    await att(emp._id, 3, { status: 'present' });
    const p = await computePayroll(emp._id, YEAR, MONTH);
    // day 2 floors at ₹0 (not negative), day 3 pays fully.
    expect(p.grossEarnings).toBe(1200);
  });

  // Edge: an all-approved-leave month is paid but is NOT "perfect
  // attendance" — nobody worked a single shift.
  test('all-approved-leave month earns no perfect-attendance bonus', async () => {
    const emp = await makeEmp();
    for (const d of [2, 3, 4]) await att(emp._id, d, { status: 'absent', isApprovedLeave: true });
    const p = await computePayroll(emp._id, YEAR, MONTH);
    expect(p.approvedLeaveShifts).toBe(3);
    expect(p.perfectAttendance).toBe(false);
    expect(p.perfectAttendanceBonus).toBe(0);
  });

  // Admin/finance-entered advances (POST /advance/admin-create) are born
  // approved with deductMonth/deductYear set — computePayroll must pick
  // them up exactly like an approved worker request.
  test('an admin-entered (born-approved) advance is recovered', async () => {
    const emp = await makeEmp();
    await att(emp._id, 2);
    await AdvanceRequest.create({
      employee: emp._id, amount: 300, status: 'approved',
      deductMonth: MONTH, deductYear: YEAR,
      approvedBy: 'finance', approvedAt: new Date(),
    });
    const p = await computePayroll(emp._id, YEAR, MONTH);
    expect(p.totalAdvanceDeduction).toBe(300);
  });

  // Bug 2: filtering advances on deductedInPayroll:false meant a payroll
  // RE-generation (after the first run flipped the flag) found no advance
  // and net pay jumped up by the advance amount — the recovery was lost.
  // computePayroll must recover a month's advance even once flagged.
  test('an already-flagged advance for the month is still recovered on re-compute', async () => {
    const emp = await makeEmp();
    await att(emp._id, 2);
    await att(emp._id, 3);
    await AdvanceRequest.create({
      employee: emp._id, amount: 500, status: 'approved',
      deductMonth: MONTH, deductYear: YEAR, deductedInPayroll: true, // already flipped
    });
    const p = await computePayroll(emp._id, YEAR, MONTH);
    expect(p.totalAdvanceDeduction).toBe(500);
    expect(p.netPay).toBe(2700); // gross 2400 + bonus 800 − advance 500
  });
});
