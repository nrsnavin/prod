'use strict';
// ══════════════════════════════════════════════════════════════════
//  ONE YARN ENTERED THREE TIMES
//
//    • "40s PC Black", "40/1 PC BLK", "PC 40s black" grouped under one
//      standard name; 30s never joins them
//    • "did you mean" for a new name
//    • merged: receipts, issues, POs, recipes (to any depth) and lots
//      point at the one kept; stock added, cost weighted; the others
//      archived, not deleted; the movement history kept
//    • different units: refused
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, M, admin, a, b, c, d, cones;
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
const get = (u) => request(app).get(`/api/v2/materials${u}`).set('Cookie', cookie());
const post = (u, body) => request(app).post(`/api/v2/materials${u}`).set('Cookie', cookie()).send(body);

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  M = {};
  for (const n of ['User', 'RawMaterial', 'MaterialInward', 'PurchaseOrder', 'AiSuggestion']) M[n] = require(`../../models/${n}.js`);
  admin = await M.User.create({ name: 'Owner', email: 'dedupe@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  const mk = (name, stock, avgCost, extra = {}) => M.RawMaterial.create({ name, category: 'warp', unit: 'kg', stock, avgCost, price: avgCost, minStock: 10, ...extra });
  a = await mk('40s PC Black', 100, 200);
  b = await mk('40/1 PC BLK', 50, 260, { minStock: 40 });
  c = await mk('PC 40s black', 0, 0);
  d = await mk('30s PC Black', 70, 180);
  cones = await mk('40s PC Black cones', 5, 1, { unit: 'cones' });
  await M.RawMaterial.updateOne({ _id: b._id }, { $push: { stockMovements: { date: new Date(), type: 'PO_INWARD', quantity: 50, balance: 50 } } });
  // Things that name b: a receipt, a PO line, an elastic's recipe (two levels deep), a lot.
  const sup = new mongoose.Types.ObjectId();
  await mongoose.connection.collection('materialinwards').insertOne({ rawMaterial: b._id, quantity: 50, inwardDate: new Date() });
  await mongoose.connection.collection('purchaseorders').insertOne({ poNo: 9, supplier: sup, items: [{ rawMaterial: d._id, quantity: 5 }, { rawMaterial: b._id, quantity: 50 }] });
  await mongoose.connection.collection('elastics').insertOne({
    name: '25mm Black', warpYarn: [{ id: d._id, ends: 10 }, { id: b._id, ends: 20 }], weftYarn: { id: c._id },
    warpingPlanTemplate: { beams: [{ sections: [] }, { sections: [{ warpYarn: b._id, ends: 4 }, { warpYarn: d._id, ends: 2 }] }] },
  });
  await mongoose.connection.collection('yarnlots').insertOne({ rawMaterial: b._id, lotNo: 'L1', quantity: 50 });
}, 180_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

describe('duplicate materials', () => {
  it('groups three spellings of one yarn, never with another count', async () => {
    const { groups } = (await get('/duplicates')).body;
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe('40s PC Black');
    expect(groups[0].members.map((m) => m.name).sort()).toEqual(['40/1 PC BLK', '40s PC Black', '40s PC Black cones', 'PC 40s black']);
    expect(groups[0].warning).toMatch(/different units/);
    // The most used is the one to keep.
    expect(groups[0].keep).toBe(String(b._id));
  });

  it('says "did you mean" for a new spelling', async () => {
    const { similar } = (await get('/similar?name=40S%20P.C%20blk&category=warp')).body;
    expect(similar.map((s) => s.name)).toEqual(expect.arrayContaining(['40s PC Black', '40/1 PC BLK', 'PC 40s black']));
    expect(similar.find((s) => s.name === '30s PC Black')).toBeUndefined();
  });

  it('refuses to merge different units', async () => {
    const r = await post('/merge', { into: String(a._id), from: [String(cones._id)] });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/different units/);
  });

  it('merges: every reference moves, stock adds up, the others are archived', async () => {
    const r = await post('/merge', { into: String(a._id), from: [String(b._id), String(c._id)], name: '40s PC Black', proposedName: '40s PC Black' });
    expect(r.status).toBe(200);
    expect(r.body.moved).toMatchObject({ 'MaterialInward.rawMaterial': 1, 'PurchaseOrder.items.rawMaterial': 1, 'Elastic.warpYarn.id': 1, 'Elastic.weftYarn.id': 1, 'Elastic.warpingPlanTemplate.beams.sections.warpYarn': 1, 'YarnLot.rawMaterial': 1 });

    const kept = await M.RawMaterial.findById(a._id).select('+stockMovements').lean();
    expect(kept).toMatchObject({ stock: 150, minStock: 40 });
    expect(kept.avgCost).toBeCloseTo((100 * 200 + 50 * 260) / 150, 2);
    expect(kept.stockMovements.at(-1)).toMatchObject({ type: 'MERGE_IN', quantity: 50, balance: 150 });

    const gone = await M.RawMaterial.findById(b._id).select('+stockMovements').lean();
    expect(gone).toMatchObject({ archived: true, stock: 0, name: '40/1 PC BLK (merged into 40s PC Black)' });
    expect(gone.stockMovements.map((m) => m.type)).toEqual(['PO_INWARD', 'MERGE_OUT']);

    const el = await mongoose.connection.collection('elastics').findOne({});
    expect(el.warpYarn.map((w) => String(w.id))).toEqual([String(d._id), String(a._id)]);
    expect(String(el.weftYarn.id)).toBe(String(a._id));
    expect(el.warpingPlanTemplate.beams[1].sections.map((s) => String(s.warpYarn))).toEqual([String(a._id), String(d._id)]);
    const po = await mongoose.connection.collection('purchaseorders').findOne({});
    expect(po.items.map((i) => String(i.rawMaterial))).toEqual([String(d._id), String(a._id)]);
    expect(String((await mongoose.connection.collection('yarnlots').findOne({})).rawMaterial)).toBe(String(a._id));

    expect((await M.AiSuggestion.findOne({ surface: 'material-dedupe' }).lean()).outcome).toBe('accepted');
    // Nothing left to merge but the cones, which differ in unit.
    expect((await get('/duplicates')).body.groups[0].members).toHaveLength(2);
    // Merging an archived one again: refused.
    expect((await post('/merge', { into: String(a._id), from: [String(b._id)] })).status).toBe(409);
  });
});
