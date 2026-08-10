'use strict';
// ══════════════════════════════════════════════════════════════════
//  A MASTER THAT HAS BEEN USED IS NEVER DELETED
//
//  Raw materials, elastics and customers are master data. The
//  documents that name them — orders, jobs, goods receipts, delivery
//  challans — are the business's record of what actually happened.
//  Deleting the master does not undo those documents, it orphans them:
//  the order line still exists, pointing at nothing, and the screen
//  renders a blank where a yarn name belongs.
//
//  So: used → archived (hidden from the pickers, every reference still
//  resolves). Never used → deleted, because a typo entered five
//  minutes ago has no history to protect.
//
//  What these tests pin down:
//
//    • the delete route archives instead, and says so
//    • the record and its references survive intact
//    • an unused record still deletes
//    • force=true cannot orphan another document
//    • archived masters leave the pickers but still resolve by id
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

const { countUsage } = require('../../utils/masterUsage');

let mongo, app;
let RawMaterial, Elastic, Customer, Order, JobOrder, PurchaseOrder,
  MaterialInward, Supplier, User, admin;

const adminCookie = () => [
  `token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`,
];

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  RawMaterial    = require('../../models/RawMaterial');
  Elastic        = require('../../models/Elastic');
  Customer       = require('../../models/Customer');
  Order          = require('../../models/Order');
  JobOrder       = require('../../models/JobOrder');
  PurchaseOrder  = require('../../models/PurchaseOrder');
  MaterialInward = require('../../models/MaterialInward');
  Supplier       = require('../../models/Supplier');
  User           = require('../../models/User');
  admin = await User.create({
    name: 'Owner', email: 'arch@t.co', password: 'pass1234',
    role: 'admin', department: 'admin',
  });
}, 120_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
});

// ── fixtures ──────────────────────────────────────────────────────
let seq = 0;

const makeMaterial = (over = {}) =>
  RawMaterial.create({
    name: `Nylon 70D ${++seq}`, category: 'yarn', stock: 100, price: 300, ...over,
  });

const makeElastic = (over = {}) =>
  Elastic.create({
    name: `20mm Woven ${++seq}`, weaveType: '8',
    spandexEnds: 40, pick: 30, noOfHook: 12, weight: 5, ...over,
  });

const makeCustomer = () =>
  Customer.create({
    name: `Aravind ${++seq}`, contactName: 'A', phoneNumber: '9000000001',
  });

const makeOrder = (customer, elastic, over = {}) =>
  Order.create({
    customer: customer._id, po: `PO-${++seq}`, date: new Date(), supplyDate: new Date(),
    elasticOrdered: [{ elastic: elastic._id, quantity: 1000 }],
    status: 'Open', ...over,
  });

const deleteMaterial = (id) =>
  request(app).delete(`/api/v2/materials/delete-raw-material?id=${id}`)
    .set('Cookie', adminCookie());

const deleteElastic = (id, force = false) =>
  request(app)
    .delete(`/api/v2/elastic/delete-elastic?id=${id}${force ? '&force=true' : ''}`)
    .set('Cookie', adminCookie());

// ══════════════════════════════════════════════════════════════════
//  THE USAGE PROBE
// ══════════════════════════════════════════════════════════════════
describe('countUsage', () => {
  it('finds nothing for a master nobody has touched', async () => {
    const m = await makeMaterial();
    const u = await countUsage('RawMaterial', m._id);
    expect(u).toMatchObject({ used: false, total: 0, places: [] });
  });

  it('names each place in words somebody would use', async () => {
    const m = await makeMaterial();
    const supplier = await Supplier.create({ name: 'Kumar', phoneNumber: '9000000002' });
    await PurchaseOrder.create({
      supplier: supplier._id, date: new Date(), status: 'Open',
      items: [{ rawMaterial: m._id, quantity: 100, price: 300 }],
    });
    await MaterialInward.create({ rawMaterial: m._id, quantity: 40 });
    await MaterialInward.create({ rawMaterial: m._id, quantity: 60 });

    const u = await countUsage('RawMaterial', m._id);
    expect(u.used).toBe(true);
    expect(u.summary).toMatch(/2 goods receipts/);
    expect(u.summary).toMatch(/1 purchase order/);
    // Not a collection name in sight.
    expect(u.summary).not.toMatch(/MaterialInward|PurchaseOrder/);
  });

  it('counts one document once, however many times it names the master', async () => {
    // A yarn used as BOTH the warp and the weft of one elastic is in
    // the way of exactly one recipe. Reporting two would overstate
    // what somebody has to deal with.
    const m = await makeMaterial();
    await makeElastic({
      warpYarn:  [{ id: m._id, ends: 40, weight: 4 }],
      weftYarn:  { id: m._id, weight: 1 },
    });

    const u = await countUsage('RawMaterial', m._id);
    expect(u.places).toEqual([{ label: 'elastic recipe', count: 1 }]);
  });
});

