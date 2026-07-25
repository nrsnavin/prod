'use strict';
// Diwali bonus: base = salary received in the Diwali window × per-employee
// percent × attendance multiplier; preview is approximate; trigger only in
// the Diwali month.

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
// Bonus trigger + pay run in transactions → need a replica set.
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, Employee, Payroll, ShiftDetail, BonusConfig, BonusRecord, User, admin;

const cookie = (id, role) => [`token=${jwt.sign({ id, role }, process.env.JWT_SECRET_KEY)}`];
const adminCookie = () => cookie(admin._id, 'admin');

const now = new Date();
const curYear = now.getFullYear();
const curMonth = now.getMonth() + 1;       // 1–12

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  Employee = require('../../models/Employee'); Payroll = require('../../models/Payroll');
  ShiftDetail = require('../../models/ShiftDetail'); BonusConfig = require('../../models/BonusConfig');
  BonusRecord = require('../../models/BonusRecord'); User = require('../../models/User');
  admin = await User.create({ name: 'Owner', email: 'o@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
}, 60_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
});

// employee with ₹10000 net pay this month, 2 attendance days, working-days=2 → 100% → S tier
async function seed({ diwaliMonth }) {
  const emp = await Employee.create({ name: 'W', hourlyRate: 100, bonusPercent: 10 });
  await Payroll.create({ employee: emp._id, year: curYear, month: curMonth, netPay: 10000, status: 'paid' });
  await ShiftDetail.collection.insertMany([
    { employee: emp._id, date: new Date(curYear, curMonth - 1, 3), shift: 'DAY' },
    { employee: emp._id, date: new Date(curYear, curMonth - 1, 4), shift: 'DAY' },
  ]);
  await BonusConfig.create({
    year: curYear,
    bonusDate: new Date(curYear, (diwaliMonth ? curMonth : curMonth === 1 ? 6 : 1) - 1, 15),
    yearlyWorkingDays: 2,
  });
  return emp;
}

describe('GET /bonus/preview', () => {
  test('bonus = window salary × percent × attendance multiplier', async () => {
    await seed({ diwaliMonth: true });
    const res = await request(app).get(`/api/v2/bonus/preview?year=${curYear}`).set('Cookie', adminCookie());
    expect(res.status).toBe(200);
    const row = res.body.rows[0];
    expect(row.salaryReceived).toBe(10000);
    expect(row.basedOn).toBe('salary_received');
    expect(row.attendanceTier).toBe('S');        // 2/2 days = 100%
    expect(row.bonusAmount).toBe(1000);          // 10000 × 10% × 1.0
    expect(res.body.approximate).toBe(false);    // it IS the Diwali month
    expect(res.body.canGenerate).toBe(true);
  });

  test('is marked approximate outside the Diwali month', async () => {
    await seed({ diwaliMonth: false });
    const res = await request(app).get(`/api/v2/bonus/preview?year=${curYear}`).set('Cookie', adminCookie());
    expect(res.body.approximate).toBe(true);
    expect(res.body.canGenerate).toBe(false);
  });
});

describe('POST /bonus/trigger — Diwali-month guard', () => {
  test('blocked outside the Diwali month', async () => {
    await seed({ diwaliMonth: false });
    const res = await request(app).post('/api/v2/bonus/trigger').set('Cookie', adminCookie()).send({ year: curYear });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/diwali month/i);
  });

  test('generates records in the Diwali month', async () => {
    await seed({ diwaliMonth: true });
    const res = await request(app).post('/api/v2/bonus/trigger').set('Cookie', adminCookie()).send({ year: curYear });
    expect(res.status).toBe(200);
    expect(res.body.recordCount).toBe(1);
    const rec = await BonusRecord.findOne({ year: curYear });
    expect(rec.bonusAmount).toBe(1000);
    expect(rec.salaryReceived).toBe(10000);
  });
});
