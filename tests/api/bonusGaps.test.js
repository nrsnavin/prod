'use strict';
// Diwali-bonus gap fixes:
//   • attendance comes from the attendance REGISTER, not scheduled shifts
//     (an employee marked absent every day must not score a full tier)
//   • eligibility threshold (min days worked)
//   • statutory floor on the effective bonus rate
//   • reset retracts the ledger rows it deletes (no orphans)
//   • re-trigger never recomputes or clobbers an already-PAID record

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, Employee, Payroll, ShiftDetail, Attendance, BonusConfig, BonusRecord, LedgerEntry, User, admin;

const now = new Date(), curYear = now.getFullYear(), curMonth = now.getMonth() + 1;
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
const day = (d) => new Date(curYear, curMonth - 1, d);

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  Employee = require('../../models/Employee'); Payroll = require('../../models/Payroll');
  ShiftDetail = require('../../models/ShiftDetail'); Attendance = require('../../models/Attendence.js');
  BonusConfig = require('../../models/BonusConfig'); BonusRecord = require('../../models/BonusRecord');
  LedgerEntry = require('../../models/LedgerEntry'); User = require('../../models/User');
  await BonusRecord.syncIndexes();
  admin = await User.create({ name: 'Owner', email: 'o@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
}, 60_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
});

// cfg with eligibility/floor off unless a test opts in
const makeCfg = (over = {}) => BonusConfig.create({
  year: curYear, bonusDate: day(15), yearlyWorkingDays: 2,
  minDaysForEligibility: 0, minBonusPercent: 0, ...over,
});
const makeEmp = (name = 'W') => Employee.create({ name, hourlyRate: 100, bonusPercent: 10 });
const paidMonth = (emp, net = 10000) =>
  Payroll.create({ employee: emp._id, year: curYear, month: curMonth, netPay: net, status: 'paid' });
const scheduled = (emp, days) => ShiftDetail.collection.insertMany(
  days.map(d => ({ employee: emp._id, date: day(d), shift: 'DAY' })));
const marked = (emp, days, status) => Attendance.insertMany(
  days.map(d => ({ employee: emp._id, date: day(d), shift: 'DAY', status })));

describe('attendance is taken from the register, not the roster', () => {
  test('an employee marked ABSENT every day gets tier C, not S', async () => {
    const emp = await makeEmp('Absentee');
    await paidMonth(emp);
    await scheduled(emp, [3, 4]);        // rostered both days
    await marked(emp, [3, 4], 'absent'); // …but absent both days
    await makeCfg();

    const res = await request(app).get(`/api/v2/bonus/preview?year=${curYear}`).set('Cookie', cookie());
    const row = res.body.rows[0];
    expect(row.attendanceSource).toBe('attendance');
    expect(row.attendanceDays).toBe(0);
    expect(row.attendanceRate).toBe(0);
    expect(row.attendanceTier).toBe('C');
    expect(row.bonusAmount).toBe(250);   // 10000 × 10% × 0.25, not the full 1000
  });

  test('present days still score, and approved leave counts as attendance', async () => {
    const emp = await makeEmp();
    await paidMonth(emp);
    await scheduled(emp, [3, 4]);
    await Attendance.create({ employee: emp._id, date: day(3), shift: 'DAY', status: 'present' });
    await Attendance.create({ employee: emp._id, date: day(4), shift: 'DAY', status: 'absent', isApprovedLeave: true });
    await makeCfg();

    const res = await request(app).get(`/api/v2/bonus/preview?year=${curYear}`).set('Cookie', cookie());
    expect(res.body.rows[0].attendanceDays).toBe(2);
    expect(res.body.rows[0].attendanceTier).toBe('S');
  });

  test('falls back to the roster when no attendance was ever recorded', async () => {
    const emp = await makeEmp();
    await paidMonth(emp);
    await scheduled(emp, [3, 4]);        // no Attendance rows at all
    await makeCfg();

    const res = await request(app).get(`/api/v2/bonus/preview?year=${curYear}`).set('Cookie', cookie());
    expect(res.body.rows[0].attendanceSource).toBe('scheduled_shifts');
    expect(res.body.rows[0].attendanceDays).toBe(2);
  });
});

