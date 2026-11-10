'use strict';
// ══════════════════════════════════════════════════════════════════
//  WHAT PAYROLL IS TOLD, CHECKED AS IT ARRIVES
//
//    • the settings go straight into the pay arithmetic, and were stored
//      as sent: one "abc" in the overtime multiplier made every payslip
//      of the month fail to generate, and a negative penalty paid people
//      for being absent. Each is a number within its range, or refused;
//    • the pay of a night shift, shown beside a rate, was worked out at
//      8 hours while payroll has always paid 12;
//    • a month that is not a month is refused, not searched for.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, Employee, Attendance, Payroll, PayrollSettings, User, admin;
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
const post = (url, body) => request(app).post(`/api/v2${url}`).set('Cookie', cookie()).send(body);
const get  = (url) => request(app).get(`/api/v2${url}`).set('Cookie', cookie());

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  Employee = require('../../models/Employee'); Attendance = require('../../models/Attendence.js');
  Payroll = require('../../models/Payroll'); PayrollSettings = require('../../models/PayrollSettings');
  User = require('../../models/User');
  admin = await User.create({ name: 'Owner', email: 'o@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
});

describe('payroll settings', () => {
  it.each([
    ['text where a number goes', { overtimeMultiplier: 'abc' }, /overtimeMultiplier must be a number from 0 to 10/],
    ['nothing at all', { noLeaveBonus: '' }, /noLeaveBonus must be a number/],
    ['a negative penalty', { penaltyPerExcessAbsent: -200 }, /penaltyPerExcessAbsent must be a number from 0/],
    ['more than all of the wage', { pfPercent: 120 }, /pfPercent must be a number from 0 to 100/],
    ['more leave than the month has days', { casualLeavesPerMonth: 40 }, /casualLeavesPerMonth must be a number from 0 to 31/],
    ['yes or no where a number goes', { esiPercent: true }, /esiPercent must be a number/],
  ])('%s is refused, and nothing is stored', async (_what, body, message) => {
    const res = await post('/payroll/settings', { lateGracePeriodMinutes: 15, ...body });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(message);
    expect(await PayrollSettings.countDocuments({})).toBe(0);
  });

  it('what is in range is stored, text numbers included, and the overtime cap can be set', async () => {
    const res = await post('/payroll/settings', {
      lateGracePeriodMinutes: '15', overtimeMultiplier: 1.5, maxOvertimeMinutesPerShift: 180, pfPercent: 12, noLeaveBonus: 0,
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      lateGracePeriodMinutes: 15, overtimeMultiplier: 1.5, maxOvertimeMinutesPerShift: 180, pfPercent: 12, noLeaveBonus: 0,
    });
    // Sent again with one field: the others stay.
    const again = await post('/payroll/settings', { pfPercent: 10 });
    expect(again.body.data).toMatchObject({ pfPercent: 10, overtimeMultiplier: 1.5 });
  });

  it('a month still generates after somebody tried to save a bad setting', async () => {
    const emp = await Employee.create({ name: 'Ravi', hourlyRate: 100 });
    await Attendance.create({ employee: emp._id, date: new Date(Date.UTC(2026, 5, 2)), shift: 'DAY', status: 'present', overtimeMinutes: 300 });
    expect((await post('/payroll/settings', { overtimeMultiplier: 'abc' })).status).toBe(400);
    const res = await post('/payroll/generate', { year: 2026, month: 6 });
    expect(res.body.errors).toBeUndefined();
    const slip = await Payroll.findOne({ employee: emp._id }).lean();
    expect(Number.isFinite(slip.netPay)).toBe(true);
    expect(slip.overtimeEarnings).toBeGreaterThan(0);
  });
});

describe('what a shift pays at a rate', () => {
  it('a night shift is twelve hours, as payroll pays it', async () => {
    const emp = await Employee.create({ name: 'Ravi', hourlyRate: 100 });
    const list = await get('/payroll/employees');
    expect(list.body.data[0]).toMatchObject({ hourlyRate: 100, dayShiftPay: 1200, nightShiftPay: 1200 });

    const set = await post(`/payroll/employees/${emp._id}/rate`, { hourlyRate: 110 });
    expect(set.body.data).toMatchObject({ hourlyRate: 110, dayShiftPay: 1320, nightShiftPay: 1320 });

    // …which is what a night shift is then paid.
    await Attendance.create({ employee: emp._id, date: new Date(Date.UTC(2026, 5, 2)), shift: 'NIGHT', status: 'present' });
    await post('/payroll/generate', { year: 2026, month: 6 });
    expect((await Payroll.findOne({ employee: emp._id }).lean()).nightShiftEarnings).toBe(1320);
  });
});

describe('a month that is not a month', () => {
  it('is refused where a month is asked for', async () => {
    const emp = await Employee.create({ name: 'Ravi', hourlyRate: 100 });
    for (const body of [{ year: 2026, month: 13 }, { year: 2026, month: 'June' }, { year: 26, month: 6 }, { year: 2026, month: 6.5 }]) {
      const res = await post('/payroll/generate', body);
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/not a valid month/);
    }
    expect((await post('/payroll/generate', { year: 2026, month: 6, employeeId: 'ravi' })).body.message).toMatch(/employeeId is not a valid id/);
    expect(await Payroll.countDocuments({})).toBe(0);

    expect((await get('/payroll/dashboard?year=2026&month=13')).status).toBe(400);
    expect((await get(`/payroll/slip/${emp._id}?year=2026&month=0`)).status).toBe(400);
    expect((await get(`/payroll/slip/${emp._id}/pdf?year=x&month=6`)).status).toBe(400);
  });

  it('CONTROL: a real month is answered, and with none asked for it is the factory\'s own', async () => {
    const factoryDay = require('../../utils/factoryDay');
    const [y, m] = factoryDay.ymd().split('-').map(Number);
    const res = await get('/payroll/dashboard');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ year: y, month: m });
    expect((await get('/payroll/dashboard?year=2026&month=6')).body).toMatchObject({ year: 2026, month: 6 });
    expect((await post('/payroll/generate', { month: 6 })).body.message).toMatch(/year and month required/);
  });
});

