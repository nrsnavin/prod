'use strict';
// ══════════════════════════════════════════════════════════════════
//  WHY THE STOCK MOVED
//
//  Reported as: the stock movements list does not say why a movement
//  happened — an order approval or a goods receipt should name the
//  order or the purchase order behind it.
//
//  Two separate faults sat behind that:
//
//   1. The row's only reference field is `order`, declared ref:"Order".
//      A receipt is caused by a PURCHASE order, so the inward route
//      wrote no reference at all — deliberately, with a comment saying
//      why. Every goods receipt in the ledger was therefore unexplained.
//   2. The type was rendered as the raw enum. ORDER_APPROVAL is a
//      database value, not a sentence.
//
//  A manual adjustment had a third: the operator's reason was computed
//  on the line after the ledger write and then thrown away, so the one
//  movement type with no document behind it also had no explanation.
//
//  Everything here goes through the real routes. A ledger is exactly
//  the thing you cannot test by writing the rows yourself.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
// Approval and inward both run in transactions.
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app;
let RawMaterial, Supplier, PurchaseOrder, Elastic, Customer, Order, User, admin;

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
  Elastic       = require('../../models/Elastic');
  Customer      = require('../../models/Customer');
  Order         = require('../../models/Order');
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

async function seed({ stock = 500 } = {}) {
  const supplier = await Supplier.create({ name: 'Kumar Yarns', phoneNumber: '9000000001' });
  const yarn = await RawMaterial.create({
    name: 'Nylon 70D', category: 'Yarn', stock, price: 300, supplier: supplier._id,
  });
  const elastic = await Elastic.create({
    name: '20mm', weaveType: '8',
    spandexEnds: 40, yarnEnds: 120, pick: 12, noOfHook: 8, weight: 2.4,
    warpYarn: [{ id: yarn._id, weight: 1 }],
  });
  const customer = await Customer.create({
    name: 'Acme', contactName: 'R', phoneNumber: '9000000002',
  });
  return { supplier, yarn, elastic, customer };
}

const ledger = async (yarn) => {
  const res = await request(app)
    .get('/api/v2/materials/get-raw-material-detail')
    .query({ id: String(yarn._id) })
    .set('Cookie', adminCookie());
  if (res.status >= 400) throw new Error(`ledger read failed: ${res.status}`);
  return (res.body.material || res.body.data || res.body).stockMovements || [];
};

const rowOf = (rows, type) => rows.find((r) => r.type === type);

// ── An order approval ─────────────────────────────────────────────────

describe('an order approval on the ledger', () => {
  async function approveAnOrder(seeded, { orderNo = 1042 } = {}) {
    const order = await Order.create({
      orderNo, customer: seeded.customer._id, status: 'Open', po: 'ACME-77',
      date: new Date(), supplyDate: new Date(),
      elasticOrdered: [{ elastic: seeded.elastic._id, quantity: 100 }],
      // Approval debits from this stored requirement, not from the BOM —
      // /create-order computes it. Building the order directly without
      // it means approval succeeds and deducts nothing, which looks
      // exactly like the ledger being broken.
      rawMaterialRequired: [{
        rawMaterial: seeded.yarn._id, name: 'Nylon 70D',
        requiredWeight: 40, inStock: 500,
      }],
    });
    const res = await request(app).post('/api/v2/order/approve')
      .set('Cookie', adminCookie())
      .send({ orderId: String(order._id) });
    if (res.status >= 400) throw new Error(`approve failed: ${res.status} ${JSON.stringify(res.body)}`);
    return order;
  }

  it('names the order that caused it', async () => {
    const seeded = await seed();
    // The number the sequence plugin actually assigned — it overrides
    // anything passed to create, so asserting a hand-picked number tests
    // the fixture rather than the ledger.
    const order = await approveAnOrder(seeded);

    const row = rowOf(await ledger(seeded.yarn), 'ORDER_APPROVAL');
    expect(row).toBeTruthy();
    expect(row.reference).toBe(`Order #${order.orderNo}`);
    expect(row.referenceKind).toBe('order');
  });

  it('says what happened in words, not as an enum', async () => {
    const seeded = await seed();
    await approveAnOrder(seeded);

    const row = rowOf(await ledger(seeded.yarn), 'ORDER_APPROVAL');
    expect(row.typeLabel).toBe('Order approved');
    // The raw value is still there for anything that keyed off it.
    expect(row.type).toBe('ORDER_APPROVAL');
  });

  it('links to the order, so the row can be opened', async () => {
    const seeded = await seed();
    const order = await approveAnOrder(seeded);

    const row = rowOf(await ledger(seeded.yarn), 'ORDER_APPROVAL');
    expect(row.referenceId).toBe(String(order._id));
  });

  it('still names the order after the order is deleted', async () => {
    // The number is snapshotted onto the row for exactly this. Without
    // it, deleting an order silently blanks its own history.
    const seeded = await seed();
    const order = await approveAnOrder(seeded);
    const assignedNo = order.orderNo;
    await Order.deleteOne({ _id: order._id });

    const row = rowOf(await ledger(seeded.yarn), 'ORDER_APPROVAL');
    expect(row.reference).toContain(String(assignedNo));
  });
});

// ── A goods receipt ───────────────────────────────────────────────────

