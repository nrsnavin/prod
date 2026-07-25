'use strict';
// Tests for the payroll month-range views:
//   GET /payroll/range/:empId     — one employee's slips + totals over a window
//   GET /payroll/dashboard-range  — per-employee summed rows over a window

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongo, app, Employee, Payroll, User, admin;

const cookie = (id, role) => [`token=${jwt.sign({ id, role }, process.env.JWT_SECRET_KEY)}`];
const adminCookie = () => cookie(admin._id, 'admin');

const slip = (emp, year, month, over = {}) => Payroll.create({
  employee: emp, year, month, netPay: 1000, grossEarnings: 1200,
  totalBonuses: 100, totalDeductions: 300, amountPaid: 0, status: 'draft', ...over,
});

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  Employee = require('../../models/Employee');
  Payroll  = require('../../models/Payroll');
  User     = require('../../models/User');
  admin = await User.create({ name: 'Owner', email: 'o@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
}, 60_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
});

describe('GET /payroll/range/:empId', () => {
  test('returns every slip in the window, oldest first, with totals', async () => {
    const emp = await Employee.create({ name: 'W', hourlyRate: 100 });
    await slip(emp._id, 2026, 4, { netPay: 1000 });
    await slip(emp._id, 2026, 5, { netPay: 2000, amountPaid: 2000, status: 'paid' });
    await slip(emp._id, 2026, 6, { netPay: 3000 });
    await slip(emp._id, 2026, 3, { netPay: 9999 }); // outside the window

    const res = await request(app)
      .get(`/api/v2/payroll/range/${emp._id}?fromYear=2026&fromMonth=4&toYear=2026&toMonth=6`)
      .set('Cookie', adminCookie());
    expect(res.status).toBe(200);
    expect(res.body.slips).toHaveLength(3);
    expect(res.body.slips.map(s => s.month)).toEqual([4, 5, 6]); // oldest first
    expect(res.body.totals.netPay).toBe(6000);
    expect(res.body.totals.amountPaid).toBe(2000);
    expect(res.body.totals.months).toBe(3);
  });

  test('rejects an inverted window', async () => {
    const emp = await Employee.create({ name: 'W', hourlyRate: 100 });
    const res = await request(app)
      .get(`/api/v2/payroll/range/${emp._id}?fromYear=2026&fromMonth=6&toYear=2026&toMonth=4`)
      .set('Cookie', adminCookie());
    expect(res.status).toBe(400);
  });
});

describe('GET /payroll/dashboard-range', () => {
  test('sums each employee across the window, spanning a year boundary', async () => {
    const a = await Employee.create({ name: 'A', hourlyRate: 100 });
    const b = await Employee.create({ name: 'B', hourlyRate: 100 });
    // Window Dec 2025 → Feb 2026
    await slip(a._id, 2025, 12, { netPay: 1000 });
    await slip(a._id, 2026, 1,  { netPay: 1500, amountPaid: 1500, status: 'paid' });
    await slip(a._id, 2026, 2,  { netPay: 500 });
    await slip(b._id, 2026, 1,  { netPay: 4000 });
    await slip(a._id, 2026, 5,  { netPay: 9999 }); // outside window

    const res = await request(app)
      .get('/api/v2/payroll/dashboard-range?fromYear=2025&fromMonth=12&toYear=2026&toMonth=2')
      .set('Cookie', adminCookie());
    expect(res.status).toBe(200);
    const rowA = res.body.employees.find(e => String(e.employeeId) === String(a._id));
    expect(rowA.netPay).toBe(3000);   // 1000 + 1500 + 500
    expect(rowA.months).toBe(3);
    expect(rowA.paidMonths).toBe(1);
    expect(rowA.fullyPaid).toBe(false);
    expect(res.body.summary.totalNetPay).toBe(7000); // 3000 + 4000
  });
});
