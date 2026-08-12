'use strict';
// ══════════════════════════════════════════════════════════════════
//  EDITING THE SAME CHALLAN TWICE
//
//  The edit works by reversing every line and re-applying the new one.
//  The reversal finds the challan's DC_OUT movements and refunds their
//  total.
//
//  After one edit the ledger holds TWO DC_OUT rows for the same line:
//  the original, and the one the edit re-applied. The first has already
//  been cancelled by a DC_CANCEL_RETURN sitting between them.
//
//  So the question these ask is whether the second edit refunds only
//  what is currently out, or everything the line has ever taken.
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
    name: 'Owner', email: 'dc2@t.co', password: 'pass1234',
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

async function seed(stock = 1000, ordered = 1000) {
  const customer = await Customer.create({
    name: `Acme ${++seq}`, contactName: 'R', phoneNumber: '9000000001',
  });
  const elastic = await Elastic.create({
    name: `20mm ${Math.random().toString(36).slice(2, 8)}`, weaveType: '8',
    spandexEnds: 40, yarnEnds: 120, pick: 12, noOfHook: 8, weight: 2.4, stock,
  });
  const order = await Order.create({
    customer: customer._id, po: `PO-${seq}`, date: new Date(), supplyDate: new Date(),
    elasticOrdered: [{ elastic: elastic._id, quantity: ordered }],
    status: 'Approved',
  });
  return { order, elastic };
}

const createDc = (order, elastic, quantity) =>
  request(app).post('/api/v2/dc/create').set('Cookie', adminCookie()).send({
    type: 'elastic',
    orderId: String(order._id),
    orderNo: order.orderNo,
    customerName: 'Acme',
    items: [{ elastic: String(elastic._id), elasticName: '20mm', quantity, rate: 10 }],
  });

const editDc = (dcId, elastic, quantity) =>
  request(app).put('/api/v2/dc/update').set('Cookie', adminCookie()).send({
    id: dcId,
    auditReason: 'Customer revised the despatch',
    items: [{ elastic: String(elastic._id), elasticName: '20mm', quantity, rate: 10 }],
  });

const stockOf = async (elastic) =>
  (await Elastic.findById(elastic._id).lean()).stock;

// ══════════════════════════════════════════════════════════════════
describe('a challan edited more than once', () => {
  it('leaves stock reflecting the LATEST figure, not an accumulated refund', async () => {
    const { order, elastic } = await seed(1000);

    const created = await createDc(order, elastic, 500);
    expect(created.status).toBe(201);
    expect(await stockOf(elastic)).toBe(500);

    const first = await editDc(created.body.dc._id, elastic, 300);
    expect(first.status).toBe(200);
    expect(await stockOf(elastic)).toBe(700);

    // The one that matters: 200 is out, so 800 is on the shelf.
    // If the reversal refunds every DC_OUT the challan has ever
    // written, this reads 1300 — stock invented out of an edit.
    const second = await editDc(created.body.dc._id, elastic, 200);
    expect(second.status).toBe(200);
    expect(await stockOf(elastic)).toBe(800);
  });

  it('survives a third edit, and an edit back upwards', async () => {
    const { order, elastic } = await seed(1000);
    const created = await createDc(order, elastic, 500);

    await editDc(created.body.dc._id, elastic, 300);
    await editDc(created.body.dc._id, elastic, 200);
    await editDc(created.body.dc._id, elastic, 450);

    expect(await stockOf(elastic)).toBe(550);
  });

  it('keeps the ledger summing to the stock on hand', async () => {
    const { order, elastic } = await seed(1000);
    const created = await createDc(order, elastic, 500);
    await editDc(created.body.dc._id, elastic, 300);
    await editDc(created.body.dc._id, elastic, 200);

    const rows = await StockMovement.find({ elastic: elastic._id }).lean();
    const net = rows.reduce((s, m) => s + Number(m.applied || 0), 0);
    // Every movement written, added up, must equal what left the
    // opening balance. A ledger that disagrees with the shelf is worse
    // than no ledger.
    expect(1000 + net).toBe(await stockOf(elastic));
  });

  it('cancels to the full opening stock, however many edits came first', async () => {
    const { order, elastic } = await seed(1000);
    const created = await createDc(order, elastic, 500);
    await editDc(created.body.dc._id, elastic, 300);
    await editDc(created.body.dc._id, elastic, 200);

    const res = await request(app).patch('/api/v2/dc/update-status')
      .set('Cookie', adminCookie())
      .send({ id: created.body.dc._id, status: 'cancelled' });
    expect(res.status).toBe(200);

    expect(await stockOf(elastic)).toBe(1000);
  });

  it('restores the order reservation to what it was, not more', async () => {
    const { order, elastic } = await seed(1000);
    // Both halves of the promise, because they are one fact held in two
    // places: the order's own entry and the elastic's reservedStock.
    // Setting only the order's leaves applyMovement with no promise to
    // release, so it clamps the release to zero and the ledger records
    // a reservation that was never held.
    await Order.updateOne(
      { _id: order._id },
      { $set: { reservations: [{ elastic: elastic._id, quantity: 1000 }] } }
    );
    await Elastic.updateOne({ _id: elastic._id }, { $set: { reservedStock: 1000 } });

    const created = await createDc(order, elastic, 500);
    await editDc(created.body.dc._id, elastic, 300);
    await editDc(created.body.dc._id, elastic, 200);

    const after = await Order.findById(order._id).lean();
    const held = (after.reservations || [])
      .filter((r) => String(r.elastic) === String(elastic._id))
      .reduce((s, r) => s + r.quantity, 0);
    // 200 despatched against a 1000 promise leaves 800 owed.
    expect(held).toBe(800);
  });
});
