'use strict';
// ══════════════════════════════════════════════════════════════════
//  A CHALLAN LINE THAT NAMES ITS ELASTIC BUT DOES NOT IDENTIFY IT
//
//  The Delivered column on the order reads zero for some despatches
//  that plainly happened. This pins down why.
//
//  Every consumer of a challan line keys on `item.elastic`, the id:
//
//    • the delivered figure on the order sums by that id
//    • _applyDcItems SKIPS a line without one — no stock movement, no
//      reservation settled
//
//  But /dc/create takes `elastic` straight from the body and never
//  requires it, and the create FORM only supplies it for rows that were
//  prefilled from a linked order. A row added by hand, or any row on an
//  unlinked "manual" challan, carries `elasticName` as free text and no
//  id at all.
//
//  Such a line is not rejected and not flagged. It prints on the
//  challan, it goes out of the gate, and as far as the order and the
//  warehouse are concerned nothing happened.
//
//  These tests state the current behaviour so the repair can be
//  measured against it.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app;
let Order, Customer, Elastic, User, admin;

const adminCookie = () => [
  `token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`,
];

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  Order    = require('../../models/Order');
  Customer = require('../../models/Customer');
  Elastic  = require('../../models/Elastic');
  User     = require('../../models/User');
  admin = await User.create({
    name: 'Owner', email: 'dnol@t.co', password: 'pass1234',
    role: 'admin', department: 'admin',
  });
}, 120_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
});

let seq = 0;

async function seedOrder(quantity = 1000, stock = 5000) {
  const customer = await Customer.create({
    name: `Acme ${++seq}`, contactName: 'R', phoneNumber: '9000000001',
  });
  const elastic = await Elastic.create({
    name: `20mm ${Math.random().toString(36).slice(2, 8)}`, weaveType: '8',
    spandexEnds: 40, yarnEnds: 120, pick: 12, noOfHook: 8, weight: 2.4,
    stock,
  });
  const order = await Order.create({
    customer: customer._id, po: `PO-${seq}`, date: new Date(), supplyDate: new Date(),
    elasticOrdered: [{ elastic: elastic._id, quantity }],
    status: 'Approved',
  });
  return { order, elastic };
}

const createDc = (body) =>
  request(app).post('/api/v2/dc/create').set('Cookie', adminCookie()).send(body);

const orderDetail = (order) =>
  request(app).get('/api/v2/order/get-orderDetail')
    .query({ id: String(order._id) }).set('Cookie', adminCookie());

/** The delivered figure the order page renders, for the first elastic. */
const deliveredOn = async (order) => {
  const res = await orderDetail(order);
  expect(res.status).toBe(200);
  return res.body.data.elastics[0].delivered;
};

// ══════════════════════════════════════════════════════════════════
describe('a line that carries the elastic id', () => {
  it('counts as delivered on the order', async () => {
    const { order, elastic } = await seedOrder();
    const res = await createDc({
      type: 'elastic',
      orderId: String(order._id),
      orderNo: order.orderNo,
      customerName: 'Acme',
      items: [{ elastic: String(elastic._id), elasticName: '20mm', quantity: 400, rate: 10 }],
    });
    expect(res.status).toBe(201);

    expect(await deliveredOn(order)).toBe(400);
  });

  it('takes the goods off the shelf', async () => {
    const { order, elastic } = await seedOrder(1000, 5000);
    await createDc({
      type: 'elastic',
      orderId: String(order._id),
      orderNo: order.orderNo,
      customerName: 'Acme',
      items: [{ elastic: String(elastic._id), elasticName: '20mm', quantity: 400, rate: 10 }],
    });

    const after = await Elastic.findById(elastic._id).lean();
    expect(after.stock).toBe(4600);
  });
});

describe('a line that only NAMES the elastic', () => {
  const nameOnly = (order) => createDc({
    type: 'elastic',
    orderId: String(order._id),
    orderNo: order.orderNo,
    customerName: 'Acme',
    // No `elastic` key at all — what the form used to send for a row
    // the user added by hand, or any row on an unlinked challan.
    items: [{ elasticName: '20mm', quantity: 400, rate: 10 }],
  });

  it('is refused, and the message says which line and why', async () => {
    const { order } = await seedOrder();
    const res = await nameOnly(order);

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/line 1/i);
    expect(res.body.message).toMatch(/20mm/);
    expect(res.body.message).toMatch(/moves no stock/i);
  });

  it('names the offending line when it is not the first', async () => {
    const { order, elastic } = await seedOrder();
    const res = await createDc({
      type: 'elastic',
      orderId: String(order._id), orderNo: order.orderNo, customerName: 'Acme',
      items: [
        { elastic: String(elastic._id), elasticName: '20mm', quantity: 100, rate: 10 },
        { elasticName: 'typed by hand', quantity: 400, rate: 10 },
      ],
    });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/line 2/i);
  });

  it('cuts no challan at all, rather than one missing a line', async () => {
    const { order } = await seedOrder();
    await nameOnly(order);

    const DeliveryChallan = require('../../models/DeliveryChallan');
    expect(await DeliveryChallan.countDocuments({})).toBe(0);
    expect(await deliveredOn(order)).toBe(0);
  });

  it('still allows a machine-part challan, which is free text by nature', async () => {
    const res = await createDc({
      type: 'machine_part',
      customerName: 'Acme',
      items: [{ description: 'Gear box cover', quantity: 2, rate: 500 }],
    });

    expect(res.status).toBe(201);
  });
});

describe('a challan not linked to the order at all', () => {
  it('never reaches the order, even with the id on the line', async () => {
    // The second half of the same problem: the delivered figure is
    // matched by order reference or order number, and a manual challan
    // carries neither.
    const { order, elastic } = await seedOrder();
    await createDc({
      type: 'elastic',
      customerName: 'Acme',
      items: [{ elastic: String(elastic._id), elasticName: '20mm', quantity: 400, rate: 10 }],
    });

    expect(await deliveredOn(order)).toBe(0);
  });
});
