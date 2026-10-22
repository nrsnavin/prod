'use strict';
// ══════════════════════════════════════════════════════════════════
//  ADDING AN ELASTIC TO AN APPROVED ORDER
//
//  Rare, with a reason. The line's own yarn is drawn the way approval
//  draws it — refused short of stock, or forced with a reason to draw
//  what there is — the elastic is reserved, the order's pending and
//  requirement grow by the line, and the amendment is kept. From there
//  the elastic can go on a running job mid-run.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, M, admin;
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
const post = (url, body) => request(app).post(`/api/v2${url}`).set('Cookie', cookie()).send(body);
const get = (url) => request(app).get(`/api/v2${url}`).set('Cookie', cookie());

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  M = {};
  for (const n of ['User', 'Customer', 'Order', 'Elastic', 'RawMaterial', 'JobOrder', 'Machine', 'Employee']) {
    M[n] = require(`../../models/${n}.js`);
  }
  M.MaterialOutward = require('../../models/MaterialOut.cjs');
  admin = await M.User.create({ name: 'Owner', email: 'o@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
}, 120_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (!['users', 'counters'].includes(c.collectionName)) await c.deleteMany({});
  }
});

/**
 * An approved order of one elastic; a second elastic, not on it, whose
 * weft yarn weighs 0.5 g a metre — 1,000 m needs 0.5 kg of it.
 */
async function seed({ weftStock = 100 } = {}) {
  const customer = await M.Customer.create({ name: 'Acme', contactName: 'R', phoneNumber: '9000000001' });
  const weft = await M.RawMaterial.create({ name: 'Poly 300D', category: 'weft', price: 180, stock: weftStock });
  const mk = (name, over = {}) => M.Elastic.create({
    name: `${name} ${Math.random().toString(36).slice(2, 6)}`, weaveType: '8',
    spandexEnds: 40, yarnEnds: 120, pick: 12, noOfHook: 8, weight: 2.4, reservedStock: 0, ...over,
  });
  const a = await mk('20mm White');
  const b = await mk('25mm Black', { weftYarn: { id: weft._id, weight: 0.5 } });
  const order = await M.Order.create({
    orderNo: Math.floor(Math.random() * 100000), customer: customer._id, status: 'Approved', po: 'PO-1',
    date: new Date(), supplyDate: new Date(),
    elasticOrdered: [{ elastic: a._id, quantity: 5000, rate: 12 }],
    pendingElastic: [{ elastic: a._id, quantity: 5000 }],
    producedElastic: [{ elastic: a._id, quantity: 0 }], packedElastic: [{ elastic: a._id, quantity: 0 }],
    reservations: [{ elastic: a._id, quantity: 5000 }],
    rawMaterialRequired: [],
  });
  return { order, a, b, weft, customer };
}

const add = (s, body = {}) => post(`/order/${s.order._id}/add-elastic`, {
  elastic: String(s.b._id), quantity: 1000, rate: 15,
  auditReason: 'Customer added 25mm Black to the PO after approval', ...body,
});

