'use strict';
// ══════════════════════════════════════════════════════════════════
//  PUTTING A SHIFT'S MINUTES RIGHT — the forgotten clock-out
//
//  Somebody goes home without clocking out. The timer runs on until the
//  office notices and presses clock-out, days later: the shift now reads
//  three days long, pays a full shift and the most overtime the cap
//  allows. There was no way to put it right. Minutes typed over it
//  changed what the sheet showed and nothing about the pay, because pay
//  is worked out from the clock-in and clock-out before the figure kept
//  beside them.
//
//  Held here: minutes given by hand for a shift the timer was used on
//  move the timer's own record, so the sheet and the payslip say the same
//  thing — and that record only ever moves back in time.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, Employee, Attendance, Payroll, User, computePayroll, stampsFor, admin;

const YEAR = 2026, MONTH = 6, RATE = 100; // ₹100 an hour: a 12-hour shift is ₹1,200
const HOUR = 3600_000, MIN = 60_000;
const dstr = (day) => `${YEAR}-${String(MONTH).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
const post = (url, body) => request(app).post(`/api/v2${url}`).set('Cookie', cookie()).send(body);
const put  = (url, body) => request(app).put(`/api/v2${url}`).set('Cookie', cookie()).send(body);
const get  = (url) => request(app).get(`/api/v2${url}`).set('Cookie', cookie());
const makeEmp = (over = {}) => Employee.create({ name: 'Ravi', hourlyRate: RATE, ...over });
const rowOf = (emp, day = 2, shift = 'DAY') =>
  Attendance.findOne({ employee: emp._id, date: new Date(`${dstr(day)}T00:00:00.000Z`), shift }).lean();
const lines = (pay, re) => pay.lineItems.filter((l) => re.test(l.label));
const clock = (which, emp, day = 2) =>
  post(`/attendance/clock-${which}`, { employeeId: emp._id, shift: 'DAY', date: dstr(day) });
/** As if they had clocked in that long ago. */
const clockedInAgo = (emp, ms) =>
  Attendance.updateOne({ employee: emp._id }, { $set: { clockInAt: new Date(Date.now() - ms) } });
const minutesOnTimer = (row) => Math.round((row.clockOutAt - row.clockInAt) / MIN) + (row.priorMinutes || 0);

/** A shift clocked in, and clocked out `hours` later. */
async function timedShift(emp, hours) {
  expect((await clock('in', emp)).status).toBe(200);
  await clockedInAgo(emp, hours * HOUR);
  expect((await clock('out', emp)).status).toBe(200);
  return rowOf(emp);
}

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  Employee = require('../../models/Employee');
  Attendance = require('../../models/Attendence.js');
  Payroll = require('../../models/Payroll');
  User = require('../../models/User');
  computePayroll = require('../../services/payrollService').computePayroll;
  stampsFor = require('../../services/attendanceMarks').stampsFor;
  await Attendance.init();
  admin = await User.create({ name: 'Asha', email: 'o@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
});

describe('a clock-out forgotten, and pressed three days later', () => {
  it('pays what the correction says, not the three days', async () => {
    const emp = await makeEmp();
    const before = await timedShift(emp, 73);
    expect(before.workedMinutes).toBeGreaterThan(72 * 60);

    // As it stands: a full shift, and overtime up to the cap.
    const wrong = await computePayroll(emp._id, YEAR, MONTH);
    expect(lines(wrong, /Overtime/)).toHaveLength(1);
    expect(wrong.grossEarnings).toBeGreaterThan(1200);

    // They left after ten hours.
    const res = await put(`/attendance/${before._id}`, { workedMinutes: 600 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ changed: true, payslipFinal: false });
    expect(res.body.data).toMatchObject({ workedMinutes: 600 });

    const after = await rowOf(emp);
    expect(after.workedMinutes).toBe(600);
    expect(after.hoursWorked).toBe(10);
    // The arrival stays where the timer put it; the clock-out comes back.
    expect(after.clockInAt).toEqual(before.clockInAt);
    expect(after.clockOutAt - after.clockInAt).toBe(600 * MIN);
    expect(after.markedBy).toBe('Asha');

    const pay = await computePayroll(emp._id, YEAR, MONTH);
    expect(lines(pay, /Overtime/)).toHaveLength(0);
    expect(lines(pay, /DAY Shift 10h worked/)).toHaveLength(1);
    expect(pay.grossEarnings).toBe(1000);
  });

  it('in and out times entered over it are a correction as well', async () => {
    const emp = await makeEmp();
    const before = await timedShift(emp, 73);

    const res = await put(`/attendance/${before._id}`, { checkIn: '08:00', checkOut: '17:30' });
    expect(res.status).toBe(200);
    const after = await rowOf(emp);
    expect(after.workedMinutes).toBe(570);
    expect(minutesOnTimer(after)).toBe(570);

    const pay = await computePayroll(emp._id, YEAR, MONTH);
    expect(pay.grossEarnings).toBe(950);
    expect(lines(pay, /Overtime/)).toHaveLength(0);
  });

  it('CONTROL: a note, or a status the same as before, leaves the timer\'s record alone', async () => {
    const emp = await makeEmp();
    const before = await timedShift(emp, 9);

    expect((await put(`/attendance/${before._id}`, { notes: 'left by the side gate', status: 'present' })).status).toBe(200);
    const after = await rowOf(emp);
    expect(after.notes).toBe('left by the side gate');
    expect(after.clockInAt).toEqual(before.clockInAt);
    expect(after.clockOutAt).toEqual(before.clockOutAt);
    expect(after.workedMinutes).toBe(before.workedMinutes);

    // …and the same minutes sent back change nothing at all.
    const same = await put(`/attendance/${before._id}`, { workedMinutes: before.workedMinutes });
    expect(same.body).toMatchObject({ changed: false });
    expect((await rowOf(emp)).updatedAt).toEqual(after.updatedAt);
  });
});

describe('the timer\'s record only moves back', () => {
  it('more minutes than the timer has: it is the clock-in that was late', async () => {
    const emp = await makeEmp();
    const before = await timedShift(emp, 6);

    expect((await put(`/attendance/${before._id}`, { workedMinutes: 540 })).status).toBe(200);
    const after = await rowOf(emp);
    expect(after.clockOutAt).toEqual(before.clockOutAt);
    expect(after.clockOutAt - after.clockInAt).toBe(540 * MIN);
    expect(after.clockInAt.getTime()).toBeLessThan(before.clockInAt.getTime());

    expect((await computePayroll(emp._id, YEAR, MONTH)).grossEarnings).toBe(900);
  });

  it('a timer still running: a figure for the shift ends it', async () => {
    const emp = await makeEmp();
    await clock('in', emp);
    await clockedInAgo(emp, 30 * HOUR); // yesterday morning, never clocked out
    const running = await rowOf(emp);
    expect(running.clockOutAt).toBeNull();

    expect((await put(`/attendance/${running._id}`, { workedMinutes: 480 })).status).toBe(200);
    const after = await rowOf(emp);
    expect(after.clockInAt).toEqual(running.clockInAt);
    expect(after.clockOutAt - after.clockInAt).toBe(480 * MIN);
    expect(after.hoursWorked).toBe(8);

    // No longer among the timers running.
    const active = await get(`/attendance/active?date=${dstr(2)}`);
    expect(active.body.data).toHaveLength(0);
    expect((await computePayroll(emp._id, YEAR, MONTH)).grossEarnings).toBe(800);
  });

  it('a figure longer than the time since they clocked in ends it now, not later', async () => {
    const emp = await makeEmp();
    await clock('in', emp);
    await clockedInAgo(emp, 2 * HOUR);
    const running = await rowOf(emp);

    const asked = Date.now();
    expect((await put(`/attendance/${running._id}`, { workedMinutes: 480 })).status).toBe(200);
    const after = await rowOf(emp);
    expect(after.clockOutAt.getTime()).toBeGreaterThanOrEqual(asked - 1000);
    expect(after.clockOutAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect(after.clockOutAt - after.clockInAt).toBe(480 * MIN);
  });

  it('time worked before a break stays counted', async () => {
    const emp = await makeEmp();
    // Two hours, a break, then back — and no clock-out until days later.
    await timedShift(emp, 2);
    expect((await clock('in', emp)).status).toBe(200);
    await clockedInAgo(emp, 70 * HOUR);
    await clock('out', emp);
    const before = await rowOf(emp);
    expect(before.priorMinutes).toBe(120);

    expect((await put(`/attendance/${before._id}`, { workedMinutes: 600 })).status).toBe(200);
    let after = await rowOf(emp);
    expect(after.priorMinutes).toBe(120);
    expect(after.clockOutAt - after.clockInAt).toBe(480 * MIN);
    expect((await computePayroll(emp._id, YEAR, MONTH)).grossEarnings).toBe(1000);

    // Less than the first stint alone: that is all there was.
    expect((await put(`/attendance/${before._id}`, { workedMinutes: 60 })).status).toBe(200);
    after = await rowOf(emp);
    expect(after.priorMinutes).toBe(60);
    expect(after.clockOutAt).toEqual(after.clockInAt);
    expect((await computePayroll(emp._id, YEAR, MONTH)).grossEarnings).toBe(100);
  });
});

describe('the record for a correction, worked out', () => {
  const at = (h) => new Date(Date.UTC(2026, 5, 2, h));
  const mins = (s) => (s.clockOutAt - s.clockInAt) / MIN + s.priorMinutes;

  it('says nothing for a shift the timer was never used on, or for no minutes', () => {
    expect(stampsFor({}, 480)).toBeNull();
    expect(stampsFor({ clockInAt: null, clockOutAt: null }, 480)).toBeNull();
    expect(stampsFor({ clockInAt: at(8), clockOutAt: at(20) }, 0)).toBeNull();
  });

  it('always comes to the minutes asked for', () => {
    const rows = [
      { clockInAt: at(8), clockOutAt: at(20) },
      { clockInAt: at(8), clockOutAt: at(9) },
      { clockInAt: at(8), clockOutAt: null },
      { clockInAt: at(14), clockOutAt: at(20), priorMinutes: 300 },
    ];
    for (const row of rows) {
      for (const m of [1, 59, 300, 301, 480, 720, 900]) {
        const s = stampsFor(row, m, at(22));
        expect(mins(s)).toBe(m);
        // Never later than it was (or than now, for one still running).
        expect(s.clockOutAt.getTime()).toBeLessThanOrEqual((row.clockOutAt || at(22)).getTime());
        expect(s.clockInAt.getTime()).toBeLessThanOrEqual(row.clockInAt.getTime());
      }
    }
  });

  it('leaves a record that already says so as it is', () => {
    const row = { clockInAt: at(8), clockOutAt: at(18), priorMinutes: 0 };
    expect(stampsFor(row, 600)).toEqual(row);
  });
});

describe('a mark changed after the month was paid', () => {
  it('says the payslip is already finalised, so nobody takes the pay to have changed', async () => {
    const emp = await makeEmp();
    const row = await timedShift(emp, 9);
    await Payroll.create({ employee: emp._id, year: YEAR, month: MONTH, status: 'finalized' });

    const res = await put(`/attendance/${row._id}`, { workedMinutes: 480 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ changed: true, payslipFinal: true });
  });

  it('CONTROL: a draft payslip is still to be worked out, and says nothing', async () => {
    const emp = await makeEmp();
    const row = await timedShift(emp, 9);
    await Payroll.create({ employee: emp._id, year: YEAR, month: MONTH, status: 'draft' });
    await Payroll.create({ employee: emp._id, year: YEAR, month: MONTH - 1, status: 'paid' }); // another month

    const res = await put(`/attendance/${row._id}`, { workedMinutes: 480 });
    expect(res.body).toMatchObject({ changed: true, payslipFinal: false });
  });
});
