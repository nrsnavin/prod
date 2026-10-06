'use strict';
// ══════════════════════════════════════════════════════════════════
//  A JOB'S STATUS, CHANGED BY TWO PEOPLE AT ONCE
//
//  • The last two jobs on an order completed at the same moment: each
//    saw the other still running, neither closed the order, and it stayed
//    "in progress" with every job done.
//  • A loom planned onto a job that was cancelled meanwhile: the plan was
//    written onto a stale copy of the job, leaving the loom running a
//    cancelled job.
//  • A cancellation that failed part-way: the looms were released and
//    the job saved as cancelled before the order was updated.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, JobOrder, Order, Machine, Elastic, admin, lifecycle;
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
const post = (url, body) => request(app).post(url).set('Cookie', cookie()).send(body);

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  JobOrder = require('../../models/JobOrder');
  Order = require('../../models/Order');
  Machine = require('../../models/Machine');
  Elastic = require('../../models/Elastic');
  lifecycle = require('../../services/orderLifecycle');
  const User = require('../../models/User');
  admin = await User.create({ name: 'Owner', email: 'o@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
}, 120_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(() => jest.restoreAllMocks());

let seq = 0;
async function orderWithJobs(statuses) {
  const elastic = await Elastic.create({
    name: `E ${++seq} ${Math.random().toString(36).slice(2, 6)}`, weaveType: '8',
    spandexEnds: 40, yarnEnds: 120, pick: 12, noOfHook: 8, weight: 2.4,
  });
  const order = await Order.create({
    customer: new mongoose.Types.ObjectId(), status: 'InProgress', po: `PO-${seq}`,
    date: new Date(), supplyDate: new Date(),
    elasticOrdered: [{ elastic: elastic._id, quantity: 1000 }],
  });
  const jobs = [];
  for (const status of statuses) {
    jobs.push(await JobOrder.create({
      date: new Date(), order: order._id, customer: order.customer, status,
      elastics: [{ elastic: elastic._id, quantity: 500 }],
    }));
  }
  return { elastic, order, jobs };
}

/** Make the next `n` reads of `Model.method` wait until all n have arrived (or 2 s). */
function barrier(Model, method, n = 2) {
  const real = Model[method].bind(Model);
  let arrived = 0; let release;
  const gate = new Promise((r) => { release = r; });
  return jest.spyOn(Model, method).mockImplementation((...a) => {
    const q = real(...a);
    const then = q.then.bind(q);
    q.then = (ok, fail) => (async () => {
      if (++arrived === n) release();
      if (arrived <= n) await Promise.race([gate, new Promise((r) => setTimeout(r, 2000))]);
      return then(ok, fail);
    })();
    return q;
  });
}

describe('the last two jobs on an order completed at the same moment', () => {
  it('closes the order', async () => {
    const { order, jobs: [a, b] } = await orderWithJobs(['packing', 'packing']);
    // Both read their sibling (still packing) before either writes.
    barrier(JobOrder, 'find');
    const [ra, rb] = await Promise.all([
      post('/api/v2/job/update-status', { jobId: String(a._id), nextStatus: 'completed' }),
      post('/api/v2/job/update-status', { jobId: String(b._id), nextStatus: 'completed' }),
    ]);
    expect([ra.status, rb.status]).toEqual([200, 200]);
    expect((await Order.findById(order._id).lean()).status).toBe('Completed');
  }, 30_000);
});

describe('a loom planned onto a job cancelled meanwhile', () => {
  it('is refused, and the loom stays free', async () => {
    const { elastic, jobs: [job] } = await orderWithJobs(['preparatory']);
    const machine = await Machine.create({
      ID: `M-${++seq}`, manufacturer: 'Comez', NoOfHead: 2, NoOfHooks: 8, status: 'free', elastics: [],
    });
    const stale = await JobOrder.findById(job._id);
    await JobOrder.updateOne({ _id: job._id }, { $set: { status: 'cancelled' } });
    jest.spyOn(JobOrder, 'findById').mockImplementationOnce(() => Promise.resolve(stale));

    const res = await post('/api/v2/job/plan-weaving', {
      jobId: String(job._id), machineId: String(machine._id),
      headElasticMap: { 0: String(elastic._id), 1: String(elastic._id) },
    });
    expect(res.status).toBe(409);
    expect(await Machine.findById(machine._id).lean()).toMatchObject({ status: 'free', orderRunning: null });
    expect((await JobOrder.findById(job._id).lean()).status).toBe('cancelled');
  });
});

describe('a cancellation that fails part-way', () => {
  it('changes nothing: the job, its loom and its order stay as they were', async () => {
    const { order, jobs: [job] } = await orderWithJobs(['weaving']);
    const machine = await Machine.create({
      ID: `M-${++seq}`, manufacturer: 'Comez', NoOfHead: 2, NoOfHooks: 8,
      status: 'running', orderRunning: job._id, elastics: [],
    });
    await JobOrder.updateOne({ _id: job._id }, { $set: { machine: machine._id } });
    jest.spyOn(lifecycle, 'jobCancelled').mockRejectedValueOnce(new Error('order write failed'));

    const res = await post('/api/v2/job/cancel', { jobId: String(job._id), reason: 'customer cancelled' });
    expect(res.status).toBe(500);
    expect((await JobOrder.findById(job._id).lean()).status).toBe('weaving');
    expect(await Machine.findById(machine._id).lean()).toMatchObject({ status: 'running' });
    expect(String((await Machine.findById(machine._id).lean()).orderRunning)).toBe(String(job._id));
    expect((await Order.findById(order._id).lean()).status).toBe('InProgress');
  });
});
