'use strict';
// ══════════════════════════════════════════════════════════════════
//  AN ELASTIC'S COST SHEET — GET/POST /elastic/:id/cost-sheet
//
//  Every material in the recipe with today's price, its cost in a
//  metre, and the price the last costing used; saving changes the
//  material's price (with history) and the conversion cost, re-costs
//  the elastic, and — if asked — every other elastic on a changed
//  material.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, admin, production, Elastic, Costing, RawMaterial;
let warp, rubber, cover, weft, other;

const cookie = (u = admin) => [`token=${jwt.sign({ id: u._id, role: u.role }, process.env.JWT_SECRET_KEY)}`];
const get = (url, u) => request(app).get(url).set('Cookie', cookie(u));
const post = (url, body, u) => request(app).post(url).set('Cookie', cookie(u)).send(body);

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  const User = require('../../models/User');
  const Supplier = require('../../models/Supplier');
  const { ALWAYS_ON } = require('../../utils/features');
  Elastic = require('../../models/Elastic');
  Costing = require('../../models/Costing');
  RawMaterial = require('../../models/RawMaterial');
  admin = await User.create({ name: 'Owner', email: 'o@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  production = await User.create({
    name: 'Floor', email: 'f@t.co', password: 'pass1234', role: 'production', department: 'production',
    features: [...ALWAYS_ON, '/elastics'],
  });
  const supplier = await Supplier.create({ name: 'Kumar Yarns', phoneNumber: '9000000001' });
  const mat = (name, category, price) => RawMaterial.create({ name, category, stock: 100, price, supplier: supplier._id });
  warp = await mat('Poly 150D', 'warp', 200);
  rubber = await mat('Spandex 840D', 'rubber', 900);
  cover = await mat('Cover 40D', 'covering', 300);
  weft = await mat('Poly 300D', 'weft', 180);
  other = await mat('Nylon 70D', 'warp', 400);
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

let seq = 0;
async function makeElastic(conversionCost = 1.5, warpYarn = [{ id: String(warp._id), weight: 1.0 }]) {
  const name = `25mm Woven ${seq++}`;
  const res = await post('/api/v2/elastic/create-elastic', {
    name, weaveType: '8', pick: 12, noOfHook: 8, weight: 2.4, spandexEnds: 40, yarnEnds: 120,
    warpYarn,
    warpSpandex: { id: String(rubber._id), weight: 0.5 },
    spandexCovering: { id: String(cover._id), weight: 0.2 },
    weftYarn: { id: String(weft._id), weight: 0.4 },
    conversionCost,
  });
  expect(res.status).toBeLessThan(300);
  return Elastic.findOne({ name });
}
const round = (n) => Math.round(n * 1000) / 1000;
const resetPrices = () => Promise.all([
  RawMaterial.updateOne({ _id: warp._id }, { $set: { price: 200 } }),
  RawMaterial.updateOne({ _id: rubber._id }, { $set: { price: 900 } }),
  RawMaterial.updateOne({ _id: weft._id }, { $set: { price: 180 } }),
]);
afterEach(resetPrices);

// 1.0×200 + 0.5×900 + 0.2×300 + 0.4×180 = 782 → ₹0.782 a metre
const MATERIAL = 0.782;

describe('reading the cost sheet', () => {
  it('lists every material with grams, today\'s price and its cost a metre', async () => {
    const e = await makeElastic(1.5);
    const res = await get(`/api/v2/elastic/${e._id}/cost-sheet`);
    expect(res.status).toBe(200);
    const { sheet } = res.body;
    expect(sheet.lines.map((l) => l.role)).toEqual(['Warp spandex', 'Spandex covering', 'Weft yarn', 'Warp yarn 1']);
    expect(sheet.lines[0]).toMatchObject({
      material: { id: String(rubber._id), name: 'Spandex 840D' }, grams: 0.5, price: 900, cost: 0.45, costedRate: 900, priceChanged: false,
    });
    expect(round(sheet.now.materialCost)).toBe(MATERIAL);
    expect(sheet.now.conversionCost).toBe(1.5);
    expect(round(sheet.now.totalCost)).toBe(round(MATERIAL + 1.5));
    expect(round(sheet.costed.totalCost)).toBe(round(MATERIAL + 1.5));
    expect(sheet.stale).toBe(false);
  });

  it('marks a price that moved since the last costing, and the total as out of date', async () => {
    const e = await makeElastic(1.5);
    await RawMaterial.updateOne({ _id: warp._id }, { $set: { price: 260 } });
    const { sheet } = (await get(`/api/v2/elastic/${e._id}/cost-sheet`)).body;
    const line = sheet.lines.find((l) => l.role === 'Warp yarn 1');
    expect(line).toMatchObject({ price: 260, costedRate: 200, priceChanged: true, cost: 0.26 });
    expect(round(sheet.now.totalCost)).toBe(round(MATERIAL + 0.06 + 1.5));
    expect(sheet.stale).toBe(true);
  });

  it('says how many other elastics share each material', async () => {
    const a = await makeElastic(1.5);
    const before = (await get(`/api/v2/elastic/${a._id}/cost-sheet`)).body.sheet.lines.find((l) => l.role === 'Warp yarn 1').sharedWith;
    await makeElastic(1.5);
    const after = (await get(`/api/v2/elastic/${a._id}/cost-sheet`)).body.sheet.lines.find((l) => l.role === 'Warp yarn 1').sharedWith;
    expect(after).toBe(before + 1);
  });

  it('is 404 for an elastic that does not exist', async () => {
    expect((await get(`/api/v2/elastic/${new mongoose.Types.ObjectId()}/cost-sheet`)).status).toBe(404);
  });
});

