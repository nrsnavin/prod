'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE RAW MATERIAL STOCK LEDGER
//
//  The ledger on the material detail page was misreading itself:
//
//    • an order approval debits stock but was recorded with a POSITIVE
//      quantity, so it rendered as a receipt — "+40" beside a balance
//      that had just dropped by 40
//    • a PO receipt recorded no balance at all, leaving the Balance
//      column empty on every goods-in row
//    • that same receipt stamped a PurchaseOrder id into a field
//      declared ref:"Order", so it never resolved to anything
//
//  The writers are fixed. Rows already in the database are corrected on
//  read, since a movement's direction is knowable from its type.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

const { normaliseMovements } = require('../../utils/stockLedger');

let mongo, app, RawMaterial, Supplier, PurchaseOrder, User, admin;

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

const detail = (id) =>
  request(app).get(`/api/v2/materials/get-raw-material-detail?id=${id}`).set('Cookie', adminCookie());

// ══════════════════════════════════════════════════════════════════
//  normaliseMovements — the read-time repair
// ══════════════════════════════════════════════════════════════════
describe('normalising a movement list', () => {
  it('signs an order approval negative however it was stored', () => {
    // The historic rows are positive; the direction comes from the type.
    const [row] = normaliseMovements(
      [{ type: 'ORDER_APPROVAL', quantity: 40, balance: 60 }],
      60
    );
    expect(row.quantity).toBe(-40);
  });

  it('leaves an already-negative approval alone rather than flipping it back', () => {
    const [row] = normaliseMovements(
      [{ type: 'ORDER_APPROVAL', quantity: -40, balance: 60 }],
      60
    );
    expect(row.quantity).toBe(-40);
  });

  it('signs a receipt positive', () => {
    const [row] = normaliseMovements([{ type: 'PO_INWARD', quantity: 100, balance: 100 }], 100);
    expect(row.quantity).toBe(100);
  });

  it('trusts the stored sign of a stock adjustment, both ways', () => {
    // It is the one type that is genuinely signed either way.
    const rows = normaliseMovements(
      [
        { type: 'STOCK_ADJUST', quantity: -12, balance: 88 },
        { type: 'STOCK_ADJUST', quantity: 30, balance: 100 },
      ],
      88
    );
    expect(rows.map((r) => r.quantity)).toEqual([-12, 30]);
  });

  it('fills a missing balance by walking back from current stock', () => {
    // Newest first. Current stock is 130, so the newest row closed at
    // 130, and the one before it closed at 130 − 30 = 100.
    const rows = normaliseMovements(
      [
        { type: 'PO_INWARD', quantity: 30 },
        { type: 'PO_INWARD', quantity: 100 },
      ],
      130
    );
    expect(rows.map((r) => r.balance)).toEqual([130, 100]);
  });

  it('walks back correctly across a deduction', () => {
    const rows = normaliseMovements(
      [
        { type: 'ORDER_APPROVAL', quantity: 40 },
        { type: 'PO_INWARD', quantity: 100 },
      ],
      60
    );
    // −40 closing at 60 means it opened at 100, which is where the
    // receipt above it closed.
    expect(rows.map((r) => r.quantity)).toEqual([-40, 100]);
    expect(rows.map((r) => r.balance)).toEqual([60, 100]);
  });

  it('keeps a balance that was actually recorded at the time', () => {
    // A fact from then beats one reconstructed now.
    const rows = normaliseMovements(
      [{ type: 'PO_INWARD', quantity: 30, balance: 999 }],
      130
    );
    expect(rows[0].balance).toBe(999);
  });

  it('handles an empty ledger', () => {
    expect(normaliseMovements([], 50)).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════
//  What the writers now record
// ══════════════════════════════════════════════════════════════════
describe('a PO receipt', () => {
  async function receive(qty = 100, stock = 0) {
    const material = await RawMaterial.create({
      name: 'Nylon 70D', category: 'Yarn', stock, price: 320,
    });
    const supplier = await Supplier.create({ name: 'Kumar', phoneNumber: '9000000000' });
    const po = await PurchaseOrder.create({
      supplier: supplier._id,
      items: [{ rawMaterial: material._id, quantity: 200, price: 320 }],
    });
    await request(app).post('/api/v2/supplier/inward-stock')
      .set('Cookie', adminCookie())
      .send({ poId: String(po._id), items: [{ rawMaterial: String(material._id), quantity: qty }] });
    return material;
  }

  it('records the balance it left behind', async () => {
    // It recorded none at all, so the Balance column was empty on every
    // goods-in row.
    const material = await receive(100, 30);
    const res = await detail(material._id);

    const [row] = res.body.material.stockMovements;
    expect(row.type).toBe('PO_INWARD');
    expect(row.quantity).toBe(100);
    expect(row.balance).toBe(130);
  });

  it('credits the stock it says it did', async () => {
    const material = await receive(100, 30);
    expect((await RawMaterial.findById(material._id)).stock).toBe(130);
  });

  it('does not stamp the purchase order into the order reference', async () => {
    // The field is ref:"Order"; a PurchaseOrder id there resolves to
    // nothing and left the reference column blank anyway.
    const material = await receive();
    const res = await detail(material._id);
    expect(res.body.material.stockMovements[0].order).toBeUndefined();
  });

  it('keeps the balance right across two receipts', async () => {
    const material = await RawMaterial.create({
      name: 'Nylon 70D', category: 'Yarn', stock: 0, price: 320,
    });
    const supplier = await Supplier.create({ name: 'Kumar', phoneNumber: '9000000000' });
    const po = await PurchaseOrder.create({
      supplier: supplier._id,
      items: [{ rawMaterial: material._id, quantity: 200, price: 320 }],
    });
    const send = (q) =>
      request(app).post('/api/v2/supplier/inward-stock')
        .set('Cookie', adminCookie())
        .send({ poId: String(po._id), items: [{ rawMaterial: String(material._id), quantity: q }] });

    await send(60);
    await send(40);

    const res = await detail(material._id);
    // Newest first: the second receipt closed at 100, the first at 60.
    expect(res.body.material.stockMovements.map((m) => m.balance)).toEqual([100, 60]);
  });
});

describe('a manual adjustment', () => {
  const adjust = (material, adjustment) =>
    request(app).post('/api/v2/materials/bulk-adjust-stock')
      .set('Cookie', adminCookie())
      .send({ globalReason: 'Count', adjustments: [{ _id: String(material._id), adjustment }] });

  it('shows a removal as negative, against a falling balance', async () => {
    const material = await RawMaterial.create({
      name: 'Nylon 70D', category: 'Yarn', stock: 100, price: 320,
    });
    await adjust(material, -30);

    const res = await detail(material._id);
    const [row] = res.body.material.stockMovements;
    expect(row.quantity).toBe(-30);
    expect(row.balance).toBe(70);
  });

  it('shows an addition as positive, against a rising balance', async () => {
    const material = await RawMaterial.create({
      name: 'Nylon 70D', category: 'Yarn', stock: 100, price: 320,
    });
    await adjust(material, 25);

    const res = await detail(material._id);
    const [row] = res.body.material.stockMovements;
    expect(row.quantity).toBe(25);
    expect(row.balance).toBe(125);
  });
});

describe('a ledger written before the fix', () => {
  it('reads correctly without touching the stored rows', async () => {
    // Exactly the shape the old code produced: a positive approval and a
    // receipt with no balance.
    const material = await RawMaterial.create({
      name: 'Nylon 70D', category: 'Yarn', stock: 60, price: 320,
    });
    await RawMaterial.updateOne(
      { _id: material._id },
      {
        $push: {
          stockMovements: {
            $each: [
              { date: new Date('2026-01-01'), type: 'PO_INWARD', quantity: 100 },
              { date: new Date('2026-02-01'), type: 'ORDER_APPROVAL', quantity: 40, balance: 60 },
            ],
          },
        },
      }
    );

    const res = await detail(material._id);
    const rows = res.body.material.stockMovements;

    expect(rows.map((r) => r.quantity)).toEqual([-40, 100]);
    expect(rows.map((r) => r.balance)).toEqual([60, 100]);
  });
});
