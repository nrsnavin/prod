'use strict';
// ══════════════════════════════════════════════════════════════════
//  PAYROLL: WHAT FINALIZING AND PAYING A SLIP DO
//
//  Found reading api/payroll.js and services/payrollService.js line by
//  line.
//
//  1. AN ADVANCE THAT CHANGED AFTER THE DRAFT. The draft plans which
//     advances the month recovers; the slip is finalized later. In
//     between an approved advance can be rejected ("never handed over")
//     or approved again for a later month. Finalize only capped the plan
//     at the advance's balance: it still took a REJECTED advance out of
//     the worker's pay, and marked it recovered.
//
//  2. A SLIP WITH NOTHING TO PAY (no shift worked, or deductions that
//     came to all of the pay) finalized at ₹0 and could never be closed:
//     paying it was refused, so it waited to be paid for good and the
//     worker's page said "1 unpaid payslip, ₹0".
//
//  3. THE LINES ON A SLIP were rounded only when added up, so a slip
//     stored "Half Day 512.0999999999999", overtime off a clock read
//     "Overtime 37.49028333333331m", and a half-paisa went down as often
//     as up (60 minutes at ₹80.05 × 1.5 is ₹120.075: paid ₹120.07).
//
//  4. THE STREAK BONUS counted approved leave as days in the run, and
//     needed no shift worked: a fortnight's leave earned two of them.
//
//  5. THE PAY OVERVIEW listed the month's wastage by the day it was
//     logged; the payslip in the same answer charges by the day it
//     happened. Two different sets of entries, two different totals.
//
//  6. AN HOURLY RATE of null or "" was stored as ₹0 (which drops the
//     employee from payroll), `true` as ₹1, and "Infinity" as a rate.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, Employee, Attendance, PayrollSettings, AdvanceRequest, Wastage, Payroll, LedgerEntry, User, computePayroll, moneyLines, admin;

const YEAR = 2026, MONTH = 6, RATE = 100;
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
const api = (method, url, body) => request(app)[method](`/api/v2/payroll${url}`).set('Cookie', cookie()).send(body);
const att = (emp, day, extra = {}) => Attendance.create({
  employee: emp._id, date: new Date(Date.UTC(YEAR, MONTH - 1, day)), shift: 'DAY', status: 'present', ...extra,
});

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  Employee = require('../../models/Employee'); Attendance = require('../../models/Attendence.js');
  PayrollSettings = require('../../models/PayrollSettings'); AdvanceRequest = require('../../models/Advance');
  Wastage = require('../../models/Wastage'); Payroll = require('../../models/Payroll');
  LedgerEntry = require('../../models/LedgerEntry'); User = require('../../models/User');
  computePayroll = require('../../services/payrollService').computePayroll;
  moneyLines = require('../../utils/payslipLines').moneyLines;
  admin = await User.create({ name: 'Owner', email: 'payfin@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
});

let n = 0;
const makeEmp = (over = {}) => Employee.create({ name: `Worker ${++n}`, hourlyRate: RATE, ...over });
const generate = (emp, month = MONTH) => api('post', '/generate', { year: YEAR, month, employeeId: String(emp._id) });
const slipOf = (emp, month = MONTH) => Payroll.findOne({ employee: emp._id, year: YEAR, month });
const linesTotal = (slip) => Math.round(moneyLines(slip.lineItems).reduce((s, l) => s + l.amount, 0) * 100) / 100;

