'use strict';
// Tests for the per-shift working timer and actual-hours pay:
//   • clock-in / clock-out endpoints stamp server time + worked minutes
//   • payroll pays actual worked hours, capped at the 12h shift
//   • a short shift pays less; time beyond 12h (past grace) is overtime
//   • manual in/out times feed pay (incl. a night shift wrapping midnight)
//   • a plain "present" mark with no timer still pays a flat 12h (legacy)

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, Employee, Attendance, PayrollSettings, User, computePayroll, admin;

const YEAR = 2026, MONTH = 6, RATE = 100; // ₹100/h → 12h shift = ₹1200
const cookie = (id, role) => [`token=${jwt.sign({ id, role }, process.env.JWT_SECRET_KEY)}`];
const adminCookie = () => cookie(admin._id, 'admin');
const dstr = (day) => `${YEAR}-${String(MONTH).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
const makeEmp = (over = {}) => Employee.create({ name: 'W', hourlyRate: RATE, ...over });

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  Employee = require('../../models/Employee'); Attendance = require('../../models/Attendence.js');
  PayrollSettings = require('../../models/PayrollSettings'); User = require('../../models/User');
  computePayroll = require('../../services/payrollService').computePayroll;
  admin = await User.create({ name: 'Owner', email: 'o@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
}, 60_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
});

describe('clock-in / clock-out endpoints', () => {
  test('clock-in stamps a running timer; clock-out records worked minutes', async () => {
    const emp = await makeEmp();
    const ci = await request(app).post('/api/v2/attendance/clock-in').set('Cookie', adminCookie())
      .send({ employeeId: emp._id, shift: 'DAY', date: dstr(2) });
    expect(ci.status).toBe(200);
    expect(ci.body.data.clockInAt).toBeTruthy();
    expect(ci.body.data.clockOutAt).toBeNull();

    // appears on the live board
    const active = await request(app).get(`/api/v2/attendance/active?date=${dstr(2)}`).set('Cookie', adminCookie());
    expect(active.body.data).toHaveLength(1);

    // simulate 3h elapsed by back-dating the clock-in
    await Attendance.updateOne(
      { employee: emp._id, shift: 'DAY' },
      { $set: { clockInAt: new Date(Date.now() - 3 * 60 * 60 * 1000) } }
    );

    const co = await request(app).post('/api/v2/attendance/clock-out').set('Cookie', adminCookie())
      .send({ employeeId: emp._id, shift: 'DAY', date: dstr(2) });
    expect(co.status).toBe(200);
    expect(co.body.data.clockOutAt).toBeTruthy();
    expect(co.body.data.workedMinutes).toBeGreaterThanOrEqual(179);
    expect(co.body.data.workedMinutes).toBeLessThanOrEqual(181);
  });

  test('double clock-in and clock-out-without-in are rejected', async () => {
    const emp = await makeEmp();
    await request(app).post('/api/v2/attendance/clock-in').set('Cookie', adminCookie())
      .send({ employeeId: emp._id, shift: 'DAY', date: dstr(2) });
    const again = await request(app).post('/api/v2/attendance/clock-in').set('Cookie', adminCookie())
      .send({ employeeId: emp._id, shift: 'DAY', date: dstr(2) });
    expect(again.status).toBe(409);

    const emp2 = await makeEmp({ name: 'X' });
    const noIn = await request(app).post('/api/v2/attendance/clock-out').set('Cookie', adminCookie())
      .send({ employeeId: emp2._id, shift: 'DAY', date: dstr(2) });
    expect(noIn.status).toBe(400);
  });
});

describe('actual-hours pay (capped at 12h)', () => {
  test('a 3h worked shift pays 3h, not a full 12h shift', async () => {
    const emp = await makeEmp();
    await Attendance.create({
      employee: emp._id, date: new Date(YEAR, MONTH - 1, 2), shift: 'DAY', status: 'present',
      clockInAt: new Date(YEAR, MONTH - 1, 2, 8, 0), clockOutAt: new Date(YEAR, MONTH - 1, 2, 11, 0),
    });
    const p = await computePayroll(emp._id, YEAR, MONTH);
    expect(p.grossEarnings).toBe(300); // 3h × ₹100
  });

  test('a worked shift beyond 12h caps base at 12h and pays the rest as overtime', async () => {
    // grace 120m, multiplier 1.25 (defaults). 15h worked → 12h base + 3h over.
    // OT billable = 180 − 120 = 60m → 1h × ₹100 × 1.25 = ₹125.
    const emp = await makeEmp();
    await Attendance.create({
      employee: emp._id, date: new Date(YEAR, MONTH - 1, 2), shift: 'DAY', status: 'present',
      clockInAt: new Date(YEAR, MONTH - 1, 2, 6, 0), clockOutAt: new Date(YEAR, MONTH - 1, 2, 21, 0),
    });
    const p = await computePayroll(emp._id, YEAR, MONTH);
    expect(p.overtimeEarnings).toBe(125);
    expect(p.grossEarnings).toBe(1325); // 1200 base (capped) + 125 OT
  });

  test('manual in/out times feed actual-hours pay', async () => {
    const emp = await makeEmp();
    const res = await request(app).post('/api/v2/attendance/mark').set('Cookie', adminCookie()).send({
      date: dstr(2), shift: 'DAY',
      records: [{ employeeId: emp._id, status: 'present', checkIn: '09:00', checkOut: '15:00' }], // 6h
    });
    expect(res.status).toBeLessThan(300);
    const p = await computePayroll(emp._id, YEAR, MONTH);
    expect(p.grossEarnings).toBe(600); // 6h × ₹100
  });

  test('a NIGHT shift crossing midnight computes the right worked hours', async () => {
    const emp = await makeEmp();
    await request(app).post('/api/v2/attendance/mark').set('Cookie', adminCookie()).send({
      date: dstr(2), shift: 'NIGHT',
      records: [{ employeeId: emp._id, status: 'present', checkIn: '20:00', checkOut: '04:00' }], // 8h
    });
    const p = await computePayroll(emp._id, YEAR, MONTH);
    expect(p.grossEarnings).toBe(800); // 8h × ₹100
  });

  test('a plain present mark with no timer still pays a full 12h shift (legacy)', async () => {
    const emp = await makeEmp();
    await Attendance.create({ employee: emp._id, date: new Date(YEAR, MONTH - 1, 2), shift: 'DAY', status: 'present' });
    const p = await computePayroll(emp._id, YEAR, MONTH);
    expect(p.grossEarnings).toBe(1200); // flat 12h
  });
});
