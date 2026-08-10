'use strict';
// ══════════════════════════════════════════════════════════════════
//  WHAT THE YARN ON THE SHELF IS WORTH
//
//  A material used to carry one price — the latest one paid — and
//  everything was costed at it. Buy 100 kg at ₹300 and then 100 kg at
//  ₹360 and all 200 kg were suddenly worth ₹360, including the half
//  that cost ₹300. What these tests pin down:
//
//    • the arithmetic itself, without a database
//    • a receipt moves the average; an issue and an adjustment do not
//    • an issue is costed at the average, and that cost is SNAPSHOTTED
//      on the row — the average moves, so looking it up later would
//      price an old movement at a cost it never had
//    • a cancelled order returns yarn at what it left at, not at
//      today's average, which would otherwise create money
//    • a receipt with no price recorded leaves the average alone
//      rather than dragging it toward zero
//    • two receipts landing together cannot each average from the same
//      stale stock figure
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

const {
  nextAverage, costOf, receiveAtCost,
} = require('../../utils/materialValuation');

let mongo, app;
let RawMaterial, MaterialInward, MaterialOutward, PurchaseOrder, Supplier,
  Order, Customer, Elastic, User, admin;

const adminCookie = () => [
  `token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`,
];

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  RawMaterial     = require('../../models/RawMaterial');
  MaterialInward  = require('../../models/MaterialInward');
  MaterialOutward = require('../../models/MaterialOut.cjs');
  PurchaseOrder   = require('../../models/PurchaseOrder');
  Supplier        = require('../../models/Supplier');
  Order           = require('../../models/Order');
  Customer        = require('../../models/Customer');
  Elastic         = require('../../models/Elastic');
  User            = require('../../models/User');
  admin = await User.create({
    name: 'Owner', email: 'val@t.co', password: 'pass1234',
    role: 'admin', department: 'admin',
  });
}, 90_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
});

// ── fixtures ──────────────────────────────────────────────────────
const makeMaterial = (over = {}) =>
  RawMaterial.create({
    name: 'Nylon 70D', category: 'Yarn', stock: 0, price: 300, avgCost: 0, ...over,
  });

const makeSupplier = () =>
  Supplier.create({ name: 'Kumar Yarns', phoneNumber: '9000000001' });

async function makePo(material, { price = 300, quantity = 100 } = {}) {
  const supplier = await makeSupplier();
  return PurchaseOrder.create({
    supplier: supplier._id,
    date: new Date(),
    status: 'Open',
    items: [{ rawMaterial: material._id, price, quantity }],
  });
}

// ══════════════════════════════════════════════════════════════════
//  THE ARITHMETIC
// ══════════════════════════════════════════════════════════════════
describe('nextAverage', () => {
  it('averages the two receipts by weight', () => {
    // The example the whole feature exists for.
    expect(nextAverage(100, 300, 100, 360)).toBe(330);
  });

  it('weights by quantity, not by number of receipts', () => {
    // 300 kg at 300 plus 100 kg at 400 is 325, not 350.
    expect(nextAverage(300, 300, 100, 400)).toBe(325);
  });

  it('takes the first priced receipt as the average outright', () => {
    expect(nextAverage(0, 0, 100, 300)).toBe(300);
  });

  it('uses `price` as the basis for stock that predates averaging', () => {
    // 100 kg on hand with no average but a price of 300. Treating that
    // stock as costing nothing would jump the average to 360.
    expect(nextAverage(100, 0, 100, 360, 300)).toBe(330);
  });

  it('leaves the average alone when the receipt has no price', () => {
    // Missing information, not free yarn.
    expect(nextAverage(100, 300, 50, 0)).toBe(300);
  });

  it('keeps the last average when stock has run out', () => {
    // So the first issue after a stock-out is not costed at nothing
    // while a receipt is in transit.
    expect(nextAverage(0, 300, 0, 0)).toBe(300);
  });

  it('ignores negative stock and negative prices', () => {
    expect(nextAverage(-50, 300, 100, 360)).toBe(360);
    expect(nextAverage(100, 300, 100, -10)).toBe(300);
  });

  it('keeps four decimal places, because a rate can be ₹342.6875', () => {
    expect(nextAverage(3, 100, 4, 200)).toBe(157.1429);
  });
});

