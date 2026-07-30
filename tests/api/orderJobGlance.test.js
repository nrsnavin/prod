'use strict';
// Per-job elastic breakdown on the order detail payload.
//
// "Pending" means different things at the two levels and the test pins both:
//   order level — ordered minus PLANNED  ("no job raised for it yet")
//   job level   — planned minus PRODUCED ("committed here, not yet woven")

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
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
}, 60_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
});

const detail = (id) =>
  request(app).get('/api/v2/order/get-orderDetail')
    .query({ id: String(id) }).set('Cookie', adminCookie());

/** An order for two elastics with one job covering part of it. */
async function seed({ jobElastics, produced = [], packed = [] } = {}) {
  const customer = await Customer.create({ name: 'Sri Kumaran Mills', contactName: 'Ravi', phoneNumber: '9000000000' });
  const [a, b] = await Promise.all([
    Elastic.create({ name: 'E-100 20mm', weight: 10, noOfHook: 24, pick: 12, spandexEnds: 4 }),
    Elastic.create({ name: 'E-200 15mm', weight: 10, noOfHook: 24, pick: 12, spandexEnds: 4 }),
  ]);

  const order = await Order.create({
    customer: customer._id, po: 'PO-1', supplyDate: new Date(),
    date: new Date(),
    elasticOrdered: [
      { elastic: a._id, quantity: 1000 },
      { elastic: b._id, quantity: 500 },
    ],
    producedElastic: [{ elastic: a._id, quantity: 0 }, { elastic: b._id, quantity: 0 }],
    packedElastic:   [{ elastic: a._id, quantity: 0 }, { elastic: b._id, quantity: 0 }],
    pendingElastic:  [{ elastic: a._id, quantity: 1000 }, { elastic: b._id, quantity: 500 }],
  });

  const job = await JobOrder.create({
    date: new Date(),
    order: order._id,
    customer: customer._id, po: 'PO-1', supplyDate: new Date(),
    status: 'weaving',
    elastics: jobElastics ?? [{ elastic: a._id, quantity: 600 }],
    producedElastic: produced,
    packedElastic: packed,
  });

  await Order.findByIdAndUpdate(order._id, { $push: { jobs: { job: job._id } } });
  return { order, job, a, b };
}

describe('GET /order/get-orderDetail — per-job elastic glance', () => {
  test('names each elastic the job covers and how much is planned', async () => {
    const { order } = await seed();

    const res = await detail(order._id);
    expect(res.status).toBe(200);

    const [jobRef] = res.body.data.jobs;
    expect(jobRef.elasticSummary).toHaveLength(1);
    expect(jobRef.elasticSummary[0]).toMatchObject({
      name: 'E-100 20mm',
      planned: 600,
      produced: 0,
      pending: 600,
    });
  });

  test('job pending is planned minus produced, not ordered minus produced', async () => {
    const customer = await Customer.create({ name: 'X', contactName: 'Ravi', phoneNumber: '9000000000' });
    const a = await Elastic.create({ name: 'E-100 20mm', weight: 10, noOfHook: 24, pick: 12, spandexEnds: 4 });
    const order = await Order.create({
      customer: customer._id, date: new Date(), po: 'PO-1', supplyDate: new Date(),
      elasticOrdered: [{ elastic: a._id, quantity: 1000 }],
      producedElastic: [{ elastic: a._id, quantity: 250 }],
      packedElastic: [{ elastic: a._id, quantity: 0 }],
      pendingElastic: [{ elastic: a._id, quantity: 400 }], // 1000 ordered − 600 planned
    });
    const job = await JobOrder.create({
      date: new Date(), order: order._id, customer: customer._id, status: 'weaving',
      elastics: [{ elastic: a._id, quantity: 600 }],
      producedElastic: [{ elastic: a._id, quantity: 250 }],
    });
    await Order.findByIdAndUpdate(order._id, { $push: { jobs: { job: job._id } } });

    const res = await detail(order._id);
    // Order level keeps its own meaning …
    expect(res.body.data.elastics[0].pending).toBe(400);
    // … while the job reports what is left to weave on it.
    expect(res.body.data.jobs[0].elasticSummary[0].pending).toBe(350);
  });

  test('carries produced and packed per elastic', async () => {
    const customer = await Customer.create({ name: 'X', contactName: 'Ravi', phoneNumber: '9000000000' });
    const a = await Elastic.create({ name: 'E-100 20mm', weight: 10, noOfHook: 24, pick: 12, spandexEnds: 4 });
    const order = await Order.create({
      customer: customer._id, date: new Date(), po: 'PO-1', supplyDate: new Date(),
      elasticOrdered: [{ elastic: a._id, quantity: 1000 }],
      producedElastic: [], packedElastic: [], pendingElastic: [],
    });
    const job = await JobOrder.create({
      date: new Date(), order: order._id, customer: customer._id, status: 'packing',
      elastics: [{ elastic: a._id, quantity: 600 }],
      producedElastic: [{ elastic: a._id, quantity: 600 }],
      packedElastic: [{ elastic: a._id, quantity: 450 }],
    });
    await Order.findByIdAndUpdate(order._id, { $push: { jobs: { job: job._id } } });

    const row = (await detail(order._id)).body.data.jobs[0].elasticSummary[0];
    expect(row).toMatchObject({ planned: 600, produced: 600, packed: 450, pending: 0 });
  });

  test('never reports a negative pending when a job over-produces', async () => {
    const customer = await Customer.create({ name: 'X', contactName: 'Ravi', phoneNumber: '9000000000' });
    const a = await Elastic.create({ name: 'E-100 20mm', weight: 10, noOfHook: 24, pick: 12, spandexEnds: 4 });
    const order = await Order.create({
      customer: customer._id, date: new Date(), po: 'PO-1', supplyDate: new Date(),
      elasticOrdered: [{ elastic: a._id, quantity: 1000 }],
      producedElastic: [], packedElastic: [], pendingElastic: [],
    });
    const job = await JobOrder.create({
      date: new Date(), order: order._id, customer: customer._id, status: 'weaving',
      elastics: [{ elastic: a._id, quantity: 600 }],
      producedElastic: [{ elastic: a._id, quantity: 650 }],
    });
    await Order.findByIdAndUpdate(order._id, { $push: { jobs: { job: job._id } } });

    expect((await detail(order._id)).body.data.jobs[0].elasticSummary[0].pending).toBe(0);
  });

  test('keeps the populated job object both clients already read', async () => {
    const { order, job } = await seed();

    const [jobRef] = (await detail(order._id)).body.data.jobs;
    // Web reads jobs[].job._id / .jobOrderNo / .status; mobile reads job._id.
    expect(jobRef.job._id).toBe(String(job._id));
    expect(jobRef.job.status).toBe('weaving');
    expect(jobRef.job.jobOrderNo).toBeDefined();
  });

  test('returns an empty summary for a job with no elastics', async () => {
    const { order } = await seed({ jobElastics: [] });
    expect((await detail(order._id)).body.data.jobs[0].elasticSummary).toEqual([]);
  });

  test('survives an elastic master that was deleted after the job was raised', async () => {
    const { order, a } = await seed();
    await Elastic.findByIdAndDelete(a._id);

    const res = await detail(order._id);
    expect(res.status).toBe(200);
    // The row stays — a job line that vanishes is worse than one labelled Unknown.
    expect(res.body.data.jobs[0].elasticSummary).toHaveLength(1);
    expect(res.body.data.jobs[0].elasticSummary[0].planned).toBe(600);
  });
});
