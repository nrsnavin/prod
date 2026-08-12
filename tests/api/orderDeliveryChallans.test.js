'use strict';
// ══════════════════════════════════════════════════════════════════
//  WHAT HAS ACTUALLY LEFT THE BUILDING, ON THE ORDER
//
//  The order detail page could say what was ordered, planned, produced
//  and packed, and then stopped. Whether any of it had been DESPATCHED
//  — and against which delivery note — could only be answered by
//  leaving the order, opening the DC list and searching it by order
//  number. That is the question customers ring up about.
//
//  What these tests pin down:
//
//    • every note raised against the order is listed, newest first
//    • a note matched by its NUMBER is found too, not only by its
//      reference — older rows carry one without the other, and a
//      despatch list that is silently incomplete is worse than none
//    • another order's notes never appear on this one
//    • cancelled notes are listed but excluded from the totals
//    • ordered vs despatched is stated per elastic
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app;
let Order, Customer, Elastic, DeliveryChallan, User, admin;

const adminCookie = () => [
  `token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`,
];

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  Order           = require('../../models/Order');
  Customer        = require('../../models/Customer');
  Elastic         = require('../../models/Elastic');
  DeliveryChallan = require('../../models/DeliveryChallan');
  User            = require('../../models/User');
  admin = await User.create({
    name: 'Owner', email: 'dc@t.co', password: 'pass1234',
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

async function seedOrder(quantity = 1000) {
  const customer = await Customer.create({
    name: `Acme ${++seq}`, contactName: 'R', phoneNumber: '9000000001',
  });
  const elastic = await Elastic.create({
    name: `20mm ${Math.random().toString(36).slice(2, 8)}`, weaveType: '8',
    spandexEnds: 40, yarnEnds: 120, pick: 12, noOfHook: 8, weight: 2.4,
  });
  const order = await Order.create({
    customer: customer._id, po: `PO-${seq}`, date: new Date(), supplyDate: new Date(),
    elasticOrdered: [{ elastic: elastic._id, quantity }],
    status: 'Approved',
  });
  return { order, elastic, customer };
}

/** A note written straight to the collection, so its shape is exact. */
const makeDc = (over = {}) =>
  DeliveryChallan.create({
    dcNumber: `DC-${++seq}`,
    // Required by the model — the numbering scheme is per financial
    // year, and a note without them is not a note the app could ever
    // have written.
    financialYear: '25/26',
    sequence: seq,
    type: 'elastic',
    customerName: 'Acme',
    date: new Date(),
    status: 'dispatched',
    items: [],
    totalQuantity: 0,
    ...over,
  });

const fetch = (order) =>
  request(app).get(`/api/v2/order/${order._id}/delivery-challans`)
    .set('Cookie', adminCookie());

// ══════════════════════════════════════════════════════════════════
describe('the delivery notes raised for an order', () => {
  it('lists every one of them', async () => {
    const { order, elastic } = await seedOrder();
    await makeDc({
      order: order._id, orderNo: order.orderNo, dcNumber: 'DC-A',
      totalQuantity: 400,
      items: [{ elastic: elastic._id, elasticName: '20mm', quantity: 400, unit: 'm' }],
    });
    await makeDc({
      order: order._id, orderNo: order.orderNo, dcNumber: 'DC-B',
      totalQuantity: 300,
      items: [{ elastic: elastic._id, elasticName: '20mm', quantity: 300, unit: 'm' }],
    });

    const res = await fetch(order);
    expect(res.status).toBe(200);
    expect(res.body.data.dcs.map((d) => d.dcNumber).sort()).toEqual(['DC-A', 'DC-B']);
  });

  it('finds a note that carries only the order number', async () => {
    // Older rows have one of the two links, not both. Matching on the
    // reference alone would quietly drop them.
    const { order, elastic } = await seedOrder();
    await makeDc({
      orderNo: order.orderNo, dcNumber: 'DC-LEGACY', totalQuantity: 250,
      items: [{ elastic: elastic._id, elasticName: '20mm', quantity: 250, unit: 'm' }],
    });

    const res = await fetch(order);
    expect(res.body.data.dcs.map((d) => d.dcNumber)).toEqual(['DC-LEGACY']);
    expect(res.body.data.totals.dispatched).toBe(250);
  });

  it('finds a note that carries only the reference', async () => {
    const { order } = await seedOrder();
    await makeDc({ order: order._id, dcNumber: 'DC-REFONLY', totalQuantity: 100 });

    const res = await fetch(order);
    expect(res.body.data.dcs.map((d) => d.dcNumber)).toEqual(['DC-REFONLY']);
  });

  it('never shows another order its notes', async () => {
    const a = await seedOrder();
    const b = await seedOrder();
    await makeDc({ order: a.order._id, orderNo: a.order.orderNo, dcNumber: 'DC-MINE' });
    await makeDc({ order: b.order._id, orderNo: b.order.orderNo, dcNumber: 'DC-THEIRS' });

    const res = await fetch(a.order);
    expect(res.body.data.dcs.map((d) => d.dcNumber)).toEqual(['DC-MINE']);
  });

  it('lists a note once, even though it carries both links', async () => {
    const { order } = await seedOrder();
    await makeDc({ order: order._id, orderNo: order.orderNo, dcNumber: 'DC-BOTH' });

    const res = await fetch(order);
    expect(res.body.data.dcs).toHaveLength(1);
  });

  it('says nothing has gone out yet, rather than failing', async () => {
    const { order } = await seedOrder();
    const res = await fetch(order);

    expect(res.status).toBe(200);
    expect(res.body.data.dcs).toEqual([]);
    expect(res.body.data.totals).toMatchObject({ count: 0, dispatched: 0 });
  });

  it('carries the despatch detail a customer would quote', async () => {
    const { order, elastic } = await seedOrder();
    await makeDc({
      order: order._id, orderNo: order.orderNo, dcNumber: 'DC-DETAIL',
      status: 'delivered', totalQuantity: 400, totalAmount: 4800,
      vehicleNo: 'TN-39-AB-1234', transporter: 'VRL', lrNumber: 'LR-77',
      items: [{ elastic: elastic._id, elasticName: '20mm', quantity: 400, unit: 'm', rate: 12 }],
    });

    const row = (await fetch(order)).body.data.dcs[0];
    expect(row).toMatchObject({
      dcNumber: 'DC-DETAIL', status: 'delivered', totalQuantity: 400,
      vehicleNo: 'TN-39-AB-1234', transporter: 'VRL', lrNumber: 'LR-77',
    });
    expect(row.items[0]).toMatchObject({ elasticName: '20mm', quantity: 400, unit: 'm' });
  });
});

describe('a cancelled note', () => {
  it('is still listed — somebody raised it', async () => {
    // "Why is there a gap in the DC numbers" has to have an answer.
    const { order } = await seedOrder();
    await makeDc({
      order: order._id, orderNo: order.orderNo, dcNumber: 'DC-VOID',
      status: 'cancelled', totalQuantity: 400,
    });

    const res = await fetch(order);
    expect(res.body.data.dcs.map((d) => d.dcNumber)).toEqual(['DC-VOID']);
    expect(res.body.data.totals.cancelled).toBe(1);
  });

  it('counts for nothing in the despatched totals', async () => {
    const { order, elastic } = await seedOrder();
    await makeDc({
      order: order._id, orderNo: order.orderNo, dcNumber: 'DC-LIVE',
      totalQuantity: 400,
      items: [{ elastic: elastic._id, elasticName: '20mm', quantity: 400, unit: 'm' }],
    });
    await makeDc({
      order: order._id, orderNo: order.orderNo, dcNumber: 'DC-VOID',
      status: 'cancelled', totalQuantity: 999,
      items: [{ elastic: elastic._id, elasticName: '20mm', quantity: 999, unit: 'm' }],
    });

    const { totals, lines } = (await fetch(order)).body.data;
    expect(totals.quantity).toBe(400);
    expect(totals.dispatched).toBe(400);
    expect(lines[0].dispatched).toBe(400);
  });
});

describe('ordered against despatched', () => {
  it('states both, per elastic, and what is left', async () => {
    const { order, elastic } = await seedOrder(1000);
    await makeDc({
      order: order._id, orderNo: order.orderNo, totalQuantity: 400,
      items: [{ elastic: elastic._id, elasticName: '20mm', quantity: 400, unit: 'm' }],
    });

    const { lines } = (await fetch(order)).body.data;
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      elasticName: elastic.name, ordered: 1000, dispatched: 400, pending: 600,
    });
  });

  it('adds up several notes for the same elastic', async () => {
    const { order, elastic } = await seedOrder(1000);
    for (const q of [400, 300, 200]) {
      await makeDc({
        order: order._id, orderNo: order.orderNo, totalQuantity: q,
        items: [{ elastic: elastic._id, elasticName: '20mm', quantity: q, unit: 'm' }],
      });
    }

    const { lines } = (await fetch(order)).body.data;
    expect(lines[0]).toMatchObject({ dispatched: 900, pending: 100 });
  });

  it('shows an over-despatch rather than clamping it away', async () => {
    // More going out than was ordered happens, and it is exactly the
    // thing somebody needs to see.
    const { order, elastic } = await seedOrder(1000);
    await makeDc({
      order: order._id, orderNo: order.orderNo, totalQuantity: 1200,
      items: [{ elastic: elastic._id, elasticName: '20mm', quantity: 1200, unit: 'm' }],
    });

    const { lines } = (await fetch(order)).body.data;
    expect(lines[0].pending).toBe(-200);
  });

  it('lists an ordered elastic nothing has gone out for', async () => {
    const { order, elastic } = await seedOrder(1000);
    const { lines } = (await fetch(order)).body.data;
    expect(lines[0]).toMatchObject({
      elasticName: elastic.name, ordered: 1000, dispatched: 0, pending: 1000,
    });
  });
});

