'use strict';
// ══════════════════════════════════════════════════════════════════
//  PURCHASE ORDERS: THE LINES ON ONE, AND RECEIVING AGAINST IT
//
//  Found reading api/supplier.js and utils/materialValuation.js line by
//  line.
//
//  1. DECIMAL KILOGRAMS. What comes in is added up in floating point:
//     227.69 + 168.85 is 396.53999999999996, a hair short of the 396.54
//     ordered. A PO received in two lots stayed "Partial" for good, with
//     a pending quantity too small to see and impossible to receive —
//     about one two-lot decimal PO in ten. The shelf drifted the same
//     way (0.1 + 0.2 kg stored as 0.30000000000000004).
//
//  2. ONE MATERIAL ON TWO LINES. A receipt finds "the" line for its
//     material — the first. The second line could never be received, so
//     the PO never completed. Nothing stopped such a PO being raised.
//
//  3. A PO could be raised on a supplier or a material that does not
//     exist, at a negative price, or at a price of text.
//
//  4. GET /get-inward-history with no PO named returned every receipt
//     ever made.
//
//  5. Searching the PO list for anything but a number was ignored: the
//     whole list came back as if nothing had been typed.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, RawMaterial, Supplier, PurchaseOrder, MaterialInward, User, admin;

const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
const post = (url, body) => request(app).post(`/api/v2/supplier${url}`).set('Cookie', cookie()).send(body);
const put  = (url, body) => request(app).put(`/api/v2/supplier${url}`).set('Cookie', cookie()).send(body);
const get  = (url) => request(app).get(`/api/v2/supplier${url}`).set('Cookie', cookie());

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  RawMaterial = require('../../models/RawMaterial');
  Supplier = require('../../models/Supplier');
  PurchaseOrder = require('../../models/PurchaseOrder');
  MaterialInward = require('../../models/MaterialInward');
  User = require('../../models/User');
  admin = await User.create({ name: 'Owner', email: 'po-rules@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
});

let n = 0;
const makeMaterial = (over = {}) => RawMaterial.create({ name: `Nylon 70D ${++n}`, category: 'Yarn', stock: 0, price: 320, ...over });
const makeSupplier = (name = `Kumar Dyeing ${++n}`) => Supplier.create({ name, phoneNumber: '9000000000' });
const raise = (supplier, items, over = {}) => post('/create-po', { supplier: String(supplier._id), items, ...over });
const receive = (po, material, quantity, over = {}) => post('/inward-stock', {
  poId: String(po._id), items: [{ rawMaterial: String(material._id), quantity, ...over }],
});
const fresh = (po) => PurchaseOrder.findById(po._id).lean();

