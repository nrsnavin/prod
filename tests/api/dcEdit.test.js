'use strict';
// ══════════════════════════════════════════════════════════════════
//  EDITING A DELIVERY CHALLAN
//
//  A DC takes goods off the shelf and settles part of the order's
//  reservation the moment it is cut. So an edit is not a text change:
//  changing a quantity has to MOVE STOCK, and changing the elastic has
//  to put one product back and take another out.
//
//  It is done by reversing every line and re-applying the new ones,
//  rather than computing a per-line delta. The reversal already exists —
//  it is what cancelling a DC does — and the re-application is the same
//  helper /create uses. A delta calculation would be a third way of
//  doing the same arithmetic, and the first to disagree with the other
//  two would do so silently, in stock.
//
//  What these tests pin down, hardest first:
//
//    • the stock ends where the new quantity says, not the old
//    • the order's reservation follows the edit both ways
//    • a delivered or cancelled challan is refused by name
//    • the ledger explains the move rather than jumping
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app;
let Order, Customer, Elastic, DeliveryChallan, StockMovement, User, admin;

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
  StockMovement   = require('../../models/StockMovement');
  User            = require('../../models/User');
  admin = await User.create({
    name: 'Owner', email: 'dce@t.co', password: 'pass1234',
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

const makeElastic = (stock) =>
  Elastic.create({
    name: `20mm ${Math.random().toString(36).slice(2, 8)}`, weaveType: '8',
    spandexEnds: 40, yarnEnds: 120, pick: 12, noOfHook: 8, weight: 2.4,
    stock, reservedStock: 0,
  });

const makeCustomer = () =>
  Customer.create({ name: `Acme ${++seq}`, contactName: 'R', phoneNumber: '9000000001' });

/** Cut a challan for `quantity` through the real route. */
async function cutDc(elastic, customer, quantity, order) {
  const res = await request(app).post('/api/v2/dc/create')
    .set('Cookie', adminCookie())
    .send({
      type: 'elastic',
      customerName: customer.name,
      ...(order ? { orderId: String(order._id), orderNo: order.orderNo } : {}),
      items: [{ elastic: String(elastic._id), quantity, rate: 12 }],
    });
  if (res.status >= 400) throw new Error(`create failed: ${JSON.stringify(res.body)}`);
  return res.body.dc;
}

const editDc = (dc, body) =>
  request(app).put('/api/v2/dc/update')
    .set('Cookie', adminCookie())
    .send({ id: String(dc._id), auditReason: 'miscount on the loading bay', ...body });

const stockOf = async (e) => (await Elastic.findById(e._id).lean()).stock;
const reservedOf = async (e) => (await Elastic.findById(e._id).lean()).reservedStock;

/** An approved order reserving `qty`, so the promise side is in play. */
async function approvedOrder(elastic, customer, qty) {
  const order = await Order.create({
    customer: customer._id, status: 'Open', po: `PO-${++seq}`,
    date: new Date(), supplyDate: new Date(),
    elasticOrdered: [{ elastic: elastic._id, quantity: qty }],
    rawMaterialRequired: [],
  });
  const res = await request(app).post('/api/v2/order/approve')
    .set('Cookie', adminCookie()).send({ orderId: String(order._id) });
  if (res.status >= 400) throw new Error(`approve failed: ${JSON.stringify(res.body)}`);
  return Order.findById(order._id);
}

// ══════════════════════════════════════════════════════════════════
//  THE STOCK
// ══════════════════════════════════════════════════════════════════
describe('editing the quantity on a challan', () => {
  it('moves the stock to where the new figure says', async () => {
    const elastic  = await makeElastic(1000);
    const customer = await makeCustomer();
    const dc = await cutDc(elastic, customer, 400);
    expect(await stockOf(elastic)).toBe(600);

    const res = await editDc(dc, {
      items: [{ elastic: String(elastic._id), quantity: 250, rate: 12 }],
    });

    expect(res.status).toBe(200);
    // 1000 − 250, not 600 − 250 and not 600.
    expect(await stockOf(elastic)).toBe(750);
  });

  it('takes more off when the quantity goes up', async () => {
    const elastic  = await makeElastic(1000);
    const customer = await makeCustomer();
    const dc = await cutDc(elastic, customer, 400);

    await editDc(dc, {
      items: [{ elastic: String(elastic._id), quantity: 700, rate: 12 }],
    });

    expect(await stockOf(elastic)).toBe(300);
  });

  it('puts one product back and takes the other out', async () => {
    const was  = await makeElastic(1000);
    const now  = await makeElastic(1000);
    const customer = await makeCustomer();
    const dc = await cutDc(was, customer, 400);

    await editDc(dc, {
      items: [{ elastic: String(now._id), quantity: 400, rate: 12 }],
    });

    expect(await stockOf(was)).toBe(1000);
    expect(await stockOf(now)).toBe(600);
  });

  it('restates the totals on the challan', async () => {
    const elastic  = await makeElastic(1000);
    const customer = await makeCustomer();
    const dc = await cutDc(elastic, customer, 400);

    await editDc(dc, {
      items: [{ elastic: String(elastic._id), quantity: 250, rate: 20 }],
    });

    const after = await DeliveryChallan.findById(dc._id).lean();
    expect(after.totalQuantity).toBe(250);
    expect(after.totalAmount).toBe(5000);
  });

  it('explains the move on the ledger rather than jumping', async () => {
    // A stock figure that changes with nothing to account for it is the
    // thing the ledger exists to prevent.
    const elastic  = await makeElastic(1000);
    const customer = await makeCustomer();
    const dc = await cutDc(elastic, customer, 400);

    await editDc(dc, {
      items: [{ elastic: String(elastic._id), quantity: 250, rate: 12 }],
    });

    const rows = await StockMovement.find({ elastic: elastic._id })
      .sort({ date: 1, _id: 1 }).lean();
    // Out 400, back 400, out 250 — and the running balance lands on 750.
    expect(rows.map((r) => r.type)).toEqual(
      expect.arrayContaining(['DC_OUT', 'DC_CANCEL_RETURN', 'DC_OUT'])
    );
    expect(rows.at(-1).balance).toBe(750);
    expect(rows.reduce((s, r) => s + r.applied, 0)).toBe(-250);
  });

  it('records the change with its reason', async () => {
    const elastic  = await makeElastic(1000);
    const customer = await makeCustomer();
    const dc = await cutDc(elastic, customer, 400);

    await editDc(dc, {
      items: [{ elastic: String(elastic._id), quantity: 250, rate: 12 }],
    });

    const after = await DeliveryChallan.findById(dc._id).lean();
    const fp = after.fingerprints.at(-1);
    expect(fp.meta.auditReason).toMatch(/miscount/);
    expect(fp.meta.before.totalQuantity).toBe(400);
    expect(fp.meta.after.totalQuantity).toBe(250);
  });
});

// ══════════════════════════════════════════════════════════════════
//  THE PROMISE SIDE
// ══════════════════════════════════════════════════════════════════
describe('a challan against a reserved order', () => {
  it('gives the reservation back when the quantity drops', async () => {
    const elastic  = await makeElastic(1000);
    const customer = await makeCustomer();
    const order = await approvedOrder(elastic, customer, 500);
    expect(await reservedOf(elastic)).toBe(500);

    const dc = await cutDc(elastic, customer, 400, order);
    expect(await reservedOf(elastic)).toBe(100);

    await editDc(dc, {
      items: [{ elastic: String(elastic._id), quantity: 200, rate: 12 }],
    });

    // 500 promised, 200 shipped against it — 300 still owed.
    expect(await reservedOf(elastic)).toBe(300);
    expect(await stockOf(elastic)).toBe(800);
  });

  it('consumes more of it when the quantity rises', async () => {
    const elastic  = await makeElastic(1000);
    const customer = await makeCustomer();
    const order = await approvedOrder(elastic, customer, 500);
    const dc = await cutDc(elastic, customer, 200, order);
    expect(await reservedOf(elastic)).toBe(300);

    await editDc(dc, {
      items: [{ elastic: String(elastic._id), quantity: 450, rate: 12 }],
    });

    expect(await reservedOf(elastic)).toBe(50);
    expect(await stockOf(elastic)).toBe(550);
  });

  it('keeps the order own reservation entry in step', async () => {
    const elastic  = await makeElastic(1000);
    const customer = await makeCustomer();
    const order = await approvedOrder(elastic, customer, 500);
    const dc = await cutDc(elastic, customer, 400, order);

    await editDc(dc, {
      items: [{ elastic: String(elastic._id), quantity: 200, rate: 12 }],
    });

    const after = await Order.findById(order._id).lean();
    const entry = (after.reservations || [])
      .find((r) => String(r.elastic) === String(elastic._id));
    expect(entry?.quantity ?? 0).toBe(300);
  });
});

// ══════════════════════════════════════════════════════════════════
//  WHAT CANNOT BE EDITED
// ══════════════════════════════════════════════════════════════════
describe('a challan that is closed', () => {
  const setStatus = (dc, status) =>
    DeliveryChallan.updateOne({ _id: dc._id }, { $set: { status } });

  it('refuses a delivered one, and says why', async () => {
    const elastic  = await makeElastic(1000);
    const customer = await makeCustomer();
    const dc = await cutDc(elastic, customer, 400);
    await setStatus(dc, 'delivered');

    const res = await editDc(dc, {
      items: [{ elastic: String(elastic._id), quantity: 250, rate: 12 }],
    });

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/their receipt/i);
    expect(await stockOf(elastic)).toBe(600);
  });

  it('refuses a cancelled one — its stock has already gone back', async () => {
    const elastic  = await makeElastic(1000);
    const customer = await makeCustomer();
    const dc = await cutDc(elastic, customer, 400);
    await setStatus(dc, 'cancelled');

    const res = await editDc(dc, {
      items: [{ elastic: String(elastic._id), quantity: 250, rate: 12 }],
    });

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/already gone back/i);
  });

  it('allows a dispatched one — it is still ours to correct', async () => {
    const elastic  = await makeElastic(1000);
    const customer = await makeCustomer();
    const dc = await cutDc(elastic, customer, 400);
    await setStatus(dc, 'dispatched');

    const res = await editDc(dc, {
      items: [{ elastic: String(elastic._id), quantity: 250, rate: 12 }],
    });
    expect(res.status).toBe(200);
    expect(await stockOf(elastic)).toBe(750);
  });
});