// ══════════════════════════════════════════════════════════════════
//  RAW MATERIAL
// ══════════════════════════════════════════════════════════════════
describe('deleting a raw material', () => {
  it('archives it when a purchase order names it', async () => {
    const m = await makeMaterial();
    const supplier = await Supplier.create({ name: 'Kumar', phoneNumber: '9000000003' });
    const po = await PurchaseOrder.create({
      supplier: supplier._id, date: new Date(), status: 'Open',
      items: [{ rawMaterial: m._id, quantity: 100, price: 300 }],
    });

    const res = await deleteMaterial(m._id);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ archived: true, deleted: false });
    expect(res.body.message).toMatch(/1 purchase order/);

    const after = await RawMaterial.findById(m._id).lean();
    expect(after).not.toBeNull();
    expect(after.archived).toBe(true);
    expect(after.archivedAt).toBeTruthy();

    // And the PO line still resolves — the whole point.
    const line = (await PurchaseOrder.findById(po._id).lean()).items[0];
    expect(String(line.rawMaterial)).toBe(String(m._id));
  });

  it('archives it when an elastic recipe names it', async () => {
    // The nastiest orphan of the lot: the product still costs and
    // still plans, at nothing.
    const m = await makeMaterial();
    await makeElastic({ warpYarn: [{ id: m._id, ends: 40, weight: 4 }] });

    const res = await deleteMaterial(m._id);
    expect(res.body.archived).toBe(true);
    expect(res.body.message).toMatch(/elastic recipe/);
    expect(await RawMaterial.countDocuments({ _id: m._id })).toBe(1);
  });

  it('archives it when an order requires it', async () => {
    const m = await makeMaterial();
    const c = await makeCustomer();
    const e = await makeElastic();
    await makeOrder(c, e, {
      rawMaterialRequired: [{ rawMaterial: m._id, requiredWeight: 40 }],
    });

    const res = await deleteMaterial(m._id);
    expect(res.body.archived).toBe(true);
    expect(res.body.message).toMatch(/1 order requirement/);
  });

  it('deletes one nothing has ever used', async () => {
    const m = await makeMaterial();
    const res = await deleteMaterial(m._id);

    expect(res.body).toMatchObject({ archived: false, deleted: true });
    expect(res.body.message).toMatch(/nothing had used it/);
    expect(await RawMaterial.countDocuments({ _id: m._id })).toBe(0);
  });

  it('says so plainly when it is already archived', async () => {
    const m = await makeMaterial({ archived: true });
    await MaterialInward.create({ rawMaterial: m._id, quantity: 40 });

    const res = await deleteMaterial(m._id);
    expect(res.body).toMatchObject({ archived: true, deleted: false });
    expect(res.body.message).toMatch(/already archived/);
  });

  it('reports which places are in the way, not just that some are', async () => {
    const m = await makeMaterial();
    await MaterialInward.create({ rawMaterial: m._id, quantity: 40 });

    const res = await deleteMaterial(m._id);
    expect(res.body.usage).toEqual([{ label: 'goods receipt', count: 1 }]);
  });
});

