'use strict';
// ══════════════════════════════════════════════════════════════════
//  AN ORDER IS NOT CANCELLED OUT FROM UNDER ITS JOBS
//
//  Found reading api/orderApproval.js and api/orderChanges.js line by
//  line.
//
//  Completing an order is refused while one of its jobs is still live,
//  and says which ("Complete or cancel them first"). Cancelling an order
//  asked nothing. It marked the order Cancelled, released its reserved
//  stock and put ALL the yarn drawn at approval back on the shelf — and
//  left every job on the order exactly as it was: still weaving, still
//  holding its machines, its warping and covering still open, its metres
//  still being entered and packed. The books then said the yarn was back
//  in the store while the floor went on turning it into elastic for an
//  order that no longer existed.
//
//  One rule, two doors: cancelling asks the same question completing
//  does. Once the jobs are finished or cancelled, the order cancels as
//  it did before.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, M, admin;
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
const post = (url, body) => request(app).post(`/api/v2${url}`).set('Cookie', cookie()).send(body);

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  M = {};
  for (const n of ['Customer', 'Elastic', 'Order', 'JobOrder', 'RawMaterial', 'User', 'Machine']) M[n] = require(`../../models/${n}`);
  M.MaterialOutward = require('../../models/MaterialOut.cjs');
  admin = await M.User.create({ name: 'Owner', email: 'order-cancel-jobs@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
});

let n = 0;
/** An order approved through the route: 40 kg of yarn drawn, 1,000 m reserved. */
async function approvedOrder() {
  n += 1;
  const material = await M.RawMaterial.create({ name: `Nylon 70D ${n}`, category: 'Yarn', stock: 200, price: 300, avgCost: 300 });
  const customer = await M.Customer.create({ name: `Acme ${n}`, contactName: 'R', phoneNumber: '9000000001' });
  const elastic = await M.Elastic.create({ name: `20mm ${n}`, weight: 5, noOfHook: 24, pick: 40, spandexEnds: 8 });
  const order = await M.Order.create({
    customer: customer._id, po: `PO-${n}`, date: new Date(), supplyDate: new Date(), status: 'Open',
    elasticOrdered: [{ elastic: elastic._id, quantity: 1000 }],
    pendingElastic: [{ elastic: elastic._id, quantity: 1000 }],
    rawMaterialRequired: [{ rawMaterial: material._id, requiredWeight: 40 }],
  });
  const res = await post('/order/approve', { orderId: String(order._id) });
  expect(res.status).toBe(200);
  return { order, material, elastic, customer };
}
/** A job on the order, as raising one leaves things: the order running, nothing left to plan. */
async function jobOn(s, status = 'weaving') {
  const job = await M.JobOrder.create({
    order: s.order._id, customer: s.customer._id, date: new Date(), status,
    elastics: [{ elastic: s.elastic._id, quantity: 1000 }],
  });
  await M.Order.updateOne({ _id: s.order._id }, {
    $set: { status: 'InProgress', pendingElastic: [{ elastic: s.elastic._id, quantity: 0 }] },
    $push: { jobs: { job: job._id, no: job.jobOrderNo } },
  });
  return job;
}
const stockOf = async (m) => (await M.RawMaterial.findById(m._id).lean()).stock;
const reservedOf = async (e) => (await M.Elastic.findById(e._id).lean()).reservedStock;
const statusOf = async (o) => (await M.Order.findById(o._id).lean()).status;