describe('saving the cost sheet', () => {
  it('changes the material price with history, the conversion cost, and re-costs the elastic', async () => {
    const e = await makeElastic(1.5);
    const res = await post(`/api/v2/elastic/${e._id}/cost-sheet`, {
      prices: [{ material: String(warp._id), price: 250 }, { material: String(rubber._id), price: 900 }],
      conversionCost: 2,
      reason: 'October revision',
    });
    expect(res.status).toBe(200);
    // Only the price that moved is reported and written.
    expect(res.body.changed).toEqual([{ id: String(warp._id), name: 'Poly 150D', oldPrice: 200, newPrice: 250 }]);
    const m = await RawMaterial.findById(warp._id).lean();
    expect(m.price).toBe(250);
    expect(m.priceHistory.slice(-1)[0]).toMatchObject({ price: 250, oldPrice: 200, reason: 'October revision' });
    // +50 × 1.0 g = +0.05
    expect(round(res.body.costing.materialCost)).toBe(round(MATERIAL + 0.05));
    expect(res.body.costing.conversionCost).toBe(2);
    expect(round(res.body.costing.totalCost)).toBe(round(MATERIAL + 0.05 + 2));
    expect(res.body.sheet.stale).toBe(false);
    expect(res.body.others).toEqual({ recosted: 0, failed: [] });
  });

  it('keeps the conversion cost when none is given, and recalculates on today\'s prices alone', async () => {
    const e = await makeElastic(1.75);
    await RawMaterial.updateOne({ _id: weft._id }, { $set: { price: 280 } }); // +100 × 0.4 = +0.04
    const res = await post(`/api/v2/elastic/${e._id}/cost-sheet`, { prices: [] });
    expect(res.status).toBe(200);
    expect(res.body.costing.conversionCost).toBe(1.75);
    expect(round(res.body.costing.totalCost)).toBe(round(MATERIAL + 0.04 + 1.75));
  });

  it('re-costs the other elastics on a changed material when asked, and only then', async () => {
    const a = await makeElastic(1.5);
    const b = await makeElastic(1.5);
    const untouched = await makeElastic(1.5, [{ id: String(other._id), weight: 1.0 }]);
    const costOf = async (e) => Costing.findById((await Elastic.findById(e._id)).costing).lean();
    const untouchedBefore = (await costOf(untouched)).totalCost;

    await post(`/api/v2/elastic/${a._id}/cost-sheet`, { prices: [{ material: String(warp._id), price: 220 }] });
    expect(round((await costOf(b)).totalCost)).toBe(round(MATERIAL + 1.5)); // not asked: still the old price

    const res = await post(`/api/v2/elastic/${a._id}/cost-sheet`, {
      prices: [{ material: String(warp._id), price: 300 }], recostOthers: true,
    });
    expect(res.status).toBe(200);
    expect(res.body.others.recosted).toBeGreaterThanOrEqual(1);
    expect(round((await costOf(b)).materialCost)).toBe(round(MATERIAL + 0.1));
    // An elastic without the material is not touched.
    expect((await costOf(untouched)).totalCost).toBe(untouchedBefore);
  });

  it('refuses a price for a material the elastic does not use, and a bad price or conversion cost', async () => {
    const e = await makeElastic(1.5);
    const url = `/api/v2/elastic/${e._id}/cost-sheet`;
    const notOurs = await post(url, { prices: [{ material: String(other._id), price: 10 }] });
    expect(notOurs.status).toBe(400);
    expect(notOurs.body.message).toMatch(/does not use/);
    expect((await post(url, { prices: [{ material: String(warp._id), price: -1 }] })).status).toBe(400);
    expect((await post(url, { prices: [{ material: String(warp._id), price: '' }] })).status).toBe(400);
    expect((await post(url, { conversionCost: -2 })).status).toBe(400);
    expect((await RawMaterial.findById(warp._id).lean()).price).toBe(200);
  });

  it('is for admin and accounts, not the floor', async () => {
    const e = await makeElastic(1.5);
    const res = await post(`/api/v2/elastic/${e._id}/cost-sheet`, { prices: [{ material: String(warp._id), price: 999 }] }, production);
    expect([401, 403]).toContain(res.status);
    expect((await RawMaterial.findById(warp._id).lean()).price).toBe(200);
  });
});
