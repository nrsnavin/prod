'use strict';
//
// CHARACTERIZATION test for api/order.js POST /approve.
//
// Pins the CURRENT behaviour of the order-approval handler — raw
// stock deduction, elastic reservation, fingerprints, and the
// force/shortfall guard — before the planned service-layer extraction
// (Phase B4) and status-state-machine (B3). Behaviour-descriptive, not
// aspirational.
//
// /approve runs inside a Mongo transaction, so this uses
// MongoMemoryReplSet (standalone mongo can't do transactions). The
// order router does not apply auth middleware internally (the app-level
// ADMIN_GATE does), and the handler tolerates an absent req.user, so no
// auth mock is required.

const express  = require('express');
const bodyParser = require('body-parser');
const request  = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let app, mongo, Order, RawMaterial, Elastic;

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  Order       = require('../../models/Order');
  RawMaterial = require('../../models/RawMaterial');
  Elastic     = require('../../models/Elastic');
  const orderRouter = require('../../api/order.js');

  app = express();
  app.use(bodyParser.json());
  app.use('/api/v2/order', orderRouter);
  app.use((err, _req, res, _next) => {
    res.status(err.statusCode || 500).json({
      success: false, message: err.message, code: err.code,
    });
  });
}, 90_000);

afterAll(async () => {
  if (mongo) { await mongoose.disconnect(); await mongo.stop(); }
});
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    await c.deleteMany({});
  }
});

async function makeElastic(name, over = {}) {
  return Elastic.create({
    name, weaveType: '8', spandexEnds: 1, pick: 1, noOfHook: 1, weight: 1,
    testingParameters: { elongation: 120, recovery: 90 },
    reservedStock: 0, ...over,
  });
}
async function makeMaterial(name, stock) {
  return RawMaterial.create({
    name, category: 'Yarn', supplier: new mongoose.Types.ObjectId(),
    stock, minStock: 0, price: 0,
  });
}
async function makeOpenOrder({ elastic, material, requiredWeight, orderQty }) {
  return Order.create({
    orderNo: 7001, status: 'Open', po: 'PO-1',
    date: new Date(), supplyDate: new Date(),
    customer: new mongoose.Types.ObjectId(),
    elasticOrdered:      [{ elastic: elastic._id, quantity: orderQty }],
    rawMaterialRequired: [{ rawMaterial: material._id, requiredWeight }],
    reservations: [],
  });
}

const approve = (body) => request(app).post('/api/v2/order/approve').send(body);

describe('POST /approve — guards', () => {
  test('400 on a missing/invalid orderId', async () => {
    const res = await approve({});
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Valid orderId is required/);
  });

  test('404 when the order does not exist', async () => {
    const res = await approve({ orderId: new mongoose.Types.ObjectId().toString() });
    expect(res.status).toBe(404);
  });

  test('400 when the order is not Open', async () => {
    const e = await makeElastic('E'); const m = await makeMaterial('M', 100);
    const order = await makeOpenOrder({ elastic: e, material: m, requiredWeight: 10, orderQty: 5 });
    order.status = 'Approved'; await order.save();
    const res = await approve({ orderId: order._id.toString() });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Only Open orders/);
  });
});

describe('POST /approve — happy path', () => {
  test('deducts raw stock, reserves elastic, stamps fingerprints, flips to Approved', async () => {
    const elastic  = await makeElastic('Elastic-A');
    const material = await makeMaterial('Spandex', 100);
    const order = await makeOpenOrder({
      elastic, material, requiredWeight: 30, orderQty: 500,
    });

    const res = await approve({ orderId: order._id.toString() });
    expect(res.status).toBe(200);

    // Raw stock deducted by requiredWeight.
    const m = await RawMaterial.findById(material._id);
    expect(m.stock).toBe(70); // 100 - 30

    // Elastic reservedStock bumped by the ordered quantity.
    const e = await Elastic.findById(elastic._id);
    expect(e.reservedStock).toBe(500);

    // Order flipped + reservation recorded + fingerprints present.
    const saved = await Order.findById(order._id);
    expect(saved.status).toBe('Approved');
    expect(saved.approvedAt).toBeTruthy();
    expect(saved.reservations).toHaveLength(1);
    expect(saved.reservations[0].quantity).toBe(500);
    const codes = saved.fingerprints.map(f => f.code);
    expect(codes).toContain('ORDER_APPROVED');
    expect(codes).toContain('RAW_MATERIAL_DEDUCTED');
    expect(codes).toContain('STOCK_RESERVED');
  });
});

describe('POST /approve — insufficient stock', () => {
  test('without force: 400 INSUFFICIENT_STOCK and NO mutation (txn rolled back)', async () => {
    const elastic  = await makeElastic('Elastic-A');
    const material = await makeMaterial('Spandex', 5); // need 30, have 5
    const order = await makeOpenOrder({
      elastic, material, requiredWeight: 30, orderQty: 500,
    });

    const res = await approve({ orderId: order._id.toString() });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INSUFFICIENT_STOCK');

    // Nothing changed — transaction aborted.
    expect((await RawMaterial.findById(material._id)).stock).toBe(5);
    expect((await Elastic.findById(elastic._id)).reservedStock).toBe(0);
    expect((await Order.findById(order._id)).status).toBe('Open');
  });

  test('force with a too-short reason: 400 (reason must be ≥ 8 chars)', async () => {
    const elastic  = await makeElastic('Elastic-A');
    const material = await makeMaterial('Spandex', 5);
    const order = await makeOpenOrder({
      elastic, material, requiredWeight: 30, orderQty: 500,
    });
    const res = await approve({ orderId: order._id.toString(), force: true, forceReason: 'short' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/forceReason must be at least 8 characters/);
  });

  test('force with a valid reason: approves, clamps stock at 0, records the shortfall', async () => {
    const elastic  = await makeElastic('Elastic-A');
    const material = await makeMaterial('Spandex', 5); // need 30, have 5
    const order = await makeOpenOrder({
      elastic, material, requiredWeight: 30, orderQty: 500,
    });
    const res = await approve({
      orderId: order._id.toString(), force: true,
      forceReason: 'urgent customer deadline',
    });
    expect(res.status).toBe(200);

    // Stock clamped to 0 (5 - 30 floored at 0).
    expect((await RawMaterial.findById(material._id)).stock).toBe(0);
    const saved = await Order.findById(order._id);
    expect(saved.status).toBe('Approved');
    // The force path stamps TWO ORDER_APPROVED fingerprints: a
    // standalone one capturing the override reason + shortfalls, then
    // the final approval fingerprint carrying shortfallCount.
    const approveFps = saved.fingerprints.filter(f => f.code === 'ORDER_APPROVED');
    expect(approveFps).toHaveLength(2);
    // Standalone force fingerprint: reason + shortfalls array.
    const forceFp = approveFps.find(f => Array.isArray(f.meta.shortfalls));
    expect(forceFp.meta.forced).toBe(true);
    expect(forceFp.meta.shortfalls).toHaveLength(1);
    expect(forceFp.meta.reason).toMatch(/urgent customer deadline/);
    // Final approval fingerprint: forced flag + shortfallCount.
    const finalFp = approveFps.find(f => f.meta.shortfallCount !== undefined);
    expect(finalFp.meta.forced).toBe(true);
    expect(finalFp.meta.shortfallCount).toBe(1);
  });
});
