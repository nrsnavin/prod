'use strict';
// ══════════════════════════════════════════════════════════════════
//  WHAT THE FLOOR ENTERED, ON THE JOB AND THE ORDER, BEFORE VERIFYING
//
//  A supervisor's entry is pending until the office verifies it, and
//  nothing reaches the job's produced figure until then — right, and
//  unchanged here. But the job and order pages showed only the
//  verified figure, so a day's weaving looked like nothing had
//  happened. They now carry the drafted metres beside it: the per-head
//  figure once for every head running the elastic, the way the
//  cascade will count it, and never added to the verified number.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, M, admin;
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
const get = (url) => request(app).get(`/api/v2${url}`).set('Cookie', cookie());
const DATE = '2026-10-21';

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  M = {};
  for (const n of ['User', 'Employee', 'Machine', 'JobOrder', 'ShiftPlan', 'ShiftDetail', 'Customer', 'Order', 'Elastic']) {
    M[n] = require(`../../models/${n}.js`);
  }
  admin = await M.User.create({ name: 'Owner', email: 'drafts@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
}, 180_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
// One shift plan per date and shift: each scene starts clean.
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (!['users', 'counters'].includes(c.collectionName)) await c.deleteMany({});
  }
});

let n = 0;
async function seed() {
  n += 1;
  const customer = await M.Customer.create({ name: `Acme ${n}`, contactName: 'R', phoneNumber: `91000000${String(n).padStart(2, '0')}` });
  const mk = (name) => M.Elastic.create({ name: `${name} ${n}`, weaveType: '8', spandexEnds: 40, yarnEnds: 120, pick: 12, noOfHook: 8, weight: 2.4 });
  const a = await mk('20mm');
  const b = await mk('32mm');
  const order = await M.Order.create({
    orderNo: 2000 + n, customer: customer._id, status: 'InProgress', po: `PO-${n}`, date: new Date(), supplyDate: new Date(),
    elasticOrdered: [{ elastic: a._id, quantity: 10000 }, { elastic: b._id, quantity: 5000 }],
    producedElastic: [{ elastic: a._id, quantity: 300 }],
  });
  const job = await M.JobOrder.create({
    date: new Date(), order: order._id, customer: customer._id, status: 'weaving',
    elastics: [{ elastic: a._id, quantity: 10000 }, { elastic: b._id, quantity: 5000 }],
    producedElastic: [{ elastic: a._id, quantity: 300 }],
  });
  await M.Order.updateOne({ _id: order._id }, { $push: { jobs: { job: job._id } } });
  // Three heads on the 20mm, one on the 32mm, one free.
  const loom = await M.Machine.create({
    ID: `L1-${n}`, manufacturer: 'Comez', NoOfHead: 5, NoOfHooks: 8, status: 'running', orderRunning: job._id,
    elastics: [{ head: 0, elastic: a._id }, { head: 1, elastic: a._id }, { head: 2, elastic: a._id }, { head: 3, elastic: b._id }, { head: 4, elastic: null }],
  });
  const ravi = await M.Employee.create({ name: 'Ravi', department: 'weaving' });
  const { createShiftPlan } = require('../../services/shiftPlanCreate');
  const { shiftPlan } = await createShiftPlan({ date: DATE, shiftType: 'DAY', machines: [{ machine: loom._id, operator: ravi._id }] });
  const detail = await M.ShiftDetail.findOne({ shiftPlan: shiftPlan._id, machine: loom._id });
  return { customer, a, b, order, job, loom, detail };
}

const entered = (detail, perHead) => M.ShiftDetail.updateOne(
  { _id: detail._id },
  { $set: { status: 'pending_verification', submittedProductionMeters: perHead, submittedTimer: '7:30:00', submittedByName: 'Kumar' } }
);

describe('floor entries waiting to be verified', () => {
  it('are nothing on the job summary and the order until something is entered', async () => {
    const s = await seed();
    const job = await get(`/job/summary?jobId=${s.job._id}`);
    expect(job.status).toBe(200);
    expect(job.body.draftShifts).toBe(0);
    expect(job.body.summary.map((r) => r.drafted)).toEqual([0, 0]);
    const order = await get(`/order/get-orderDetail?id=${s.order._id}`);
    expect(order.status).toBe(200);
    expect(order.body.data.elastics.map((r) => r.drafted)).toEqual([0, 0]);
    expect(order.body.data.draftShifts).toBe(0);
  });

  it('show on the job summary per elastic, per head × the heads running it, beside the verified figure', async () => {
    const s = await seed();
    await entered(s.detail, 820);
    const res = await get(`/job/summary?jobId=${s.job._id}`);
    expect(res.status).toBe(200);
    expect(res.body.draftShifts).toBe(1);
    const rows = Object.fromEntries(res.body.summary.map((r) => [r.elasticName, r]));
    // Three heads of 20mm: 3 × 820. The verified 300 is untouched.
    expect(rows[s.a.name]).toMatchObject({ produced: 300, drafted: 2460, remaining: 9700 });
    expect(rows[s.b.name]).toMatchObject({ produced: 0, drafted: 820 });
    // Still nothing on the job itself: pending is pending.
    const job = await M.JobOrder.findById(s.job._id).lean();
    expect(job.producedElastic).toHaveLength(1);
    expect(job.producedElastic[0].quantity).toBe(300);
  });

  it('show on the order, summed over its jobs, and on each job\'s breakdown', async () => {
    const s = await seed();
    await entered(s.detail, 500);
    const res = await get(`/order/get-orderDetail?id=${s.order._id}`);
    expect(res.status).toBe(200);
    const rows = Object.fromEntries(res.body.data.elastics.map((r) => [r.name, r]));
    expect(rows[s.a.name]).toMatchObject({ produced: 300, drafted: 1500 });
    expect(rows[s.b.name]).toMatchObject({ produced: 0, drafted: 500 });
    expect(res.body.data.draftShifts).toBe(1);
    const jobRow = res.body.data.jobs[0];
    const byName = Object.fromEntries(jobRow.elasticSummary.map((r) => [r.name, r]));
    expect(byName[s.a.name]).toMatchObject({ produced: 300, drafted: 1500, pending: 9700 });
  });

  it('a verified entry stops being a draft and becomes the figure', async () => {
    const s = await seed();
    await entered(s.detail, 100);
    const verify = await request(app).post('/api/v2/shift/verify-production')
      .set('Cookie', cookie())
      .send({ shiftId: String(s.detail._id), productionMeters: 100, timer: '7:30:00' });
    expect(verify.status).toBe(200);
    const res = await get(`/job/summary?jobId=${s.job._id}`);
    const rows = Object.fromEntries(res.body.summary.map((r) => [r.elasticName, r]));
    expect(rows[s.a.name]).toMatchObject({ produced: 600, drafted: 0 });
    expect(res.body.draftShifts).toBe(0);
  });
});
