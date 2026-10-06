'use strict';
// ══════════════════════════════════════════════════════════════════
//  PAYROLL, CHANGED BY TWO PEOPLE AT ONCE
//
//  • Generating a month re-read nothing between "is it still a draft?"
//    and its write, so a slip finalized or paid in that window was put
//    back to draft with a recomputed amount.
//  • Auto-generate did the same to any slip made since it listed who
//    still needed one — and dropped the advance recovery plan, so the
//    advance was deducted from pay and then deducted again next month.
//  • An advance already paid out could be approved again, and paid out
//    again; or rejected, which stops it ever being recovered.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, Employee, Attendance, AdvanceRequest, Payroll, User, admin;

const YEAR = 2026, MONTH = 6, RATE = 100;
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
const put = (url, body = {}) => request(app).put(url).set('Cookie', cookie()).send(body);
const post = (url, body = {}) => request(app).post(url).set('Cookie', cookie()).send(body);
const att = (emp, day) =>
  Attendance.create({ employee: emp, date: new Date(YEAR, MONTH - 1, day), shift: 'DAY', status: 'present' });

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  Employee = require('../../models/Employee');
  Attendance = require('../../models/Attendence.js');
  AdvanceRequest = require('../../models/Advance');
  Payroll = require('../../models/Payroll');
  User = require('../../models/User');
  admin = await User.create({ name: 'Owner', email: 'o@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  await Payroll.init();
}, 60_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  jest.restoreAllMocks();
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
});

const generate = () => post('/api/v2/payroll/generate', { year: YEAR, month: MONTH });
const slipOf = (emp) => Payroll.findOne({ employee: emp._id, year: YEAR, month: MONTH }).lean();

describe('generating a month as a slip is paid', () => {
  it('leaves the paid slip as it is', async () => {
    const emp = await Employee.create({ name: 'W', hourlyRate: RATE });
    await att(emp._id, 2);
    await generate();
    const slip = await slipOf(emp);
    expect((await put(`/api/v2/payroll/${slip._id}/pay`)).status).toBe(200);
    const paid = await slipOf(emp);

    // More attendance turns up, and the regenerate's first look at the
    // slip was taken while it was still a draft.
    await att(emp._id, 3);
    jest.spyOn(Payroll, 'findOne').mockImplementationOnce(() => ({
      lean: () => Promise.resolve({ status: 'draft', amountPaid: 0 }),
    }));
    const res = await generate();
    expect(res.status).toBe(200);
    expect(res.body.errors?.[0]?.error).toMatch(/finalized or paid/);

    const after = await slipOf(emp);
    expect(after.status).toBe('paid');
    expect(after.netPay).toBe(paid.netPay);
    expect(after.amountPaid).toBe(paid.amountPaid);
  });

  it('still regenerates a draft', async () => {
    const emp = await Employee.create({ name: 'W', hourlyRate: RATE });
    await att(emp._id, 2);
    await generate();
    const first = await slipOf(emp);
    await att(emp._id, 3);
    await generate();
    const second = await slipOf(emp);
    expect(second.status).toBe('draft');
    expect(second.grossEarnings).toBeGreaterThan(first.grossEarnings);
  });
});

describe('auto-generate', () => {
  const auto = () => post('/api/v2/payroll/auto-generate', { period: `${YEAR}-${String(MONTH).padStart(2, '0')}` });

  it('carries the advance recovery, so finalizing recovers it', async () => {
    const emp = await Employee.create({ name: 'W', hourlyRate: RATE });
    await att(emp._id, 2);
    const adv = await AdvanceRequest.create({
      employee: emp._id, amount: 500, status: 'paid_out', deductMonth: MONTH, deductYear: YEAR,
    });

    const res = await auto();
    expect(res.body.result?.generated).toBe(1);
    const slip = await slipOf(emp);
    expect(slip.totalAdvanceDeduction).toBe(500);

    expect((await put(`/api/v2/payroll/${slip._id}/finalize`)).status).toBe(200);
    const after = await AdvanceRequest.findById(adv._id).lean();
    expect(after.remainingBalance).toBe(0);
    expect(after.status).toBe('recovered');
  });

  it('does not overwrite a slip finalized since it listed who needed one', async () => {
    const emp = await Employee.create({ name: 'W', hourlyRate: RATE });
    await att(emp._id, 2);
    await generate();
    const slip = await slipOf(emp);
    expect((await put(`/api/v2/payroll/${slip._id}/finalize`)).status).toBe(200);
    const finalized = await slipOf(emp);

    await att(emp._id, 3);
    // Its "who already has a slip" read was taken before the slip existed.
    jest.spyOn(Payroll, 'find').mockImplementationOnce(() => ({ lean: () => Promise.resolve([]) }));
    const res = await auto();
    expect(res.status).toBe(200);

    const after = await slipOf(emp);
    expect(after.status).toBe('finalized');
    expect(after.netPay).toBe(finalized.netPay);
  });
});

describe('an advance already paid out', () => {
  async function paidOut() {
    const emp = await Employee.create({ name: 'W', hourlyRate: RATE });
    const adv = await AdvanceRequest.create({ employee: emp._id, amount: 2000, status: 'requested' });
    expect((await put(`/api/v2/payroll/advance/${adv._id}/approve`, { deductMonth: MONTH, deductYear: YEAR })).status).toBe(200);
    expect((await put(`/api/v2/payroll/advance/${adv._id}/pay-out`)).status).toBe(200);
    return adv;
  }

  it('cannot be approved again, and so cannot be paid out twice', async () => {
    const adv = await paidOut();
    const again = await put(`/api/v2/payroll/advance/${adv._id}/approve`, { deductMonth: MONTH, deductYear: YEAR });
    expect(again.status).toBe(409);
    expect((await put(`/api/v2/payroll/advance/${adv._id}/pay-out`)).status).toBe(400);
    expect((await AdvanceRequest.findById(adv._id).lean()).status).toBe('paid_out');
  });

  it('cannot be rejected, which would stop it being recovered', async () => {
    const adv = await paidOut();
    const res = await put(`/api/v2/payroll/advance/${adv._id}/reject`, { adminNotes: 'oops' });
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/paid out/);
    expect((await AdvanceRequest.findById(adv._id).lean()).status).toBe('paid_out');
  });

  it('a request can still be rejected, and a rejection reconsidered', async () => {
    const emp = await Employee.create({ name: 'W', hourlyRate: RATE });
    const adv = await AdvanceRequest.create({ employee: emp._id, amount: 2000, status: 'requested' });
    expect((await put(`/api/v2/payroll/advance/${adv._id}/reject`)).status).toBe(200);
    expect((await put(`/api/v2/payroll/advance/${adv._id}/approve`, { deductMonth: MONTH, deductYear: YEAR })).status).toBe(200);
  });
});
