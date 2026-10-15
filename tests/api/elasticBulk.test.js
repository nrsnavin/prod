'use strict';
// ══════════════════════════════════════════════════════════════════
//  ACTING ON SEVERAL ELASTICS AT ONCE (the list's multi-select)
//
//  Same rules as one at a time, and an answer per elastic: one that
//  cannot be done does not stop the others, and says why.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, admin, production, Elastic, Costing, nylon, rubber, covering, weft;
const cookie = (u) => [`token=${jwt.sign({ id: u._id, role: u.role }, process.env.JWT_SECRET_KEY)}`];
const post = (url, body, u = admin) => request(app).post(url).set('Cookie', cookie(u)).send(body);

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  const User = require('../../models/User');
  const RawMaterial = require('../../models/RawMaterial');
  const Supplier = require('../../models/Supplier');
  Elastic = require('../../models/Elastic');
  Costing = require('../../models/Costing');
  admin = await User.create({ name: 'Owner', email: 'o@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  production = await User.create({ name: 'Floor', email: 'f@t.co', password: 'pass1234', role: 'production', department: 'production' });
  const supplier = await Supplier.create({ name: 'Kumar Yarns', phoneNumber: '9000000001' });
  const mat = (name, category, price) => RawMaterial.create({ name, category, stock: 100, price, supplier: supplier._id });
  nylon = await mat('Nylon', 'warp', 200);
  rubber = await mat('Rubber', 'rubber', 400);
  covering = await mat('Covering', 'covering', 300);
  weft = await mat('Weft', 'weft', 150);
}, 120_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

let n = 0;
async function elastic(over = {}) {
  const e = await Elastic.create({
    name: `E-${++n}`, weaveType: '8', spandexEnds: 40, yarnEnds: 120, pick: 12, noOfHook: 8, weight: 2.4,
    warpYarn: [{ id: nylon._id, weight: 2 }],
    warpSpandex: { id: rubber._id, weight: 0.5 },
    spandexCovering: { id: covering._id, weight: 0.3 },
    weftYarn: { id: weft._id, weight: 1 },
    ...over,
  });
  const c = await Costing.create({ elastic: e._id, conversionCost: 2, materialCost: 0.4, totalCost: 2.4 });
  await Elastic.updateOne({ _id: e._id }, { $set: { costing: c._id } });
  return e;
}

describe('inactivating several', () => {
  it('does the free ones and names the one with stock reserved', async () => {
    const a = await elastic();
    const b = await elastic({ reservedStock: 300 });
    const res = await post('/api/v2/elastic/bulk/archive', { ids: [String(a._id), String(b._id)], archived: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ done: 1, refused: 1 });
    expect(res.body.results.find((r) => r.id === String(b._id)).reason).toMatch(/300 m reserved/);
    expect((await Elastic.findById(a._id).lean()).archived).toBe(true);
    expect((await Elastic.findById(b._id).lean()).archived).toBeFalsy();
  });

  it('reactivates them', async () => {
    const a = await elastic({ archived: true });
    const res = await post('/api/v2/elastic/bulk/archive', { ids: [String(a._id)], archived: false });
    expect(res.body.done).toBe(1);
    expect((await Elastic.findById(a._id).lean()).archived).toBe(false);
  });
});

describe('updating the price (conversion cost) of several', () => {
  it('sets a new conversion cost and re-costs each from today\'s material prices', async () => {
    const a = await elastic();
    const b = await elastic();
    const res = await post('/api/v2/elastic/bulk/costing', { ids: [String(a._id), String(b._id)], conversionCost: 3.5 });
    expect(res.body.done).toBe(2);
    for (const e of [a, b]) {
      const c = await Costing.findOne({ elastic: e._id }).lean();
      expect(c.conversionCost).toBe(3.5);
      expect(c.totalCost).toBeCloseTo(c.materialCost + 3.5, 5);
    }
    expect(res.body.results[0]).toMatchObject({ before: { conversionCost: 2 }, after: { conversionCost: 3.5 } });
  });

  it('changes it by a percentage', async () => {
    const a = await elastic();
    await post('/api/v2/elastic/bulk/costing', { ids: [String(a._id)], changePercent: 10 });
    expect((await Costing.findOne({ elastic: a._id }).lean()).conversionCost).toBe(2.2);
  });

  it('one that cannot be costed is reported, and the rest still are', async () => {
    const good = await elastic();
    const broken = await elastic({ warpSpandex: undefined });
    await Elastic.updateOne({ _id: broken._id }, { $unset: { warpSpandex: 1 } });
    const res = await post('/api/v2/elastic/bulk/costing', { ids: [String(broken._id), String(good._id)], conversionCost: 4 });
    expect(res.body).toMatchObject({ done: 1, refused: 1 });
    expect(res.body.results[0].ok).toBe(false);
    expect((await Costing.findOne({ elastic: good._id }).lean()).conversionCost).toBe(4);
  });

  it('refuses both at once, or nonsense', async () => {
    const a = await elastic();
    expect((await post('/api/v2/elastic/bulk/costing', { ids: [String(a._id)], conversionCost: 3, changePercent: 5 })).status).toBe(400);
    expect((await post('/api/v2/elastic/bulk/costing', { ids: [String(a._id)], changePercent: -95 })).status).toBe(400);
  });
});

describe('the rest', () => {
  it('sets one min stock on several', async () => {
    const a = await elastic();
    const b = await elastic();
    const res = await post('/api/v2/elastic/bulk/min-stock', { ids: [String(a._id), String(b._id)], minStock: 500 });
    expect(res.body.done).toBe(2);
    expect((await Elastic.findById(b._id).lean()).minStock).toBe(500);
  });

  it('wants a selection, and not an enormous one', async () => {
    expect((await post('/api/v2/elastic/bulk/min-stock', { ids: [], minStock: 1 })).status).toBe(400);
    const many = Array.from({ length: 201 }, () => String(new mongoose.Types.ObjectId()));
    expect((await post('/api/v2/elastic/bulk/min-stock', { ids: many, minStock: 1 })).status).toBe(400);
  });

  it('is for admin and accounts only', async () => {
    const a = await elastic();
    expect((await post('/api/v2/elastic/bulk/archive', { ids: [String(a._id)] }, production)).status).toBe(403);
  });
});
