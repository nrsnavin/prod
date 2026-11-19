'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE BONUS SETTINGS CAN BE SAVED, AND A BONUS OF NOTHING IS NOT OWED
//
//  Found reading api/bonus.js line by line.
//
//  1. SAVING THE DIWALI DATE ANSWERED WITH A SERVER ERROR. The route read
//     the date with a helper (dayFrom) that the file never imported, so
//     the line threw "dayFrom is not defined". The date is the first thing
//     the bonus needs — nothing can be generated without it — and it was
//     broken by the change that set out to check it (18 Nov). No test had
//     ever sent the date through the route.
//
//  2. THE DATE CAN BE IN THE WRONG YEAR. The bonus year runs to the month
//     of its date; a date typed with last year's year made "2026" a
//     window ending in 2025 with nothing to say so.
//
//  3. A BONUS OF ₹0 HAD TO BE "PAID". Somebody under the minimum days gets
//     a record of ₹0, and it was pending like any other: a "Mark ₹0 paid"
//     button, a ₹0 row on their ledger, a −₹0 payment when pressed, and
//     the year not complete until every one of them had been.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, Employee, Payroll, Attendance, BonusConfig, BonusRecord, LedgerEntry, User, admin;

const now = new Date(), curYear = now.getFullYear(), curMonth = now.getMonth() + 1;
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
const day = (d) => new Date(Date.UTC(curYear, curMonth - 1, d));
const ymd = (d) => `${curYear}-${String(curMonth).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const put  = (url, body) => request(app).put(`/api/v2/bonus${url}`).set('Cookie', cookie()).send(body);
const post = (url, body) => request(app).post(`/api/v2/bonus${url}`).set('Cookie', cookie()).send(body);
const get  = (url) => request(app).get(`/api/v2/bonus${url}`).set('Cookie', cookie());

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  Employee = require('../../models/Employee'); Payroll = require('../../models/Payroll');
  Attendance = require('../../models/Attendence.js');
  BonusConfig = require('../../models/BonusConfig'); BonusRecord = require('../../models/BonusRecord');
  LedgerEntry = require('../../models/LedgerEntry'); User = require('../../models/User');
  await BonusRecord.syncIndexes();
  admin = await User.create({ name: 'Owner', email: 'bonus-set@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
}, 60_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
});

const makeEmp = (name) => Employee.create({ name, hourlyRate: 100, bonusPercent: 10 });
const paidMonth = (emp, net = 10000) => Payroll.create({ employee: emp._id, year: curYear, month: curMonth, netPay: net, status: 'paid' });
const marked = (emp, days) => Attendance.insertMany(days.map((d) => ({ employee: emp._id, date: day(d), shift: 'DAY', status: 'present' })));

// ══════════════════════════════════════════════════════════════════
describe('the bonus settings', () => {
  it('take the Diwali date', async () => {
    const res = await put('/config', { year: curYear, bonusDate: ymd(15), bonusLabel: 'Diwali bonus' });
    // Before: 500 — "dayFrom is not defined".
    expect(res.status).toBe(200);
    const cfg = await BonusConfig.findOne({ year: curYear }).lean();
    expect(cfg.bonusDate.toISOString()).toBe(`${ymd(15)}T00:00:00.000Z`);
    expect(cfg.bonusLabel).toBe('Diwali bonus');
  });

  it('take the date the phone sends, with its clock and no zone, as that day', async () => {
    const res = await put('/config', { year: curYear, bonusDate: `${ymd(15)}T21:15:30.123` });
    expect(res.status).toBe(200);
    expect((await BonusConfig.findOne({ year: curYear }).lean()).bonusDate.toISOString()).toBe(`${ymd(15)}T00:00:00.000Z`);
  });

  it('refuse a date that is not one, by name', async () => {
    const res = await put('/config', { year: curYear, bonusDate: 'after the festival' });
    expect([res.status, res.body.message]).toEqual([400, 'bonusDate is not a date']);
    expect(await BonusConfig.countDocuments({ bonusDate: { $ne: null } })).toBe(0);
  });

  it('refuse a date in another year', async () => {
    const res = await put('/config', { year: curYear, bonusDate: `${curYear - 1}-10-20` });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(new RegExp(`must be in ${curYear}`));
  });

  it('let the date be cleared', async () => {
    await put('/config', { year: curYear, bonusDate: ymd(15) });
    const res = await put('/config', { year: curYear, bonusDate: '' });
    expect(res.status).toBe(200);
    expect((await BonusConfig.findOne({ year: curYear }).lean()).bonusDate).toBeNull();
  });

  it('once the date is saved through the route, the bonus can be generated', async () => {
    const emp = await makeEmp('Ravi');
    await paidMonth(emp);
    await marked(emp, [3, 4]);
    expect((await put('/config', { year: curYear, bonusDate: ymd(15), yearlyWorkingDays: 2, minDaysForEligibility: 0, minBonusPercent: 0 })).status).toBe(200);
    const res = await post('/trigger', { year: curYear });
    expect(res.status).toBe(200);
    expect(res.body.records.map((r) => r.bonusAmount)).toEqual([1000]);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('a bonus of nothing', () => {
  /** One person with a bonus of ₹1,000 and one under the minimum days, generated. */
  async function generated() {
    const earns = await makeEmp('Ravi');
    const short = await makeEmp('Newcomer');
    for (const e of [earns, short]) await paidMonth(e);
    await marked(earns, [3, 4, 5]);
    await marked(short, [3]);
    await BonusConfig.create({ year: curYear, bonusDate: day(15), yearlyWorkingDays: 3, minDaysForEligibility: 2, minBonusPercent: 0 });
    expect((await post('/trigger', { year: curYear })).status).toBe(200);
    const of = (e) => BonusRecord.findOne({ employee: e._id, year: curYear }).lean();
    return { earns, short, of };
  }

  it('is not put on the ledger', async () => {
    const { earns, short, of } = await generated();
    expect((await of(short)).bonusAmount).toBe(0);
    expect((await of(earns)).bonusAmount).toBe(1000);
    // Before: a "Diwali bonus" row of ₹0 on the newcomer's ledger too.
    expect(await LedgerEntry.countDocuments({ employee: short._id })).toBe(0);
    expect(await LedgerEntry.countDocuments({ employee: earns._id, kind: 'diwali_bonus', amount: 1000 })).toBe(1);
  });

  it('cannot be "paid"', async () => {
    const { short, of } = await generated();
    const res = await put(`/records/${(await of(short))._id}/pay`, {});
    // Before: 200, and a payment of −₹0 on the ledger.
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/nothing (is )?due/i);
    expect((await of(short)).status).toBe('pending');
    expect(await LedgerEntry.countDocuments({ employee: short._id })).toBe(0);
  });

  it('does not keep the year open once everybody owed a bonus has been paid', async () => {
    const { earns, of } = await generated();
    expect((await put(`/records/${(await of(earns))._id}/pay`, {})).status).toBe(200);
    // Before: still "triggered" — one "pending" record, of ₹0.
    expect((await BonusConfig.findOne({ year: curYear }).lean()).status).toBe('completed');
  });

  it('is counted as nothing due, not as a payment waiting', async () => {
    await generated();
    const res = await get(`/records?year=${curYear}`);
    expect(res.body.summary).toMatchObject({ total: 2, paid: 0, pending: 1, nothingDue: 1, totalPayout: 1000, pendingPayout: 1000 });
    const cfg = await get(`/config?year=${curYear}`);
    expect(cfg.body.stats).toMatchObject({ totalRecords: 2, paidRecords: 0, pendingRecords: 1, nothingDueRecords: 1 });
  });
});
