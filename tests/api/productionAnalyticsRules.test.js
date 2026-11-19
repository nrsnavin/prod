'use strict';
// ══════════════════════════════════════════════════════════════════
//  PRODUCTION ANALYTICS: WHAT COUNTS AS PRODUCTION, AND WHERE WASTAGE GOES
//
//  Found reading api/production.js line by line.
//
//  1. A SHIFT THAT HAS NOT BEEN VERIFIED HAS NO METRES YET. A shift's
//     productionMeters is written when it is verified; until then it is
//     0 (what the operator typed waits in submittedProductionMeters).
//     /analytics read every shift but a loading one, so today's shifts —
//     still running, or waiting for the supervisor — each counted as a
//     shift that made nothing: a high "recorded 0m production" anomaly
//     apiece, the averages pulled down, an operator's streak ended and
//     their worst shift 0. The Breakdown tab on the same page counts
//     verified shifts only, so the two tabs did not agree either.
//
//  2. WASTAGE HAS A MACHINE AFTER THE JOB LEAVES IT. The machine a
//     wastage entry belongs to was looked up as the job's machine — which
//     is cleared the moment the job goes to finishing. So in the machine
//     breakdown (the tab's default view) all wastage on a job that had
//     left the loom was dropped: from its machine's row, and from the
//     Wastage, Wastage rate and Penalty totals at the top.
//
//  3. THE TOTALS DO NOT DEPEND ON HOW THE ROWS ARE GROUPED. They were the
//     sum of the rows, and a row with no key was dropped: production of a
//     shift with no job vanished under Customer and Order, and under
//     Group an elastic in two groups was counted twice.
//
//  4. WASTAGE DAYS ARE INDIA'S. The range was cut at UTC midnight, so
//     wastage logged before 05:30 fell on the day before.
//
//  5. A RANGE HAS A LIMIT. /analytics loads every shift in the range;
//     it took any range at all.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const factoryDay = require('../../utils/factoryDay');

let mongo, app, M, admin;
const DAY = 86_400_000;
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
const get = (url) => request(app).get(`/api/v2/production${url}`).set('Cookie', cookie());

/** The calendar date `n` days before today, as shifts keep it. */
const dayAgo = (n) => new Date(factoryDay.calendarDay().getTime() - n * DAY);
const ymdAgo = (n) => factoryDay.ymd(dayAgo(n));

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  M = {};
  for (const n of ['Customer', 'Elastic', 'ElasticGroup', 'Employee', 'Order', 'JobOrder', 'Machine', 'ShiftPlan', 'ShiftDetail', 'Wastage', 'User']) {
    M[n] = require(`../../models/${n}`);
  }
  admin = await M.User.create({ name: 'Owner', email: 'prod-an@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
});

let n = 0;
/**
 * A four-head loom weaving one elastic for one job, with an operator who
 * has three verified shifts on it: 1,000 m a head, so 4,000 m a shift.
 */
async function floor() {
  n += 1;
  const customer = await M.Customer.create({ name: `Acme ${n}`, contactName: 'R', phoneNumber: '9000000001' });
  const elastic  = await M.Elastic.create({ name: `20mm ${n}`, weaveType: '8', spandexEnds: 40, yarnEnds: 120, pick: 12, noOfHook: 8, weight: 2.4 });
  const order = await M.Order.create({
    customer: customer._id, status: 'InProgress', po: `PO-${n}`, date: new Date(), supplyDate: new Date(),
    elasticOrdered: [{ elastic: elastic._id, quantity: 50000 }],
  });
  const machine = await M.Machine.create({
    ID: `M-${n}`, manufacturer: 'Comez', DateOfPurchase: new Date('2020-01-01'), NoOfHead: 4, NoOfHooks: 8, status: 'running',
  });
  const job = await M.JobOrder.create({
    date: new Date(), order: order._id, customer: customer._id, status: 'weaving', machine: machine._id,
    elastics: [{ elastic: elastic._id, quantity: 30000 }], wastageElastic: [{ elastic: elastic._id, quantity: 0 }],
  });
  const operator = await M.Employee.create({ name: `Operator ${n}`, department: 'weaving', hourlyRate: 100 });
  const s = { customer, elastic, order, machine, job, operator };
  for (const back of [3, 2, 1]) await shift(s, back, { status: 'closed', productionMeters: 4000 });
  return s;
}

/** One shift row on the floor's loom, `back` days ago. */
async function shift(s, back, over = {}) {
  const date = dayAgo(back);
  const kind = over.shift || 'DAY';
  const plan = await M.ShiftPlan.create({ date, shift: kind, plan: [], totalProduction: over.productionMeters || 0 });
  const heads = [1, 2, 3, 4].map((head) => ({ head, elastic: s.elastic._id }));
  const detail = await M.ShiftDetail.create({
    date, shift: kind, shiftPlan: plan._id, machine: s.machine._id, employee: s.operator._id, job: s.job._id,
    timer: '10:00:00', elastics: heads, headsRun: 4, ...over,
  });
  plan.plan = [detail._id];
  await plan.save();
  return detail;
}

