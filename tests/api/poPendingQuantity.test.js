'use strict';
// ══════════════════════════════════════════════════════════════════
//  WHAT IS STILL PENDING ON A PURCHASE ORDER
//
//  Reported as: record an inward against a PO and the pending quantity
//  on the goods-received screen still reads as the whole PO quantity.
//
//  The cause is a name. /get-po-detail hands back the raw document,
//  whose line items carry `receivedQuantity`. The screen reads
//  `received` — the name used by a DIFFERENT endpoint, the pending-PO
//  ageing report, which maps it explicitly. `received` is therefore
//  always undefined, `?? 0` turns it into nothing received, and the
//  pending column prints the full order quantity forever.
//
//  It is the worst shape of bug: no error, no blank, just a confident
//  wrong number that says "nothing has arrived" about goods sitting in
//  the store.
//
//  The fix is not to rename one side to match the other but to have the
//  server state the pending quantity itself. Two clients subtracting
//  the same two fields under two different names is how this happened.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
// /inward-stock records the receipt in a transaction.
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, RawMaterial, Supplier, PurchaseOrder, User, admin;

const adminCookie = () => [
  `token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`,
];

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  RawMaterial   = require('../../models/RawMaterial');
  Supplier      = require('../../models/Supplier');
  PurchaseOrder = require('../../models/PurchaseOrder');
  User          = require('../../models/User');
  admin = await User.create({
    name: 'Owner', email: 'o@t.co', password: 'pass1234', role: 'admin', department: 'admin',
  });
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
});

async function seedPo({ ordered = 100 } = {}) {
  const supplier = await Supplier.create({ name: 'Kumar Yarns', phoneNumber: '9000000001' });
  const yarn = await RawMaterial.create({
    name: 'Nylon 70D', category: 'Yarn', stock: 0, price: 300, supplier: supplier._id,
  });
  const po = await PurchaseOrder.create({
    poNo: Math.floor(Math.random() * 100000),
    supplier: supplier._id, status: 'Open',
    items: [{ rawMaterial: yarn._id, quantity: ordered, price: 300, receivedQuantity: 0 }],
  });
  return { yarn, po, supplier };
}

/**
 * Record a receipt, and insist it worked.
 *
 * Asserting the status here rather than at the call sites is not
 * ceremony: without it, a receipt that fails leaves the test to fall
 * over on a pending quantity further down, reporting "expected 60, got
 * 100" — which describes the symptom and hides the reason. The receipt
 * is the precondition of every test in this file, so it is checked
 * where it happens and the server's own message comes out.
 */
async function receive(po, yarn, quantity) {
  const res = await request(app).post('/api/v2/supplier/inward-stock')
    .set('Cookie', adminCookie())
    .send({ poId: String(po._id), items: [{ rawMaterial: String(yarn._id), quantity }] });
  if (res.status >= 400) {
    throw new Error(
      `inward of ${quantity} failed: ${res.status} ${JSON.stringify(res.body)}`
    );
  }
  return res;
}

const detail = (po) =>
  request(app).get('/api/v2/supplier/get-po-detail')
    .query({ id: String(po._id) })
    .set('Cookie', adminCookie());

const line = (body) => body.po.items[0];

describe('the pending quantity on a purchase order', () => {
  it('drops by what was received', async () => {
    const { yarn, po } = await seedPo({ ordered: 100 });
    await receive(po, yarn, 40);

    const { body } = await detail(po);
    expect(line(body).pending).toBe(60);
  });

  it('states the received quantity under the name the screen reads', async () => {
    // The whole bug in one assertion. The document field is
    // receivedQuantity; the screen asks for `received`.
    const { yarn, po } = await seedPo({ ordered: 100 });
    await receive(po, yarn, 40);

    const { body } = await detail(po);
    expect(line(body).received).toBe(40);
    // And the original name still works, so nothing that reads the
    // document field breaks.
    expect(line(body).receivedQuantity).toBe(40);
  });

  it('is the whole quantity before anything arrives', async () => {
    const { po } = await seedPo({ ordered: 100 });
    const { body } = await detail(po);
    expect(line(body)).toMatchObject({ received: 0, pending: 100 });
  });

  it('reaches nothing pending when the order is complete', async () => {
    const { yarn, po } = await seedPo({ ordered: 100 });
    await receive(po, yarn, 100);

    const { body } = await detail(po);
    expect(line(body).pending).toBe(0);
  });

  it('accumulates across part deliveries', async () => {
    const { yarn, po } = await seedPo({ ordered: 100 });
    await receive(po, yarn, 30);
    await receive(po, yarn, 25);

    const { body } = await detail(po);
    expect(line(body)).toMatchObject({ received: 55, pending: 45 });
  });

  it('never reports a negative pending on an over-receipt', async () => {
    // Delivering more than ordered is allowed within tolerance. "-8
    // pending" is not a quantity anyone can act on; nothing pending is.
    const { yarn, po } = await seedPo({ ordered: 100 });
    const res = await receive(po, yarn, 108);
    expect(res.status).toBeLessThan(400);

    const { body } = await detail(po);
    expect(line(body).received).toBe(108);
    expect(line(body).pending).toBe(0);
  });

  it('leaves the rest of the line alone', async () => {
    // The mapping must not drop fields the screen also needs.
    const { yarn, po } = await seedPo({ ordered: 100 });
    const { body } = await detail(po);
    const it = line(body);
    expect(it.quantity).toBe(100);
    expect(it.price).toBe(300);
    // rawMaterial is still populated, not flattened to an id.
    expect(it.rawMaterial).toMatchObject({ name: 'Nylon 70D' });
  });
});