describe('the route itself', () => {
  it('refuses an id that is not one', async () => {
    const res = await request(app)
      .get('/api/v2/order/not-an-id/delivery-challans').set('Cookie', adminCookie());
    expect(res.status).toBe(400);
  });

  it('is a 404 for an order that does not exist', async () => {
    const res = await request(app)
      .get(`/api/v2/order/${new mongoose.Types.ObjectId()}/delivery-challans`)
      .set('Cookie', adminCookie());
    expect(res.status).toBe(404);
  });
});

// ── The optimistic lock the edit form depends on ──────────────────────
//
// /update-order compares the client's `expectedVersion` against the
// document's __v and 409s on a mismatch — but assertVersion no-ops when
// the value is absent, and the order detail projection is hand-built and
// never included __v. So the form sent `undefined` every time and the
// lock was decorative: two people editing the same order both saved, and
// the second silently overwrote the first.

describe('the order detail carries its version', () => {
  it('returns __v, so an edit can be locked against it', async () => {
    const { order } = await seedOrder();
    const res = await request(app)
      .get(`/api/v2/order/get-orderDetail?id=${order._id}`)
      .set('Cookie', adminCookie());

    expect(res.status).toBe(200);
    expect(res.body.data.__v).toBe(order.__v);
    expect(typeof res.body.data.__v).toBe('number');
  });

  it('refuses an edit that was written against an older version', async () => {
    // Open, because /update-order is Open-only — approval is where the
    // raw material is drawn, and changing the order after that would
    // leave stock and requirement disagreeing.
    const { order } = await seedOrder();
    await Order.updateOne({ _id: order._id }, { $set: { status: 'Open' } });
    const stale = order.__v;

    const first = await request(app).post('/api/v2/order/update-order')
      .set('Cookie', adminCookie())
      .send({ orderId: String(order._id), po: 'PO-EDIT-1',
              auditReason: 'first editor', expectedVersion: stale });
    expect(first.status).toBe(200);

    // Second editor loaded the order before that save.
    const second = await request(app).post('/api/v2/order/update-order')
      .set('Cookie', adminCookie())
      .send({ orderId: String(order._id), po: 'PO-EDIT-2',
              auditReason: 'second editor', expectedVersion: stale });

    expect(second.status).toBe(409);
    expect((await Order.findById(order._id).lean()).po).toBe('PO-EDIT-1');
  });
});
