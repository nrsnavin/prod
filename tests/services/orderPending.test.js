'use strict';
// Order pending quantity = ordered − PLANNED (quantity committed to jobs).
//
// Regression: the production cascade recomputed pending as
// ordered − produced, which overwrote the planning deduction — planning
// 600 of 1000 dropped pending to 400, then producing 200 pushed it back
// UP to 800. Production is tracked on the job; it must not move pending.

process.env.NODE_ENV = 'test';

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongo, Order, JobOrder, recomputePending, recomputeProduced;

const oid = () => new mongoose.Types.ObjectId();
let EL_A, EL_B, CUST;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  Order    = require('../../models/Order');
  JobOrder = require('../../models/JobOrder');
  ({ recomputePending, recomputeProduced } = require('../../services/orderPending.js'));
}, 60_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
beforeEach(() => { EL_A = oid(); EL_B = oid(); CUST = oid(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) await c.deleteMany({});
});

const makeOrder = (lines) => Order.create({
  customer: CUST, orderNo: 1, date: new Date(), supplyDate: new Date(), po: 'PO-1',
  elasticOrdered: lines,
  pendingElastic: lines.map((l) => ({ ...l })),
  producedElastic: lines.map((l) => ({ elastic: l.elastic, quantity: 0 })),
  status: 'Open',
});
const makeJob = (order, elastics, over = {}) => JobOrder.create({
  date: new Date(), order: order._id, customer: CUST, status: 'weaving',
  elastics, producedElastic: elastics.map((e) => ({ elastic: e.elastic, quantity: 0 })), ...over,
});
const pendingOf = (order, el) =>
  order.pendingElastic.find((p) => p.elastic.toString() === el.toString())?.quantity;

test('pending drops by the PLANNED quantity when a job is raised', async () => {
  const order = await makeOrder([{ elastic: EL_A, quantity: 1000 }]);
  await makeJob(order, [{ elastic: EL_A, quantity: 600 }]);
  await recomputePending(order);
  expect(pendingOf(order, EL_A)).toBe(400);
});

test('production does NOT move pending — it stays at ordered − planned', async () => {
  const order = await makeOrder([{ elastic: EL_A, quantity: 1000 }]);
  const job = await makeJob(order, [{ elastic: EL_A, quantity: 600 }]);

  job.producedElastic = [{ elastic: EL_A, quantity: 200 }];
  await job.save();
  await recomputePending(order);
  expect(pendingOf(order, EL_A)).toBe(400);      // was 800 under the old rule

  // even once the job over-produces its plan, pending is unchanged
  job.producedElastic = [{ elastic: EL_A, quantity: 600 }];
  await job.save();
  await recomputePending(order);
  expect(pendingOf(order, EL_A)).toBe(400);
});

test('produced is still tracked on the order for reporting', async () => {
  const order = await makeOrder([{ elastic: EL_A, quantity: 1000 }]);
  const job = await makeJob(order, [{ elastic: EL_A, quantity: 600 }]);
  job.producedElastic = [{ elastic: EL_A, quantity: 250 }];
  await job.save();

  await recomputeProduced(order);
  expect(order.producedElastic[0].quantity).toBe(250);
  await recomputePending(order);
  expect(pendingOf(order, EL_A)).toBe(400);      // and pending is untouched
});

test('several jobs accumulate against the same order', async () => {
  const order = await makeOrder([{ elastic: EL_A, quantity: 1000 }]);
  await makeJob(order, [{ elastic: EL_A, quantity: 600 }]);
  await makeJob(order, [{ elastic: EL_A, quantity: 300 }]);
  await recomputePending(order);
  expect(pendingOf(order, EL_A)).toBe(100);
});

test('a cancelled job releases its quantity back to pending', async () => {
  const order = await makeOrder([{ elastic: EL_A, quantity: 1000 }]);
  const job = await makeJob(order, [{ elastic: EL_A, quantity: 600 }]);
  await recomputePending(order);
  expect(pendingOf(order, EL_A)).toBe(400);

  job.status = 'cancelled';
  await job.save();
  await recomputePending(order);
  expect(pendingOf(order, EL_A)).toBe(1000);
});

test('a completed job keeps holding its quantity', async () => {
  const order = await makeOrder([{ elastic: EL_A, quantity: 1000 }]);
  const job = await makeJob(order, [{ elastic: EL_A, quantity: 1000 }]);
  job.status = 'completed';
  await job.save();
  await recomputePending(order);
  expect(pendingOf(order, EL_A)).toBe(0);        // fulfilled, not waiting
});

test('per-elastic lines are independent', async () => {
  const order = await makeOrder([
    { elastic: EL_A, quantity: 1000 },
    { elastic: EL_B, quantity: 500 },
  ]);
  await makeJob(order, [{ elastic: EL_A, quantity: 400 }]);
  await recomputePending(order);
  expect(pendingOf(order, EL_A)).toBe(600);
  expect(pendingOf(order, EL_B)).toBe(500);
});

test('over-planning floors pending at zero rather than going negative', async () => {
  const order = await makeOrder([{ elastic: EL_A, quantity: 1000 }]);
  await makeJob(order, [{ elastic: EL_A, quantity: 700 }]);
  await makeJob(order, [{ elastic: EL_A, quantity: 700 }]);
  await recomputePending(order);
  expect(pendingOf(order, EL_A)).toBe(0);
});

test('recomputing repeatedly is idempotent', async () => {
  const order = await makeOrder([{ elastic: EL_A, quantity: 1000 }]);
  await makeJob(order, [{ elastic: EL_A, quantity: 600 }]);
  await recomputePending(order);
  await recomputePending(order);
  await recomputePending(order);
  expect(pendingOf(order, EL_A)).toBe(400);
});