describe('eligibility + statutory floor', () => {
  test('below the minimum days worked, no bonus is due', async () => {
    const emp = await makeEmp();
    await paidMonth(emp);
    await marked(emp, [3], 'present');    // 1 day worked
    await makeCfg({ minDaysForEligibility: 30 });

    const res = await request(app).get(`/api/v2/bonus/preview?year=${curYear}`).set('Cookie', cookie());
    expect(res.body.rows[0].eligible).toBe(false);
    expect(res.body.rows[0].bonusAmount).toBe(0);
    expect(res.body.ineligibleCount).toBe(1);
  });

  test('the floor lifts a low tier up to the statutory minimum percent', async () => {
    const emp = await makeEmp();
    await paidMonth(emp);                       // base 10000, percent 10
    await marked(emp, [3], 'present');          // 1/2 days = 50% → tier C ×0.25
    await makeCfg({ minBonusPercent: 8.33, minDaysForEligibility: 0 });

    const res = await request(app).get(`/api/v2/bonus/preview?year=${curYear}`).set('Cookie', cookie());
    const row = res.body.rows[0];
    expect(row.attendanceTier).toBe('C');
    // ×0.25 would be 250, but the 8.33% floor lifts it to 833
    expect(row.bonusAmount).toBe(833);
  });

  test('the floor never pays MORE than the full un-scaled bonus', async () => {
    const emp = await makeEmp();
    await paidMonth(emp);
    await marked(emp, [3, 4], 'present');       // 100% → tier S ×1.0
    await makeCfg({ minBonusPercent: 50, minDaysForEligibility: 0 });

    const res = await request(app).get(`/api/v2/bonus/preview?year=${curYear}`).set('Cookie', cookie());
    expect(res.body.rows[0].bonusAmount).toBe(1000);  // capped at raw 10%, not 50%
  });
});

describe('reset + re-trigger integrity', () => {
  test('reset retracts the ledger rows for the records it deletes', async () => {
    const emp = await makeEmp();
    await paidMonth(emp);
    await marked(emp, [3, 4], 'present');
    await makeCfg();

    await request(app).post('/api/v2/bonus/trigger').set('Cookie', cookie()).send({ year: curYear });
    expect(await LedgerEntry.countDocuments({ kind: 'diwali_bonus' })).toBe(1);

    await request(app).delete(`/api/v2/bonus/year/${curYear}/reset`).set('Cookie', cookie());
    expect(await BonusRecord.countDocuments({ year: curYear })).toBe(0);
    // the ledger must not keep a bonus that no longer exists
    expect(await LedgerEntry.countDocuments({ kind: 'diwali_bonus' })).toBe(0);
  });

  test('re-trigger leaves a PAID record untouched and still updates the others', async () => {
    const a = await makeEmp('Paid');
    const b = await makeEmp('Pending');
    await paidMonth(a); await paidMonth(b);
    await marked(a, [3, 4], 'present'); await marked(b, [3, 4], 'present');
    await makeCfg();

    await request(app).post('/api/v2/bonus/trigger').set('Cookie', cookie()).send({ year: curYear });
    const recA = await BonusRecord.findOne({ employee: a._id });
    await request(app).put(`/api/v2/bonus/records/${recA._id}/pay`).set('Cookie', cookie());

    // config is 'triggered' (not all paid), so a re-trigger is allowed
    const again = await request(app).post('/api/v2/bonus/trigger').set('Cookie', cookie()).send({ year: curYear });
    expect(again.status).toBe(200);

    const afterA = await BonusRecord.findById(recA._id);
    expect(afterA.status).toBe('paid');       // still paid
    expect(afterA.paidAt).toBeTruthy();       // payment history intact
    expect(await BonusRecord.countDocuments({ year: curYear })).toBe(2);  // no duplicate
  });

  test('reset keeps a year with paid records marked completed', async () => {
    const emp = await makeEmp();
    await paidMonth(emp);
    await marked(emp, [3, 4], 'present');
    await makeCfg();
    await request(app).post('/api/v2/bonus/trigger').set('Cookie', cookie()).send({ year: curYear });
    const rec = await BonusRecord.findOne({ year: curYear });
    await request(app).put(`/api/v2/bonus/records/${rec._id}/pay`).set('Cookie', cookie());

    await request(app).delete(`/api/v2/bonus/year/${curYear}/reset`).set('Cookie', cookie());
    const cfg = await BonusConfig.findOne({ year: curYear });
    expect(cfg.status).toBe('completed');     // not reopened
    expect(await BonusRecord.countDocuments({ year: curYear, status: 'paid' })).toBe(1);
  });
});

describe('preview exposes the configured Diwali settings', () => {
  test('config (date, label, thresholds) comes back with the prediction', async () => {
    const emp = await makeEmp();
    await paidMonth(emp);
    await marked(emp, [3, 4], 'present');
    await makeCfg({ bonusLabel: 'Diwali 2026' });

    const res = await request(app).get(`/api/v2/bonus/preview?year=${curYear}`).set('Cookie', cookie());
    expect(res.body.configured).toBe(true);
    expect(res.body.config.bonusLabel).toBe('Diwali 2026');
    expect(res.body.config.yearlyWorkingDays).toBe(2);
    expect(res.body.eligibleCount).toBe(1);
    expect(res.body.rows[0].bonusAmount).toBeGreaterThan(0);
  });
});
