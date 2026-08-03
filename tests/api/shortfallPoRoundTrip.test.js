'use strict';
// ══════════════════════════════════════════════════════════════════
//  RAISE A PO FOR AN ORDER'S SHORTFALL, RECEIVE IT, LOOK AGAIN
//
//  Reported as: the MRP still shows the wrong stock, and still shows a
//  shortfall, after a PO raised from the order's own shortfall panel
//  has been received in full.
//
//  Walks the whole loop through the real routes and prints what each
//  step reports, because the fault could be in any of four places —
//  what the PO was raised for, what the receipt credited, what stock
//  says afterwards, or what the MRP computes from it — and three of
//  them would look identical from the screen.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
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

/** One yarn at 1 g/m, one elastic, one order for `metres`. */
async function seed({ stock = 0, metres = 100_000 } = {}) {
  const supplier = await Supplier.create({ name: 'Kumar Yarns', phoneNumber: '9000000001' });
  const yarn = await RawMaterial.create({
    name: 'Nylon 70D', category: 'Yarn', stock, price: 300, supplier: supplier._id,
  });
  const elastic = await Elastic.create({
    name: '20mm', weaveType: '8',
    spandexEnds: 40, yarnEnds: 120, pick: 12, noOfHook: 8, weight: 2.4,
    warpYarn: [{ id: yarn._id, weight: 1 }],   // 1 g/m → 100 kg for 100,000 m
  });
  const customer = await Customer.create({
    name: 'Acme', contactName: 'R', phoneNumber: '9000000002',
  });
  const order = await Order.create({
    orderNo: Math.floor(Math.random() * 100000),
    customer: customer._id, status: 'Open', po: 'ACME-1',
    date: new Date(), supplyDate: new Date(),
    elasticOrdered: [{ elastic: elastic._id, quantity: metres }],
    rawMaterialRequired: [{
      rawMaterial: yarn._id, name: 'Nylon 70D',
      requiredWeight: metres / 1000, inStock: stock,
    }],
  });
  return { supplier, yarn, elastic, customer, order };
}

const mrpRow = async (order, yarn) => {
  const res = await request(app)
    .get(`/api/v2/order/${order._id}/mrp`)
    .set('Cookie', adminCookie());
  if (res.status >= 400) throw new Error(`mrp failed: ${res.status}`);
  return res.body.data.materials.find((m) => String(m.rawMaterial) === String(yarn._id));
};

const raisePo = async (order) => {
  const res = await request(app)
    .post(`/api/v2/order/${order._id}/raise-po`)
    .set('Cookie', adminCookie())
    .send({});
  if (res.status >= 400) throw new Error(`raise-po failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
};

const receiveAll = async (po, yarn, quantity) => {
  const res = await request(app).post('/api/v2/supplier/inward-stock')
    .set('Cookie', adminCookie())
    .send({ poId: String(po._id), items: [{ rawMaterial: String(yarn._id), quantity }] });
  if (res.status >= 400) throw new Error(`inward failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
};

const stockOf = async (yarn) => (await RawMaterial.findById(yarn._id)).stock;

// ── The reported loop, on an order that was never approved ────────────

describe('shortfall → PO → inward → MRP, on an open order', () => {
  it('clears the shortfall once the yarn is in', async () => {
    const s = await seed({ stock: 0, metres: 100_000 });

    const before = await mrpRow(s.order, s.yarn);
    expect(before).toMatchObject({ requiredWeight: 100, inStock: 0, shortfall: 100 });

    const raised = await raisePo(s.order);
    const po = await PurchaseOrder.findById(raised.purchaseOrders[0].poId);
    // The PO is raised for the shortfall, not for the whole requirement.
    expect(po.items[0].quantity).toBe(100);

    await receiveAll(po, s.yarn, 100);
    expect(await stockOf(s.yarn)).toBe(100);

    const after = await mrpRow(s.order, s.yarn);
    expect(after.inStock).toBe(100);
    expect(after.shortfall).toBe(0);
    expect(after.onOrder).toBe(0);
  });

  it('does not buy the same yarn twice when the first PO has not arrived', async () => {
    // Between raising the PO and its delivery the shortfall does not
    // move — the yarn is bought but not in. Pressing the button again
    // in that window used to raise a second purchase order for the
    // same quantity: money out twice for goods nobody ordered.
    const s = await seed({ stock: 0, metres: 100_000 });

    const first = await raisePo(s.order);
    expect(first.purchaseOrders).toHaveLength(1);

    const mid = await mrpRow(s.order, s.yarn);
    expect(mid).toMatchObject({ shortfall: 100, onOrder: 100, toBuy: 0 });

    // The second press has nothing left to buy, and says why.
    const res = await request(app)
      .post(`/api/v2/order/${s.order._id}/raise-po`)
      .set('Cookie', adminCookie())
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/already on order/i);
    expect(await PurchaseOrder.countDocuments({})).toBe(1);
  });

  it('buys only the uncovered part when a PO covers some of the gap', async () => {
    const s = await seed({ stock: 0, metres: 100_000 });

    // A 40 kg PO already placed by hand against the same material.
    await PurchaseOrder.create({
      poNo: 9001, supplier: s.supplier._id, status: 'Open',
      items: [{ rawMaterial: s.yarn._id, quantity: 40, price: 300, receivedQuantity: 0 }],
    });

    const row = await mrpRow(s.order, s.yarn);
    expect(row).toMatchObject({ shortfall: 100, onOrder: 40, toBuy: 60 });

    const raised = await raisePo(s.order);
    const po = await PurchaseOrder.findById(raised.purchaseOrders[0].poId);
    expect(po.items[0].quantity).toBe(60);
  });
});

