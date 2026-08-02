'use strict';
// ══════════════════════════════════════════════════════════════════
//  RECEIVING YARN, AND SEEING IT AFTERWARDS
//
//  Reported as "the stock is not updated when material inward is
//  received". Two different things could produce that complaint: the
//  balance not moving, or the balance moving and nothing showing it.
//  Both are asked here, through the real app, because fixing the wrong
//  one would leave the report standing.
//
//  Also pins what is still ON ORDER — quantity bought but not yet
//  delivered. Without it, a shortfall reads as unbought and gets
//  ordered a second time.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
// /inward-stock records the receipt in a transaction.
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app;
let RawMaterial, Supplier, PurchaseOrder, Elastic, Order, JobOrder, Customer, User, admin;

const adminCookie = () => [
  `token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`,
];

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({
    replSet: { count: 1 },
    instanceOpts: [{ launchTimeout: 60_000 }],
  });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  RawMaterial = require('../../models/RawMaterial');
  Supplier = require('../../models/Supplier');
  PurchaseOrder = require('../../models/PurchaseOrder');
  Elastic = require('../../models/Elastic');
  Order = require('../../models/Order');
  JobOrder = require('../../models/JobOrder');
  Customer = require('../../models/Customer');
  User = require('../../models/User');
  admin = await User.create({
    name: 'Owner', email: 'o@t.co', password: 'pass1234', role: 'admin', department: 'admin',
  });
}, 120_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
});

/** A yarn, a supplier, and a PO for `ordered` of it. */
async function seedPo({ stock = 0, ordered = 100 } = {}) {
  const yarn = await RawMaterial.create({
    name: 'Nylon 70D', category: 'Yarn', stock, price: 300,
  });
  const supplier = await Supplier.create({ name: 'Kumar Yarns', phoneNumber: '9000000001' });
  const po = await PurchaseOrder.create({
    poNo: Math.floor(Math.random() * 100000),
    supplier: supplier._id,
    status: 'Open',
    items: [{ rawMaterial: yarn._id, quantity: ordered, price: 300, receivedQuantity: 0 }],
  });
  return { yarn, supplier, po };
}

const receive = (po, yarn, quantity, extra = {}) =>
  request(app).post('/api/v2/supplier/inward-stock')
    .set('Cookie', adminCookie())
    .send({ poId: String(po._id), items: [{ rawMaterial: String(yarn._id), quantity, ...extra }] });

const stockOf = async (yarn) => (await RawMaterial.findById(yarn._id)).stock;

describe('the balance itself', () => {
  it('goes up by what was received', async () => {
    const { yarn, po } = await seedPo({ stock: 40, ordered: 100 });

    const res = await receive(po, yarn, 60);
    expect(res.status).toBe(201);
    expect(await stockOf(yarn)).toBe(100);
  });

  it('adds up across several receipts against one PO', async () => {
    const { yarn, po } = await seedPo({ stock: 0, ordered: 100 });

    await receive(po, yarn, 30);
    await receive(po, yarn, 45);
    expect(await stockOf(yarn)).toBe(75);
  });

  it('records the movement, so the ledger explains the balance', async () => {
    const { yarn, po } = await seedPo({ stock: 10, ordered: 50 });
    await receive(po, yarn, 50);

    // The array is select:false on the schema — a plain findById does
    // not load it, which is its own way of looking like nothing happened.
    const material = await RawMaterial.findById(yarn._id).select('+stockMovements');
    const inward = (material.stockMovements || []).find((m) => m.type === 'PO_INWARD');
    expect(inward).toBeTruthy();
    expect(inward.quantity).toBe(50);
    expect(inward.balance).toBe(60);
  });
});

describe('seeing it on the material itself', () => {
  it('the detail page reports the new balance', async () => {
    const { yarn, po } = await seedPo({ stock: 0, ordered: 100 });
    await receive(po, yarn, 100);

    const res = await request(app)
      .get('/api/v2/materials/get-raw-material-detail')
      .query({ id: String(yarn._id) })
      .set('Cookie', adminCookie());

    expect(res.status).toBeLessThan(400);
    const body = res.body.material || res.body.data || res.body;
    expect(body.stock).toBe(100);
  });
});

// ── What is on order but not yet here ────────────────────────────────
// A shortfall that ignores open purchase orders reads as unbought, and
// the natural response is to buy it again.