// ══════════════════════════════════════════════════════════════════
//  THE GUARDS
// ══════════════════════════════════════════════════════════════════
describe('the edit route', () => {
  it('wants a reason', async () => {
    const elastic  = await makeElastic(1000);
    const customer = await makeCustomer();
    const dc = await cutDc(elastic, customer, 400);

    const res = await request(app).put('/api/v2/dc/update')
      .set('Cookie', adminCookie())
      .send({ id: String(dc._id), items: [{ elastic: String(elastic._id), quantity: 250 }] });

    expect(res.status).toBe(400);
    expect(await stockOf(elastic)).toBe(600);
  });

  it('refuses an empty line list rather than emptying the challan', async () => {
    const elastic  = await makeElastic(1000);
    const customer = await makeCustomer();
    const dc = await cutDc(elastic, customer, 400);

    const res = await editDc(dc, { items: [] });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/cancel it instead/i);
  });

  it('refuses a quantity of zero or less', async () => {
    const elastic  = await makeElastic(1000);
    const customer = await makeCustomer();
    const dc = await cutDc(elastic, customer, 400);

    const res = await editDc(dc, {
      items: [{ elastic: String(elastic._id), quantity: 0, rate: 12 }],
    });
    expect(res.status).toBe(400);
    expect(await stockOf(elastic)).toBe(600);
  });

  it('edits the despatch detail without touching stock', async () => {
    const elastic  = await makeElastic(1000);
    const customer = await makeCustomer();
    const dc = await cutDc(elastic, customer, 400);

    const res = await editDc(dc, {
      vehicleNo: 'TN-39-AB-1234', transporter: 'VRL', lrNumber: '77',
    });

    expect(res.status).toBe(200);
    const after = await DeliveryChallan.findById(dc._id).lean();
    expect(after).toMatchObject({
      vehicleNo: 'TN-39-AB-1234', transporter: 'VRL', lrNumber: '77',
    });
    expect(await stockOf(elastic)).toBe(600);
  });

  it('is a 404 for a challan that does not exist', async () => {
    const res = await request(app).put('/api/v2/dc/update')
      .set('Cookie', adminCookie())
      .send({ id: String(new mongoose.Types.ObjectId()), auditReason: 'nothing there' });
    expect(res.status).toBe(404);
  });
});
