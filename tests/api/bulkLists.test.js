'use strict';
// ══════════════════════════════════════════════════════════════════
//  MULTI-SELECT ON RAW MATERIALS, CHALLANS AND ORDERS
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';
process.env.PDF_IN_THREAD = '1';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, admin, RawMaterial, Supplier, MaterialGroup, Order, DeliveryChallan, Customer, Elastic;
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
const post = (url, body) => request(app).post(url).set('Cookie', cookie()).send(body);
const pdfOf = (url, body) => request(app).post(url).set('Cookie', cookie()).send(body)
  .buffer(true).parse((r, cb) => { const c = []; r.on('data', (d) => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); });

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  const User = require('../../models/User');
  RawMaterial = require('../../models/RawMaterial');
  Supplier = require('../../models/Supplier');
  MaterialGroup = require('../../models/MaterialGroup');
  Order = require('../../models/Order');
  DeliveryChallan = require('../../models/DeliveryChallan');
  Customer = require('../../models/Customer');
  Elastic = require('../../models/Elastic');
  admin = await User.create({ name: 'Owner', email: 'o@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
}, 120_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

let n = 0;
const material = (over = {}) => RawMaterial.create({ name: `Yarn ${++n}`, category: 'warp', stock: 10, price: 100, ...over });

describe('raw materials', () => {
  it('change supplier and min stock on several, bumping each version', async () => {
    const s = await Supplier.create({ name: 'Kumar Yarns', phoneNumber: '9000000001' });
    const a = await material();
    const b = await material();
    const res = await post('/api/v2/materials/bulk/update', { ids: [String(a._id), String(b._id)], supplier: String(s._id), minStock: 50 });
    expect(res.body).toMatchObject({ done: 2, refused: 0 });
    const after = await RawMaterial.findById(a._id).lean();
    expect(String(after.supplier)).toBe(String(s._id));
    expect(after.minStock).toBe(50);
    expect(after.__v).toBe((a.__v ?? 0) + 1);
  });

  it('file several under a group, keeping each category', async () => {
    const g = await MaterialGroup.create({ name: 'Nylon yarns', code: `NY${n}` });
    const a = await material({ category: 'warp' });
    const res = await post('/api/v2/materials/bulk/update', { ids: [String(a._id)], group: String(g._id) });
    expect(res.body.done).toBe(1);
    const after = await RawMaterial.findById(a._id).lean();
    expect(String(after.group)).toBe(String(g._id));
    expect(after.category).toBe('warp');
  });

  it('refuses an unknown supplier, or nothing to change', async () => {
    const a = await material();
    expect((await post('/api/v2/materials/bulk/update', { ids: [String(a._id)], supplier: String(new mongoose.Types.ObjectId()) })).status).toBe(400);
    expect((await post('/api/v2/materials/bulk/update', { ids: [String(a._id)] })).status).toBe(400);
  });

  it('inactivates the free ones and names one an open order needs', async () => {
    const free = await material();
    const needed = await material();
    await Order.create({
      customer: new mongoose.Types.ObjectId(), status: 'Approved', po: 'PO-RM', date: new Date(), supplyDate: new Date(),
      elasticOrdered: [], rawMaterialRequired: [{ rawMaterial: needed._id, requiredWeight: 5 }],
    });
    const res = await post('/api/v2/materials/bulk/archive', { ids: [String(free._id), String(needed._id)], archived: true });
    expect(res.body).toMatchObject({ done: 1, refused: 1 });
    expect(res.body.results.find((r) => r.id === String(needed._id)).reason).toMatch(/open order/);
    expect((await RawMaterial.findById(free._id).lean()).archived).toBe(true);
  });
});

describe('delivery challans', () => {
  let seq = 0;
  const dc = (status) => DeliveryChallan.create({
    dcNumber: `DC/T/${++seq}`, type: 'machine_part', status, customerName: 'Ravi',
    financialYear: '26-27', sequence: seq, items: [{ description: 'Spare', quantity: 1, rate: 10 }],
  });

  it('marks several dispatched; one that cannot be is named', async () => {
    const a = await dc('draft');
    const b = await dc('delivered');
    const res = await post('/api/v2/dc/bulk/status', { ids: [String(a._id), String(b._id)], status: 'dispatched' });
    expect(res.body).toMatchObject({ done: 1, refused: 1 });
    expect(res.body.results[1]).toMatchObject({ ok: false, name: b.dcNumber });
    expect((await DeliveryChallan.findById(a._id).lean()).status).toBe('dispatched');
  });

  it('will not cancel in bulk', async () => {
    const a = await dc('draft');
    expect((await post('/api/v2/dc/bulk/status', { ids: [String(a._id)], status: 'cancelled' })).status).toBe(400);
  });

  it('prints several as one PDF', async () => {
    const a = await dc('draft');
    const b = await dc('dispatched');
    const res = await pdfOf('/api/v2/dc/bulk/pdf', { ids: [String(a._id), String(b._id)] });
    expect(res.status).toBe(200);
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
    const { PDFDocument } = require('pdf-lib');
    expect((await PDFDocument.load(res.body)).getPageCount()).toBeGreaterThanOrEqual(2);
  });
});

describe('orders', () => {
  it('prints the status reports of several as one PDF', async () => {
    const c = await Customer.create({ name: 'Acme', contactName: 'R', phoneNumber: '9000000002' });
    const e = await Elastic.create({ name: 'E1', weaveType: '8', spandexEnds: 40, yarnEnds: 120, pick: 12, noOfHook: 8, weight: 2 });
    const mk = (po) => Order.create({
      customer: c._id, status: 'Open', po, date: new Date(), supplyDate: new Date(),
      elasticOrdered: [{ elastic: e._id, quantity: 100 }], pendingElastic: [{ elastic: e._id, quantity: 100 }],
    });
    const a = await mk('PO-A');
    const b = await mk('PO-B');
    const res = await pdfOf('/api/v2/order/bulk/status-report.pdf', { ids: [String(a._id), String(b._id)] });
    expect(res.status).toBe(200);
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
  });
});
