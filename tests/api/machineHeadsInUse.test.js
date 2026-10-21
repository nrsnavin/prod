'use strict';
// ══════════════════════════════════════════════════════════════════
//  A LOOM RUNNING FEWER HEADS THAN IT HAS
//
//  A wide elastic may fit on only 6 heads of an 8-head loom. The job's
//  head plan says so, and every figure follows it: the shift's metres,
//  the job's produced metres, the plan's total, all per head × the
//  heads RUNNING. Changing the plan mid-run carries to the shifts not
//  yet verified. Older shifts keep the head count they were stored with.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, M, admin;
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
const post = (url, body) => request(app).post(`/api/v2${url}`).set('Cookie', cookie()).send(body);

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  M = {};
  for (const n of ['User', 'Employee', 'Machine', 'JobOrder', 'ShiftPlan', 'ShiftDetail', 'Customer', 'Order', 'Elastic', 'Warping', 'Covering']) {
    M[n] = require(`../../models/${n}.js`);
  }
  admin = await M.User.create({ name: 'Owner', email: 'o@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
}, 120_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (!['users', 'counters'].includes(c.collectionName)) await c.deleteMany({});
  }
});

async function seed() {
  const customer = await M.Customer.create({ name: 'Acme', contactName: 'R', phoneNumber: '9000000001' });
  const elastic = await M.Elastic.create({
    name: `50mm Wide ${Math.random().toString(36).slice(2, 7)}`, weaveType: '8',
    spandexEnds: 40, yarnEnds: 120, pick: 12, noOfHook: 8, weight: 2.4,
  });
  const order = await M.Order.create({
    orderNo: Math.floor(Math.random() * 100000), customer: customer._id, status: 'InProgress', po: 'PO-1',
    date: new Date(), supplyDate: new Date(), elasticOrdered: [{ elastic: elastic._id, quantity: 100000 }],
  });
  const job = await M.JobOrder.create({
    date: new Date(), order: order._id, customer: customer._id, status: 'weaving',
    elastics: [{ elastic: elastic._id, quantity: 100000 }],
  });
  const machine = await M.Machine.create({
    ID: `M-${Math.floor(Math.random() * 100000)}`, manufacturer: 'Comez',
    NoOfHead: 8, NoOfHooks: 8, status: 'free', orderRunning: null, elastics: [],
  });
  const operator = await M.Employee.create({ name: 'Ravi', department: 'weaving' });
  return { job, elastic, machine, operator, order };
}

const headMap = (n, elastic) => Object.fromEntries(Array.from({ length: n }, (_, i) => [String(i), String(elastic._id)]));
const plan = (s, n) => post('/job/plan-weaving', { jobId: String(s.job._id), machineId: String(s.machine._id), headElasticMap: headMap(n, s.elastic) });

async function shiftFor(s) {
  const { createShiftPlan } = require('../../services/shiftPlanCreate');
  const { shiftPlan } = await createShiftPlan({
    date: new Date().toISOString().slice(0, 10), shiftType: 'DAY',
    machines: [{ machine: s.machine._id, operator: s.operator._id }],
  });
  return M.ShiftDetail.findOne({ shiftPlan: shiftPlan._id });
}

describe('planning fewer heads than the loom has', () => {
  it('accepts 6 of 8, refuses more than the loom has or a gap', async () => {
    const s = await seed();
    const ok = await plan(s, 6);
    expect(ok.status).toBe(200);
    const m = await M.Machine.findById(s.machine._id).lean();
    expect(m.elastics).toHaveLength(6);
    expect(m.NoOfHead).toBe(8);

    expect((await plan(s, 9)).body.message).toMatch(/has 8 heads; the plan uses 9/);
    const gap = await post('/job/plan-weaving', {
      jobId: String(s.job._id), machineId: String(s.machine._id),
      headElasticMap: { 0: String(s.elastic._id), 2: String(s.elastic._id) },
    });
    expect(gap.body.message).toMatch(/without gaps/);
  });

  it('the job shows the heads in use and the loom\'s own count', async () => {
    const s = await seed();
    await plan(s, 6);
    const res = await request(app).get(`/api/v2/job/${s.job._id}`).set('Cookie', cookie());
    const machine = (res.body.job || res.body.data || res.body).machine;
    expect(machine).toMatchObject({ machineNoOfHead: 8, headsInUse: 6 });
    expect(machine.headPlan).toHaveLength(6);
  });
});