describe('quantity still to be received', () => {
  async function seedRequirement({ stock = 0, ordered = 0, received = 0 } = {}) {
    const yarn = await RawMaterial.create({
      name: 'Nylon 70D', category: 'Yarn', stock, price: 300,
    });
    const supplier = await Supplier.create({ name: 'Kumar Yarns', phoneNumber: '9000000001' });
    if (ordered > 0) {
      await PurchaseOrder.create({
        poNo: Math.floor(Math.random() * 100000),
        supplier: supplier._id,
        status: received >= ordered ? 'Completed' : 'Open',
        items: [{ rawMaterial: yarn._id, quantity: ordered, price: 300, receivedQuantity: received }],
      });
    }
    const elastic = await Elastic.create({
      name: '20mm', weaveType: '8',
      spandexEnds: 40, yarnEnds: 120, pick: 12, noOfHook: 8, weight: 2.4,
      warpYarn: [{ id: yarn._id, weight: 1 }],
    });
    const customer = await Customer.create({
      name: 'Acme', contactName: 'R', phoneNumber: '9000000002',
    });
    const order = await Order.create({
      orderNo: Math.floor(Math.random() * 100000),
      customer: customer._id, status: 'Approved', po: 'PO-1',
      date: new Date(), supplyDate: new Date(),
      elasticOrdered: [{ elastic: elastic._id, quantity: 500 }],
      pendingElastic: [{ elastic: elastic._id, quantity: 500 }],
    });
    return { yarn, order, elastic };
  }

  const orderMrp = (order) =>
    request(app).get(`/api/v2/order/${order._id}/mrp`).set('Cookie', adminCookie());

  it('reports what an open PO still owes', async () => {
    const { yarn, order } = await seedRequirement({ stock: 100, ordered: 400, received: 150 });

    const { body } = await orderMrp(order);
    const row = body.data.materials.find((m) => String(m.rawMaterial) === String(yarn._id));
    expect(row.inStock).toBe(100);
    // 400 ordered, 150 already delivered.
    expect(row.onOrder).toBe(250);
  });

  it('reports nothing on order when the PO is fully received', async () => {
    const { yarn, order } = await seedRequirement({ stock: 400, ordered: 400, received: 400 });

    const { body } = await orderMrp(order);
    const row = body.data.materials.find((m) => String(m.rawMaterial) === String(yarn._id));
    expect(row.onOrder).toBe(0);
  });

  it('reports nothing on order when none was ever raised', async () => {
    const { yarn, order } = await seedRequirement({ stock: 0 });

    const { body } = await orderMrp(order);
    const row = body.data.materials.find((m) => String(m.rawMaterial) === String(yarn._id));
    expect(row.onOrder).toBe(0);
  });

  it('the job MRP moves with the receipt, like the order MRP does', async () => {
    // The job sheet is what the floor works from, so a receipt that
    // reaches the order screen and not this one is still the reported
    // fault. Both read RawMaterial.stock live — this pins that.
    const { yarn, order, elastic } = await seedRequirement({ stock: 0, ordered: 400, received: 0 });
    const job = await JobOrder.create({
      date: new Date(), order: order._id, customer: order.customer, status: 'preparatory',
      elastics: [{ elastic: elastic._id, quantity: 500 }],
    });

    const before = await request(app)
      .get(`/api/v2/job/${job._id}/mrp`).set('Cookie', adminCookie());
    const rowBefore = before.body.data.materials.find(
      (m) => String(m.rawMaterial) === String(yarn._id)
    );
    expect(rowBefore.inStock).toBe(0);
    expect(rowBefore.onOrder).toBe(400);

    // The yarn arrives against that PO.
    const po = await PurchaseOrder.findOne({ 'items.rawMaterial': yarn._id });
    await receive(po, yarn, 400);

    const after = await request(app)
      .get(`/api/v2/job/${job._id}/mrp`).set('Cookie', adminCookie());
    const rowAfter = after.body.data.materials.find(
      (m) => String(m.rawMaterial) === String(yarn._id)
    );
    expect(rowAfter.inStock).toBe(400);
    // And nothing is owed twice: it is here now, not on its way.
    expect(rowAfter.onOrder).toBe(0);
  });

  it('the shortfall still measures against stock alone', async () => {
    // On-order quantity is not in the building. Netting it off the
    // shortfall would report a material as covered while the machine
    // has nothing to run, so it is shown beside the shortfall, never
    // subtracted from it.
    const { yarn, order } = await seedRequirement({ stock: 0, ordered: 10_000, received: 0 });

    const { body } = await orderMrp(order);
    const row = body.data.materials.find((m) => String(m.rawMaterial) === String(yarn._id));
    expect(row.shortfall).toBeGreaterThan(0);
    expect(row.onOrder).toBe(10_000);
  });
});
