'use strict';
// ══════════════════════════════════════════════════════════════════
//  PACKING A JOB, AND THE ORDER THAT ASKED FOR IT
//
//  Reported as: packing an elastic on a job leaves the order's packing
//  figures untouched. The job's own packedElastic was updated and a
//  fingerprint was pushed onto the order — so the audit trail said it
//  happened while the order's numbers said it had not.
//
//  It matters twice over now that Pending means ordered less packed:
//  an order whose every metre is packed still read as entirely
//  outstanding.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
// Packing writes job, order and elastic stock in one transaction.
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, Order, JobOrder, Elastic, Customer, Employee, User, admin;

const adminCookie = () => [
  `token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`,
];

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({
    replSet: { count: 1 },
    instanceOpts: [{ launchTimeout: 60_000 }],
  });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  Order = require('../../models/Order');
  JobOrder = require('../../models/JobOrder');
  Elastic = require('../../models/Elastic');
  Customer = require('../../models/Customer');
  Employee = require('../../models/Employee');
  User = require('../../models/User');
  admin = await User.create({
    name: 'Owner', email: 'o@t.co', password: 'pass1234', role: 'admin', department: 'admin',
  });
}, 120_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
});

async function seed({ ordered = 1000, jobQty = 400 } = {}) {
  const customer = await Customer.create({
    name: 'Acme', contactName: 'R', phoneNumber: '9000000001',
  });
  const elastic = await Elastic.create({
    name: '20mm', weaveType: '8',
    spandexEnds: 40, yarnEnds: 120, pick: 12, noOfHook: 8, weight: 2.4,
  });
  const employee = await Employee.create({
    name: 'Ravi', phoneNumber: '9000000002', role: 'operator', salary: 500,
  });
  const order = await Order.create({
    orderNo: Math.floor(Math.random() * 100000),
    customer: customer._id, status: 'InProgress', po: 'PO-1',
    date: new Date(), supplyDate: new Date(),
    elasticOrdered:  [{ elastic: elastic._id, quantity: ordered }],
    producedElastic: [{ elastic: elastic._id, quantity: 0 }],
    packedElastic:   [{ elastic: elastic._id, quantity: 0 }],
    pendingElastic:  [{ elastic: elastic._id, quantity: ordered - jobQty }],
  });
  const job = await JobOrder.create({
    date: new Date(), order: order._id, customer: customer._id,
    status: 'packing',
    elastics:        [{ elastic: elastic._id, quantity: jobQty }],
    producedElastic: [{ elastic: elastic._id, quantity: jobQty }],
    packedElastic:   [{ elastic: elastic._id, quantity: 0 }],
    wastageElastic:  [{ elastic: elastic._id, quantity: 0 }],
  });
  await Order.findByIdAndUpdate(order._id, {
    $push: { jobs: { job: job._id, no: job.jobOrderNo } },
  });
  return { order, job, elastic, employee };
}

const pack = (job, elastic, employee, meter) =>
  request(app).post('/api/v2/packing/create-packing')
    .set('Cookie', adminCookie())
    .send({
      job: String(job._id),
      elastic: String(elastic._id),
      meter,
      netWeight: meter * 2.4 / 1000,
      tareWeight: 0.5,
      grossWeight: meter * 2.4 / 1000 + 0.5,
      checkedBy: String(employee._id),
      packedBy: String(employee._id),
      date: new Date().toISOString(),
    });

const orderPacked = async (order, elastic) => {
  const o = await Order.findById(order._id);
  const row = (o.packedElastic || []).find((p) => String(p.elastic) === String(elastic._id));
  return row ? row.quantity : null;
};

describe('packing on a job reaches the order', () => {
  it('adds the packed metres to the order', async () => {
    const { order, job, elastic, employee } = await seed();

    const res = await pack(job, elastic, employee, 250);
    expect(res.status).toBeLessThan(400);

    expect(await orderPacked(order, elastic)).toBe(250);
  });

  it('accumulates across several packings', async () => {
    const { order, job, elastic, employee } = await seed();

    await pack(job, elastic, employee, 100);
    await pack(job, elastic, employee, 150);

    expect(await orderPacked(order, elastic)).toBe(250);
  });

  it('sums the jobs, rather than counting the latest one only', async () => {
    const { order, job, elastic, employee } = await seed({ ordered: 1000, jobQty: 400 });
    // A second job on the same order, also packing.
    const second = await JobOrder.create({
      date: new Date(), order: order._id, customer: job.customer,
      status: 'packing',
      elastics:        [{ elastic: elastic._id, quantity: 300 }],
      producedElastic: [{ elastic: elastic._id, quantity: 300 }],
      packedElastic:   [{ elastic: elastic._id, quantity: 0 }],
      wastageElastic:  [{ elastic: elastic._id, quantity: 0 }],
    });

    await pack(job, elastic, employee, 200);
    await pack(second, elastic, employee, 300);

    expect(await orderPacked(order, elastic)).toBe(500);
  });

  it('is a recompute, so it cannot drift from the jobs it mirrors', async () => {
    // Incrementing in place drifts the moment anything is corrected or
    // replayed. Deriving it from the jobs means the order can only ever
    // say what its jobs say.
    const { order, job, elastic, employee } = await seed();
    await pack(job, elastic, employee, 200);

    // Something corrects the job's figure behind the order's back.
    await JobOrder.updateOne(
      { _id: job._id, 'packedElastic.elastic': elastic._id },
      { $set: { 'packedElastic.$.quantity': 75 } }
    );
    await pack(job, elastic, employee, 25);

    // 75 + 25 as the job now holds it, not 200 + 25 as a counter would.
    expect(await orderPacked(order, elastic)).toBe(100);
  });

  it('leaves the produced figure to its own path', async () => {
    const { order, job, elastic, employee } = await seed();
    await pack(job, elastic, employee, 250);

    const o = await Order.findById(order._id);
    const produced = (o.producedElastic || []).find(
      (p) => String(p.elastic) === String(elastic._id)
    );
    // Packing is not production; mirroring one onto the other would
    // double-count the same metres.
    expect(produced.quantity).toBe(0);
  });
});

describe('what the order then reports', () => {
  it('counts the packed metres against what is still owed', async () => {
    const { order, job, elastic, employee } = await seed({ ordered: 1000, jobQty: 400 });
    await pack(job, elastic, employee, 400);

    const res = await request(app)
      .get('/api/v2/order/get-orderDetail')
      .query({ id: String(order._id) })
      .set('Cookie', adminCookie());

    const row = res.body.data.elastics.find((e) => String(e.id) === String(elastic._id));
    expect(row.packed).toBe(400);
    // Pending is ordered less packed — the whole point of the split.
    expect(row.pendingDelivery).toBe(600);
  });
});
