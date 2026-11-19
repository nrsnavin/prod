'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE ORDER LIST, AND AN ORDER SAVED TWICE
//
//  Found reading api/orderIntake.js line by line.
//
//  1. A DELETED ORDER WAS ON THE DEFAULT LIST. "All" matched every
//     status, and Deleted is one of them. The web's list opens on "All"
//     and does not know that status: a deleted order sat among the live
//     ones with a blank status chip, and the global search found it.
//     "All" is now every order that has not been deleted; asked for by
//     name (the phone's Deleted tab), deleted orders are still listed.
//
//  2. A STATUS NOBODY KNOWS GAVE AN EMPTY LIST. "open", "Shipped" — any
//     typo read as "there are no such orders". It is a bad request.
//
//  3. EVERY ROW CARRIED ITS WHOLE TRAIL. The list sent each order's
//     fingerprints — every approval, draw and edit — up to 500 orders at
//     a time, to pages that show one line per order.
//
//  4. AN ORDER SENT TWICE WAS TWO ORDERS. A double tap on Save, or a
//     phone retrying on a bad line: nothing stood between the second
//     request and a second order with the same customer, PO, dates and
//     lines. The second is now answered with the order the first made.
//
//  5. A QUANTITY WAS KEPT AS TYPED, to any number of decimals; every
//     figure worked out from it is kept to three.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, admin;
const M = {};
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
const get  = (url) => request(app).get(`/api/v2${url}`).set('Cookie', cookie());
const post = (url, body) => request(app).post(`/api/v2${url}`).set('Cookie', cookie()).send(body);

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  for (const n of ['User', 'Order', 'Customer', 'Elastic']) M[n] = require(`../../models/${n}.js`);
  admin = await M.User.create({ name: 'Owner', email: 'order-intake@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
});

let seq = 0;
async function masters() {
  seq += 1;
  const elastic = await M.Elastic.create({ name: `20mm ${seq}`, weaveType: '8', spandexEnds: 40, yarnEnds: 120, pick: 12, noOfHook: 8, weight: 2.4 });
  const other = await M.Elastic.create({ name: `25mm ${seq}`, weaveType: '8', spandexEnds: 40, yarnEnds: 120, pick: 12, noOfHook: 8, weight: 2.4 });
  const customer = await M.Customer.create({ name: `Acme ${seq}`, contactName: 'R', phoneNumber: '9000000002' });
  return { elastic, other, customer };
}
const seedOrder = (m, status, over = {}) => M.Order.create({
  customer: m.customer._id, status, po: `PO-${status}`, date: new Date('2026-11-01'), supplyDate: new Date('2026-11-25'),
  elasticOrdered: [{ elastic: m.elastic._id, quantity: 1000, rate: 12 }],
  producedElastic: [{ elastic: m.elastic._id, quantity: 250 }],
  fingerprints: [{ code: 'ORDER_CREATED', label: 'Order Created', hash: 'h', shortId: 's', at: new Date(), actor: 'system', meta: {} }],
  ...over,
});
const body = (m, over = {}) => ({
  po: 'ACME-17', customer: String(m.customer._id), date: '2026-11-19', supplyDate: '2026-12-05',
  elasticOrdered: [{ elastic: String(m.elastic._id), quantity: 1000 }, { elastic: String(m.other._id), quantity: 500 }],
  ...over,
});

// ══════════════════════════════════════════════════════════════════
describe('the order list', () => {
  it('"all" is every order that has not been deleted', async () => {
    const m = await masters();
    for (const status of ['Open', 'Approved', 'InProgress', 'Completed', 'Cancelled', 'Deleted']) await seedOrder(m, status);

    for (const asked of ['All', 'all']) {
      const res = await get(`/order/list?status=${asked}`);
      expect(res.status).toBe(200);
      // Before: six — the deleted order among them.
      expect(res.body.total).toBe(5);
      expect(res.body.orders.map((o) => o.status).sort()).toEqual(['Approved', 'Cancelled', 'Completed', 'InProgress', 'Open']);
    }
  });

  it('deleted orders are listed when asked for by name', async () => {
    const m = await masters();
    await seedOrder(m, 'Open');
    await seedOrder(m, 'Deleted');
    const res = await get('/order/list?status=Deleted');
    expect(res.body.orders.map((o) => o.status)).toEqual(['Deleted']);
  });

  it('the search does not find a deleted order either', async () => {
    const m = await masters();
    const gone = await seedOrder(m, 'Deleted', { po: 'GONE-1' });
    const live = await seedOrder(m, 'Open', { po: 'LIVE-1' });
    expect((await get(`/order/list?status=all&search=${gone.orderNo}`)).body.orders).toEqual([]);
    expect((await get('/order/list?status=all&search=GONE')).body.orders).toEqual([]);
    expect((await get(`/order/list?status=all&search=${live.orderNo}`)).body.orders).toHaveLength(1);
  });

  it('a status nobody knows is a bad request, not an empty list', async () => {
    const m = await masters();
    await seedOrder(m, 'Open');
    for (const asked of ['open', 'Shipped', 'Pending']) {
      const res = await get(`/order/list?status=${asked}`);
      // Before: 200 with no orders.
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/Open, Approved, InProgress, Completed, Cancelled/);
    }
    expect((await get('/order/list')).status).toBe(400);
  });

  it('sends what the list shows, without each order\'s whole trail', async () => {
    const m = await masters();
    await seedOrder(m, 'Approved', { approvalVia: 'whatsapp' });
    const [row] = (await get('/order/list?status=Approved')).body.orders;
    // Before: every fingerprint of every order on the page.
    expect(row.fingerprints).toBeUndefined();
    expect(row).toMatchObject({
      status: 'Approved', po: 'PO-Approved', approvalVia: 'whatsapp',
      customer: { name: m.customer.name },
      elasticOrdered: [{ quantity: 1000, rate: 12 }],
      producedElastic: [{ quantity: 250 }],
    });
    expect(row.orderNo).toBeGreaterThan(0);
    expect(row.supplyDate).toBeTruthy();
  });
});