// ══════════════════════════════════════════════════════════════════
describe('an advance that changed after the draft was drawn up', () => {
  /** Two shifts worked (₹2,400 + ₹800 of bonuses) and an approved advance of ₹500 for the month. */
  async function drafted() {
    const emp = await makeEmp();
    await att(emp, 2); await att(emp, 3);
    const adv = await AdvanceRequest.create({ employee: emp._id, amount: 500, status: 'approved', deductMonth: MONTH, deductYear: YEAR });
    expect((await generate(emp)).status).toBe(200);
    const draft = await slipOf(emp);
    expect(draft).toMatchObject({ status: 'draft', netPay: 2700, totalAdvanceDeduction: 500 });
    return { emp, adv, draft };
  }

  it('rejected: nothing is taken, and the advance stays rejected', async () => {
    const { emp, adv, draft } = await drafted();
    expect((await api('put', `/advance/${adv._id}/reject`, { adminNotes: 'never handed over' })).status).toBe(200);

    const res = await api('put', `/${draft._id}/finalize`, {});
    expect(res.status).toBe(200);
    // Before: net pay 2,700 — ₹500 taken for an advance that was never given.
    expect(res.body.data).toMatchObject({ status: 'finalized', netPay: 3200, totalAdvanceDeduction: 0 });
    expect(res.body.data.advanceRecoveries.map((r) => r.amount)).toEqual([0]);
    expect(res.body.data.lineItems.at(-1)).toMatchObject({ amount: 500, type: 'earning' });
    expect(res.body.data.lineItems.at(-1).label).toMatch(/^Advance recovery capped — ₹500 not taken: the advance was rejected or moved/);
    // The lines still come to the net pay.
    expect(linesTotal(res.body.data)).toBe(3200);

    // Before: "recovered", balance 0.
    expect(await AdvanceRequest.findById(adv._id).lean()).toMatchObject({ status: 'rejected', remainingBalance: 500, deductedInPayroll: false });
    // And the ledger owes the worker the whole month, with no advance on it.
    const rows = await LedgerEntry.find({ employee: emp._id }).lean();
    expect(rows.some((r) => /advance/i.test(r.kind))).toBe(false);
    expect(Math.round(rows.reduce((s, r) => s + r.amount, 0) * 100) / 100).toBe(3200);
  });

  it('moved to a later month: not taken now, and next month plans it', async () => {
    const { emp, adv, draft } = await drafted();
    const moved = await api('put', `/advance/${adv._id}/approve`, { deductMonth: MONTH + 1, deductYear: YEAR });
    expect(moved.status).toBe(200);

    const res = await api('put', `/${draft._id}/finalize`, {});
    expect(res.body.data).toMatchObject({ netPay: 3200, totalAdvanceDeduction: 0 });
    expect(await AdvanceRequest.findById(adv._id).lean()).toMatchObject({ status: 'approved', remainingBalance: 500, deductMonth: MONTH + 1 });

    await Attendance.create({ employee: emp._id, date: new Date(Date.UTC(YEAR, MONTH, 2)), shift: 'DAY', status: 'present' });
    expect((await generate(emp, MONTH + 1)).status).toBe(200);
    expect(await slipOf(emp, MONTH + 1)).toMatchObject({ totalAdvanceDeduction: 500 });
  });

  it('paid straight from the draft: the same', async () => {
    const { adv, draft } = await drafted();
    await api('put', `/advance/${adv._id}/reject`, {});
    const res = await api('put', `/${draft._id}/pay`, {});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ cashPaid: 3200, advanceRecovered: 0 });
    expect(res.body.data).toMatchObject({ status: 'paid', netPay: 3200, amountPaid: 3200 });
    expect((await AdvanceRequest.findById(adv._id).lean()).status).toBe('rejected');
  });

  it('an advance that still stands is recovered, as before', async () => {
    const { adv, draft } = await drafted();
    const res = await api('put', `/${draft._id}/finalize`, {});
    expect(res.body.data).toMatchObject({ status: 'finalized', netPay: 2700, totalAdvanceDeduction: 500 });
    expect(await AdvanceRequest.findById(adv._id).lean()).toMatchObject({ status: 'recovered', remainingBalance: 0 });
  });

  it('one with less left than planned is capped, and the rest carried, as before', async () => {
    const { adv, draft } = await drafted();
    await AdvanceRequest.updateOne({ _id: adv._id }, { $set: { remainingBalance: 200, status: 'paid_out' } });
    const res = await api('put', `/${draft._id}/finalize`, {});
    expect(res.body.data).toMatchObject({ netPay: 3000, totalAdvanceDeduction: 200 });
    expect(res.body.data.lineItems.at(-1).label).toBe('Advance recovery capped — ₹300 carried to next month');
  });
});

