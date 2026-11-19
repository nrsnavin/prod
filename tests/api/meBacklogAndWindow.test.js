'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE EMPLOYEE'S OWN WORK: A BACKLOG, A LONG WINDOW, AND AN EMAIL THAT
//  IS NOT ONE
//
//  Found reading api/me.js line by line.
//
//  1. TODAY'S SHIFT COULD FALL OFF "TODAY". The shifts a worker still
//     has to enter were read oldest first, ten at most. Ten old shifts
//     never entered — a loom planned and not run, a week away — and
//     today's shift was the eleventh: not on the page it is named for.
//
//  2. "THE LAST 90 DAYS" WAS THE LAST 200 ROWS. A shift row is one loom
//     for one shift, and a weaver minds several looms: four looms is
//     two hundred rows in under two months. The totals and the average
//     were worked out from those two hundred and shown as the window's
//     — against a "window before" that was counted in full.
//
//  3. A WORKER'S PLACEHOLDER ADDRESS WAS GIVEN AS THEIR EMAIL. A login
//     that signs in by phone has a made-up address so the account can
//     exist; everywhere else it is shown as none.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, worker, phoneOnly, ravi, loom, elastic, plan;
const M = {};
const DAY = 86_400_000;
const cookieFor = (u) => [`token=${jwt.sign({ id: u._id, role: u.role }, process.env.JWT_SECRET_KEY)}`];
const get = (u, url) => request(app).get(`/api/v2/me${url}`).set('Cookie', cookieFor(u));

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  for (const n of ['User', 'Employee', 'Machine', 'Elastic', 'ShiftPlan', 'ShiftDetail']) M[n] = require(`../../models/${n}`);
  const { ALWAYS_ON } = require('../../utils/features');
  const { placeholderEmail } = require('../../utils/workerLogin');

  ravi = await M.Employee.create({ name: 'Ravi', phoneNumber: '9500000001', department: 'weaving', role: 'operator' });
  const kumar = await M.Employee.create({ name: 'Kumar', phoneNumber: '9500000002', department: 'weaving', role: 'operator' });
  elastic = await M.Elastic.create({ name: '20mm trouser', weaveType: '8', spandexEnds: 40, yarnEnds: 120, pick: 12, noOfHook: 8, weight: 2 });
  loom = await M.Machine.create({ ID: 'LOOM-ME-1', manufacturer: 'Comez', NoOfHead: 2, NoOfHooks: 8 });
  plan = await M.ShiftPlan.create({ date: new Date(Date.now() - 400 * DAY), shift: 'DAY' });
  worker = await M.User.create({ name: 'Ravi', email: 'me-ravi@t.co', password: 'pass1234', role: 'production', department: 'production', features: [...ALWAYS_ON], employee: ravi._id });
  phoneOnly = await M.User.create({ name: 'Kumar', email: placeholderEmail(kumar._id), password: 'pass1234', role: 'production', department: 'production', features: [...ALWAYS_ON], employee: kumar._id });
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => { await M.ShiftDetail.deleteMany({}); });

/** A shift row of Ravi's: one loom, one shift. */
const row = (over = {}) => ({
  employee: ravi._id, machine: loom._id, shiftPlan: plan._id, shift: 'DAY', status: 'closed',
  date: new Date(Date.now() - DAY), productionMeters: 100, timer: '08:00:00',
  elastics: [{ head: 1, elastic: elastic._id }], ...over,
});
const daysAgo = (n) => new Date(Date.now() - n * DAY);

// ══════════════════════════════════════════════════════════════════
describe('GET /me/today', () => {
  it('has today\'s shift on it, whatever is left over from before', async () => {
    // Twelve old shifts, planned and never entered…
    await M.ShiftDetail.insertMany(Array.from({ length: 12 }, (_, i) => row({ status: 'open', date: daysAgo(40 - i) })));
    // …and the one for today.
    const today = await M.ShiftDetail.create(row({ status: 'open', date: new Date() }));

    const res = await get(worker, '/today');
    expect(res.status).toBe(200);
    const ids = res.body.shifts.map((s) => String(s.id));
    // Before: the ten oldest — today's was not among them.
    expect(ids).toContain(String(today._id));
    expect(ids).toHaveLength(10);
    // Still oldest first: what was left undone comes before what is to do.
    const dates = res.body.shifts.map((s) => new Date(s.date).getTime());
    expect(dates).toEqual([...dates].sort((a, b) => a - b));
    expect(String(res.body.shifts[res.body.shifts.length - 1].id)).toBe(String(today._id));
  });

  it('is every open shift when there are few (unchanged)', async () => {
    await M.ShiftDetail.insertMany([row({ status: 'open', date: daysAgo(2) }), row({ status: 'pending_verification', date: daysAgo(1) }), row({ status: 'closed', date: daysAgo(3) })]);
    const res = await get(worker, '/today');
    expect(res.body.shifts.map((s) => s.status)).toEqual(['open', 'pending_verification']);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('GET /me/shifts', () => {
  it('adds up the whole window, not its newest two hundred rows', async () => {
    // Four looms a shift for 60 days: 240 rows of 100 m, 8 hours each.
    await M.ShiftDetail.insertMany(Array.from({ length: 240 }, (_, i) => row({ date: daysAgo(1 + Math.floor(i / 4)) })));
    // The 90 days before: 10 rows of 80 m.
    await M.ShiftDetail.insertMany(Array.from({ length: 10 }, (_, i) => row({ date: daysAgo(100 + i), productionMeters: 80 })));

    const res = await get(worker, '/shifts?days=90');
    expect(res.status).toBe(200);
    // Before: 200 shifts, 20,000 m.
    expect(res.body.summary).toMatchObject({
      shifts: 240,
      totalMetres: 24000,
      avgPerShift: 100,
      metresPerHour: 12.5,
      previousAvgPerShift: 80,
      changePct: 25,
    });
    // The list itself stays a list a phone can show.
    expect(res.body.shifts).toHaveLength(200);
    expect(res.body.shifts[0]).toMatchObject({ machine: 'LOOM-ME-1', elastics: ['20mm trouser'], metres: 100, runHours: 8, metresPerHour: 12.5 });
  });

  it('is the same answer as before for a short history (unchanged)', async () => {
    await M.ShiftDetail.insertMany([row({ productionMeters: 400, date: daysAgo(3) }), row({ productionMeters: 600, date: daysAgo(5) })]);
    const res = await get(worker, '/shifts?days=30');
    expect(res.body.summary).toMatchObject({ shifts: 2, totalMetres: 1000, avgPerShift: 500, metresPerHour: 62.5, previousAvgPerShift: null, changePct: null });
    expect(res.body.shifts.map((s) => s.metres)).toEqual([400, 600]);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('GET /me/profile', () => {
  it('gives no email for a login that has only a placeholder', async () => {
    const res = await get(phoneOnly, '/profile');
    expect(res.status).toBe(200);
    // Before: "worker-<id>@workers.invalid".
    expect(res.body.profile.email).toBeNull();
    expect(res.body.profile.name).toBe('Kumar');
  });

  it('gives a real address as it is (unchanged)', async () => {
    expect((await get(worker, '/profile')).body.profile.email).toBe('me-ravi@t.co');
  });
});