describe('a goods receipt on the ledger', () => {
  async function receiveAgainstPo(seeded, { poNo = 55, quantity = 40 } = {}) {
    const po = await PurchaseOrder.create({
      poNo, supplier: seeded.supplier._id, status: 'Open',
      items: [{ rawMaterial: seeded.yarn._id, quantity: 100, price: 300, receivedQuantity: 0 }],
    });
    const res = await request(app).post('/api/v2/supplier/inward-stock')
      .set('Cookie', adminCookie())
      .send({
        poId: String(po._id),
        items: [{ rawMaterial: String(seeded.yarn._id), quantity }],
      });
    if (res.status >= 400) throw new Error(`inward failed: ${res.status} ${JSON.stringify(res.body)}`);
    return po;
  }

  it('names the purchase order that brought the goods in', async () => {
    // The reported gap. This field could not previously be recorded at
    // all, so every receipt in the ledger was unexplained.
    const seeded = await seed({ stock: 0 });
    await receiveAgainstPo(seeded, { poNo: 55 });

    const row = rowOf(await ledger(seeded.yarn), 'PO_INWARD');
    expect(row).toBeTruthy();
    expect(row.reference).toBe('PO #55');
    expect(row.referenceKind).toBe('purchaseOrder');
  });

  it('says "goods received" rather than PO_INWARD', async () => {
    const seeded = await seed({ stock: 0 });
    await receiveAgainstPo(seeded);

    expect(rowOf(await ledger(seeded.yarn), 'PO_INWARD').typeLabel).toBe('Goods received');
  });

  it('links to the purchase order', async () => {
    const seeded = await seed({ stock: 0 });
    const po = await receiveAgainstPo(seeded);

    expect(rowOf(await ledger(seeded.yarn), 'PO_INWARD').referenceId).toBe(String(po._id));
  });

  it('does not put the PO id in the order field', async () => {
    // What the original code was avoiding, and rightly: `order` is
    // ref:"Order", so a PO id there resolves to nothing.
    const seeded = await seed({ stock: 0 });
    await receiveAgainstPo(seeded);

    const stored = await RawMaterial.findById(seeded.yarn._id).select('+stockMovements').lean();
    const row = stored.stockMovements.find((m) => m.type === 'PO_INWARD');
    expect(row.order).toBeFalsy();
    expect(String(row.purchaseOrder)).toBeTruthy();
  });
});

// ── Receipts recorded before the field existed ────────────────────────

describe('a receipt written before the ledger could record a PO', () => {
  it('recovers the number from the inward history', async () => {
    // Every row already in the customer's database looks like this.
    // Fixing only new writes would leave the ledger exactly as
    // unexplained as it was reported.
    const seeded = await seed({ stock: 0 });
    const po = await PurchaseOrder.create({
      poNo: 77, supplier: seeded.supplier._id, status: 'Open',
      items: [{ rawMaterial: seeded.yarn._id, quantity: 100, price: 300, receivedQuantity: 0 }],
    });
    await request(app).post('/api/v2/supplier/inward-stock')
      .set('Cookie', adminCookie())
      .send({ poId: String(po._id), items: [{ rawMaterial: String(seeded.yarn._id), quantity: 40 }] });

    // Strip the reference, leaving the row exactly as history has it.
    await RawMaterial.updateOne(
      { _id: seeded.yarn._id },
      { $unset: { 'stockMovements.$[m].purchaseOrder': '', 'stockMovements.$[m].refNo': '' } },
      { arrayFilters: [{ 'm.type': 'PO_INWARD' }] }
    );

    const row = rowOf(await ledger(seeded.yarn), 'PO_INWARD');
    expect(row.reference).toBe('PO #77');
    // And says it was matched rather than recorded, because those are
    // not the same claim.
    expect(row.referenceDerived).toBe(true);
  });

  it('leaves it unexplained when two receipts are indistinguishable', async () => {
    // Same day, same quantity, two POs. Naming one of them would be
    // inventing a fact to fill a column.
    const seeded = await seed({ stock: 0 });
    const MaterialInward = require('../../models/MaterialInward');
    const when = new Date('2026-06-10T00:00:00.000Z');
    const { appendStockMovement } = require('../../utils/stockLedger');

    const poA = await PurchaseOrder.create({
      poNo: 81, supplier: seeded.supplier._id, status: 'Open',
      items: [{ rawMaterial: seeded.yarn._id, quantity: 50, price: 300 }],
    });
    const poB = await PurchaseOrder.create({
      poNo: 82, supplier: seeded.supplier._id, status: 'Open',
      items: [{ rawMaterial: seeded.yarn._id, quantity: 50, price: 300 }],
    });
    for (const po of [poA, poB]) {
      await MaterialInward.create({
        rawMaterial: seeded.yarn._id, purchaseOrder: po._id,
        quantity: 25, inwardDate: when,
      });
    }
    await appendStockMovement(seeded.yarn._id, {
      date: when, type: 'PO_INWARD', quantity: 25, balance: 25,
    });

    const row = rowOf(await ledger(seeded.yarn), 'PO_INWARD');
    expect(row.reference).toBeNull();
    expect(row.referenceDerived).toBeFalsy();
  });
});

// ── A manual adjustment ───────────────────────────────────────────────

describe('a manual adjustment on the ledger', () => {
  it('keeps the reason the person typed', async () => {
    // There is no document behind an adjustment — the reason IS the
    // explanation, and it was being computed and thrown away.
    const seeded = await seed({ stock: 100 });
    const res = await request(app).post('/api/v2/materials/bulk-adjust-stock')
      .set('Cookie', adminCookie())
      .send({
        globalReason: 'annual stock count correction',
        adjustments: [{ _id: String(seeded.yarn._id), adjustment: -12 }],
      });
    expect(res.status).toBeLessThan(400);

    const row = rowOf(await ledger(seeded.yarn), 'STOCK_ADJUST');
    expect(row).toBeTruthy();
    expect(row.reason).toBe('annual stock count correction');
    expect(row.typeLabel).toBe('Manual adjustment');
  });
});