// ══════════════════════════════════════════════════════════════════
describe('a slip with nothing to pay', () => {
  it('is settled when it is finalized', async () => {
    const emp = await makeEmp();           // no shift in the month
    await generate(emp);
    const draft = await slipOf(emp);
    expect(draft.netPay).toBe(0);

    const res = await api('put', `/${draft._id}/finalize`, {});
    expect(res.status).toBe(200);
    // Before: "finalized", and nothing could move it on.
    expect(res.body.data).toMatchObject({ status: 'paid', netPay: 0, amountPaid: 0 });
    expect(res.body.data.paidAt).toBeTruthy();
    expect(res.body.data.payouts).toEqual([]);

    const dash = (await api('get', `/dashboard?year=${YEAR}&month=${MONTH}`)).body.summary;
    expect(dash).toMatchObject({ paidCount: 1, finalizedCount: 0, totalPaid: 0 });
    const history = (await api('get', `/history/${emp._id}`)).body.data;
    expect(history).toMatchObject({ unpaidCount: 0, unpaidTotal: 0 });
  });

  it('one finalized before this is settled by Pay, not refused', async () => {
    const emp = await makeEmp();
    const old = await Payroll.create({ employee: emp._id, year: YEAR, month: MONTH, hourlyRate: RATE, netPay: 0, status: 'finalized', finalizedAt: new Date() });
    const res = await api('put', `/${old._id}/pay`, {});
    // Before: 400 "Nothing left to pay".
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ cashPaid: 0, advanceRecovered: 0 });
    expect(res.body.message).toMatch(/nothing to pay/i);
    expect(res.body.data.status).toBe('paid');
    expect(await LedgerEntry.countDocuments({ kind: 'payment' })).toBe(0);
  });

  it('is not counted as an unpaid slip on the worker\'s page', async () => {
    const emp = await makeEmp();
    await Payroll.create({ employee: emp._id, year: YEAR, month: MONTH, hourlyRate: RATE, netPay: 0, status: 'finalized' });
    await Payroll.create({ employee: emp._id, year: YEAR, month: MONTH - 1, hourlyRate: RATE, netPay: 1200.1, amountPaid: 400.2, status: 'partially_paid' });
    const history = (await api('get', `/history/${emp._id}`)).body.data;
    // To the paisa: 1200.1 − 400.2 is 799.8999999999999 in floating point.
    expect(history).toMatchObject({ unpaidCount: 1, unpaidTotal: 799.9 });
  });

  it('a slip with money on it still waits to be paid', async () => {
    const emp = await makeEmp();
    await att(emp, 2);
    await generate(emp);
    const draft = await slipOf(emp);
    expect((await api('put', `/${draft._id}/finalize`, {})).body.data.status).toBe('finalized');
    const paid = await api('put', `/${draft._id}/pay`, {});
    expect(paid.body).toMatchObject({ cashPaid: draft.netPay });
    expect(paid.body.data.status).toBe('paid');
    expect((await api('put', `/${draft._id}/pay`, {})).status).toBe(400);   // already fully paid
  });
});

