'use strict';
// ══════════════════════════════════════════════════════════════════
//  TWO WAYS AN ORDER FINISHES, ONE OF THEM LEAKS
//
//  Approving an order RESERVES elastic stock: `Elastic.reservedStock`
//  goes up, and the order carries a `reservations` array saying how
//  much of each is held for it. Available stock is
//  `stock − reservedStock` everywhere the floor reads it.
//
//  An order reaches Completed by two routes:
//
//    POST /order/complete        releases every remaining reservation
//                                first, then flips the status
//
//    POST /job/update-status     when the LAST job completes, the
//                                cascade flips the order to Completed
//                                via applyOrderStatus — which only
//                                sets the status and its stamps
//
//  The second never releases anything. And Completed is terminal, so
//  /order/complete can never run on that order afterwards: the reserved
//  stock is held for a finished order forever, and every subsequent
//  order sees less available than there is.
//
//  Nothing errors. The order looks correctly completed on every screen.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, Order, JobOrder, Elastic, Customer, User, admin;
let customer, elastic;

const cookie = () => [
  `token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`,
];

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app      = require('../../app.js');
  Order    = require('../../models/Order');
  JobOrder = require('../../models/JobOrder');
  Elastic  = require('../../models/Elastic');
  Customer = require('../../models/Customer');
  User     = require('../../models/User');
  admin = await User.create({
    name: 'Floor', email: 'jobdone@t.co', password: 'pass1234',
    role: 'admin', department: 'admin',
  });
}, 120_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

let seq = 0;
beforeEach(async () => {
  customer = await Customer.create({
    name: 'Acme', contactName: 'R', phoneNumber: '9000000001',
  });
  elastic = await Elastic.create({
    name: `20mm-${seq++}`, weaveType: '8', spandexEnds: 40,
    yarnEnds: 120, pick: 12, noOfHook: 8, weight: 2.4,
    stock: 5000, reservedStock: 1000,
  });
});

afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
});

/**
 * An order mid-production, with 1,000 m still reserved against it, and
 * one job about to finish. This is the ordinary shape of an order the
 * day its last job comes off the machine.
 */
const orderInProgress = async () => {
  const order = await Order.create({
    customer: customer._id, po: 'PO-1',
    date: new Date(), supplyDate: new Date(),
    status: 'InProgress',
    elasticOrdered: [{ elastic: elastic._id, quantity: 1000, rate: 10 }],
    pendingElastic: [{ elastic: elastic._id, quantity: 0 }],
    reservations:   [{ elastic: elastic._id, quantity: 1000 }],
  });
  const job = await JobOrder.create({
    order: order._id, customer: customer._id, date: new Date(),
    status: 'packing',
    elastics: [{ elastic: elastic._id, quantity: 1000 }],
    producedElastic: [{ elastic: elastic._id, quantity: 1000 }],
  });
  return { order, job };
};

const advance = (job, nextStatus) =>
  request(app).post('/api/v2/job/update-status')
    .set('Cookie', cookie())
    .send({ jobId: job._id, nextStatus });

const reservedNow = async () =>
  (await Elastic.findById(elastic._id).lean()).reservedStock;

// ══════════════════════════════════════════════════════════════════
describe('the last job completing an order', () => {
  it('completes the order', async () => {
    const { order, job } = await orderInProgress();
    const res = await advance(job, 'completed');

    expect(res.status).toBe(200);
    expect((await Order.findById(order._id).lean()).status).toBe('Completed');
  });

  it('gives the reserved stock back', async () => {
    // 1,000 m was held for this order. It is finished, so nothing is
    // held for it any more — the same thing /order/complete does.
    const { job } = await orderInProgress();
    expect(await reservedNow()).toBe(1000);

    await advance(job, 'completed');

    expect(await reservedNow()).toBe(0);
  });

  it('clears the order\'s own reservation rows', async () => {
    // Leaving them behind means the order says stock is held for it
    // while the elastic says otherwise — two records of one fact,
    // disagreeing, on a document nobody can touch again.
    const { order, job } = await orderInProgress();
    await advance(job, 'completed');

    const fresh = await Order.findById(order._id).lean();
    const held = (fresh.reservations || []).reduce((s, r) => s + r.quantity, 0);
    expect(held).toBe(0);
  });

  it('records the release on the order trail', async () => {
    const { order, job } = await orderInProgress();
    await advance(job, 'completed');

    const fresh = await Order.findById(order._id).lean();
    const codes = fresh.fingerprints.map((f) => f.code);
    expect(codes).toContain('STOCK_RELEASED');
  });

  it('reaches the same place /order/complete reaches', async () => {
    // The two routes are two doors into one state. If they leave the
    // system in different states, one of them is wrong.
    const viaJob = await orderInProgress();
    await advance(viaJob.job, 'completed');
    const afterJob = await reservedNow();

    await Elastic.updateOne({ _id: elastic._id }, { $set: { reservedStock: 1000 } });
    const viaOrder = await Order.create({
      customer: customer._id, po: 'PO-2',
      date: new Date(), supplyDate: new Date(), status: 'InProgress',
      elasticOrdered: [{ elastic: elastic._id, quantity: 1000, rate: 10 }],
      reservations:   [{ elastic: elastic._id, quantity: 1000 }],
    });
    await request(app).post('/api/v2/order/complete')
      .set('Cookie', cookie()).send({ orderId: viaOrder._id });

    expect(afterJob).toBe(await reservedNow());
  });
});

describe('a job completing while siblings are still running', () => {
  it('does not complete the order, and holds the reservation', async () => {
    const { order, job } = await orderInProgress();
    await JobOrder.create({
      order: order._id, customer: customer._id, date: new Date(),
      status: 'weaving',
      elastics: [{ elastic: elastic._id, quantity: 500 }],
    });

    await advance(job, 'completed');

    const fresh = await Order.findById(order._id).lean();
    expect(fresh.status).toBe('InProgress');
    // Still work to come, so the stock stays held.
    expect(await reservedNow()).toBe(1000);
  });
});

describe('an order that is no longer completable', () => {
  it('is left alone when its last job finishes', async () => {
    // A cancelled order is not completed by its jobs finishing — that
    // used to resurrect it. The reservations were already released by
    // the cancel, and must not be released twice.
    const { order, job } = await orderInProgress();
    await Order.updateOne({ _id: order._id }, { $set: { status: 'Cancelled', reservations: [] } });
    await Elastic.updateOne({ _id: elastic._id }, { $set: { reservedStock: 0 } });

    await advance(job, 'completed');

    const fresh = await Order.findById(order._id).lean();
    expect(fresh.status).toBe('Cancelled');
    expect(await reservedNow()).toBe(0);
  });
});