// ══════════════════════════════════════════════════════════════════
describe('a purchase order received in two lots of decimal kilograms', () => {
  it.each([
    [396.54, 227.69, 168.85], [630.32, 360.62, 269.7], [953.6, 460.15, 493.45], [0.8, 0.7, 0.1],
  ])('%s kg ordered, %s + %s received: completed, nothing pending', async (ordered, first, second) => {
    expect(first + second).toBeLessThan(ordered);        // as floating point has it
    const material = await makeMaterial();
    const po = (await raise(await makeSupplier(), [{ rawMaterial: String(material._id), quantity: ordered, price: 320 }])).body.po;

    expect((await receive(po, material, first)).body.poStatus).toBe('Partial');
    const done = await receive(po, material, second);
    expect(done.status).toBe(201);
    // Before: "Partial", for good.
    expect(done.body.poStatus).toBe('Completed');

    const stored = await fresh(po);
    expect(stored.items[0].receivedQuantity).toBe(ordered);
    const detail = (await get(`/get-po-detail?id=${po._id}`)).body.po;
    expect(detail.items[0]).toMatchObject({ received: ordered, pending: 0 });
    // Nothing of it on the list of POs still waiting for goods.
    expect((await get('/po-receipt-aging')).body.count).toBe(0);
    // And the shelf holds what came, to the gram.
    expect((await RawMaterial.findById(material._id).lean()).stock).toBe(ordered);
  });

  it('a lot that leaves something to come is still Partial, and says how much', async () => {
    const material = await makeMaterial();
    const po = (await raise(await makeSupplier(), [{ rawMaterial: String(material._id), quantity: 100.5, price: 320 }])).body.po;
    await receive(po, material, 40.2);
    const detail = (await get(`/get-po-detail?id=${po._id}`)).body.po;
    // 100.5 − 40.2 is 60.3, not 60.300000000000004.
    expect(detail.items[0]).toMatchObject({ received: 40.2, pending: 60.3 });
    expect(detail.status).toBe('Partial');
    const aging = (await get('/po-receipt-aging')).body.data[0];
    expect(aging).toMatchObject({ totalPending: 60.3 });
  });

  it('the over-receipt rule still measures against the order', async () => {
    const material = await makeMaterial();
    const po = (await raise(await makeSupplier(), [{ rawMaterial: String(material._id), quantity: 100.3, price: 320 }])).body.po;
    await receive(po, material, 50.1);
    // Exactly the rest: no excess, no reason asked for.
    const rest = await receive(po, material, 50.2);
    expect(rest.status).toBe(201);
    expect((await MaterialInward.find({ purchaseOrder: po._id }).lean()).map((r) => r.excessQuantity)).toEqual([0, 0]);
    // 20% over needs its reason, as before.
    const over = await receive((await raise(await makeSupplier(), [{ rawMaterial: String(material._id), quantity: 100, price: 320 }])).body.po, material, 120);
    expect(over.status).toBe(400);
    expect(over.body.message).toMatch(/past the 10% tolerance/);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('the lines on a purchase order', () => {
  it('one material is on one line', async () => {
    const material = await makeMaterial();
    const supplier = await makeSupplier();
    const twice = [{ rawMaterial: String(material._id), quantity: 100, price: 320 }, { rawMaterial: String(material._id), quantity: 50, price: 320 }];
    const res = await raise(supplier, twice);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/^Line 2 is a material already on this purchase order\./);
    expect(await PurchaseOrder.countDocuments()).toBe(0);

    // The same on an edit.
    const po = (await raise(supplier, [twice[0]])).body.po;
    const edited = await put('/edit-po', { poId: String(po._id), auditReason: 'second lot added', items: twice });
    expect(edited.status).toBe(400);
    expect((await fresh(po)).items).toHaveLength(1);
  });

  it.each([['a negative price', -5], ['a price of text', 'abc'], ['a price nobody pays', 1e9]])('%s is refused', async (_what, price) => {
    const material = await makeMaterial();
    const res = await raise(await makeSupplier(), [{ rawMaterial: String(material._id), quantity: 10, price }]);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/^Line 1: the price /);
    expect(await PurchaseOrder.countDocuments()).toBe(0);
  });

  it('no price is ₹0, and a quantity is kept to three places', async () => {
    const material = await makeMaterial();
    const res = await raise(await makeSupplier(), [{ rawMaterial: String(material._id), quantity: '250.7504' }]);
    expect(res.status).toBe(201);
    expect((await fresh(res.body.po)).items[0]).toMatchObject({ price: 0, quantity: 250.75, receivedQuantity: 0 });
  });

  it('a supplier or a material that does not exist is refused', async () => {
    const material = await makeMaterial();
    const nobody = await raise({ _id: new mongoose.Types.ObjectId() }, [{ rawMaterial: String(material._id), quantity: 10 }]);
    expect(nobody.status).toBe(400);
    expect(nobody.body.message).toBe('That supplier does not exist');
    const nothing = await raise(await makeSupplier(), [{ rawMaterial: String(new mongoose.Types.ObjectId()), quantity: 10 }]);
    expect(nothing.status).toBe(400);
    expect(nothing.body.message).toBe('Line 1: that material does not exist');
    const notAnId = await raise(await makeSupplier(), [{ rawMaterial: 'yarn', quantity: 10 }]);
    expect(notAnId.status).toBe(400);
    expect(await PurchaseOrder.countDocuments()).toBe(0);
  });

  it('an ordinary purchase order is raised as before', async () => {
    const a = await makeMaterial(); const b = await makeMaterial();
    const res = await raise(await makeSupplier(), [
      { rawMaterial: String(a._id), quantity: 100, price: 320 }, { rawMaterial: String(b._id), quantity: 40, price: '87.5' },
    ], { notes: ' urgent ', expectedDate: '2026-12-01' });
    expect(res.status).toBe(201);
    expect(res.body.po).toMatchObject({ status: 'Open', notes: 'urgent' });
    expect(res.body.po.items.map((i) => [i.quantity, i.price])).toEqual([[100, 320], [40, 87.5]]);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('the receipts of one purchase order', () => {
  it('are asked for by its id — asked for nothing, nothing comes back', async () => {
    const material = await makeMaterial();
    const po = (await raise(await makeSupplier(), [{ rawMaterial: String(material._id), quantity: 100, price: 320 }])).body.po;
    await receive(po, material, 40);
    const other = (await raise(await makeSupplier(), [{ rawMaterial: String(material._id), quantity: 100, price: 320 }])).body.po;
    await receive(other, material, 10);

    expect((await get(`/get-inward-history?poId=${po._id}`)).body.records.map((r) => r.quantity)).toEqual([40]);
    // Before: both receipts — every receipt there is.
    const none = await get('/get-inward-history');
    expect(none.status).toBe(400);
    expect(none.body.records).toBeUndefined();
    expect((await get('/get-inward-history?poId=abc')).status).toBe(400);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('searching the purchase orders', () => {
  it('by a supplier\'s name finds that supplier\'s, and by number still finds the one', async () => {
    const material = await makeMaterial();
    const kumar = await makeSupplier('Kumar Dyeing Works');
    const sri = await makeSupplier('Sri Lakshmi Yarns');
    const first = (await raise(kumar, [{ rawMaterial: String(material._id), quantity: 10 }])).body.po;
    await raise(sri, [{ rawMaterial: String(material._id), quantity: 10 }]);

    const byName = (await get('/get-pos?search=lakshmi')).body;
    // Before: both — the search was ignored.
    expect(byName.pos.map((p) => p.supplier.name)).toEqual(['Sri Lakshmi Yarns']);
    expect(byName.pagination.total).toBe(1);
    expect((await get('/get-pos?search=nobody-of-that-name')).body.pos).toEqual([]);
    expect((await get(`/get-pos?search=${first.poNo}`)).body.pos.map((p) => p.poNo)).toEqual([first.poNo]);
    // One supplier's list, narrowed by name: theirs or nothing.
    expect((await get(`/get-pos?supplierId=${kumar._id}&search=lakshmi`)).body.pos).toEqual([]);
    expect((await get(`/get-pos?supplierId=${kumar._id}&search=kumar`)).body.pos).toHaveLength(1);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('the shelf after a receipt', () => {
  it('holds a clean figure', async () => {
    const material = await makeMaterial();
    const po = (await raise(await makeSupplier(), [{ rawMaterial: String(material._id), quantity: 10, price: 320 }])).body.po;
    await receive(po, material, 0.1);
    await receive(po, material, 0.2);
    // Before: 0.30000000000000004.
    expect((await RawMaterial.findById(material._id).lean()).stock).toBe(0.3);
  });
});
