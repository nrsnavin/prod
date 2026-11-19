'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE MATERIAL SCREEN'S OWN PO, RECEIPT AND ADJUSTMENT ROUTES
//
//  Found reading api/rawMaterialStock.js line by line.
//
//  1. "RAISE PO" ON A MATERIAL (the phone app) made a purchase order with
//     NO NUMBER. Only the purchase order form allocated one. The PO then
//     listed without a number, could not be found by one, and its receipts
//     went on the stock ledger with a blank reference. Its lines were also
//     stored exactly as sent: a supplier that does not exist, a negative
//     price, the same material twice — and `receivedQuantity`, so a PO
//     could be created already "received" with no stock behind it.
//
//  2. ITS RECEIPT ROUTE had its own copy of the sum the purchase order
//     form's receipt was fixed for: 227.69 + 168.85 is
//     396.53999999999996, so a PO for 396.54 received in those two lots
//     stayed "Partial". And a material that is not on the PO at all was
//     received anyway: stock went up, against a PO that never moved.
//
//  3. A STOCK ADJUSTMENT added the typed figure to the stock unrounded.
//     250.7 − 0.3 left 250.39999999999998, and because what was applied
//     (−0.30000000000001137) no longer equalled what was asked (−0.3),
//     the answer said the write-off had been cut short, when it had not.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, M, admin, supplier;
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
const post = (url, body) => request(app).post(`/api/v2${url}`).set('Cookie', cookie()).send(body);

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  M = {};
  for (const n of ['RawMaterial', 'PurchaseOrder', 'MaterialInward', 'Supplier', 'User']) M[n] = require(`../../models/${n}`);
  M.MaterialOutward = require('../../models/MaterialOut.cjs');
  admin = await M.User.create({ name: 'Owner', email: 'mat-po@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

beforeEach(async () => {
  supplier = await M.Supplier.create({ name: 'Sri Yarns', phoneNumber: '9000000002' });
});
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    // The PO counter is kept: numbers are never reused.
    if (!['users', 'doc_counters'].includes(c.collectionName)) await c.deleteMany({});
  }
});

let n = 0;
const material = (over = {}) => {
  n += 1;
  return M.RawMaterial.create({ name: `Nylon 70D ${n}`, category: 'Yarn', stock: 100, price: 300, avgCost: 300, ...over });
};
const line = (m, over = {}) => ({ rawMaterial: String(m._id), quantity: 100, price: 310, ...over });
const raise = (items, over = {}) => post('/materials/raise-po', { supplier: String(supplier._id), items, ...over });

