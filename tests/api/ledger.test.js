'use strict';
// Employee ledger: every money event lands as a signed row, written in the
// same transaction as the change that caused it. Also covers recovering an
// advance at payment time.
//
//   +ve = factory owes the employee more   (earnings, bonuses)
//   -ve = reduces what is owed             (penalties, statutory, payments,
//                                           advance issued)

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, Employee, Attendance, PayrollSettings, AdvanceRequest, Payroll, LedgerEntry, User, admin;

const YEAR = 2026, MONTH = 6, RATE = 100;
const cookie = (id, role) => [`token=${jwt.sign({ id, role }, process.env.JWT_SECRET_KEY)}`];
const adminCookie = () => cookie(admin._id, 'admin');
const att = (emp, day, extra = {}) =>
  Attendance.create({ employee: emp, date: new Date(YEAR, MONTH - 1, day), shift: 'DAY', status: 'present', ...extra });
const makeEmp = (over = {}) => Employee.create({ name: 'W', hourlyRate: RATE, ...over });
const gen = () => request(app).post('/api/v2/payroll/generate').set('Cookie', adminCookie()).send({ year: YEAR, month: MONTH });

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  Employee = require('../../models/Employee'); Attendance = require('../../models/Attendence.js');
  PayrollSettings = require('../../models/PayrollSettings'); AdvanceRequest = require('../../models/Advance');
  Payroll = require('../../models/Payroll'); LedgerEntry = require('../../models/LedgerEntry');
  User = require('../../models/User');
  admin = await User.create({ name: 'Owner', email: 'o@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
}, 60_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
});

describe('ledger postings', () => {
  test('finalizing a payroll posts its earnings/deductions, dated per shift', async () => {
    const emp = await makeEmp();
    await att(emp._id, 2);
    await att(emp._id, 3, { status: 'absent' });
    await gen();
    const slip = await Payroll.findOne({ employee: emp._id });

    // nothing posted while still a draft
    expect(await LedgerEntry.countDocuments({ employee: emp._id })).toBe(0);

    await request(app).put(`/api/v2/payroll/${slip._id}/finalize`).set('Cookie', adminCookie()).send({});
    const rows = await LedgerEntry.find({ employee: emp._id }).sort({ date: 1 }).lean();
    expect(rows.length).toBeGreaterThan(0);

    const shift = rows.find(r => r.kind === 'shift_salary' && r.amount > 0);
    expect(shift).toBeTruthy();
    // dated on the worked day, parsed out of the line-item label
    expect(new Date(shift.date).getDate()).toBe(2);

    expect(rows.some(r => r.kind === 'absence' && r.amount < 0)).toBe(true);
    // re-finalize is blocked, so no chance of duplicates; but re-posting the
    // same source must be idempotent anyway
    const before = rows.length;
    const ledger = require('../../services/ledgerService');
    const session = await mongoose.startSession();
    await session.withTransaction(async () => {
      await ledger.postPayroll(await Payroll.findById(slip._id), session, {});
    });
    await session.endSession();
    expect(await LedgerEntry.countDocuments({ employee: emp._id, kind: { $ne: 'payment' } })).toBe(before);
  });

  test('an approved advance is booked as owed, and paying posts a payment row', async () => {
    const emp = await makeEmp();
    await att(emp._id, 2);

    // admin-created advance is born approved → ledger row immediately
    const adv = await request(app).post('/api/v2/payroll/advance/admin-create').set('Cookie', adminCookie())
      .send({ employee: emp._id, amount: 500, deductMonth: 12, deductYear: YEAR, reason: 'medical' });
    expect(adv.status).toBe(201);
    const issued = await LedgerEntry.findOne({ employee: emp._id, kind: 'advance_issued' });
    expect(issued.amount).toBe(-500);          // employee owes it back

    await gen();
    const slip = await Payroll.findOne({ employee: emp._id });
    const pay = await request(app).put(`/api/v2/payroll/${slip._id}/pay`).set('Cookie', adminCookie()).send({});
    expect(pay.status).toBe(200);

    const payment = await LedgerEntry.findOne({ employee: emp._id, kind: 'payment' });
    expect(payment.amount).toBeLessThan(0);    // money going out settles the debt
  });

  test('GET /payroll/ledger/:empId returns a running balance over a date range', async () => {
    const emp = await makeEmp();
    await att(emp._id, 2);
    await gen();
    const slip = await Payroll.findOne({ employee: emp._id });
    await request(app).put(`/api/v2/payroll/${slip._id}/finalize`).set('Cookie', adminCookie()).send({});

    const res = await request(app)
      .get(`/api/v2/payroll/ledger/${emp._id}?from=${YEAR}-${String(MONTH).padStart(2,'0')}-01&to=${YEAR}-${String(MONTH).padStart(2,'0')}-30`)
      .set('Cookie', adminCookie());
    expect(res.status).toBe(200);
    expect(res.body.entries.length).toBeGreaterThan(0);
    // running balance is cumulative
    const last = res.body.entries[res.body.entries.length - 1];
    expect(last.balance).toBe(res.body.closingBalance);
    expect(res.body.totals.earnings).toBeGreaterThan(0);
  });

  test('a date window excludes entries outside it', async () => {
    const emp = await makeEmp();
    await LedgerEntry.create([
      { employee: emp._id, date: new Date(2026, 0, 15), kind: 'shift_salary', amount: 1000, source: 'manual' },
      { employee: emp._id, date: new Date(2026, 5, 15), kind: 'shift_salary', amount: 2000, source: 'manual' },
    ]);
    const res = await request(app)
      .get(`/api/v2/payroll/ledger/${emp._id}?from=2026-06-01&to=2026-06-30`)
      .set('Cookie', adminCookie());
    expect(res.body.entries).toHaveLength(1);
    expect(res.body.openingBalance).toBe(1000);   // January carried in
    expect(res.body.closingBalance).toBe(3000);
  });
});