/** A wastage record written at a given moment. */
async function wastage(s, at, over = {}) {
  const w = await M.Wastage.create({
    job: s.job._id, elastic: s.elastic._id, employee: s.operator._id, quantity: 50, penalty: 100, reason: 'Selvedge torn', ...over,
  });
  // Past Mongoose: createdAt cannot be changed through the model.
  await M.Wastage.collection.updateOne({ _id: w._id }, { $set: { createdAt: at } });
  return w;
}

const range = (from, to) => `start=${ymdAgo(from)}&end=${ymdAgo(to)}`;

// ══════════════════════════════════════════════════════════════════
describe('a shift that has not been verified has no production yet', () => {
  it('today\'s running and waiting shifts are not shifts that made nothing', async () => {
    const s = await floor();
    // Today: one still running, one entered by the operator and waiting.
    await shift(s, 0, { status: 'open' });
    await shift(s, 0, { status: 'pending_verification', shift: 'NIGHT', submittedProductionMeters: 950, submittedAt: new Date() });

    const res = await get(`/analytics?startDate=${ymdAgo(3)}&endDate=${ymdAgo(0)}`);
    expect(res.status).toBe(200);
    const { summary, anomalies, byEmployee, byMachine } = res.body.data;

    // Before: 5 shifts averaging 2,400 m, and two high anomalies.
    expect(summary.activeShifts).toBe(3);
    expect(summary.totalProduction).toBe(12000);
    expect(summary.avgPerShift).toBe(4000);
    expect(anomalies).toEqual([]);
    expect(summary.anomalyCount).toBe(0);

    expect(byMachine[0]).toMatchObject({ shiftCount: 3, avgPerShift: 4000, worstShift: 4000 });
    // Before: worst shift 0, and a streak of 0 — ended by a shift not yet over.
    expect(byEmployee[0]).toMatchObject({ shiftCount: 3, worstShift: 4000, streak: 3, anomalyCount: 0 });
  });

  it('a verified shift that made nothing is still an anomaly', async () => {
    const s = await floor();
    await shift(s, 0, { status: 'closed', productionMeters: 0 });
    const res = await get(`/analytics?startDate=${ymdAgo(3)}&endDate=${ymdAgo(0)}`);
    const zero = res.body.data.anomalies.filter((a) => a.type === 'ZERO_PRODUCTION');
    expect(zero.map((a) => a.entityType).sort()).toEqual(['employee', 'machine']);
  });

  it('agrees with the breakdown of the same days', async () => {
    const s = await floor();
    await shift(s, 0, { status: 'pending_verification', submittedProductionMeters: 950, submittedAt: new Date() });
    const overview  = await get(`/analytics?startDate=${ymdAgo(3)}&endDate=${ymdAgo(0)}`);
    const breakdown = await get(`/breakdown?${range(3, 0)}&groupBy=machine`);
    expect(overview.body.data.summary.totalProduction).toBe(breakdown.body.totals.production);
    expect(overview.body.data.summary.activeShifts).toBe(breakdown.body.totals.shiftCount);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('wastage by machine', () => {
  it('stays with the machine after the job has left the loom', async () => {
    const s = await floor();
    await wastage(s, new Date(dayAgo(1).getTime() + 6 * 3_600_000));
    // Off the loom: the job no longer points at a machine (api/jobProgress.js).
    await M.JobOrder.updateOne({ _id: s.job._id }, { $set: { status: 'finishing' }, $unset: { machine: 1 } });

    const res = await get(`/breakdown?${range(3, 0)}&groupBy=machine`);
    expect(res.status).toBe(200);
    // Before: wastage 0, penalty 0, rate 0% — the entry was dropped.
    expect(res.body.totals).toMatchObject({ production: 12000, wastageQty: 50, wastagePenalty: 100, wastageEvents: 1 });
    const row = res.body.rows.find((r) => r.key === String(s.machine._id));
    expect(row).toMatchObject({ label: `Machine ${s.machine.ID}`, production: 12000, wastageQty: 50, wastageEvents: 1 });
  });

  it('is the machine the operator ran that job on, when the job ran on two', async () => {
    const s = await floor();
    const second = await M.Machine.create({
      ID: `M-${n}-B`, manufacturer: 'Comez', DateOfPurchase: new Date('2020-01-01'), NoOfHead: 4, NoOfHooks: 8, status: 'running',
    });
    const other = await M.Employee.create({ name: 'Operator Two', department: 'weaving', hourlyRate: 100 });
    await shift({ ...s, machine: second, operator: other }, 1, { status: 'closed', productionMeters: 2000, shift: 'NIGHT' });
    await wastage({ ...s, operator: other }, new Date(dayAgo(1).getTime() + 20 * 3_600_000), { quantity: 30, penalty: 0 });
    await M.JobOrder.updateOne({ _id: s.job._id }, { $unset: { machine: 1 } });

    const res = await get(`/breakdown?${range(3, 0)}&groupBy=machine`);
    const of = (m) => res.body.rows.find((r) => r.key === String(m._id));
    expect(of(second)).toMatchObject({ production: 2000, wastageQty: 30 });
    expect(of(s.machine)).toMatchObject({ production: 12000, wastageQty: 0 });
  });

  it('a machine filter keeps that machine\'s wastage too', async () => {
    const s = await floor();
    await wastage(s, new Date(dayAgo(1).getTime() + 6 * 3_600_000));
    await M.JobOrder.updateOne({ _id: s.job._id }, { $unset: { machine: 1 } });
    const res = await get(`/breakdown?${range(3, 0)}&groupBy=operator&machineId=${s.machine._id}`);
    expect(res.body.totals).toMatchObject({ production: 12000, wastageQty: 50 });
  });
});

// ══════════════════════════════════════════════════════════════════
describe('the totals over a range', () => {
  it('are the same however the rows are grouped', async () => {
    const s = await floor();
    await wastage(s, new Date(dayAgo(1).getTime() + 6 * 3_600_000));
    // A shift that ran with no job on the loom: production, but nobody's order.
    await shift({ ...s, job: { _id: null } }, 2, { status: 'closed', productionMeters: 2000, shift: 'NIGHT' });

    const totals = {};
    for (const groupBy of ['machine', 'operator', 'customer', 'order', 'elastic']) {
      const res = await get(`/breakdown?${range(3, 0)}&groupBy=${groupBy}`);
      expect(res.status).toBe(200);
      totals[groupBy] = [res.body.totals.production, res.body.totals.wastageQty, res.body.totals.wastagePenalty];
      // And the rows account for all of it.
      expect(res.body.rows.reduce((sum, r) => sum + r.production, 0)).toBe(14000);
    }
    // Before: customer and order said 12,000 — the 2,000 m with no job was dropped.
    expect(totals).toEqual({
      machine: [14000, 50, 100], operator: [14000, 50, 100], customer: [14000, 50, 100], order: [14000, 50, 100], elastic: [14000, 50, 100],
    });
  });

  it('names what belongs to nothing, instead of leaving it out', async () => {
    const s = await floor();
    await shift({ ...s, job: { _id: null } }, 2, { status: 'closed', productionMeters: 2000, shift: 'NIGHT' });
    const res = await get(`/breakdown?${range(3, 0)}&groupBy=customer`);
    const loose = res.body.rows.find((r) => r.key === 'none');
    expect(loose).toMatchObject({ production: 2000, shiftCount: 1 });
    expect(loose.label).toMatch(/no customer/i);
  });

  it('by group: an elastic in two groups is in both rows and once in the total', async () => {
    const s = await floor();
    for (const name of ['Narrow', 'Black']) {
      await M.ElasticGroup.create({ name: `${name} ${n}`, isActive: true, items: [{ elastic: s.elastic._id }] });
    }
    const res = await get(`/breakdown?${range(3, 0)}&groupBy=group`);
    expect(res.status).toBe(200);
    expect(res.body.rows.map((r) => r.production)).toEqual([12000, 12000]);
    // Before: 24,000 — and each group a 50% share of it.
    expect(res.body.totals.production).toBe(12000);
    expect(res.body.rows.map((r) => r.share)).toEqual([100, 100]);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('the days wastage is counted on', () => {
  it('are India\'s: 01:00 on the first day is in, 02:00 on the day after the last is out', async () => {
    const s = await floor();
    // 01:00 in India on the first day of the range — 19:30 UTC the evening before.
    await wastage(s, new Date(factoryDay.dayStart(dayAgo(3)).getTime() + 1 * 3_600_000), { quantity: 7, penalty: 0 });
    // 02:00 in India on the day AFTER the range — still "yesterday" at UTC.
    await wastage(s, new Date(factoryDay.dayStart(dayAgo(0)).getTime() + 2 * 3_600_000), { quantity: 900, penalty: 0 });

    const res = await get(`/breakdown?${range(3, 1)}&groupBy=operator`);
    // Before: 900 — the wrong one of the two.
    expect(res.body.totals.wastageQty).toBe(7);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('a range that is too wide', () => {
  it.each(['/analytics?startDate=2020-01-01&endDate=2026-11-19', '/breakdown?start=2020-01-01&end=2026-11-19'])('%s is refused', async (url) => {
    const res = await get(url);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/at most 370 days/);
  });

  it('a year is fine', async () => {
    await floor();
    expect((await get('/analytics?startDate=2026-01-01&endDate=2026-12-31')).status).toBe(200);
    expect((await get('/breakdown?start=2026-01-01&end=2026-12-31')).status).toBe(200);
  });
});
