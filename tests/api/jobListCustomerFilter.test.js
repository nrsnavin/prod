'use strict';
// ══════════════════════════════════════════════════════════════════
//  FILTERING THE JOB LIST BY CUSTOMER
//
//  Added for the complaint form, whose job picker has to offer the jobs
//  one specific customer received. The alternatives were both wrong:
//
//    • `search` only matches an integer job number, so it cannot find
//      "this customer's jobs" at all;
//    • filtering the returned page client-side hides every job outside
//      the newest twenty — and a complaint is usually about goods
//      delivered months ago, which is to say all of them.
//
//  GET /job/jobs had no test coverage of any kind before this. These
//  cover the new parameter and the two existing ones beside it, so a
//  future change to the filter block has something to fail against.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app;
let JobOrder, Order, Customer, Elastic, User;
let admin, alpha, beta, elastic;

const cookieFor = (u) => [
  `token=${jwt.sign({ id: u._id, role: u.role }, process.env.JWT_SECRET_KEY)}`,
];

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app      = require('../../app.js');
  JobOrder = require('../../models/JobOrder');
  Order    = require('../../models/Order');
  Customer = require('../../models/Customer');
  Elastic  = require('../../models/Elastic');
  User     = require('../../models/User');

  admin = await User.create({
    name: 'Admin', email: 'joblist-admin@t.co', password: 'pass1234',
    role: 'admin', department: 'admin',
  });
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

let seq = 0;

beforeEach(async () => {
  alpha = await Customer.create({
    name: 'Alpha', contactName: 'Alpha', phoneNumber: `9${String(seq++).padStart(9, '0')}`,
  });
  beta = await Customer.create({
    name: 'Beta', contactName: 'Beta', phoneNumber: `9${String(seq++).padStart(9, '0')}`,
  });
  elastic = await Elastic.create({
    name: `E-${seq++}`, weaveType: '8', spandexEnds: 40, yarnEnds: 120,
    pick: 12, noOfHook: 8, weight: 2.4,
  });
});

afterEach(async () => {
  await Promise.all([
    JobOrder.deleteMany({}), Order.deleteMany({}),
    Customer.deleteMany({}), Elastic.deleteMany({}),
  ]);
});

async function makeJob(customer, status = 'weaving') {
  const order = await Order.create({
    customer, date: new Date(), po: `PO-${seq++}`, supplyDate: new Date(),
    elastics: [{ elastic: elastic._id, quantity: 1000 }],
  });
  return JobOrder.create({
    order: order._id, customer, date: new Date(), status,
    elastics: [{ elastic: elastic._id, quantity: 1000 }],
  });
}

const list = (query = '') =>
  request(app).get(`/api/v2/job/jobs${query}`).set('Cookie', cookieFor(admin));

describe('GET /job/jobs?customer=', () => {
  test('returns only that customer\'s jobs', async () => {
    await makeJob(alpha._id);
    await makeJob(alpha._id);
    await makeJob(beta._id);

    const res = await list(`?customer=${alpha._id}`);
    expect(res.status).toBe(200);
    expect(res.body.jobs).toHaveLength(2);
    for (const j of res.body.jobs) {
      expect(String(j.customer._id)).toBe(String(alpha._id));
    }
    expect(res.body.pagination.total).toBe(2);
  });

  test('reaches past the first page — the whole reason it is server-side', async () => {
    // One recent job for Beta and an older one for Alpha. Filtering the
    // returned page instead would find nothing for Alpha at limit=1.
    const old = await makeJob(alpha._id);
    await JobOrder.updateOne({ _id: old._id }, { createdAt: new Date('2025-01-01') });
    await makeJob(beta._id);

    const res = await list(`?customer=${alpha._id}&limit=1`);
    expect(res.body.jobs).toHaveLength(1);
    expect(String(res.body.jobs[0]._id)).toBe(String(old._id));
  });

  test('combines with the status filter', async () => {
    await makeJob(alpha._id, 'weaving');
    await makeJob(alpha._id, 'completed');
    await makeJob(beta._id, 'completed');

    const res = await list(`?customer=${alpha._id}&status=completed`);
    expect(res.body.jobs).toHaveLength(1);
    expect(res.body.jobs[0].status).toBe('completed');
  });

  test('a malformed customer id is a 400, not a silent empty list', async () => {
    // An empty list reads as "this customer has no jobs", which would
    // send somebody looking for a job that is right there.
    await makeJob(alpha._id);
    const res = await list('?customer=not-an-id');
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/invalid customer id/i);
  });

  test('omitting it returns everybody, as before', async () => {
    await makeJob(alpha._id);
    await makeJob(beta._id);

    const res = await list();
    expect(res.body.jobs).toHaveLength(2);
  });

  test('an unknown but well-formed customer returns nothing', async () => {
    await makeJob(alpha._id);
    const res = await list(`?customer=${new mongoose.Types.ObjectId()}`);
    expect(res.status).toBe(200);
    expect(res.body.jobs).toHaveLength(0);
  });

  test('an invalid status is still rejected', async () => {
    const res = await list('?status=nonsense');
    expect(res.status).toBe(400);
  });
});