// ══════════════════════════════════════════════════════════════════
describe("a payslip's lines", () => {
  it('are each to the paisa, and add up to its gross', async () => {
    const emp = await makeEmp({ hourlyRate: 85.35 });
    await att(emp, 2, { status: 'half_day' });
    await att(emp, 3);
    await att(emp, 4, { lateMinutes: 23 });      // 13 minutes past the 10 of grace
    const p = await computePayroll(emp._id, YEAR, MONTH);
    const amounts = Object.fromEntries(p.lineItems.map((l) => [l.label, l.amount]));
    // Before: 512.0999999999999, 1024.1999999999998, −18.4925, 1005.7074999999999.
    expect(amounts['Half Day (DAY 2026-06-02)']).toBe(512.1);
    expect(amounts['DAY Shift (2026-06-03)']).toBe(1024.2);
    expect(amounts['Late deduction 13m (DAY 2026-06-04)']).toBe(-18.49);
    expect(amounts['DAY Shift (2026-06-04)']).toBe(1005.71);
    expect(p.grossEarnings).toBe(2542.01);
    expect(Math.round((512.1 + 1024.2 + 1005.71) * 100) / 100).toBe(p.grossEarnings);
  });

  it('round a half-paisa up, not down', async () => {
    await PayrollSettings.create({ overtimeMultiplier: 1.5, overtimeGraceMinutes: 0 });
    const emp = await makeEmp({ hourlyRate: 80.05 });
    await att(emp, 2, { overtimeMinutes: 60 });  // 1 h × 80.05 × 1.5 = 120.075
    const p = await computePayroll(emp._id, YEAR, MONTH);
    expect(p.overtimeEarnings).toBe(120.08);     // was 120.07
    expect(p.lineItems.find((l) => /^Overtime/.test(l.label)).amount).toBe(120.08);
  });

  it('say overtime in whole minutes when it comes off the clock', async () => {
    await PayrollSettings.create({ overtimeMultiplier: 1.25, overtimeGraceMinutes: 120 });
    const emp = await makeEmp();
    // 14 h 37 min 29.417 s on the floor: 12 h of shift, 2 h of grace, 37.49 minutes paid.
    await att(emp, 2, { clockInAt: new Date('2026-06-02T02:30:00.000Z'), clockOutAt: new Date('2026-06-02T17:07:29.417Z') });
    const p = await computePayroll(emp._id, YEAR, MONTH);
    const ot = p.lineItems.find((l) => /^Overtime/.test(l.label));
    // Before: "Overtime 37.49028333333331m ×1.25 (DAY 2026-06-02)", 78.10475694444439.
    expect(ot).toMatchObject({ label: 'Overtime 37m ×1.25 (DAY 2026-06-02)', amount: 78.1 });
    expect(p.totalOvertimeMinutes).toBe(37);
    expect(p.overtimeEarnings).toBe(78.1);
    expect(p.grossEarnings).toBe(1278.1);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('the streak bonus', () => {
  it('is not paid for a run of approved leave with no shift worked', async () => {
    const emp = await makeEmp();
    for (let d = 1; d <= 14; d++) await att(emp, d, { status: 'on_leave', isApprovedLeave: true, leaveType: 'casual' });
    const p = await computePayroll(emp._id, YEAR, MONTH);
    // Before: two streak bonuses, ₹200 net for a month nobody worked.
    expect(p).toMatchObject({ presentShifts: 0, totalStreakBonus: 0, totalBonuses: 0, netPay: 0 });
    expect(p.lineItems.filter((l) => l.type === 'bonus')).toEqual([]);
  });

  it('is still paid for seven days worked in a row', async () => {
    const emp = await makeEmp();
    for (let d = 1; d <= 7; d++) await att(emp, d);
    const p = await computePayroll(emp._id, YEAR, MONTH);
    expect(p).toMatchObject({ longestStreak: 7, totalStreakBonus: 100 });
  });
});

// ══════════════════════════════════════════════════════════════════
describe("the pay overview's wastage", () => {
  it('is the wastage the payslip charges, with how much it was', async () => {
    const emp = await makeEmp();
    await att(emp, 2);
    const job = new mongoose.Types.ObjectId(); const elastic = new mongoose.Types.ObjectId();
    await Wastage.collection.insertMany([
      // Happened on 20 June, logged on 2 July: June's pay.
      { job, elastic, employee: emp._id, quantity: 40, penalty: 100, reason: 'Selvedge torn', incidentDate: new Date(Date.UTC(YEAR, MONTH - 1, 20)), createdAt: new Date(Date.UTC(YEAR, MONTH, 2)), updatedAt: new Date() },
      // Happened on 30 May, logged on 1 June: May's pay.
      { job, elastic, employee: emp._id, quantity: 25, penalty: 50, reason: 'Wrong pick', incidentDate: new Date(Date.UTC(YEAR, MONTH - 2, 30)), createdAt: new Date(Date.UTC(YEAR, MONTH - 1, 1, 3)), updatedAt: new Date() },
    ]);
    const res = await api('get', `/employee-overview/${emp._id}?year=${YEAR}&month=${MONTH}`);
    expect(res.status).toBe(200);
    const { wastage, payroll, shiftRates } = res.body.data;
    // Before: the May entry, ₹50 — beside a payslip charging ₹100.
    expect(wastage.entries.map((w) => [w.reason, w.penalty, w.quantity])).toEqual([['Selvedge torn', 100, 40]]);
    expect(wastage.totalPenalty).toBe(100);
    expect(payroll.lineItems.find((l) => /^Wastage penalty/.test(l.label))).toMatchObject({ label: 'Wastage penalty (1 entry)', amount: -100 });
    expect(shiftRates).toEqual({ DAY: 1200, NIGHT: 1200 });
  });
});

// ══════════════════════════════════════════════════════════════════
describe('setting an hourly rate', () => {
  const setRate = (emp, hourlyRate) => api('post', `/employees/${emp._id}/rate`, { hourlyRate });
  const rateOf = async (emp) => (await Employee.findById(emp._id).lean()).hourlyRate;

  it.each([
    ['nothing', null], ['a blank', ''], ['true', true], ['"Infinity"', 'Infinity'], ['1e308', 1e308],
    ['words', '12abc'], ['a negative', -1], ['more than anybody is paid', 100001],
  ])('refuses %s, and leaves the rate as it was', async (_what, value) => {
    const emp = await makeEmp();
    const res = await setRate(emp, value);
    // Before: nothing and a blank were stored as ₹0, true as ₹1, and
    // "Infinity" and 1e308 as they stood.
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/^The hourly rate /);
    expect(await rateOf(emp)).toBe(RATE);
  });

  it('takes a rate, as a number or as typed, and ₹0 when ₹0 is meant', async () => {
    const emp = await makeEmp();
    expect((await setRate(emp, 85.5)).body.data).toMatchObject({ hourlyRate: 85.5, dayShiftPay: 1026, nightShiftPay: 1026 });
    expect((await setRate(emp, '92')).status).toBe(200);
    expect(await rateOf(emp)).toBe(92);
    expect((await setRate(emp, 0)).status).toBe(200);
    expect(await rateOf(emp)).toBe(0);
  });

  it('says so when there is no such employee', async () => {
    expect((await api('post', `/employees/${new mongoose.Types.ObjectId()}/rate`, { hourlyRate: 90 })).status).toBe(404);
    expect((await api('post', '/employees/not-an-id/rate', { hourlyRate: 90 })).status).toBe(404);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('the year a payroll report is asked for', () => {
  it('is refused when it is not one, and the month likewise', async () => {
    expect((await api('get', '/analytics?year=abc')).status).toBe(400);
    expect((await api('get', '/analytics?month=13')).status).toBe(400);
    expect((await api('get', '/analytics?month=6.5')).status).toBe(400);
  });

  it('is the factory\'s when none is asked for', async () => {
    const res = await api('get', '/analytics');
    expect(res.status).toBe(200);
    expect(res.body.year).toBe(Number(require('../../utils/factoryDay').ymd().slice(0, 4)));
    expect(res.body.month).toBe('all');
  });
});