describe('recovering an advance during payment', () => {
  test('recovery reduces cash paid, clears the advance, and settles the slip', async () => {
    const emp = await makeEmp();
    await att(emp._id, 2);  // net = 1200 + 800 bonus = 2000
    // deduct month is far out, so payroll generation does NOT auto-recover it
    const adv = await AdvanceRequest.create({
      employee: emp._id, amount: 600, status: 'paid_out', deductMonth: 12, deductYear: YEAR + 1,
    });
    await gen();
    const slip = await Payroll.findOne({ employee: emp._id });
    expect(slip.netPay).toBe(2000);

    const res = await request(app).put(`/api/v2/payroll/${slip._id}/pay`).set('Cookie', adminCookie())
      .send({ amount: 1400, recoverAdvances: [{ advance: adv._id, amount: 600 }] });
    expect(res.status).toBe(200);
    expect(res.body.cashPaid).toBe(1400);
    expect(res.body.advanceRecovered).toBe(600);
    expect(res.body.data.status).toBe('paid');          // 1400 + 600 = 2000
    expect(res.body.data.amountPaid).toBe(2000);

    const after = await AdvanceRequest.findById(adv._id);
    expect(after.remainingBalance).toBe(0);

    // the payout history records cash vs advance held back
    expect(after.status).toBe('recovered');
    const fresh = await Payroll.findById(slip._id);
    expect(fresh.totalCashPaid).toBe(1400);
    expect(fresh.advanceRecoveredAtPayment).toBe(600);
    expect(fresh.payouts).toHaveLength(1);
    expect(fresh.payouts[0].cash).toBe(1400);
    expect(fresh.payouts[0].advanceRecovered).toBe(600);
    expect(fresh.payouts[0].total).toBe(2000);
    expect(fresh.payouts[0].advances[0].amount).toBe(600);

    const rec = await LedgerEntry.findOne({ employee: emp._id, kind: 'advance_recovered' });
    expect(rec.amount).toBe(600);   // +ve: cancels the advance_issued debt
  });

  test('recovery is capped at the advance balance and the slip remaining', async () => {
    const emp = await makeEmp();
    await att(emp._id, 2);  // net 2000
    const adv = await AdvanceRequest.create({
      employee: emp._id, amount: 300, status: 'paid_out', deductMonth: 12, deductYear: YEAR + 1,
    });
    await gen();
    const slip = await Payroll.findOne({ employee: emp._id });

    const res = await request(app).put(`/api/v2/payroll/${slip._id}/pay`).set('Cookie', adminCookie())
      .send({ amount: 0, recoverAdvances: [{ advance: adv._id, amount: 99999 }] });
    expect(res.status).toBe(200);
    expect(res.body.advanceRecovered).toBe(300);        // capped at the balance
    expect(res.body.data.status).toBe('partially_paid'); // 300 of 2000
  });

  test("refuses to touch another employee's advance", async () => {
    const a = await makeEmp({ name: 'A' });
    const b = await makeEmp({ name: 'B' });
    await att(a._id, 2);
    const advB = await AdvanceRequest.create({
      employee: b._id, amount: 500, status: 'paid_out', deductMonth: 12, deductYear: YEAR + 1,
    });
    await gen();
    const slipA = await Payroll.findOne({ employee: a._id });

    const res = await request(app).put(`/api/v2/payroll/${slipA._id}/pay`).set('Cookie', adminCookie())
      .send({ amount: 100, recoverAdvances: [{ advance: advB._id, amount: 500 }] });
    expect(res.status).toBe(200);
    expect(res.body.advanceRecovered).toBe(0);
    expect((await AdvanceRequest.findById(advB._id)).remainingBalance).toBe(500); // untouched
  });
});