describe('an archived raw material', () => {
  it('leaves the picker but still resolves by id', async () => {
    // Archiving is a display filter. If the detail endpoint hid it too,
    // every document pointing at it would render a blank — which is
    // the exact failure archiving exists to prevent.
    const m = await makeMaterial({ archived: true });

    const list = await request(app)
      .get('/api/v2/materials/get-raw-materials').set('Cookie', adminCookie());
    expect(list.body.materials.map((x) => String(x._id))).not.toContain(String(m._id));

    const detail = await request(app)
      .get(`/api/v2/materials/get-raw-material-detail?id=${m._id}`)
      .set('Cookie', adminCookie());
    expect(detail.status).toBe(200);
    expect(detail.body.material.name).toBe(m.name);
  });

  it('comes back when asked for', async () => {
    const m = await makeMaterial({ archived: true });
    const list = await request(app)
      .get('/api/v2/materials/get-raw-materials?includeArchived=true')
      .set('Cookie', adminCookie());
    expect(list.body.materials.map((x) => String(x._id))).toContain(String(m._id));
  });

  it('does not hide a material an open order still needs', async () => {
    // Archiving it would take it out of the MRP and the reorder
    // suggestions at the moment somebody has to buy it.
    const m = await makeMaterial();
    const c = await makeCustomer();
    const e = await makeElastic();
    await makeOrder(c, e, {
      status: 'Approved',
      rawMaterialRequired: [{ rawMaterial: m._id, requiredWeight: 40 }],
    });

    const res = await request(app)
      .patch(`/api/v2/materials/${m._id}/archive`)
      .set('Cookie', adminCookie()).send({ archived: true });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/still require/i);
    expect((await RawMaterial.findById(m._id).lean()).archived).toBeFalsy();
  });

  it('can be restored', async () => {
    const m = await makeMaterial({ archived: true, archivedAt: new Date() });
    const res = await request(app)
      .patch(`/api/v2/materials/${m._id}/archive`)
      .set('Cookie', adminCookie()).send({ archived: false });

    expect(res.status).toBe(200);
    expect((await RawMaterial.findById(m._id).lean()).archived).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════
//  ELASTIC
// ══════════════════════════════════════════════════════════════════
describe('deleting an elastic', () => {
  it('archives it when an order names it', async () => {
    const c = await makeCustomer();
    const e = await makeElastic();
    const order = await makeOrder(c, e);

    const res = await deleteElastic(e._id);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ archived: true, deleted: false });
    expect(res.body.message).toMatch(/1 order/);

    expect((await Elastic.findById(e._id).lean()).archived).toBe(true);
    // The order line still resolves.
    const line = (await Order.findById(order._id).lean()).elasticOrdered[0];
    expect(String(line.elastic)).toBe(String(e._id));
  });

  it('archives it when a job names it', async () => {
    const c = await makeCustomer();
    const e = await makeElastic();
    const order = await makeOrder(c, e);
    await JobOrder.create({
      order: order._id, customer: c._id, date: new Date(),
      elastics: [{ elastic: e._id, quantity: 500 }],
    });

    const res = await deleteElastic(e._id);
    expect(res.body.archived).toBe(true);
    expect(res.body.message).toMatch(/job/);
  });

  it('cannot be forced into orphaning an order', async () => {
    // force exists for the elastic's OWN state — stock on the shelf,
    // movements on its ledger. Whether another document points at it
    // is not the admin's to override: deleting it breaks THAT
    // document, and no flag on this request makes that safe.
    const c = await makeCustomer();
    const e = await makeElastic();
    await makeOrder(c, e);

    const res = await deleteElastic(e._id, true);
    expect(res.body).toMatchObject({ archived: true, deleted: false });
    expect(await Elastic.countDocuments({ _id: e._id })).toBe(1);
  });

  it('still deletes one nothing has used', async () => {
    const e = await makeElastic();
    const res = await deleteElastic(e._id);

    expect(res.body).toMatchObject({ archived: false, deleted: true });
    expect(await Elastic.countDocuments({ _id: e._id })).toBe(0);
  });

  it('does not count its own ledger rows as somebody else using it', async () => {
    // Otherwise every elastic that has ever moved becomes permanently
    // undeletable — including the test data force exists for. Its own
    // movements are cascaded with it.
    const e = await makeElastic();
    await request(app)
      .post(`/api/v2/elastic/${e._id}/adjust-stock`)
      .set('Cookie', adminCookie())
      .send({ delta: 500, reason: 'opening count', force: true });

    const res = await deleteElastic(e._id, true);
    expect(res.body).toMatchObject({ archived: false, deleted: true });
    expect(await Elastic.countDocuments({ _id: e._id })).toBe(0);
  });

  it('keeps its own guards for an unused elastic with stock', async () => {
    // Nothing references it, so archiving is not the answer — but its
    // own stock is still a reason to stop and ask.
    const e = await makeElastic();
    await request(app)
      .post(`/api/v2/elastic/${e._id}/adjust-stock`)
      .set('Cookie', adminCookie())
      .send({ delta: 500, reason: 'opening count', force: true });

    const res = await deleteElastic(e._id);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/stock is 500/);
  });
});

// ══════════════════════════════════════════════════════════════════
//  CUSTOMER
// ══════════════════════════════════════════════════════════════════
describe('a customer', () => {
  it('has no delete route at all — archive is the only way out', async () => {
    const c = await makeCustomer();
    const res = await request(app)
      .delete(`/api/v2/customer/${c._id}`).set('Cookie', adminCookie());

    expect(res.status).toBe(404);
    expect(await Customer.countDocuments({ _id: c._id })).toBe(1);
  });

  it('cannot be archived while an order is still open', async () => {
    const c = await makeCustomer();
    const e = await makeElastic();
    await makeOrder(c, e, { status: 'Approved' });

    const res = await request(app)
      .patch(`/api/v2/customer/${c._id}/archive`)
      .set('Cookie', adminCookie()).send({ archived: true });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/still open/i);
  });

  it('archives once the work is done, keeping its history', async () => {
    const c = await makeCustomer();
    const e = await makeElastic();
    const order = await makeOrder(c, e, { status: 'Completed' });

    const res = await request(app)
      .patch(`/api/v2/customer/${c._id}/archive`)
      .set('Cookie', adminCookie()).send({ archived: true });

    expect(res.status).toBe(200);
    expect((await Customer.findById(c._id).lean()).archived).toBe(true);
    expect(String((await Order.findById(order._id).lean()).customer)).toBe(String(c._id));
  });
});