// ── The same loop on an order that has been APPROVED ──────────────────
//
// Approval debits the requirement from stock. That is the case the
// report is most likely describing, because the order has to be
// approved before a job can be raised on it.

describe('shortfall → PO → inward → MRP, on an approved order', () => {
  async function approve(order, { force = false } = {}) {
    const res = await request(app).post('/api/v2/order/approve')
      .set('Cookie', adminCookie())
      .send({
        orderId: String(order._id),
        ...(force ? { force: true, forceReason: 'proceeding on part stock' } : {}),
      });
    return res;
  }

  it('clears the shortfall once yarn bought elsewhere arrives', async () => {
    // A forced approval allocated nothing, so the order is genuinely
    // short. It cannot be bought from the order any more — that route
    // is closed once the stock is allocated — so this is the PO screen
    // doing it, which is the path the refusal points at.
    const s = await seed({ stock: 0, metres: 100_000 });

    const plain = await approve(s.order);
    const forced = plain.status >= 400 ? await approve(s.order, { force: true }) : plain;
    expect(forced.status).toBeLessThan(400);

    const afterApproval = await mrpRow(s.order, s.yarn);
    expect(afterApproval).toMatchObject({
      requiredWeight: 100, allocated: 0, outstanding: 100, inStock: 0, shortfall: 100,
    });

    const po = await PurchaseOrder.create({
      poNo: 7001, supplier: s.supplier._id, status: 'Open',
      items: [{ rawMaterial: s.yarn._id, quantity: 100, price: 300, receivedQuantity: 0 }],
    });
    await receiveAll(po, s.yarn, 100);
    expect(await stockOf(s.yarn)).toBe(100);

    const afterInward = await mrpRow(s.order, s.yarn);
    expect(afterInward.shortfall).toBe(0);
    expect(afterInward.onOrder).toBe(0);
    // Nothing was drawn at approval, so the whole requirement is still
    // owed out of stock. Saying so is the difference between "covered"
    // and "here, but not yet yours".
    expect(afterInward.allocated).toBe(0);
    expect(afterInward.outstanding).toBe(100);
  });

  it('does not ask for the yarn twice when stock covered it at approval', async () => {
    // Approval consumed 100 of the 100 in stock. The order's needs are
    // met and paid for; a shortfall now would send someone to buy yarn
    // for an order that already has it.
    const s = await seed({ stock: 100, metres: 100_000 });
    const res = await approve(s.order);
    expect(res.status).toBeLessThan(400);

    const after = await mrpRow(s.order, s.yarn);
    expect(after).toMatchObject({
      requiredWeight: 100,
      allocated: 100,       // taken out of stock at approval
      outstanding: 0,    // nothing left to draw
      inStock: 0,        // which is why the balance is zero
      shortfall: 0,
      toBuy: 0,
    });
  });

  it('will not raise a PO once the stock is allocated', async () => {
    // Buying for an order happens before approval. Approval allocated
    // the stock to it — took it out of the balance and held it — so a
    // purchase raised here would be buying a requirement already met.
    const s = await seed({ stock: 100, metres: 100_000 });
    expect((await approve(s.order)).status).toBeLessThan(400);

    const res = await request(app)
      .post(`/api/v2/order/${s.order._id}/raise-po`)
      .set('Cookie', adminCookie())
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('ORDER_ALREADY_APPROVED');
    expect(res.body.message).toMatch(/allocated when it was approved/i);
    expect(await PurchaseOrder.countDocuments({})).toBe(0);
  });

  it('refuses even when a forced approval left a real gap', async () => {
    // The gap is real and nothing is holding it, but this is not the
    // route that buys it — the job that needs it is, and the
    // purchase-order screen is. This one sits next to the requirement,
    // which is why it was the one that doubled up.
    const s = await seed({ stock: 0, metres: 100_000 });
    expect((await approve(s.order, { force: true })).status).toBeLessThan(400);

    const row = await mrpRow(s.order, s.yarn);
    expect(row).toMatchObject({ allocated: 0, outstanding: 100, shortfall: 100 });

    const res = await request(app)
      .post(`/api/v2/order/${s.order._id}/raise-po`)
      .set('Cookie', adminCookie())
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('ORDER_ALREADY_APPROVED');
  });

  it('still raises one while the order is Open', async () => {
    // The rule must not close the door it exists to keep open.
    const s = await seed({ stock: 0, metres: 100_000 });
    const raised = await raisePo(s.order);
    expect(raised.purchaseOrders).toHaveLength(1);
  });

  it('says the stock is allocated on the order detail', async () => {
    const s = await seed({ stock: 100, metres: 100_000 });
    await approve(s.order);

    const res = await request(app)
      .get('/api/v2/order/get-orderDetail')
      .query({ id: String(s.order._id) })
      .set('Cookie', adminCookie());
    expect(res.status).toBeLessThan(400);

    const row = res.body.data.rawMaterialRequired.find(
      (r) => String(r.rawMaterial) === String(s.yarn._id)
    );
    expect(row).toMatchObject({
      requiredWeight: 100,
      allocated: 100,
      outstanding: 0,
      allocationState: 'full',
      stockSufficient: true,
    });
  });

  it('calls a forced approval part-allocated, not allocated', async () => {
    // "Allocated" on a row holding nothing would be the worst kind of
    // wrong: reassuring, and false.
    const s = await seed({ stock: 40, metres: 100_000 });
    await approve(s.order, { force: true });

    const res = await request(app)
      .get('/api/v2/order/get-orderDetail')
      .query({ id: String(s.order._id) })
      .set('Cookie', adminCookie());

    const row = res.body.data.rawMaterialRequired.find(
      (r) => String(r.rawMaterial) === String(s.yarn._id)
    );
    expect(row).toMatchObject({ allocated: 40, outstanding: 60, allocationState: 'partial' });
  });

  it('gives the material back when the order is cancelled', async () => {
    // Cancelling refunds the draw, so the order stops accounting for
    // stock it no longer holds — and a sheet drawn afterwards is short
    // again, correctly.
    const s = await seed({ stock: 100, metres: 100_000 });
    await approve(s.order);
    expect((await mrpRow(s.order, s.yarn)).allocated).toBe(100);

    const res = await request(app).post('/api/v2/order/cancel')
      .set('Cookie', adminCookie())
      .send({ orderId: String(s.order._id), cancelReason: 'customer pulled out' });
    expect(res.status).toBeLessThan(400);

    const after = await mrpRow(s.order, s.yarn);
    expect(after).toMatchObject({ allocated: 0, outstanding: 100, inStock: 100, shortfall: 0 });
  });
});

