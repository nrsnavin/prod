'use strict';
// ══════════════════════════════════════════════════════════════════
//  HOW AN ORDER FOLLOWS ITS JOBS — services/orderLifecycle.js
//
//    • raising a job starts the order, and never reopens a finished one;
//    • the last job finishing completes the order (inside the caller's
//      transaction), and never a cancelled one;
//    • cancelling a job gives its quantity back to pending, and the
//      order goes back to waiting only when nothing live is left.
// ══════════════════════════════════════════════════════════════════

process.env.NODE_ENV = 'test';

const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, Order, JobOrder, life, buildFingerprint, ACTION_CODES;
const oid = () => new mongoose.Types.ObjectId();
const EL = oid();
const actor = { id: 'u1', name: 'Owner', role: 'admin' };

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  Order = require('../../models/Order');
  JobOrder = require('../../models/JobOrder');
  life = require('../../services/orderLifecycle');
  ({ buildFingerprint, ACTION_CODES } = require('../../utils/fingerprint'));
}, 120_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) await c.deleteMany({});
});

let seq = 1;
const makeOrder = (status = 'Approved', qty = 1000) => Order.create({
  customer: oid(), orderNo: seq++, date: new Date(), supplyDate: new Date(), po: 'PO',
  elasticOrdered: [{ elastic: EL, quantity: qty }],
  pendingElastic: [{ elastic: EL, quantity: qty }],
  producedElastic: [{ elastic: EL, quantity: 0 }],
  status,
});
const makeJob = (order, qty, status = 'weaving') => JobOrder.create({
  date: new Date(), order: order._id, customer: order.customer, status,
  elastics: [{ elastic: EL, quantity: qty }], producedElastic: [{ elastic: EL, quantity: 0 }],
});
const pending = (o) => o.pendingElastic.find((p) => String(p.elastic) === String(EL)).quantity;
const fp = (code, job) => buildFingerprint(code, { entityId: job._id, actor });

describe('jobRaised', () => {
  it('starts an approved order and records the job on its timeline', async () => {
    const order = await makeOrder('Approved');
    const job = await makeJob(order, 400);
    life.jobRaised(order, { job, jobFp: fp(ACTION_CODES.JOB_CREATED, job), actor, userId: oid(), elasticCount: 1 });
    expect(order.status).toBe('InProgress');
    expect(order.fingerprints.at(-1).code).toBe('JOB_CREATED');
  });

  it('never reopens a finished order', async () => {
    const order = await makeOrder('Completed');
    const job = await makeJob(order, 400);
    life.jobRaised(order, { job, jobFp: fp(ACTION_CODES.JOB_CREATED, job), actor, userId: oid(), elasticCount: 1 });
    expect(order.status).toBe('Completed');
  });
});

describe('lastJobCompleted', () => {
  const run = async (job) => {
    const session = await mongoose.startSession();
    let closed;
    try {
      await session.withTransaction(async () => {
        closed = await life.lastJobCompleted(session, job, { actor, userId: oid(), completionFp: fp(ACTION_CODES.JOB_COMPLETED, job) });
      });
    } finally { session.endSession(); }
    return closed;
  };

  it('completes a running order, stamped and dated', async () => {
    const order = await makeOrder('InProgress');
    const job = await makeJob(order, 1000, 'packing');
    expect(await run(job)).toBe(true);
    const after = await Order.findById(order._id);
    expect(after.status).toBe('Completed');
    expect(after.completedAt).toBeInstanceOf(Date);
    expect(after.fingerprints.at(-1).code).toBe('ORDER_COMPLETED');
  });

  it('leaves a cancelled order cancelled', async () => {
    const order = await makeOrder('Cancelled');
    const job = await makeJob(order, 1000, 'packing');
    expect(await run(job)).toBe(false);
    expect((await Order.findById(order._id)).status).toBe('Cancelled');
  });
});

describe('jobCancelled', () => {
  it('gives the quantity back to pending, and the order goes back to waiting', async () => {
    const order = await makeOrder('InProgress');
    const job = await makeJob(order, 600, 'cancelled');
    order.pendingElastic = [{ elastic: EL, quantity: 400 }];
    await order.save();

    const after = await life.jobCancelled(job, { userId: oid() });
    expect(pending(after)).toBe(1000);
    expect(after.status).toBe('Approved');
    expect(pending(await Order.findById(order._id))).toBe(1000); // saved, not only in memory
  });

  it('keeps the order running while another job is live', async () => {
    const order = await makeOrder('InProgress');
    await makeJob(order, 300, 'weaving');
    const job = await makeJob(order, 600, 'cancelled');
    const after = await life.jobCancelled(job, { userId: oid() });
    expect(pending(after)).toBe(700);
    expect(after.status).toBe('InProgress');
  });
});