describe('costOf', () => {
  it('prefers the average', () => {
    expect(costOf({ avgCost: 330, price: 360 })).toBe(330);
  });

  it('falls back to price when nothing has been received yet', () => {
    // Which is exactly what everything was costed at before this
    // existed — so nothing on any screen jumps on the day it ships.
    expect(costOf({ avgCost: 0, price: 360 })).toBe(360);
  });

  it('is zero when there is nothing to go on', () => {
    expect(costOf({})).toBe(0);
    expect(costOf(null)).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════
//  receiveAtCost — the atomic half
// ══════════════════════════════════════════════════════════════════
describe('receiveAtCost', () => {
  it('credits the stock and moves the average together', async () => {
    const m = await makeMaterial({ stock: 100, price: 300, avgCost: 300 });
    const after = await receiveAtCost(m._id, 100, 360);
    expect(after.stock).toBe(200);
    expect(after.avgCost).toBe(330);
  });

  it('averages against the stock as it stood BEFORE the receipt', async () => {
    // The stage order in the pipeline is load-bearing: computing the
    // average after the stock had already gone up would give 345.
    const m = await makeMaterial({ stock: 100, avgCost: 300 });
    const after = await receiveAtCost(m._id, 100, 360);
    expect(after.avgCost).toBe(330);
    expect(after.avgCost).not.toBe(345);
  });

  it('uses `price` as the basis on a material that has no average yet', async () => {
    const m = await makeMaterial({ stock: 100, price: 300, avgCost: 0 });
    const after = await receiveAtCost(m._id, 100, 360);
    expect(after.avgCost).toBe(330);
  });

  it('leaves the average alone for an unpriced receipt', async () => {
    const m = await makeMaterial({ stock: 100, price: 300, avgCost: 320 });
    const after = await receiveAtCost(m._id, 50, 0);
    expect(after.stock).toBe(150);
    expect(after.avgCost).toBe(320);
  });

  it('does not let two concurrent receipts average from the same stale stock', async () => {
    // Read-modify-write would have the second overwrite the first: both
    // would compute against 100 on hand and the shelf would end up
    // valued at whichever landed last.
    const m = await makeMaterial({ stock: 100, avgCost: 300 });
    await Promise.all([
      receiveAtCost(m._id, 100, 360),
      receiveAtCost(m._id, 100, 400),
    ]);
    const after = await RawMaterial.findById(m._id).lean();
    expect(after.stock).toBe(300);
    // 100@300 + 100@360 + 100@400, in either order, is 353.3333.
    expect(after.avgCost).toBeCloseTo(353.3333, 3);
  });

  it('is a no-op for a zero quantity', async () => {
    const m = await makeMaterial({ stock: 100, avgCost: 300 });
    const after = await receiveAtCost(m._id, 0, 999);
    expect(after.stock).toBe(100);
    expect(after.avgCost).toBe(300);
  });
});

// ══════════════════════════════════════════════════════════════════
//  RECEIPTS THROUGH THE ROUTES
// ══════════════════════════════════════════════════════════════════
describe('a goods receipt', () => {
  it('moves the average at the PO line price, and records it on the inward', async () => {
    const m  = await makeMaterial({ stock: 100, price: 300, avgCost: 300 });
    const po = await makePo(m, { price: 360, quantity: 100 });

    const res = await request(app)
      .post('/api/v2/materials/material-inward')
      .set('Cookie', adminCookie())
      .send({ rawMaterialId: String(m._id), purchaseOrderId: String(po._id), quantity: 100 });

    expect(res.status).toBe(201);
    const after = await RawMaterial.findById(m._id).lean();
    expect(after.stock).toBe(200);
    expect(after.avgCost).toBe(330);

    // The receipt keeps its own price, so the average can be audited
    // back to the consignments that formed it.
    const inward = await MaterialInward.findOne({ rawMaterial: m._id }).lean();
    expect(inward.unitPrice).toBe(360);
  });

  it('stamps the receipt price on the ledger row', async () => {
    const m  = await makeMaterial({ stock: 0, price: 300 });
    const po = await makePo(m, { price: 355, quantity: 40 });

    await request(app)
      .post('/api/v2/materials/material-inward')
      .set('Cookie', adminCookie())
      .send({ rawMaterialId: String(m._id), purchaseOrderId: String(po._id), quantity: 40 });

    const doc = await RawMaterial.findById(m._id).select('+stockMovements').lean();
    const row = doc.stockMovements.find((r) => r.type === 'PO_INWARD');
    expect(row.unitCost).toBe(355);
    expect(row.quantity).toBe(40);
    expect(row.balance).toBe(40);
  });

  it('falls back to the material price when the PO line carries none', async () => {
    const m  = await makeMaterial({ stock: 0, price: 280 });
    const po = await PurchaseOrder.create({
      supplier: (await makeSupplier())._id,
      date: new Date(), status: 'Open',
      items: [{ rawMaterial: m._id, quantity: 50 }],   // no price
    });

    await request(app)
      .post('/api/v2/materials/material-inward')
      .set('Cookie', adminCookie())
      .send({ rawMaterialId: String(m._id), purchaseOrderId: String(po._id), quantity: 50 });

    const after = await RawMaterial.findById(m._id).lean();
    expect(after.avgCost).toBe(280);
  });

  it('does not lose one of two receipts landing together', async () => {
    // The old `material.stock += qty; save()` lost one outright.
    const m  = await makeMaterial({ stock: 0, price: 300 });
    const po = await makePo(m, { price: 300, quantity: 200 });
    const send = (qty) => request(app)
      .post('/api/v2/materials/material-inward')
      .set('Cookie', adminCookie())
      .send({ rawMaterialId: String(m._id), purchaseOrderId: String(po._id), quantity: qty });

    await Promise.all([send(60), send(40)]);

    const after = await RawMaterial.findById(m._id).lean();
    expect(after.stock).toBe(100);
  });
});

describe('receiving against a purchase order', () => {
  it('moves the average and prices the inward rows', async () => {
    const m  = await makeMaterial({ stock: 100, price: 300, avgCost: 300 });
    const po = await makePo(m, { price: 360, quantity: 100 });

    const res = await request(app)
      .post('/api/v2/supplier/inward-stock')
      .set('Cookie', adminCookie())
      .send({ poId: String(po._id), items: [{ rawMaterial: String(m._id), quantity: 100 }] });

    expect([200, 201]).toContain(res.status);
    const after = await RawMaterial.findById(m._id).lean();
    expect(after.stock).toBe(200);
    expect(after.avgCost).toBe(330);

    const inward = await MaterialInward.findOne({ rawMaterial: m._id }).lean();
    expect(inward.unitPrice).toBe(360);
  });
});

// ══════════════════════════════════════════════════════════════════
//  ISSUES
// ══════════════════════════════════════════════════════════════════
describe('an issue', () => {
  /** An approved order draws its raw material. */
  async function approveOrderFor(material) {
    const customer = await Customer.create({
      name: 'Aravind Garments', contactName: 'Aravind', phoneNumber: '9111111112',
      address: 'Tiruppur', email: `a${Math.random().toString(36).slice(2, 7)}@t.co`,
    });
    const elastic = await Elastic.create({
      name: `20mm Woven ${Math.random().toString(36).slice(2, 8)}`,
      weight: 5, noOfHook: 24, pick: 40, spandexEnds: 8,
    });
    const order = await Order.create({
      customer: customer._id, po: 'PO-7001', date: new Date(), supplyDate: new Date(),
      elasticOrdered: [{ elastic: elastic._id, quantity: 1000 }],
      rawMaterialRequired: [{ rawMaterial: material._id, requiredWeight: 40 }],
      status: 'Open',
    });
    const res = await request(app)
      .post('/api/v2/order/approve')
      .set('Cookie', adminCookie())
      .send({ orderId: String(order._id) });
    expect(res.status).toBeLessThan(400);
    return { order, res };
  }

  it('is costed at the average, not at the latest purchase price', async () => {
    // 100 @300 then 100 @360 averages to 330. The latest price is 360 —
    // costing the issue at it is the bug this replaces.
    const m = await makeMaterial({ stock: 200, price: 360, avgCost: 330 });
    await approveOrderFor(m);

    const out = await MaterialOutward.findOne({ rawMaterial: m._id }).lean();
    expect(out.unitPrice).toBe(330);
    expect(out.unitPrice).not.toBe(360);
  });

  it('does not move the average', async () => {
    const m = await makeMaterial({ stock: 200, price: 360, avgCost: 330 });
    await approveOrderFor(m);

    const after = await RawMaterial.findById(m._id).lean();
    expect(after.stock).toBe(160);
    expect(after.avgCost).toBe(330);   // averaging is the point
  });

  it('snapshots the cost on the ledger row', async () => {
    const m = await makeMaterial({ stock: 200, price: 360, avgCost: 330 });
    await approveOrderFor(m);

    const doc = await RawMaterial.findById(m._id).select('+stockMovements').lean();
    const row = doc.stockMovements.find((r) => r.type === 'ORDER_APPROVAL');
    expect(row.unitCost).toBe(330);
    expect(row.quantity).toBe(-40);
  });

  it('returns cancelled stock at what it left at, not at today average', async () => {
    // Issue 40 at 330, then a receipt lifts the average, then cancel.
    // Returning at the NEW average would credit the shelf with value
    // the yarn never had — a cancel after a price rise would create
    // money out of nothing.
    const m = await makeMaterial({ stock: 200, price: 330, avgCost: 330 });
    const { order } = await approveOrderFor(m);

    await receiveAtCost(m._id, 160, 500);            // average climbs
    const lifted = await RawMaterial.findById(m._id).lean();
    expect(lifted.avgCost).toBeGreaterThan(400);

    const res = await request(app)
      .post('/api/v2/order/cancel')
      .set('Cookie', adminCookie())
      .send({ orderId: String(order._id), cancelReason: 'customer withdrew the order' });
    expect(res.status).toBeLessThan(400);

    const after = await RawMaterial.findById(m._id).lean();
    expect(after.stock).toBe(360);
    // 320 @415 back plus 40 @330 → below the lifted average, and above
    // the original one. The exact figure is the weighted blend.
    const expected =
      (320 * lifted.avgCost + 40 * 330) / 360;
    expect(after.avgCost).toBeCloseTo(expected, 2);
    expect(after.avgCost).toBeLessThan(lifted.avgCost);

    const doc = await RawMaterial.findById(m._id).select('+stockMovements').lean();
    const row = doc.stockMovements.find((r) => r.type === 'ORDER_CANCEL_REFUND');
    expect(row.unitCost).toBe(330);
  });
});

// ══════════════════════════════════════════════════════════════════
//  ADJUSTMENTS NEVER MOVE COST
// ══════════════════════════════════════════════════════════════════
describe('a manual adjustment', () => {
  it('changes the quantity and leaves the average alone', async () => {
    // A count that finds 5 kg missing has not changed what the rest of
    // it cost.
    const m = await makeMaterial({ stock: 100, price: 300, avgCost: 330 });

    const res = await request(app)
      .post('/api/v2/materials/bulk-adjust-stock')
      .set('Cookie', adminCookie())
      .send({ adjustments: [{ _id: String(m._id), adjustment: -5, reason: 'Damaged cones' }] });

    expect(res.status).toBe(200);
    const after = await RawMaterial.findById(m._id).lean();
    expect(after.stock).toBe(95);
    expect(after.avgCost).toBe(330);
  });

  it('values the write-off at the average, not the latest price', async () => {
    const m = await makeMaterial({ stock: 100, price: 500, avgCost: 330 });

    await request(app)
      .post('/api/v2/materials/bulk-adjust-stock')
      .set('Cookie', adminCookie())
      .send({ adjustments: [{ _id: String(m._id), adjustment: -5, reason: 'Damaged cones' }] });

    const out = await MaterialOutward.findOne({ rawMaterial: m._id }).lean();
    expect(out.unitPrice).toBe(330);
  });
});

// ══════════════════════════════════════════════════════════════════
//  THE VALUATION SNAPSHOT
// ══════════════════════════════════════════════════════════════════
describe('the stock valuation report', () => {
  it('values the shelf at the average, falling back to price', async () => {
    const { stockPurchasesReport } = require('../../services/reports/stockPurchasesReport');
    await makeMaterial({ name: 'Averaged',  stock: 100, price: 500, avgCost: 330 });
    await makeMaterial({ name: 'Untouched', stock: 100, price: 250, avgCost: 0 });

    const report = await stockPurchasesReport({ groupBy: 'material' });
    const byName = Object.fromEntries(report.rows.map((r) => [r.label, r]));

    expect(byName.Averaged.value).toBe(33000);     // NOT 50000
    expect(byName.Untouched.value).toBe(25000);    // no average yet
    expect(byName.Untouched.latestPrice).toBe(250);
  });
});
