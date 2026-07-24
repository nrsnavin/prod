'use strict';
// Tests for the payroll gap fixes: overtime, PF/ESI, unmarked-scheduled
// absents, wastage-by-incident-date, advance carry-forward, the
// finalize/pay workflow guards, paidBy attribution, skipped-employee
// reporting, the payslip PDF, and removal of the flat yearly bonus.

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
// Finalize runs in a transaction → needs a replica set (standalone can't do txns).
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, Employee, Attendance, PayrollSettings, AdvanceRequest, Wastage, ShiftDetail, Payroll, User, computePayroll, admin;

const YEAR = 2026, MONTH = 6, RATE = 100;
const cookie = (id, role) => [`token=${jwt.sign({ id, role }, process.env.JWT_SECRET_KEY)}`];
const adminCookie = () => cookie(admin._id, 'admin');
const att = (emp, day, extra = {}) =>
  Attendance.create({ employee: emp, date: new Date(YEAR, MONTH - 1, day), shift: 'DAY', status: 'present', ...extra });

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  Employee = require('../../models/Employee'); Attendance = require('../../models/Attendence.js');
  PayrollSettings = require('../../models/PayrollSettings'); AdvanceRequest = require('../../models/Advance');
  Wastage = require('../../models/Wastage'); ShiftDetail = require('../../models/ShiftDetail');
  Payroll = require('../../models/Payroll'); User = require('../../models/User');
  computePayroll = require('../../services/payrollService').computePayroll;
  admin = await User.create({ name: 'Owner', email: 'o@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
}, 60_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
});

const makeEmp = (over = {}) => Employee.create({ name: 'W', hourlyRate: RATE, ...over });

describe('#5 overtime', () => {
  test('pays overtime minutes at the configured multiplier', async () => {
    await PayrollSettings.create({ overtimeMultiplier: 1.5 });
    const emp = await makeEmp();
    await att(emp._id, 2, { overtimeMinutes: 60 }); // 1h OT × ₹100 × 1.5 = ₹150
    const p = await computePayroll(emp._id, YEAR, MONTH);
    expect(p.overtimeEarnings).toBe(150);
    expect(p.grossEarnings).toBe(1350); // 1200 base + 150 OT
  });
});

describe('#7 statutory PF/ESI', () => {
  test('deducts PF and ESI when configured (and nothing when off)', async () => {
    const emp = await makeEmp();
    await att(emp._id, 2);
    const off = await computePayroll(emp._id, YEAR, MONTH);
    expect(off.pfDeduction).toBe(0);
    expect(off.esiDeduction).toBe(0);

    await PayrollSettings.create({ pfPercent: 12, esiPercent: 0.75, esiWageCeiling: 21000 });
    const on = await computePayroll(emp._id, YEAR, MONTH);
    expect(on.pfDeduction).toBe(144);  // 12% of 1200
    expect(on.esiDeduction).toBe(9);   // 0.75% of 1200
    expect(on.totalDeductions).toBe(153);
  });
});

describe('#11 unmarked scheduled shift = absent', () => {
  test('a ShiftDetail with no attendance counts as an absent', async () => {
    const emp = await makeEmp();
    await att(emp._id, 2); // one real present shift
    // scheduled DAY shift on day 5 with NO attendance row (insert raw)
    await ShiftDetail.collection.insertOne({ employee: emp._id, date: new Date(YEAR, MONTH - 1, 5), shift: 'DAY' });
    const p = await computePayroll(emp._id, YEAR, MONTH);
    expect(p.absentShifts).toBe(1);
    expect(p.presentShifts).toBe(1);
    expect(p.perfectAttendance).toBe(false);
  });
});

describe('#12 wastage attributed by incident date', () => {
  test('penalty lands in the incident month, not the created month', async () => {
    const emp = await makeEmp();
    await att(emp._id, 2);
    // created now, but incidentDate is inside the pay month
    await Wastage.create({ job: new mongoose.Types.ObjectId(), elastic: new mongoose.Types.ObjectId(),
      employee: emp._id, quantity: 1, penalty: 300, reason: 'x',
      incidentDate: new Date(YEAR, MONTH - 1, 10) });
    const p = await computePayroll(emp._id, YEAR, MONTH);
    expect(p.totalDeductions).toBe(300);
  });
});

