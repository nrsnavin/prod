'use strict';
// ══════════════════════════════════════════════════════════════════
//  "LOW STOCK" ON THE HOME SCREEN
//
//  Found reading api/dashboard.js and services/dashboardOverview.js
//  line by line.
//
//  The tile and the "Materials below minimum" card counted every
//  material at or under its minimum — retired ones included. A material
//  is retired at nothing in stock, and nothing is at or under any
//  minimum: every yarn the mill has stopped buying stayed on the home
//  screen for good, sorted first (lowest stock leads), so the five names
//  under the tile were five that nobody will order again. The card opens
//  the materials list, which leaves retired materials out — a count that
//  matched nothing on the page it led to.
//
//  And a material with no minimum set, out of stock, was described as
//  "0 of 0 minimum" under "below minimum".
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

jest.mock('../../services/etaService', () => ({
  _loadPlantMetersPerMachineDay: async () => 1000,
  _loadFreeMachineCount: async () => 1,
  _computeRunningEtaForOrder: async () => ({ ok: true, expectedDate: new Date(Date.now() + 2 * 86_400_000), risk: { late: false } }),
}));

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, RawMaterial, owner, forgetShared;
const cookie = () => [`token=${jwt.sign({ id: owner._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
const get = (url) => request(app).get(`/api/v2${url}`).set('Cookie', cookie());
const card = (res) => res.body.data.attention.find((a) => a.key === 'lowStock');

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  RawMaterial = require('../../models/RawMaterial');
  ({ forgetShared } = require('../../utils/sharedResult'));
  owner = await require('../../models/User').create({ name: 'Owner', email: 'ls-own@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => { await RawMaterial.deleteMany({}); forgetShared(); });

const material = (name, stock, minStock, more = {}) => ({ name, category: 'warp', stock, minStock, price: 1, ...more });

describe('the low-stock tile', () => {
  it('leaves out materials that have been retired', async () => {
    await RawMaterial.insertMany([
      material('Nylon 70D', 20, 100),
      material('Polyester 150D', 60, 100),
      material('Spandex 40D', 500, 100),                                  // healthy
      material('Old rubber 28s', 0, 0, { archived: true }),               // retired at nothing
      material('Old nylon 40D', 0, 50, { archived: true }),               // retired, a minimum still on it
      material('Old cotton 2/40', 5, 50, { archived: true }),
    ]);

    const res = await get('/dashboard/kpis');
    expect(res.status).toBe(200);
    // Before: 5, led by the three retired ones.
    expect(res.body.data.lowStock.count).toBe(2);
    expect(res.body.data.lowStock.items.map((m) => m.name)).toEqual(['Nylon 70D', 'Polyester 150D']);
  });

  it('is the number the materials list shows when it is asked for what is low', async () => {
    await RawMaterial.insertMany([
      material('Nylon 70D', 20, 100),
      material('Rubber 32s', 0, 0),                                       // out of stock, no minimum: the list flags it
      material('Spandex 40D', 500, 100),
      material('Old rubber 28s', 0, 0, { archived: true }),
    ]);

    const [tile, list] = await Promise.all([get('/dashboard/kpis'), get('/materials/get-raw-materials?lowStock=true')]);
    expect(list.body.materials.map((m) => m.name).sort()).toEqual(['Nylon 70D', 'Rubber 32s']);
    // Before: 3 on the tile, 2 on the list it stands for.
    expect(tile.body.data.lowStock.count).toBe(list.body.materials.length);
  });

  it('counts a material with no "retired" mark at all, as before (unchanged)', async () => {
    // Written before materials could be retired: the field is not there.
    await RawMaterial.collection.insertOne({ name: 'Very old yarn', category: 'warp', stock: 1, minStock: 10, price: 1 });
    const res = await get('/dashboard/kpis');
    expect(res.body.data.lowStock.count).toBe(1);
  });
});

describe('the "Materials below minimum" card', () => {
  it('leaves out retired materials, in the count and in the names', async () => {
    await RawMaterial.insertMany([
      material('Nylon 70D', 20, 100),
      material('Old rubber 28s', 0, 0, { archived: true }),
      material('Old nylon 40D', 0, 50, { archived: true }),
      material('Old cotton 2/40', 5, 50, { archived: true }),
      material('Old lycra', 0, 20, { archived: true }),
    ]);

    const res = await get('/dashboard/overview');
    expect(res.status).toBe(200);
    // Before: 5, and the three names shown were all retired.
    expect(card(res).count).toBe(1);
    expect(card(res).items.map((i) => i.title)).toEqual(['Nylon 70D']);
    expect(card(res).items[0].detail).toBe('20 of 100 minimum');
  });

  it('is not shown at all when the only "low" materials are retired ones', async () => {
    await RawMaterial.insertMany([
      material('Spandex 40D', 500, 100),
      material('Old rubber 28s', 0, 0, { archived: true }),
    ]);
    const res = await get('/dashboard/overview');
    // Before: a card saying 1, for good.
    expect(card(res)).toBeUndefined();
  });

  it('says a material has no minimum, where it has none', async () => {
    await RawMaterial.insertMany([material('Rubber 32s', 0, 0), material('Nylon 70D', 20, 100)]);
    const res = await get('/dashboard/overview');
    const byName = Object.fromEntries(card(res).items.map((i) => [i.title, i.detail]));
    // Before: "0 of 0 minimum".
    expect(byName['Rubber 32s']).toBe('Out of stock — no minimum set');
    expect(byName['Nylon 70D']).toBe('20 of 100 minimum');
  });
});