// ══════════════════════════════════════════════════════════════════
describe('"Raise PO" on a material', () => {
  it('gives the purchase order the next number, as the purchase order form does', async () => {
    const m = await material();
    const first = await post('/supplier/create-po', { supplier: String(supplier._id), items: [line(m)] });
    expect(first.status).toBe(201);
    const before = first.body.po.poNo;
    expect(Number.isInteger(before)).toBe(true);

    const res = await raise([line(m)]);
    expect(res.status).toBe(201);
    // Before: no number at all.
    expect(res.body.po.poNo).toBe(before + 1);
    expect((await M.PurchaseOrder.findById(res.body.po._id).lean()).poNo).toBe(before + 1);
  });

  it('takes the material, the quantity and the price of a line, and nothing else', async () => {
    const m = await material();
    const res = await raise([line(m, { quantity: 120.12345, receivedQuantity: 120, pendingQuantity: 0 })], { status: 'Completed' });
    expect(res.status).toBe(201);
    const po = await M.PurchaseOrder.findById(res.body.po._id).lean();
    // Before: received 120 and nothing in stock to show for it.
    expect(po.items[0]).toMatchObject({ quantity: 120.123, price: 310, receivedQuantity: 0 });
    expect(po.status).toBe('Open');
  });

  it.each([
    ['a supplier that does not exist', (m) => raise([line(m)], { supplier: String(new mongoose.Types.ObjectId()) }), /supplier does not exist/i],
    ['a supplier id that is not one', (m) => raise([line(m)], { supplier: 'sri-yarns' }), /supplier does not exist/i],
    ['a negative price', (m) => raise([line(m, { price: -5 })]), /price/i],
    ['the same material on two lines', (m) => raise([line(m), line(m, { quantity: 50 })]), /already on this purchase order/i],
    ['a material that does not exist', () => raise([{ rawMaterial: String(new mongoose.Types.ObjectId()), quantity: 10, price: 5 }]), /does not exist/i],
    ['a quantity of nothing', (m) => raise([line(m, { quantity: 0 })]), /quantity/i],
    ['no lines', () => raise([]), /at least one item/i],
  ])('refuses %s', async (_what, send, saying) => {
    const m = await material();
    const res = await send(m);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(saying);
    expect(await M.PurchaseOrder.countDocuments({})).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('receiving against a PO from the material screen', () => {
  const receive = (po, m, quantity) =>
    post('/materials/material-inward', { rawMaterialId: String(m._id), purchaseOrderId: String(po._id), quantity });

  it('two lots with decimals complete the order', async () => {
    const m = await material({ stock: 0 });
    const po = (await raise([line(m, { quantity: 396.54 })])).body.po;

    expect((await receive(po, m, 227.69)).status).toBe(201);
    expect((await M.PurchaseOrder.findById(po._id).lean()).status).toBe('Partial');
    expect((await receive(po, m, 168.85)).status).toBe(201);

    const after = await M.PurchaseOrder.findById(po._id).lean();
    // Before: 396.53999999999996 received, and "Partial" for good.
    expect(after.items[0].receivedQuantity).toBe(396.54);
    expect(after.status).toBe('Completed');
    expect((await M.RawMaterial.findById(m._id).lean()).stock).toBe(396.54);
  });

  it('refuses a material that is not on that PO, and takes nothing into stock', async () => {
    const ordered = await material({ stock: 0 });
    const other = await material({ stock: 40 });
    const po = (await raise([line(ordered)])).body.po;

    const res = await receive(po, other, 25);
    // Before: 201 — 25 kg into stock against a PO that never moved.
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/not (on|part of) (this )?(PO|purchase order)/i);
    expect((await M.RawMaterial.findById(other._id).lean()).stock).toBe(40);
    expect(await M.MaterialInward.countDocuments({})).toBe(0);
    expect((await M.PurchaseOrder.findById(po._id).lean()).status).toBe('Open');
  });

  it('keeps the received quantity to the gram', async () => {
    const m = await material({ stock: 0 });
    const po = (await raise([line(m)])).body.po;
    expect((await receive(po, m, 12.34567)).status).toBe(201);
    expect((await M.PurchaseOrder.findById(po._id).lean()).items[0].receivedQuantity).toBe(12.346);
    expect((await M.MaterialInward.findOne({}).lean()).quantity).toBe(12.346);
    expect((await M.RawMaterial.findById(m._id).lean()).stock).toBe(12.346);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('adjusting stock by hand', () => {
  const adjust = (adjustments, over = {}) => post('/materials/bulk-adjust-stock', { adjustments, ...over });

  it('leaves the figure it was adjusted to, and says what it moved by', async () => {
    const m = await material({ stock: 250.7 });
    const res = await adjust([{ _id: String(m._id), adjustment: -0.3, reason: 'Cone damaged' }]);
    expect(res.status).toBe(200);
    // Before: newStock 250.39999999999998, adjustment −0.30000000000001137,
    // and `requested: −0.3` — as though the write-off had been cut short.
    expect(res.body.updated[0]).toMatchObject({ oldStock: 250.7, newStock: 250.4, adjustment: -0.3 });
    expect(res.body.updated[0].requested).toBeUndefined();

    const after = await M.RawMaterial.findById(m._id).select('+stockMovements').lean();
    expect(after.stock).toBe(250.4);
    const row = after.stockMovements[after.stockMovements.length - 1];
    expect(row).toMatchObject({ type: 'STOCK_ADJUST', quantity: -0.3, balance: 250.4 });
    expect(row.requested).toBeUndefined();
    expect((await M.MaterialOutward.findOne({ rawMaterial: m._id }).lean()).quantity).toBe(0.3);
  });

  it('is to the gram', async () => {
    const m = await material({ stock: 10 });
    const res = await adjust([{ _id: String(m._id), adjustment: 0.12345, reason: 'Found on the rack' }]);
    expect(res.body.updated[0]).toMatchObject({ newStock: 10.123, adjustment: 0.123 });
    expect((await M.MaterialInward.findOne({ rawMaterial: m._id }).lean()).quantity).toBe(0.123);
  });

  it('still says when a write-off was cut short by what was there', async () => {
    const m = await material({ stock: 30 });
    const res = await adjust([{ _id: String(m._id), adjustment: -50, reason: 'Written off' }]);
    expect(res.body.updated[0]).toMatchObject({ oldStock: 30, newStock: 0, adjustment: -30, requested: -50 });
  });

  it('takes a reason that was sent as a number', async () => {
    const m = await material({ stock: 30 });
    const res = await adjust([{ _id: String(m._id), adjustment: -1, reason: 42 }]);
    // Before: the item failed with "item.reason?.trim is not a function".
    expect(res.body.errors).toBeUndefined();
    expect(res.body.updated).toHaveLength(1);
  });

  it.each([['nothing', null], ['text', 'all of them']])('adjustments sent as %s is a bad request, not a server error', async (_what, adjustments) => {
    const res = await adjust(adjustments);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/adjustments/i);
  });

  it('an entry that is not an adjustment is passed over, and the rest are done', async () => {
    const m = await material({ stock: 30 });
    const res = await adjust([null, { _id: String(m._id), adjustment: -1, reason: 'Sample cut' }]);
    expect(res.status).toBe(200);
    expect(res.body.updated).toHaveLength(1);
    expect(res.body.skipped).toBe(1);
  });
});