describe('production is counted by the heads running', () => {
  it('a verified shift: metres, job and plan totals are per head × 6, not × 8', async () => {
    const s = await seed();
    await plan(s, 6);
    const shift = await shiftFor(s);
    expect(shift.elastics).toHaveLength(6);

    const res = await post('/shift/verify-production', { shiftId: String(shift._id), productionMeters: 100 });
    expect(res.status).toBe(200);
    const after = await M.ShiftDetail.findById(shift._id).lean();
    expect(after).toMatchObject({ productionMeters: 600, headsRun: 6 });
    const job = await M.JobOrder.findById(s.job._id).lean();
    expect(job.producedElastic[0].quantity).toBe(600);
    expect((await M.ShiftPlan.findById(after.shiftPlan).lean()).totalProduction).toBe(600);
  });

  it('changing the plan mid-run carries to shifts not yet verified, and a correction divides by the same heads', async () => {
    const s = await seed();
    await plan(s, 8);
    const shift = await shiftFor(s);
    expect(shift.elastics).toHaveLength(8);

    // The supervisor finds only 4 heads take this width: re-plan the same loom.
    expect((await plan(s, 4)).status).toBe(200);
    expect((await M.ShiftDetail.findById(shift._id).lean()).elastics).toHaveLength(4);

    await post('/shift/verify-production', { shiftId: String(shift._id), productionMeters: 100 });
    expect((await M.ShiftDetail.findById(shift._id).lean()).productionMeters).toBe(400);
    expect((await M.JobOrder.findById(s.job._id).lean()).producedElastic[0].quantity).toBe(400);

    // Corrected to 480 total → 120 a head → the job moves by 4 × 20.
    const fix = await request(app).put(`/api/v2/shift/production-entry/${shift._id}`).set('Cookie', cookie())
      .send({ productionMeters: 480, auditReason: 'miscounted' });
    expect(fix.status).toBe(200);
    expect((await M.JobOrder.findById(s.job._id).lean()).producedElastic[0].quantity).toBe(480);
  });
});

describe("the machine page's head-map editor", () => {
  it('leaving heads empty there counts the same way, for shifts not yet verified', async () => {
    const s = await seed();
    await plan(s, 8);
    const shift = await shiftFor(s);
    const m = await M.Machine.findById(s.machine._id).lean();
    const map = Array.from({ length: 8 }, (_, i) => ({ head: i + 1, elastic: i < 5 ? String(s.elastic._id) : null }));
    const res = await request(app).put('/api/v2/machine/updateOrder').set('Cookie', cookie())
      .send({ id: String(s.machine._id), elastics: map, expectedVersion: m.__v });
    expect(res.status).toBe(200);
    expect((await M.ShiftDetail.findById(shift._id).lean()).elastics).toHaveLength(5);
    await post('/shift/verify-production', { shiftId: String(shift._id), productionMeters: 100 });
    expect((await M.ShiftDetail.findById(shift._id).lean())).toMatchObject({ productionMeters: 500, headsRun: 5 });
  });
});

describe("the loom's own head count", () => {
  const setHeads = (s, n) => request(app).patch('/api/v2/machine/update-heads').set('Cookie', cookie())
    .send({ machineId: String(s.machine._id), noOfHead: n });

  it('can change while running, but not below the heads the job is weaving on', async () => {
    const s = await seed();
    await plan(s, 6);
    const low = await setHeads(s, 5);
    expect(low.status).toBe(400);
    expect(low.body.message).toMatch(/6-head plan/);
    expect((await setHeads(s, 10)).status).toBe(200);
    expect((await M.Machine.findById(s.machine._id).lean()).NoOfHead).toBe(10);
  });
});

describe('helpers', () => {
  const { headsInUse, headsOfShift } = require('../../utils/machineHeads');
  it('heads in use is the heads with an elastic, else the whole loom', () => {
    expect(headsInUse({ NoOfHead: 8, elastics: [{ head: 1, elastic: 'a' }, { head: 2, elastic: null }] })).toBe(1);
    expect(headsInUse({ NoOfHead: 8, elastics: [] })).toBe(8);
    expect(headsOfShift({ headsRun: 6 }, { NoOfHead: 8 })).toBe(6);
    expect(headsOfShift({}, { NoOfHead: 8 })).toBe(8); // verified before headsRun was kept
  });
});