describe('#1 advance carry-forward', () => {
  test('recovers only what fits and carries the remainder', async () => {
    const emp = await makeEmp();
    await att(emp._id, 2); // gross 1200, +800 bonus → 2000 available
    await AdvanceRequest.create({ employee: emp._id, amount: 3000, status: 'approved',
      deductMonth: MONTH, deductYear: YEAR });
    const p = await computePayroll(emp._id, YEAR, MONTH);
    expect(p.totalAdvanceDeduction).toBe(2000); // capped at available
    expect(p.netPay).toBe(0);
    expect(p._advanceRecoveries[0].remaining).toBe(1000); // carried forward
  });
});

describe('#2/#3 finalize + pay workflow', () => {
  const gen = () => request(app).post('/api/v2/payroll/generate').set('Cookie', adminCookie()).send({ year: YEAR, month: MONTH });

  test('draft→finalized→paid enforced; paidBy is the authed user; advance committed', async () => {
    const emp = await makeEmp();
    await att(emp._id, 2);
    await AdvanceRequest.create({ employee: emp._id, amount: 500, status: 'approved', deductMonth: MONTH, deductYear: YEAR });
    await gen();
    const slip = await Payroll.findOne({ employee: emp._id, year: YEAR, month: MONTH });

    // can't pay a draft
    const early = await request(app).put(`/api/v2/payroll/${slip._id}/pay`).set('Cookie', adminCookie()).send({});
    expect(early.status).toBe(400);

    // finalize commits the advance recovery
    const fin = await request(app).put(`/api/v2/payroll/${slip._id}/finalize`).set('Cookie', adminCookie()).send({});
    expect(fin.status).toBe(200);
    const adv = await AdvanceRequest.findOne({ employee: emp._id });
    expect(adv.remainingBalance).toBe(0);
    expect(adv.deductedInPayroll).toBe(true);

    // re-finalize blocked
    const refin = await request(app).put(`/api/v2/payroll/${slip._id}/finalize`).set('Cookie', adminCookie()).send({});
    expect(refin.status).toBe(400);

    // pay records the authed user, not a body-supplied name
    const pay = await request(app).put(`/api/v2/payroll/${slip._id}/pay`).set('Cookie', adminCookie()).send({ paidBy: 'HACKER' });
    expect(pay.status).toBe(200);
    expect(pay.body.data.paidBy).toBe('Owner');

    // double-pay blocked
    const repay = await request(app).put(`/api/v2/payroll/${slip._id}/pay`).set('Cookie', adminCookie()).send({});
    expect(repay.status).toBe(400);
  });
});

describe('#10 skipped employees are reported', () => {
  test('generate lists employees with no hourly rate', async () => {
    await makeEmp({ hourlyRate: RATE });
    await makeEmp({ name: 'NoRate', hourlyRate: 0 });
    const res = await request(app).post('/api/v2/payroll/generate').set('Cookie', adminCookie()).send({ year: YEAR, month: MONTH });
    expect(res.status).toBe(200);
    expect(res.body.skipped).toHaveLength(1);
    expect(res.body.skipped[0].name).toBe('NoRate');
  });
});

describe('#8 payslip PDF', () => {
  test('returns a PDF for a generated month', async () => {
    const emp = await makeEmp();
    await att(emp._id, 2);
    await request(app).post('/api/v2/payroll/generate').set('Cookie', adminCookie()).send({ year: YEAR, month: MONTH });
    const res = await request(app).get(`/api/v2/payroll/slip/${emp._id}/pdf?year=${YEAR}&month=${MONTH}`).set('Cookie', adminCookie());
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/pdf/);
  });
});

describe('#9 flat yearly bonus removed', () => {
  test('the old /yearly-bonus/compute route is gone (404)', async () => {
    const res = await request(app).post('/api/v2/payroll/yearly-bonus/compute').set('Cookie', adminCookie()).send({ year: YEAR });
    expect(res.status).toBe(404);
  });
});