// ══════════════════════════════════════════════════════════════════
describe('an order saved twice', () => {
  it('is one order: the second answer is the order the first made', async () => {
    const m = await masters();
    const first = await post('/order/create-order', body(m));
    expect(first.status).toBe(201);

    const second = await post('/order/create-order', body(m));
    // Before: 201 and a second order.
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ success: true, duplicate: true, orderId: first.body.orderId });
    expect(second.body.message).toMatch(/already saved as order #\d+/i);
    expect(await M.Order.countDocuments({})).toBe(1);
  });

  it('two at the same moment are one order', async () => {
    const m = await masters();
    const [a, b] = await Promise.all([post('/order/create-order', body(m)), post('/order/create-order', body(m))]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(a.body.orderId).toBe(b.body.orderId);
    expect(await M.Order.countDocuments({})).toBe(1);
  });

  it('the lines in another order are the same lines', async () => {
    const m = await masters();
    await post('/order/create-order', body(m));
    const flipped = body(m);
    flipped.elasticOrdered.reverse();
    expect((await post('/order/create-order', flipped)).status).toBe(200);
    expect(await M.Order.countDocuments({})).toBe(1);
  });

  it.each([
    ['another quantity', (b) => { b.elasticOrdered[0].quantity = 1200; }],
    ['another PO', (b) => { b.po = 'ACME-18'; }],
    ['another promised date', (b) => { b.supplyDate = '2026-12-20'; }],
    ['one line fewer', (b) => { b.elasticOrdered.pop(); }],
  ])('%s is another order', async (_what, change) => {
    const m = await masters();
    expect((await post('/order/create-order', body(m))).status).toBe(201);
    const next = body(m);
    change(next);
    expect((await post('/order/create-order', next)).status).toBe(201);
    expect(await M.Order.countDocuments({})).toBe(2);
  });

  it('the same order for another customer is another order', async () => {
    const m = await masters();
    const elsewhere = await M.Customer.create({ name: 'Beta Garments', contactName: 'S', phoneNumber: '9000000003' });
    expect((await post('/order/create-order', body(m))).status).toBe(201);
    expect((await post('/order/create-order', body(m, { customer: String(elsewhere._id) }))).status).toBe(201);
  });

  it('an order entered again later is not mistaken for a resend', async () => {
    const m = await masters();
    const first = await post('/order/create-order', body(m));
    // Ten minutes ago: a repeat order on the same PO, not a double tap.
    await M.Order.collection.updateOne({ _id: new mongoose.Types.ObjectId(first.body.orderId) }, { $set: { createdAt: new Date(Date.now() - 10 * 60_000) } });
    expect((await post('/order/create-order', body(m))).status).toBe(201);
    expect(await M.Order.countDocuments({})).toBe(2);
  });

  it('nor is one entered again after the first was cancelled', async () => {
    const m = await masters();
    const first = await post('/order/create-order', body(m));
    await M.Order.updateOne({ _id: first.body.orderId }, { status: 'Cancelled' });
    expect((await post('/order/create-order', body(m))).status).toBe(201);
  });
});

describe('an order\'s quantities', () => {
  it('are kept to three places', async () => {
    const m = await masters();
    const res = await post('/order/create-order', body(m, {
      elasticOrdered: [{ elastic: String(m.elastic._id), quantity: 1000.33333333 }, { elastic: String(m.other._id), quantity: '250.5' }],
    }));
    expect(res.status).toBe(201);
    const order = await M.Order.findById(res.body.orderId).lean();
    // Before: 1000.33333333, on the order and on everything worked out from it.
    expect(order.elasticOrdered.map((l) => l.quantity)).toEqual([1000.333, 250.5]);
    expect(order.pendingElastic.map((l) => l.quantity)).toEqual([1000.333, 250.5]);
  });

  it('a quantity that rounds to nothing is refused', async () => {
    const m = await masters();
    const res = await post('/order/create-order', body(m, { elasticOrdered: [{ elastic: String(m.elastic._id), quantity: 0.0004 }] }));
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Line 1: quantity must be more than zero/);
  });

  it('the trail counts the lines that were saved', async () => {
    const m = await masters();
    const res = await post('/order/create-order', body(m));
    const order = await M.Order.findById(res.body.orderId).lean();
    expect(order.fingerprints.find((f) => f.code === 'ORDER_CREATED').meta).toMatchObject({ po: 'ACME-17', totalElastics: 2 });
  });
});