describe('adding an elastic to an approved order', () => {
  it('draws its yarn, reserves it, and puts it on the order with the reason', async () => {
    const s = await seed();
    const res = await add(s);
    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/added to order #\d+ for 1000 m — 1 material drawn\. Elastic reserved\./);
    expect(res.body.materialsDrawn).toEqual([expect.objectContaining({ name: 'Poly 300D', requested: 0.5, applied: 0.5 })]);

    const order = await M.Order.findById(s.order._id).lean();
    const line = order.elasticOrdered.find((l) => String(l.elastic) === String(s.b._id));
    expect(line).toMatchObject({ quantity: 1000, rate: 15, addedLater: true });
    expect(order.pendingElastic.find((p) => String(p.elastic) === String(s.b._id)).quantity).toBe(1000);
    expect(order.reservations.find((p) => String(p.elastic) === String(s.b._id)).quantity).toBe(1000);
    expect(order.rawMaterialRequired.find((r) => String(r.rawMaterial) === String(s.weft._id)).requiredWeight).toBe(0.5);
    expect(order.amendments).toHaveLength(1);
    expect(order.amendments[0]).toMatchObject({ quantity: 1000, forced: false, reason: expect.stringMatching(/after approval/) });
    expect(order.fingerprints.some((f) => f.code === 'ORDER_ELASTIC_ADDED')).toBe(true);

    // The shelf, the ledger and the outward the cancel refund reads.
    expect((await M.RawMaterial.findById(s.weft._id).lean()).stock).toBe(99.5);
    const outward = await M.MaterialOutward.findOne({ order: s.order._id }).lean();
    expect(outward).toMatchObject({ type: 'ORDER_APPROVAL', quantity: 0.5 });
    expect(outward.remarks).toMatch(/amended — 25mm Black/);
    expect((await M.Elastic.findById(s.b._id).lean()).reservedStock).toBe(1000);
  });

  it('refuses when the yarn is short, naming it; forced with a reason, draws what there is', async () => {
    const s = await seed({ weftStock: 0.2 });
    const refused = await add(s);
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe('INSUFFICIENT_STOCK');
    expect(refused.body.shortfall).toMatchObject({ materialName: 'Poly 300D', available: 0.2, required: 0.5, short: 0.3 });
    expect((await M.Order.findById(s.order._id).lean()).elasticOrdered).toHaveLength(1);

    const noReason = await add(s, { force: true });
    expect(noReason.status).toBe(400);
    expect(noReason.body.message).toMatch(/forceReason must be at least/);

    const forced = await add(s, { force: true, forceReason: 'Yarn arriving tomorrow; loom is free today' });
    expect(forced.status).toBe(200);
    expect(forced.body.forced).toBe(true);
    expect(forced.body.materialsDrawn[0]).toMatchObject({ requested: 0.5, applied: 0.2 });
    expect((await M.RawMaterial.findById(s.weft._id).lean()).stock).toBe(0);
    const order = await M.Order.findById(s.order._id).lean();
    expect(order.amendments[0]).toMatchObject({ forced: true, forceReason: expect.stringMatching(/tomorrow/) });
    expect(order.amendments[0].shortfalls[0]).toMatchObject({ name: 'Poly 300D', short: 0.3 });
  });

  it('needs a reason, an elastic not already on the order, and an approved order', async () => {
    const s = await seed();
    expect((await add(s, { auditReason: 'oops' })).body.message).toMatch(/needs a reason/);
    expect((await add(s, { elastic: String(s.a._id) })).body.message).toMatch(/on the order already/);
    await M.Order.updateOne({ _id: s.order._id }, { $set: { status: 'Open' } });
    expect((await add(s)).body.message).toMatch(/not approved yet: edit its lines/);
    await M.Order.updateOne({ _id: s.order._id }, { $set: { status: 'Completed' } });
    expect((await add(s)).status).toBe(400);
    expect((await M.Order.findById(s.order._id).lean()).elasticOrdered).toHaveLength(1);
  });

  it('a stale screen is a 409', async () => {
    const s = await seed();
    expect((await add(s, { expectedVersion: 7 })).status).toBe(409);
  });

  it('shows on the order detail, and a cancel refunds the yarn it drew', async () => {
    const s = await seed();
    await add(s);
    const detail = await get(`/order/get-orderDetail?id=${s.order._id}`);
    expect(detail.status).toBe(200);
    const row = detail.body.data.elastics.find((e) => String(e.id) === String(s.b._id));
    expect(row).toMatchObject({ ordered: 1000, addedLater: true, notAssigned: 1000 });
    expect(detail.body.data.amendments[0]).toMatchObject({ quantity: 1000, materialsDrawn: [expect.objectContaining({ applied: 0.5 })] });

    const cancel = await post('/order/cancel', { orderId: String(s.order._id), reason: 'customer withdrew' });
    expect(cancel.status).toBe(200);
    expect((await M.RawMaterial.findById(s.weft._id).lean()).stock).toBe(100);
  });

  it('once on the order, the elastic can go on a running job mid-run', async () => {
    const s = await seed();
    await add(s);
    const job = await M.JobOrder.create({
      date: new Date(), order: s.order._id, customer: s.customer._id, status: 'weaving',
      elastics: [{ elastic: s.a._id, quantity: 5000 }],
      producedElastic: [{ elastic: s.a._id, quantity: 0 }], packedElastic: [{ elastic: s.a._id, quantity: 0 }], wastageElastic: [{ elastic: s.a._id, quantity: 0 }],
    });
    const candidates = await get(`/job/${job._id}/order-elastics`);
    expect(candidates.body.elastics.find((e) => e.elasticId === String(s.b._id))).toMatchObject({ pending: 1000, onJob: false });
    const res = await post(`/job/${job._id}/change-elastic`, {
      elastic: String(s.b._id), quantity: 1000, freeze: [String(s.a._id)], heads: 'none',
      auditReason: 'Beam for 20mm White ran out; order amended with 25mm Black',
    });
    expect(res.status).toBe(200);
    const after = await M.JobOrder.findById(job._id).lean();
    expect(after.elastics.find((e) => String(e.elastic) === String(s.b._id))).toMatchObject({ quantity: 1000, addedMidRun: true });
  });
});