// ══════════════════════════════════════════════════════════════════
describe('cancelling an order that still has a job running', () => {
  it('is refused, naming the job — as completing it already is', async () => {
    const s = await approvedOrder();
    const job = await jobOn(s, 'weaving');
    const jobNo = (await M.JobOrder.findById(job._id).lean()).jobOrderNo;

    const res = await post('/order/cancel', { orderId: String(s.order._id), cancelReason: 'Customer withdrew the PO' });
    // Before: 200 — and the job went on weaving for a cancelled order.
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ORDER_HAS_OPEN_JOBS');
    expect(res.body.message).toMatch(new RegExp(`J-${jobNo} \\(weaving\\)`));
    expect(res.body.message).toMatch(/cancel or complete it first/i);
    expect(res.body.details.jobs).toEqual([{ id: String(job._id), jobOrderNo: jobNo, status: 'weaving' }]);
  });

  it('and nothing is given back: the order, its yarn and its reserved stock stay as they were', async () => {
    const s = await approvedOrder();
    await jobOn(s, 'preparatory');
    expect(await stockOf(s.material)).toBe(160);
    expect(await reservedOf(s.elastic)).toBe(1000);

    await post('/order/cancel', { orderId: String(s.order._id), cancelReason: 'Customer withdrew the PO' });

    expect(await statusOf(s.order)).toBe('InProgress');
    // Before: 200 kg — the yarn "back in the store" while it was on the loom.
    expect(await stockOf(s.material)).toBe(160);
    expect(await reservedOf(s.elastic)).toBe(1000);
    expect(await M.MaterialOutward.countDocuments({ order: s.order._id, reversed: true })).toBe(0);
  });

  it('names every job that is holding it', async () => {
    const s = await approvedOrder();
    await jobOn(s, 'weaving');
    await jobOn(s, 'packing');
    const res = await post('/order/cancel', { orderId: String(s.order._id) });
    expect(res.status).toBe(409);
    expect(res.body.details.jobs).toHaveLength(2);
    expect(res.body.message).toMatch(/2 unfinished jobs/);
    expect(res.body.message).toMatch(/cancel or complete them first/i);
  });
});

describe('once its jobs are finished or cancelled', () => {
  it('a cancelled job no longer holds the order: it cancels, and the yarn and the reserved stock come back', async () => {
    const s = await approvedOrder();
    const job = await jobOn(s, 'preparatory');
    expect((await post('/job/cancel', { jobId: String(job._id), reason: 'Customer withdrew the PO' })).status).toBe(200);

    const res = await post('/order/cancel', { orderId: String(s.order._id), cancelReason: 'Customer withdrew the PO' });
    expect(res.status).toBe(200);
    expect(await statusOf(s.order)).toBe('Cancelled');
    expect(await stockOf(s.material)).toBe(200);
    expect(await reservedOf(s.elastic)).toBe(0);
  });

  it('a completed job does not hold it either', async () => {
    const s = await approvedOrder();
    await jobOn(s, 'completed');
    const res = await post('/order/cancel', { orderId: String(s.order._id), cancelReason: 'Customer withdrew the PO' });
    expect(res.status).toBe(200);
    expect(await statusOf(s.order)).toBe('Cancelled');
  });
});

describe('an order with no jobs', () => {
  it('approved: cancels as before, with the yarn back', async () => {
    const s = await approvedOrder();
    const res = await post('/order/cancel', { orderId: String(s.order._id), cancelReason: 'Entered twice' });
    expect(res.status).toBe(200);
    expect(await stockOf(s.material)).toBe(200);
  });

  it('open: cancels as before', async () => {
    n += 1;
    const customer = await M.Customer.create({ name: `Acme ${n}`, contactName: 'R', phoneNumber: '9000000001' });
    const elastic = await M.Elastic.create({ name: `20mm ${n}`, weight: 5, noOfHook: 24, pick: 40, spandexEnds: 8 });
    const order = await M.Order.create({
      customer: customer._id, po: `PO-${n}`, date: new Date(), supplyDate: new Date(), status: 'Open',
      elasticOrdered: [{ elastic: elastic._id, quantity: 1000 }],
    });
    const res = await post('/order/cancel', { orderId: String(order._id) });
    expect(res.status).toBe(200);
    expect(await statusOf(order)).toBe('Cancelled');
  });
});

describe('completing an order with a job running', () => {
  it('still says what it said', async () => {
    const s = await approvedOrder();
    const job = await jobOn(s, 'weaving');
    const jobNo = (await M.JobOrder.findById(job._id).lean()).jobOrderNo;
    const res = await post('/order/complete', { orderId: String(s.order._id) });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ORDER_HAS_OPEN_JOBS');
    expect(res.body.message).toBe(`This order still has 1 unfinished job — J-${jobNo} (weaving). Complete or cancel it first.`);
  });
});
