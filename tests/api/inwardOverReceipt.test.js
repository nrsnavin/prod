'use strict';
// ══════════════════════════════════════════════════════════════════
//  OVER-RECEIPT ON A PURCHASE ORDER
//
//  Suppliers routinely send a little more than ordered — a full bag
//  rather than a part one. Refusing that outright only pushed the
//  difference into a stock adjustment, which credits the same yarn
//  while losing the link to the PO that brought it in.
//
//  So a delivery may now exceed the ordered quantity: up to 10% over
//  with no explanation, past that only with a reason, which is kept on
//  the inward row and shown back on the PO.
//
//  The tolerance is measured against what was ORDERED, not what is
//  still pending — see the route for why that distinction matters.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, RawMaterial, Supplier, PurchaseOrder, MaterialInward, User, admin;

const adminCookie = () => [
  `token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`,
];

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  RawMaterial = require('../../models/RawMaterial');
  Supplier = require('../../models/Supplier');
  PurchaseOrder = require('../../models/PurchaseOrder');
  MaterialInward = require('../../models/MaterialInward');
  User = require('../../models/User');
  admin = await User.create({
    name: 'Owner', email: 'o@t.co', password: 'pass1234', role: 'admin', department: 'admin',
  });
}, 90_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
});

/** A PO for 100 of one material, optionally part-received already. */
async function makePo({ ordered = 100, received = 0 } = {}) {
  const material = await RawMaterial.create({
    name: 'Nylon 70D', category: 'Yarn', stock: 0, price: 320,
  });
  const supplier = await Supplier.create({ name: 'Kumar Dyeing', phoneNumber: '9000000000' });
  const po = await PurchaseOrder.create({
    supplier: supplier._id,
    items: [{ rawMaterial: material._id, quantity: ordered, price: 320, receivedQuantity: received }],
  });
  return { material, supplier, po };
}

const receive = (po, material, body) =>
  request(app).post('/api/v2/supplier/inward-stock')
    .set('Cookie', adminCookie())
    .send({
      poId: String(po._id),
      items: [{ rawMaterial: String(material._id), ...body }],
    });

describe('receiving up to the ordered quantity', () => {
  it('records no excess', async () => {
    const { material, po } = await makePo();
    const res = await receive(po, material, { quantity: 100 });

    expect(res.status).toBe(201);
    const inward = await MaterialInward.findOne({ purchaseOrder: po._id });
    expect(inward.excessQuantity).toBe(0);
    expect(inward.excessReason).toBe('');
  });
});

describe('inside the 10% tolerance', () => {
  it('takes the excess without asking why', async () => {
    // A supplier rounding 100 up to a 108 kg bag is not an incident.
    const { material, po } = await makePo();
    const res = await receive(po, material, { quantity: 108 });

    expect(res.status).toBe(201);
    const inward = await MaterialInward.findOne({ purchaseOrder: po._id });
    expect(inward.excessQuantity).toBe(8);
    expect(inward.excessReason).toBe('');
  });

  it('credits the full delivered quantity to stock, not just the ordered part', async () => {
    const { material, po } = await makePo();
    await receive(po, material, { quantity: 108 });

    const after = await RawMaterial.findById(material._id);
    expect(after.stock).toBe(108);
  });

  it('takes exactly 10% over', async () => {
    // The boundary belongs inside the tolerance, not outside it.
    const { material, po } = await makePo();
    const res = await receive(po, material, { quantity: 110 });

    expect(res.status).toBe(201);
    expect((await MaterialInward.findOne({ purchaseOrder: po._id })).excessQuantity).toBe(10);
  });

  it('keeps a reason that was given anyway', async () => {
    const { material, po } = await makePo();
    await receive(po, material, { quantity: 105, excessReason: 'Supplier sent a full bag' });

    const inward = await MaterialInward.findOne({ purchaseOrder: po._id });
    expect(inward.excessReason).toBe('Supplier sent a full bag');
  });
});

describe('past the 10% tolerance', () => {
  it('is refused without a reason', async () => {
    const { material, po } = await makePo();
    const res = await receive(po, material, { quantity: 130 });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/past the 10% tolerance/i);
    // Nothing may have moved — this is the all-or-nothing validation pass.
    expect(await MaterialInward.countDocuments({})).toBe(0);
    expect((await RawMaterial.findById(material._id)).stock).toBe(0);
  });

  it('is refused when the reason is too thin to be one', async () => {
    const { material, po } = await makePo();
    const res = await receive(po, material, { quantity: 130, excessReason: 'ok' });
    expect(res.status).toBe(400);
  });

  it('goes through with a reason, and keeps it', async () => {
    const { material, po } = await makePo();
    const res = await receive(po, material, {
      quantity: 130,
      excessReason: 'Short-shipped the last PO, supplier made it up here',
    });

    expect(res.status).toBe(201);
    const inward = await MaterialInward.findOne({ purchaseOrder: po._id });
    expect(inward.excessQuantity).toBe(30);
    expect(inward.excessReason).toMatch(/Short-shipped/);
  });

  it('accepts a reason set on the row rather than the whole submit', async () => {
    const { material, po } = await makePo();
    const res = await receive(po, material, {
      quantity: 130, excessReason: 'Per-line reason for this material',
    });
    expect(res.status).toBe(201);
  });
});

describe('the tolerance is measured against what was ordered', () => {
  it('lets a small top-up through on a nearly complete PO', async () => {
    // 100 ordered, 90 already in, 12 more. That is 20% over the PENDING
    // 10 but only 2% over the order — and the tolerance is about the
    // delivery against the order.
    const { material, po } = await makePo({ ordered: 100, received: 90 });
    const res = await receive(po, material, { quantity: 12 });

    expect(res.status).toBe(201);
    expect((await MaterialInward.findOne({ purchaseOrder: po._id })).excessQuantity).toBe(2);
  });

  it('counts earlier receipts toward the excess', async () => {
    const { material, po } = await makePo({ ordered: 100, received: 100 });
    const res = await receive(po, material, { quantity: 25 });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/125 against 100 ordered/);
  });
});

describe('the over-receipt on the PO', () => {
  it('comes back with the inward history', async () => {
    const { material, po } = await makePo();
    await receive(po, material, {
      quantity: 130, excessReason: 'Supplier made up an earlier shortfall',
    });

    const res = await request(app)
      .get(`/api/v2/supplier/get-inward-history?poId=${po._id}`)
      .set('Cookie', adminCookie());

    expect(res.status).toBe(200);
    expect(res.body.records[0]).toMatchObject({
      excessQuantity: 30,
      excessReason: 'Supplier made up an earlier shortfall',
    });
  });

  it('lands in the PO audit trail too', async () => {
    const { material, po } = await makePo();
    await receive(po, material, { quantity: 130, excessReason: 'Made up an earlier shortfall' });

    const after = await PurchaseOrder.findById(po._id);
    const fp = after.fingerprints[after.fingerprints.length - 1];
    expect(fp.meta.items[0].excess).toBe(30);
    expect(fp.meta.items[0].excessReason).toMatch(/shortfall/);
  });

  it('marks the PO completed once the order is met or exceeded', async () => {
    const { material, po } = await makePo();
    await receive(po, material, { quantity: 108 });
    expect((await PurchaseOrder.findById(po._id)).status).toBe('Completed');
  });
});
