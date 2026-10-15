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

// ══════════════════════════════════════════════════════════════════
//  The second round: template copy, testing, low stock, PDFs, groups,
//  restock.
// ══════════════════════════════════════════════════════════════════
describe('copying a warping template', () => {
  const tpl = (yarn) => ({ noOfBeams: 1, beams: [{ beamNo: 1, totalEnds: 140, sections: [{ warpYarn: yarn, ends: 140, maxMeters: 2250 }] }] });

  it('copies to elastics that use the yarns, names the rest, and keeps existing templates unless told', async () => {
    const source = await elastic({ warpingPlanTemplate: tpl(nylon._id) });
    const fits = await elastic();
    const other = await elastic({ warpYarn: [{ id: weft._id, weight: 1 }] });
    const has = await elastic({ warpingPlanTemplate: tpl(nylon._id) });
    const res = await post('/api/v2/elastic/bulk/copy-template', {
      sourceId: String(source._id), ids: [String(fits._id), String(other._id), String(has._id)],
    });
    expect(res.body).toMatchObject({ done: 1, refused: 2 });
    expect(res.body.results.find((r) => r.id === String(other._id)).reason).toMatch(/every warp yarn/);
    expect(res.body.results.find((r) => r.id === String(has._id)).reason).toMatch(/Already has a template/);
    expect((await Elastic.findById(fits._id).lean()).warpingPlanTemplate.beams[0].sections[0].ends).toBe(140);

    const again = await post('/api/v2/elastic/bulk/copy-template', { sourceId: String(source._id), ids: [String(has._id)], replace: true });
    expect(again.body.done).toBe(1);
  });

  it('needs a source with a template', async () => {
    const source = await elastic();
    const t = await elastic();
    expect((await post('/api/v2/elastic/bulk/copy-template', { sourceId: String(source._id), ids: [String(t._id)] })).status).toBe(400);
  });
});

describe('testing parameters for a family', () => {
  it('sets only what is sent', async () => {
    const a = await elastic({ testingParameters: { width: 20, elongation: 120, recovery: 90 } });
    const res = await post('/api/v2/elastic/bulk/testing', { ids: [String(a._id)], elongation: 150, strech: 'firm' });
    expect(res.body.done).toBe(1);
    expect((await Elastic.findById(a._id).lean()).testingParameters).toMatchObject({ width: 20, elongation: 150, recovery: 90, strech: 'firm' });
  });

  it('refuses nonsense and an empty change', async () => {
    const a = await elastic();
    expect((await post('/api/v2/elastic/bulk/testing', { ids: [String(a._id)], recovery: 150 })).status).toBe(400);
    expect((await post('/api/v2/elastic/bulk/testing', { ids: [String(a._id)] })).status).toBe(400);
  });
});

describe('the low stock list', () => {
  it('lists elastics whose free stock is at or under their reorder level', async () => {
    const low = await elastic({ stock: 600, reservedStock: 300, minStock: 400 }); // free 300 ≤ 400
    const fine = await elastic({ stock: 900, reservedStock: 0, minStock: 400 });
    const noMin = await elastic({ stock: 0, minStock: 0 });
    const res = await request(app).get('/api/v2/elastic/get-elastics').set('Cookie', cookie(admin))
      .query({ lowStock: 'true', limit: 200 });
    const ids = res.body.elastics.map((e) => e._id);
    expect(ids).toContain(String(low._id));
    expect(ids).not.toContain(String(fine._id));
    expect(ids).not.toContain(String(noMin._id));
  });
});

describe('PDFs for a customer', () => {
  beforeAll(() => { process.env.PDF_IN_THREAD = '1'; });

  it('prints a spec sheet for the selection', async () => {
    const a = await elastic({ testingParameters: { width: 25, elongation: 130, recovery: 90 } });
    const res = await request(app).post('/api/v2/elastic/bulk/spec-sheet').set('Cookie', cookie(admin))
      .send({ ids: [String(a._id)] }).buffer(true).parse((r, cb) => { const c = []; r.on('data', (d) => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
  });

  it('prints a price list at cost plus margin, and refuses one with no cost sheet', async () => {
    const a = await elastic();
    const ok = await request(app).post('/api/v2/elastic/bulk/price-list').set('Cookie', cookie(admin))
      .send({ ids: [String(a._id)], marginPercent: 25, customerName: 'Ravi Textiles', gstPercent: 5 });
    expect(ok.status).toBe(200);
    expect(ok.headers['content-type']).toBe('application/pdf');

    const bare = await Elastic.create({ name: `Bare-${++n}`, weaveType: '8', spandexEnds: 40, yarnEnds: 120, pick: 12, noOfHook: 8, weight: 2 });
    const res = await post('/api/v2/elastic/bulk/price-list', { ids: [String(bare._id)], marginPercent: 25 });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/No cost sheet yet/);
  });
});

describe('adding to an existing group', () => {
  it('adds the new ones and keeps what the group has', async () => {
    const ElasticGroup = require('../../models/ElasticGroup');
    const a = await elastic();
    const b = await elastic();
    const group = await ElasticGroup.create({ name: 'Ravi usual', items: [{ elastic: a._id, defaultQuantity: 500 }] });
    const res = await post(`/api/v2/elastic-group/${group._id}/add-elastics`, { elastics: [String(a._id), String(b._id)] });
    expect(res.body).toMatchObject({ added: 1, alreadyThere: 1 });
    const after = await ElasticGroup.findById(group._id).lean();
    expect(after.items).toHaveLength(2);
    expect(after.items.find((i) => String(i.elastic) === String(a._id)).defaultQuantity).toBe(500);
  });
});

describe('restocking', () => {
  it('raises an Open order for the house customer, made once and reused', async () => {
    const Order = require('../../models/Order');
    const Customer = require('../../models/Customer');
    const a = await elastic();
    const first = await post('/api/v2/order/restock', { lines: [{ elastic: String(a._id), quantity: 1000 }] });
    expect(first.status).toBe(201);
    const order = await Order.findById(first.body.orderId).populate('customer').lean();
    expect(order).toMatchObject({ status: 'Open' });
    expect(order.customer).toMatchObject({ houseStock: true, name: 'Own stock (restock)' });
    expect(order.elasticOrdered[0]).toMatchObject({ quantity: 1000 });
    expect(order.po).toMatch(/^STOCK-\d{8}$/);

    await post('/api/v2/order/restock', { lines: [{ elastic: String(a._id), quantity: 500 }] });
    expect(await Customer.countDocuments({ houseStock: true })).toBe(1);
  });

  it('refuses an empty restock', async () => {
    expect((await post('/api/v2/order/restock', { lines: [] })).status).toBe(400);
  });
});
