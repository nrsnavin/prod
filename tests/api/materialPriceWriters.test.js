'use strict';
// ══════════════════════════════════════════════════════════════════
//  A MATERIAL'S PRICE, AND A FORM THAT WAS ALREADY OPEN
//
//  Found reading api/rawMaterialTools.js line by line.
//
//  1. A NEW PRICE COULD BE UNDONE BY SAVING AN OLD FORM. The material's
//     edit form sends its price with every save — the price it loaded.
//     A save from a form somebody else has since changed is refused
//     ("the record's version has moved")... but two things changed the
//     price WITHOUT moving the version: a price set from the list
//     (POST /materials/bulk-update-prices) and a receipt at a new rate.
//     Open the form, let the month's price revision go in, change the
//     minimum stock and save: the old price was back, with a line in the
//     price history saying somebody had edited it by hand.
//
//  2. THE LIST'S PRICE UPDATE WROTE WHAT IT HAD READ A MOMENT BEFORE.
//     The same material twice in one request made two history lines
//     from the same starting price; an id that is not one failed the
//     request after the other prices had already been written; and
//     "updates": null, or a reason that is not text, was a server error.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, admin;
const M = {};
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
const post = (url, body) => request(app).post(`/api/v2${url}`).set('Cookie', cookie()).send(body);
const put  = (url, body) => request(app).put(`/api/v2${url}`).set('Cookie', cookie()).send(body);

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  for (const n of ['User', 'RawMaterial', 'Supplier', 'PurchaseOrder']) M[n] = require(`../../models/${n}.js`);
  admin = await M.User.create({ name: 'Owner', email: 'material-prices@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
});

let seq = 0;
async function material(over = {}) {
  seq += 1;
  const supplier = await M.Supplier.create({ name: `Kumar Yarns ${seq}`, phoneNumber: '9000000001' });
  const yarn = await M.RawMaterial.create({ name: `Nylon ${seq}`, category: 'warp', stock: 100, minStock: 10, price: 300, avgCost: 300, supplier: supplier._id, ...over });
  return { supplier, yarn };
}
const fresh = (s) => M.RawMaterial.findById(s.yarn._id).lean();
const setPrices = (updates, reason = 'April revision') => post('/materials/bulk-update-prices', { updates, reason });
const editFromForm = (s, opened, change) => put('/materials/edit-raw-material', {
  _id: String(s.yarn._id), name: opened.name, price: opened.price, minStock: opened.minStock, unit: opened.unit,
  expectedVersion: opened.__v, ...change,
});

// ══════════════════════════════════════════════════════════════════
describe('a form opened before the price changed', () => {
  it('does not put the old price back after a price set from the list', async () => {
    const s = await material();
    const opened = await fresh(s);                              // the form loads: ₹300
    expect((await setPrices([{ _id: String(s.yarn._id), price: 350 }])).body.updated).toBe(1);

    const res = await editFromForm(s, opened, { minStock: 25 });
    // Before: 200 — ₹300 again, and "Manual edit" in the price history.
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('VERSION_CONFLICT');

    const now = await fresh(s);
    expect(now.price).toBe(350);
    expect(now.minStock).toBe(10);
    expect(now.priceHistory.map((h) => [h.oldPrice, h.price, h.reason])).toEqual([[300, 350, 'April revision']]);
  });

  it('nor after a receipt at a new rate', async () => {
    const s = await material();
    const po = await M.PurchaseOrder.create({
      poNo: 8101, supplier: s.supplier._id, status: 'Open',
      items: [{ rawMaterial: s.yarn._id, quantity: 100, price: 330, receivedQuantity: 0 }],
    });
    const opened = await fresh(s);
    const received = await post('/supplier/inward-stock', { poId: String(po._id), items: [{ rawMaterial: String(s.yarn._id), quantity: 50 }] });
    expect(received.status).toBeLessThan(300);
    expect((await fresh(s)).price).toBe(330);

    const res = await editFromForm(s, opened, { minStock: 25 });
    // Before: 200 — the latest purchase price back at ₹300.
    expect(res.status).toBe(409);
    expect((await fresh(s)).price).toBe(330);
  });

  it('a form opened afterwards saves as usual', async () => {
    const s = await material();
    await setPrices([{ _id: String(s.yarn._id), price: 350 }]);
    const opened = await fresh(s);
    const res = await editFromForm(s, opened, { minStock: 25 });
    expect(res.status).toBe(200);
    expect(await fresh(s)).toMatchObject({ price: 350, minStock: 25 });
  });
});

describe('setting prices from the list', () => {
  it('writes each change once, with what it changed from', async () => {
    const a = await material();
    const b = await material({ price: 120 });
    const res = await setPrices([{ _id: String(a.yarn._id), price: 350 }, { _id: String(b.yarn._id), price: '125.50' }]);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ updated: 2, skipped: 0 });
    expect(res.body.results.map((r) => [r.oldPrice, r.newPrice, r.change]).sort()).toEqual([[120, 125.5, 5.5], [300, 350, 50]]);
    expect((await fresh(b)).priceHistory).toHaveLength(1);
  });

  it('refuses the same material twice in one go', async () => {
    const s = await material();
    const res = await setPrices([{ _id: String(s.yarn._id), price: 350 }, { _id: String(s.yarn._id), price: 360 }]);
    // Before: 200, and two history lines both "from ₹300".
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/more than once/);
    expect(await fresh(s)).toMatchObject({ price: 300, priceHistory: [] });
  });

  it('writes nothing when one of the ids is not an id', async () => {
    const s = await material();
    const res = await setPrices([{ _id: String(s.yarn._id), price: 350 }, { _id: 'not-an-id', price: 10 }]);
    expect(res.status).toBe(400);
    // Before: refused — after the first price had already been written.
    expect((await fresh(s)).price).toBe(300);
  });

  it.each([
    ['no list at all', { updates: null }],
    ['a list that is not one', { updates: 'all of them' }],
    ['an empty list', { updates: [] }],
  ])('%s is a bad request', async (_what, body) => {
    const res = await post('/materials/bulk-update-prices', body);
    // Before: a server error for the first.
    expect(res.status).toBe(400);
  });

  it('takes a reason that is not text as text', async () => {
    const s = await material();
    const res = await post('/materials/bulk-update-prices', { updates: [{ _id: String(s.yarn._id), price: 350 }], reason: 42 });
    // Before: a server error — and, the write being in flight, sometimes the price as well.
    expect(res.status).toBe(200);
    expect((await fresh(s)).priceHistory[0].reason).toBe('42');
  });

  it('skips a price that has not changed, and a material that is not there (unchanged)', async () => {
    const s = await material();
    const res = await setPrices([{ _id: String(s.yarn._id), price: 300 }, { _id: String(new mongoose.Types.ObjectId()), price: 10 }]);
    expect(res.body).toMatchObject({ updated: 0, skipped: 2 });
    expect((await fresh(s)).priceHistory).toEqual([]);
  });

  it('refuses a negative price (unchanged)', async () => {
    const s = await material();
    expect((await setPrices([{ _id: String(s.yarn._id), price: -1 }])).status).toBe(400);
  });
});