describe('the month generated by itself', () => {
  const auto = (period = '2026-06') => post('/payroll/auto-generate', { period });
  const day = (d) => new Date(Date.UTC(2026, 5, d));

  it('counts the people who worked the month, not everyone who ever had a rate', async () => {
    // Everybody with a rate used to be counted, the long gone included.
    // Each was somebody whose attendance was "missing", so the month never
    // read as complete; and when it did, each got a payslip.
    const here = await Employee.create({ name: 'Ravi', hourlyRate: 100 });
    const leftInJune = await Employee.create({
      name: 'Mani', hourlyRate: 100, status: 'offboarded', offboarding: { lastWorkingDay: day(10), reason: 'resigned' },
    });
    const longGone = [];
    for (let i = 0; i < 4; i++) {
      longGone.push(await Employee.create({
        name: `Left ${i}`, hourlyRate: 100, status: 'offboarded',
        offboarding: { lastWorkingDay: new Date(Date.UTC(2025, 0, 31)), reason: 'resigned' },
      }));
    }
    for (const d of [2, 3, 4]) {
      await Attendance.create({ employee: here._id, date: day(d), shift: 'DAY', status: 'present' });
      await Attendance.create({ employee: leftInJune._id, date: day(d), shift: 'DAY', status: 'present' });
    }

    const res = await auto();
    expect(res.body).toMatchObject({ triggered: true, completenessPct: 100 });
    expect(res.body.result.generated).toBe(2);
    const paid = (await Payroll.find({}).lean()).map((p) => String(p.employee)).sort();
    expect(paid).toEqual([String(here._id), String(leftInJune._id)].sort());

    // Asked again: nothing left to do.
    expect((await auto()).body).toMatchObject({ triggered: false, reason: 'ALREADY_GENERATED' });
  });

  it('a period that is not a month is refused', async () => {
    for (const period of ['2026-13', '2026-00', 'June', '26-06']) {
      const res = await auto(period);
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/period must be YYYY-MM/);
    }
  });
});

describe('advances still to come back', () => {
  const AdvanceRequest = () => require('../../models/Advance');

  it('lists the ones handed over and overdue — not only the ones merely approved', async () => {
    // It looked for "approved" alone: an advance no cash has moved on.
    // The ones paid out and never recovered were the ones it could not see.
    const emp = await Employee.create({ name: 'Ravi', hourlyRate: 100 });
    const base = { employee: emp._id, deductMonth: 1, deductYear: 2026 };
    await AdvanceRequest().create([
      { ...base, amount: 900, status: 'paid_out', remainingBalance: 400 },   // part recovered
      { ...base, amount: 500, status: 'approved' },                           // agreed, as the admin app leaves it
      { ...base, amount: 700, status: 'recovered', remainingBalance: 0, deductedInPayroll: true },
      { ...base, amount: 300, status: 'rejected' },
      { ...base, amount: 200, status: 'paid_out', deductYear: 2100 },         // not due yet
    ]);
    const res = await get('/payroll/outstanding-advances');
    expect(res.status).toBe(200);
    expect(res.body.advances.map((a) => [a.amount, a.remaining, a.status]).sort((x, y) => x[0] - y[0]))
      .toEqual([[500, 500, 'approved'], [900, 400, 'paid_out']]);
    expect(res.body).toMatchObject({ count: 2, totalAmount: 900 });
  });

  it('asked for twice at once is one request', async () => {
    const emp = await Employee.create({ name: 'Ravi', hourlyRate: 100 });
    const ask = (amount) => post('/payroll/advance', { employeeId: emp._id, amount, reason: 'school fees' });
    const [x, y] = await Promise.all([ask(2000), ask(2000)]);
    expect([x.status, y.status]).toEqual([200, 200]);
    expect(String(x.body.data._id)).toBe(String(y.body.data._id));
    expect(await AdvanceRequest().countDocuments({})).toBe(1);

    // A different amount is a different request.
    expect((await ask(3000)).status).toBe(200);
    expect(await AdvanceRequest().countDocuments({})).toBe(2);
  });
});

describe('the year\'s figures', () => {
  it('still add up when a payslip\'s employee record is gone', async () => {
    const emp = await Employee.create({ name: 'Ravi', hourlyRate: 100 });
    await Payroll.create([
      { employee: emp._id, year: 2026, month: 6, netPay: 1200, grossEarnings: 1200, totalShifts: 1, presentShifts: 1 },
      { employee: new mongoose.Types.ObjectId(), year: 2026, month: 6, netPay: 800, grossEarnings: 800, totalShifts: 1, presentShifts: 1 },
    ]);
    const res = await get('/payroll/analytics?year=2026&month=6');
    expect(res.status).toBe(200);
    expect(res.body.summary).toMatchObject({ totalEmployees: 2, totalPayout: 2000 });
  });
});
