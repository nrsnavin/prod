'use strict';
// ══════════════════════════════════════════════════════════════════
//  FORCING AN APPROVAL: SEE ALL OF WHAT IS BEING FORCED
//
//  An order short of stock is refused, the admin is shown the
//  shortfall, types a reason and approves anyway. The refusal stopped
//  at the FIRST material it found short and named only that one. The
//  forced approval then went through every material — so an order short
//  of three yarns was approved by somebody who had been told about one,
//  and the other two were drawn down to nothing behind the dialog. The
//  trail recorded all three; the person deciding never saw them.
// ══════════════════════════════════════════════════════════════════

const express = require('express');
const bodyParser = require('body-parser');
const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let app, mongo, Order, RawMaterial, Elastic;

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  Order = require('../../models/Order');
  RawMaterial = require('../../models/RawMaterial');
  Elastic = require('../../models/Elastic');
  app = express();
  app.use(bodyParser.json());
  app.use('/api/v2/order', require('../../api/order.js'));
  app.use(require('../../middleware/error.js'));
}, 120_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) await c.deleteMany({});
});

const material = (name, stock) => RawMaterial.create({ name, category: 'Yarn', stock, minStock: 0, price: 0 });

async function orderNeeding(needs) {
  const elastic = await Elastic.create({
    name: 'E-20', weaveType: '8', spandexEnds: 1, pick: 1, noOfHook: 1, weight: 1,
    testingParameters: { elongation: 120, recovery: 90 }, reservedStock: 0,
  });
  return Order.create({
    orderNo: 8101, status: 'Open', po: 'PO-1', date: new Date(), supplyDate: new Date(),
    customer: new mongoose.Types.ObjectId(),
    elasticOrdered: [{ elastic: elastic._id, quantity: 500 }],
    rawMaterialRequired: needs.map(([m, requiredWeight]) => ({ rawMaterial: m._id, requiredWeight })),
    reservations: [],
  });
}

const approve = (body) => request(app).post('/api/v2/order/approve').send(body);

describe('an order short of more than one material', () => {
  it('is refused naming every one of them, not only the first', async () => {
    const rubber = await material('Rubber 40', 5);       // needs 30
    const warp = await material('Polyester 150D', 100);  // needs 40 — enough
    const weft = await material('Nylon 70D', 2.5);       // needs 12
    const cover = await material('Spandex 40D', 0);      // needs 8
    const order = await orderNeeding([[rubber, 30], [warp, 40], [weft, 12], [cover, 8]]);

    const res = await approve({ orderId: String(order._id) });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INSUFFICIENT_STOCK');

    // The first, where older screens look.
    expect(res.body.shortfall).toMatchObject({ materialName: 'Rubber 40', available: 5, required: 30, short: 25 });

    // All of them, for the dialog to list.
    const all = res.body.details.shortfalls;
    expect(all.map((s) => s.materialName)).toEqual(['Rubber 40', 'Nylon 70D', 'Spandex 40D']);
    expect(all.find((s) => s.materialName === 'Nylon 70D')).toMatchObject({ available: 2.5, required: 12, short: 9.5 });
    expect(all.find((s) => s.materialName === 'Spandex 40D')).toMatchObject({ available: 0, required: 8, short: 8 });

    // And in the words every screen shows above the reason box.
    expect(res.body.message).toMatch(/3 materials/);
    for (const name of ['Rubber 40', 'Nylon 70D', 'Spandex 40D']) expect(res.body.message).toContain(name);
    expect(res.body.message).not.toContain('Polyester 150D');

    // Nothing moved.
    expect((await RawMaterial.findById(rubber._id)).stock).toBe(5);
    expect((await Order.findById(order._id)).status).toBe('Open');
  });

  it('with one material short, reads as it always did', async () => {
    const rubber = await material('Rubber 40', 5);
    const warp = await material('Polyester 150D', 100);
    const order = await orderNeeding([[rubber, 30], [warp, 40]]);

    const res = await approve({ orderId: String(order._id) });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Insufficient stock for Rubber 40 (have 5, need 30)');
    expect(res.body.details.shortfalls).toHaveLength(1);
  });

  it('writes figures a person can read, not a float\'s tail', async () => {
    const rubber = await material('Rubber 40', 0.1 + 0.2); // 0.30000000000000004
    const order = await orderNeeding([[rubber, 1.1]]);
    const res = await approve({ orderId: String(order._id) });
    expect(res.body.message).toBe('Insufficient stock for Rubber 40 (have 0.3, need 1.1)');
    expect(res.body.shortfall.short).toBe(0.8);
  });

  it('is not refused for a hair that is not there', async () => {
    // What two receipts left on the shelf: 0.1 + 0.7 is 0.8 to anybody
    // weighing yarn, and 0.7999999999999999 to the arithmetic.
    const rubber = await material('Rubber 40', 0.1 + 0.7);
    expect(rubber.stock).toBeLessThan(0.8);
    const order = await orderNeeding([[rubber, 0.8]]);
    const res = await approve({ orderId: String(order._id) });
    expect(res.status).toBe(200);
    expect((await RawMaterial.findById(rubber._id)).stock).toBe(0);
  });

  it('leaves the shelf weighed to the gram, as every other draw does', async () => {
    const rubber = await material('Rubber 40', 999.6);
    const order = await orderNeeding([[rubber, 0.8]]);
    const res = await approve({ orderId: String(order._id) });
    expect(res.status).toBe(200);
    const after = await RawMaterial.findById(rubber._id).lean();
    expect(after.stock).toBe(998.8);            // not 998.8000000000001
    expect(after.totalConsumption).toBe(0.8);
  });

  it('forced with a reason, goes through and records every shortfall', async () => {
    const rubber = await material('Rubber 40', 5);
    const weft = await material('Nylon 70D', 2.5);
    const order = await orderNeeding([[rubber, 30], [weft, 12]]);

    const res = await approve({ orderId: String(order._id), force: true, forceReason: 'Stock arriving tomorrow' });
    expect(res.status).toBe(200);
    const after = await Order.findById(order._id).lean();
    expect(after.status).toBe('Approved');
    const forced = (after.fingerprints || []).find((f) => f.meta?.forced);
    expect(forced.meta.shortfalls.map((s) => s.materialName)).toEqual(['Rubber 40', 'Nylon 70D']);
    expect((await RawMaterial.findById(rubber._id)).stock).toBe(0);
    expect((await RawMaterial.findById(weft._id)).stock).toBe(0);
  });
});
