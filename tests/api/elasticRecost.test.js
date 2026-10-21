'use strict';
// ══════════════════════════════════════════════════════════════════
//  RECALCULATING AN ELASTIC'S COST
//
//  Cost a metre = Σ (material price ₹/kg × grams a metre / 1000)
//               + conversion cost.
//
//  "Recalculate cost" must take all three as they are NOW: today's
//  material prices, the grammages as last edited, and the conversion
//  cost as last set. And editing the elastic must not lose any of them.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, admin, Elastic, Costing, RawMaterial;
let warp, rubber, cover, weft;

const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
const put = (url, body) => request(app).put(url).set('Cookie', cookie()).send(body);
const post = (url, body) => request(app).post(url).set('Cookie', cookie()).send(body);

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  const User = require('../../models/User');
  const Supplier = require('../../models/Supplier');
  Elastic = require('../../models/Elastic');
  Costing = require('../../models/Costing');
  RawMaterial = require('../../models/RawMaterial');
  admin = await User.create({ name: 'Owner', email: 'o@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  const supplier = await Supplier.create({ name: 'Kumar Yarns', phoneNumber: '9000000001' });
  const mat = (name, category, price) => RawMaterial.create({ name, category, stock: 100, price, supplier: supplier._id });
  warp = await mat('Poly 150D', 'warp', 200);
  rubber = await mat('Spandex 840D', 'rubber', 900);
  cover = await mat('Cover 40D', 'covering', 300);
  weft = await mat('Poly 300D', 'weft', 180);
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

let seq = 0;
/** Created through the API, so it has a cost sheet as it would in use. */
async function makeElastic(conversionCost = 1.5) {
  const res = await post('/api/v2/elastic/create-elastic', {
    name: `20mm Knitted ${seq++}`, weaveType: '8', pick: 12, noOfHook: 8, weight: 2.4, spandexEnds: 40, yarnEnds: 120,
    warpYarn: [{ id: String(warp._id), weight: 1.0 }],
    warpSpandex: { id: String(rubber._id), weight: 0.5 },
    spandexCovering: { id: String(cover._id), weight: 0.2 },
    weftYarn: { id: String(weft._id), weight: 0.4 },
    conversionCost,
  });
  expect(res.status).toBeLessThan(300);
  return Elastic.findOne({ name: `20mm Knitted ${seq - 1}` });
}
const costOf = async (e) => Costing.findById((await Elastic.findById(e._id)).costing).lean();
const round = (n) => Math.round(n * 1000) / 1000;

// 1.0×200 + 0.5×900 + 0.2×300 + 0.4×180 = 200 + 450 + 60 + 72 = 782 → ₹0.782/m
const MATERIAL = 0.782;

test('a new elastic is costed from its grammages and conversion cost', async () => {
  const e = await makeElastic(1.5);
  const c = await costOf(e);
  expect(round(c.materialCost)).toBe(MATERIAL);
  expect(c.conversionCost).toBe(1.5);
  expect(round(c.totalCost)).toBe(round(MATERIAL + 1.5));
});

test('recalculating takes today\'s material prices', async () => {
  const e = await makeElastic(1.5);
  await RawMaterial.updateOne({ _id: warp._id }, { $set: { price: 260 } }); // +60 × 1.0 g = +0.06
  const res = await post('/api/v2/elastic/recalculate-elastic-cost', { elasticId: String(e._id) });
  await RawMaterial.updateOne({ _id: warp._id }, { $set: { price: 200 } });
  expect(res.status).toBe(200);
  expect(round(res.body.costing.materialCost)).toBe(round(MATERIAL + 0.06));
  expect(round(res.body.costing.totalCost)).toBe(round(MATERIAL + 0.06 + 1.5));
  // What it was, so the screen can say what changed.
  expect(round(res.body.before.totalCost)).toBe(round(MATERIAL + 1.5));
});

test('editing a grammage re-costs it, and recalculating keeps the new grammage', async () => {
  const e = await makeElastic(1.5);
  const res = await put('/api/v2/elastic/update-elastic', {
    _id: String(e._id),
    warpYarn: [{ id: String(warp._id), weight: 1.5 }], // +0.5 g × 200 = +0.1
  });
  expect(res.status).toBe(200);
  expect(res.body.costingWarning).toBeUndefined();
  expect(round((await costOf(e)).materialCost)).toBe(round(MATERIAL + 0.1));

  const again = await post('/api/v2/elastic/recalculate-elastic-cost', { elasticId: String(e._id) });
  expect(round(again.body.costing.materialCost)).toBe(round(MATERIAL + 0.1));
});

test('a partial edit is costed from the whole elastic, not just what was sent', async () => {
  // Only the weft changes; the warp, spandex and covering must still count.
  const e = await makeElastic(1.5);
  await put('/api/v2/elastic/update-elastic', { _id: String(e._id), weftYarn: { id: String(weft._id), weight: 0.6 } }); // +0.2 × 180 = +0.036
  const c = await costOf(e);
  expect(round(c.materialCost)).toBe(round(MATERIAL + 0.036));
  expect(c.details.length).toBe(4);
});

test('editing the conversion cost is kept, and recalculating uses it', async () => {
  const e = await makeElastic(1.5);
  const res = await put('/api/v2/elastic/update-elastic', { _id: String(e._id), conversionCost: 2.25 });
  expect(res.status).toBe(200);
  let c = await costOf(e);
  expect(c.conversionCost).toBe(2.25);
  expect(round(c.totalCost)).toBe(round(MATERIAL + 2.25));

  await RawMaterial.updateOne({ _id: weft._id }, { $set: { price: 230 } }); // +50 × 0.4 = +0.02
  const again = await post('/api/v2/elastic/recalculate-elastic-cost', { elasticId: String(e._id) });
  await RawMaterial.updateOne({ _id: weft._id }, { $set: { price: 180 } });
  expect(again.body.costing.conversionCost).toBe(2.25);
  expect(round(again.body.costing.totalCost)).toBe(round(MATERIAL + 0.02 + 2.25));
});

test('a conversion cost of 0 is kept as 0, not replaced by the default', async () => {
  const e = await makeElastic(1.5);
  await put('/api/v2/elastic/update-elastic', { _id: String(e._id), conversionCost: 0 });
  expect((await costOf(e)).conversionCost).toBe(0);
});

test('nonsense for a conversion cost is refused before anything is saved', async () => {
  const e = await makeElastic(1.5);
  const res = await put('/api/v2/elastic/update-elastic', { _id: String(e._id), name: 'Renamed', conversionCost: 'abc' });
  expect(res.status).toBe(400);
  expect((await Elastic.findById(e._id)).name).toBe(e.name);
  expect((await costOf(e)).conversionCost).toBe(1.5);
});

test('a material that cannot be priced leaves the cost sheet as it was, and says so', async () => {
  const e = await makeElastic(1.5);
  const res = await put('/api/v2/elastic/update-elastic', {
    _id: String(e._id), warpYarn: [{ id: String(new mongoose.Types.ObjectId()), weight: 1 }],
  });
  expect(res.status).toBe(200);
  expect(res.body.costingWarning).toMatch(/could not be recalculated/);
  expect(round((await costOf(e)).materialCost)).toBe(MATERIAL); // not zeroed
});

test('a PO received at a new rate is the price the next recalculation uses', async () => {
  const PurchaseOrder = require('../../models/PurchaseOrder');
  const Supplier = require('../../models/Supplier');
  const e = await makeElastic(1.5);
  const supplier = await Supplier.findOne();
  const po = await PurchaseOrder.create({
    supplier: supplier._id,
    items: [{ rawMaterial: warp._id, quantity: 50, price: 230, receivedQuantity: 0 }], // was 200
  });
  const got = await post('/api/v2/supplier/inward-stock', {
    poId: String(po._id), items: [{ rawMaterial: String(warp._id), quantity: 50 }],
  });
  expect(got.status).toBeLessThan(300);

  const m = await RawMaterial.findById(warp._id).lean();
  expect(m.price).toBe(230);
  expect(m.priceHistory.at(-1)).toMatchObject({ price: 230, oldPrice: 200, reason: expect.stringMatching(/^Received on PO/) });

  const res = await post('/api/v2/elastic/recalculate-elastic-cost', { elasticId: String(e._id) });
  expect(round(res.body.costing.materialCost)).toBe(round(MATERIAL + 0.03)); // +30 × 1.0 g
  await RawMaterial.updateOne({ _id: warp._id }, { $set: { price: 200 } });
});

test('a PO line with no price leaves the material price alone', async () => {
  const PurchaseOrder = require('../../models/PurchaseOrder');
  const Supplier = require('../../models/Supplier');
  const supplier = await Supplier.findOne();
  const po = await PurchaseOrder.create({
    supplier: supplier._id,
    items: [{ rawMaterial: cover._id, quantity: 10, price: 0, receivedQuantity: 0 }],
  });
  await post('/api/v2/supplier/inward-stock', { poId: String(po._id), items: [{ rawMaterial: String(cover._id), quantity: 10 }] });
  expect((await RawMaterial.findById(cover._id).lean()).price).toBe(300);
});