// ── The same fault, one level down ────────────────────────────────────
//
// A job only exists under an approved order, so every job MRP was
// comparing its requirement against a balance that requirement had
// already been taken out of.

describe('the job MRP under an approved order', () => {
  const Job = () => require('../../models/JobOrder');

  it('does not repeat the order-level shortfall', async () => {
    const s = await seed({ stock: 100, metres: 100_000 });
    await request(app).post('/api/v2/order/approve')
      .set('Cookie', adminCookie())
      .send({ orderId: String(s.order._id) });

    const job = await Job().create({
      order: s.order._id, customer: s.customer._id,
      elastics: [{ elastic: s.elastic._id, quantity: 100_000 }],
      date: new Date(), status: 'preparatory',
    });

    const res = await request(app)
      .get(`/api/v2/job/${job._id}/mrp`)
      .set('Cookie', adminCookie());
    expect(res.status).toBeLessThan(400);

    const row = res.body.data.materials.find(
      (m) => String(m.rawMaterial) === String(s.yarn._id)
    );
    expect(row).toMatchObject({ requiredWeight: 100, allocated: 100, outstanding: 0, shortfall: 0 });
  });

  it('splits the order draw across the jobs that share it', async () => {
    // Two jobs of 50,000 m each under one 100,000 m order: half the
    // draw belongs to each. Crediting either with the whole of it
    // would show the other as short of yarn already on the floor.
    const s = await seed({ stock: 100, metres: 100_000 });
    await request(app).post('/api/v2/order/approve')
      .set('Cookie', adminCookie())
      .send({ orderId: String(s.order._id) });

    const half = await Job().create({
      order: s.order._id, customer: s.customer._id,
      elastics: [{ elastic: s.elastic._id, quantity: 50_000 }],
      date: new Date(), status: 'preparatory',
    });

    const res = await request(app)
      .get(`/api/v2/job/${half._id}/mrp`)
      .set('Cookie', adminCookie());
    const row = res.body.data.materials.find(
      (m) => String(m.rawMaterial) === String(s.yarn._id)
    );
    expect(row).toMatchObject({ requiredWeight: 50, allocated: 50, outstanding: 0, shortfall: 0 });
  });
});
