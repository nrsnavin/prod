'use strict';
// ══════════════════════════════════════════════════════════════════
//  WHO IS ALLOWED TO MOVE AN ORDER
//
//  Order.status is written from nine places across three files, with
//  no state machine behind it — unlike JobOrder, which has one in
//  domain/jobStatus.js. Three of those writes live in the JOB router
//  and change the order as a side effect of something happening to a
//  job.
//
//  The weaving gate taught the lesson these probe for: guarding the
//  obvious route means nothing while another path writes the same
//  field unguarded. Each test below is a question, not an assertion
//  of intent — the ones that fail are the answer.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
// None of the routes exercised here opens a transaction (/job/create,
// /cancel and /update-status all write without a session), so a
// standalone server is enough — and it avoids the replica-set start
// flake this suite otherwise hits.
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongo, app, Order, JobOrder, Elastic, Customer, User, admin;

const adminCookie = () => [
  `token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`,
];

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  Order = require('../../models/Order');
  JobOrder = require('../../models/JobOrder');
  Elastic = require('../../models/Elastic');
  Customer = require('../../models/Customer');
  User = require('../../models/User');
  admin = await User.create({
    name: 'Owner', email: 'o@t.co', password: 'pass1234', role: 'admin', department: 'admin',
  });
}, 90_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
});

async function seed(status = 'Approved', { qty = 1000 } = {}) {
  const customer = await Customer.create({
    name: 'Acme', contactName: 'R', phoneNumber: '9000000001',
  });
  const elastic = await Elastic.create({
    name: '20mm', weaveType: '8',
    spandexEnds: 40, yarnEnds: 120, pick: 12, noOfHook: 8, weight: 2.4,
  });
  const order = await Order.create({
    orderNo: Math.floor(Math.random() * 100000),
    customer: customer._id,
    status,
    po: 'PO-1',
    date: new Date(),
    supplyDate: new Date(),
    elasticOrdered:  [{ elastic: elastic._id, quantity: qty }],
    pendingElastic:  [{ elastic: elastic._id, quantity: qty }],
  });
  return { order, elastic };
}

const createJob = (order, elastic, quantity = 100) =>
  request(app).post('/api/v2/job/create')
    .set('Cookie', adminCookie())
    .send({
      orderId: String(order._id),
      date: new Date().toISOString(),
      elastics: [{ elastic: String(elastic._id), quantity }],
    });

const cancelJob = (job) =>
  request(app).post('/api/v2/job/cancel')
    .set('Cookie', adminCookie())
    .send({ jobId: String(job._id) });

const statusOf = async (order) => (await Order.findById(order._id)).status;

describe('creating a job must not move an order it has no business moving', () => {
  test('an Approved order goes to InProgress — the intended path', async () => {
    const { order, elastic } = await seed('Approved');
    const res = await createJob(order, elastic);
    expect(res.status).toBeLessThan(400);
    expect(await statusOf(order)).toBe('InProgress');
  });

  test('an OPEN order is not dragged past approval', async () => {
    // Approval is where raw material is debited and the stock guard
    // runs. An order that reaches InProgress without it has consumed
    // material nobody deducted.
    const { order, elastic } = await seed('Open');
    await createJob(order, elastic);
    expect(await statusOf(order)).not.toBe('InProgress');
  });
});

describe('cancelling the last job must not resurrect a finished order', () => {
  test('an InProgress order falls back to Approved — the intended path', async () => {
    const { order, elastic } = await seed('Approved');
    await createJob(order, elastic);
    const job = await JobOrder.findOne({ order: order._id });

    await cancelJob(job);
    expect(await statusOf(order)).toBe('Approved');
  });

  test('a COMPLETED order is not pulled back to Approved', async () => {
    const { order, elastic } = await seed('Approved');
    await createJob(order, elastic);
    const job = await JobOrder.findOne({ order: order._id });
    await Order.findByIdAndUpdate(order._id, { status: 'Completed' });

    await cancelJob(job);
    expect(await statusOf(order)).toBe('Completed');
  });

  test('a CANCELLED order stays cancelled', async () => {
    const { order, elastic } = await seed('Approved');
    await createJob(order, elastic);
    const job = await JobOrder.findOne({ order: order._id });
    await Order.findByIdAndUpdate(order._id, { status: 'Cancelled' });

    await cancelJob(job);
    expect(await statusOf(order)).toBe('Cancelled');
  });
});

describe('completing the last job must not resurrect a dead order', () => {
  test('a CANCELLED order is not completed by its jobs finishing', async () => {
    const { order, elastic } = await seed('Approved');
    await createJob(order, elastic);
    const job = await JobOrder.findOne({ order: order._id });
    await JobOrder.findByIdAndUpdate(job._id, { status: 'packing' });
    await Order.findByIdAndUpdate(order._id, { status: 'Cancelled' });

    await request(app).post('/api/v2/job/update-status')
      .set('Cookie', adminCookie())
      .send({ jobId: String(job._id), nextStatus: 'completed' });

    expect(await statusOf(order)).toBe('Cancelled');
  });

  test('a DELETED order is not completed by its jobs finishing', async () => {
    const { order, elastic } = await seed('Approved');
    await createJob(order, elastic);
    const job = await JobOrder.findOne({ order: order._id });
    await JobOrder.findByIdAndUpdate(job._id, { status: 'packing' });
    await Order.findByIdAndUpdate(order._id, { status: 'Deleted' });

    await request(app).post('/api/v2/job/update-status')
      .set('Cookie', adminCookie())
      .send({ jobId: String(job._id), nextStatus: 'completed' });

    expect(await statusOf(order)).toBe('Deleted');
  });
});
