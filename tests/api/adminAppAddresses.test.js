'use strict';
// ══════════════════════════════════════════════════════════════════
//  ADDRESSES A SCREEN CALLS THAT WERE NOT THERE
//
//  Every address the three clients call was matched against the routes
//  the server has. The web and the employee app call nothing that is
//  missing. The admin app did:
//
//    GET /materials/adjust-history   its stock-adjustment History page
//    PUT /supplier/edit-customer     its supplier form (written from the
//                                    customer form, and never renamed)
//
//  (and GET /leave/all, held in leaveWithdraw.test.js). Each screen could
//  only say it had failed.
//
//  Reading the supplier form turned up a fault that is the server's own,
//  whichever screen saves: a supplier saved with its GSTIN left blank
//  kept "" as its GSTIN, and GSTINs must be unique — so the second
//  supplier without one could never be edited again.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, RawMaterial, Supplier, User, admin;

const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
const get  = (url) => request(app).get(`/api/v2${url}`).set('Cookie', cookie());
const post = (url, body) => request(app).post(`/api/v2${url}`).set('Cookie', cookie()).send(body);
const put  = (url, body) => request(app).put(`/api/v2${url}`).set('Cookie', cookie()).send(body);

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  RawMaterial = require('../../models/RawMaterial');
  Supplier = require('../../models/Supplier');
  User = require('../../models/User');
  await Supplier.init();
  admin = await User.create({ name: 'Owner', email: 'o@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
});

describe('GET /materials/adjust-history', () => {
  const material = (over = {}) => RawMaterial.create({ name: 'Nylon 40D', category: 'warp', unit: 'kg', stock: 100, price: 250, ...over });
  const adjust = (m, adjustment, reason) =>
    post('/materials/bulk-adjust-stock', { adjustments: [{ _id: String(m._id), adjustment, reason }] });
  const history = (query = '') => get(`/materials/adjust-history${query}`);

  it('lists the adjustments made by hand, newest first, with what the History page reads', async () => {
    const [nylon, rubber] = [await material(), await material({ name: 'Rubber 40s', category: 'Rubber', stock: 20 })];
    expect((await adjust(nylon, -12, 'cones damaged by damp')).status).toBe(200);
    expect((await adjust(rubber, 5, 'found behind the rack')).status).toBe(200);
    expect((await adjust(nylon, -3, 'weighing error')).status).toBe(200);

    const res = await history();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, total: 3, page: 1, pages: 1 });
    expect(res.body.adjustments.map((a) => [a.materialName, a.adjustment, a.balance, a.reason])).toEqual([
      ['Nylon 40D', -3, 85, 'weighing error'],
      ['Rubber 40s', 5, 25, 'found behind the rack'],
      ['Nylon 40D', -12, 88, 'cones damaged by damp'],
    ]);
    expect(res.body.adjustments[0]).toMatchObject({
      materialId: String(nylon._id), category: 'warp', currentStock: 85,
    });
    expect(Number.isNaN(new Date(res.body.adjustments[0].date).getTime())).toBe(false);
  });

  it('is only the adjustments: a receipt or an issue to an order is not one', async () => {
    const m = await material();
    await RawMaterial.updateOne({ _id: m._id }, { $push: { stockMovements: { $each: [
      { date: new Date(), type: 'PO_INWARD', quantity: 50, balance: 150 },
      { date: new Date(), type: 'ORDER_APPROVAL', quantity: -40, balance: 110 },
    ] } } });
    expect((await history()).body).toMatchObject({ total: 0, adjustments: [] });
    await adjust(m, -1, 'sample taken');
    expect((await history()).body.total).toBe(1);
  });

  it('by category, by name, and within the days asked for', async () => {
    const [nylon, rubber] = [await material(), await material({ name: 'Rubber 40s', category: 'Rubber', stock: 20 })];
    await adjust(nylon, -2, 'a');
    await adjust(rubber, 2, 'b');
    await RawMaterial.updateOne({ _id: rubber._id }, { $push: { stockMovements: {
      date: new Date(Date.now() - 45 * 86_400_000), type: 'STOCK_ADJUST', quantity: -1, balance: 19, reason: 'old one',
    } } });

    expect((await history('?category=Rubber')).body.adjustments.map((a) => a.reason)).toEqual(['b']);
    expect((await history('?category=All')).body.total).toBe(2);
    expect((await history('?search=nylon')).body.adjustments.map((a) => a.reason)).toEqual(['a']);
    // A name is searched for as written, not as a pattern.
    expect((await history('?search=.*')).body.total).toBe(0);
    expect((await history('?days=7')).body.total).toBe(2);
    expect((await history('?days=90')).body.adjustments.map((a) => a.reason)).toEqual(['b', 'a', 'old one']);
  });

  it('a page at a time', async () => {
    const m = await material();
    for (let i = 1; i <= 5; i++) await adjust(m, -1, `no. ${i}`);

    const first = await history('?limit=2');
    expect(first.body).toMatchObject({ total: 5, page: 1, pages: 3 });
    expect(first.body.adjustments.map((a) => a.reason)).toEqual(['no. 5', 'no. 4']);
    const last = await history('?limit=2&page=3');
    expect(last.body.adjustments.map((a) => a.reason)).toEqual(['no. 1']);
    expect((await history('?limit=2&page=9')).body.adjustments).toEqual([]);
  });

  it('refuses a page, a limit or a number of days that is not one', async () => {
    for (const query of ['?days=0', '?days=9999', '?days=soon', '?page=0', '?page=1.5', '?limit=0', '?limit=5000']) {
      const res = await history(query);
      expect([query, res.status]).toEqual([query, 400]);
      expect(res.body.message).toMatch(/must be a whole number from/);
    }
  });

  it('is behind the same door as the rest of the materials', async () => {
    expect((await request(app).get('/api/v2/materials/adjust-history')).status).toBe(401);
  });
});

describe('PUT /supplier/edit-customer — the admin app\'s supplier form', () => {
  const create = (body) => post('/supplier/create-supplier', body);

  it('saves the supplier, as /edit-supplier does', async () => {
    const made = await create({ name: 'Sri Yarns', phoneNumber: '9000000001', email: 'a@sri.in' });
    expect(made.status).toBe(201);
    const id = made.body.supplier._id;

    // As the form sends it — the three it took from the customer form included.
    const res = await put('/supplier/edit-customer', {
      _id: id, name: 'Sri Yarns Pvt Ltd', email: 'accounts@sri.in', phoneNumber: '9000000002',
      gstin: '33ABCDE1234F1Z5', contactName: '', paymentTerms: '30', status: 'Active',
    });
    expect(res.status).toBe(200);
    expect(await Supplier.findById(id).lean()).toMatchObject({
      name: 'Sri Yarns Pvt Ltd', email: 'accounts@sri.in', phoneNumber: '9000000002', gstin: '33ABCDE1234F1Z5',
    });
  });

  it('leaves alone what that form cannot show: contact person, terms, whether it is active', async () => {
    const made = await create({ name: 'Sri Yarns', phoneNumber: '9000000001', contactPerson: 'Murugan' });
    expect(made.status).toBe(201);
    const id = made.body.supplier._id;
    await Supplier.updateOne({ _id: id }, { $set: { isActive: false, paymentTermsDays: 45 } });

    // The form opens with these blank, "30" and "Active" whatever the supplier has.
    await put('/supplier/edit-customer', { _id: id, name: 'Sri Yarns', contactName: '', paymentTerms: '30', status: 'Active' });
    expect(await Supplier.findById(id).lean()).toMatchObject({
      contactPerson: 'Murugan', isActive: false, paymentTermsDays: 45,
    });
  });

  it('CONTROL: an id that is nobody\'s is not found', async () => {
    const res = await put('/supplier/edit-customer', { _id: String(new mongoose.Types.ObjectId()), name: 'x' });
    expect(res.status).toBe(404);
  });
});

describe('a supplier with no GSTIN', () => {
  const create = (name, over = {}) => post('/supplier/create-supplier', { name, phoneNumber: '9000000001', ...over });
  const edit = (id, body, path = '/supplier/edit-supplier') => put(path, { _id: id, ...body });

  it('can be edited, and so can the next one — a blank GSTIN is none, not ""', async () => {
    const [a, b] = [await create('Sri Yarns'), await create('Kovai Threads')];
    const [idA, idB] = [a.body.supplier._id, b.body.supplier._id];

    // Both forms send the GSTIN field as it stands on screen: empty.
    expect((await edit(idA, { name: 'Sri Yarns', gstin: '' })).status).toBe(200);
    const second = await edit(idB, { name: 'Kovai Threads & Co', gstin: '' });
    expect(second.status).toBe(200);
    expect((await Supplier.findById(idB).lean()).name).toBe('Kovai Threads & Co');

    // Nothing is kept for it at all, so the index has nothing to collide on.
    for (const id of [idA, idB]) expect((await Supplier.findById(id).lean()).gstin).toBeUndefined();
    expect((await edit(idA, { gstin: '   ' }, '/supplier/edit-customer')).status).toBe(200);
  });

  it('a GSTIN taken off a supplier is taken off', async () => {
    const made = await create('Sri Yarns', { gstin: '33ABCDE1234F1Z5' });
    const id = made.body.supplier._id;
    expect((await edit(id, { gstin: '' })).status).toBe(200);
    expect((await Supplier.findById(id).lean()).gstin).toBeUndefined();
  });

  it('CONTROL: a GSTIN another supplier has is still refused, and one that is not a GSTIN', async () => {
    expect((await create('Sri Yarns', { gstin: '33ABCDE1234F1Z5' })).status).toBe(201);
    const other = await create('Kovai Threads');
    const taken = await edit(other.body.supplier._id, { gstin: '33ABCDE1234F1Z5' });
    expect(taken.status).toBe(400);
    const wrong = await edit(other.body.supplier._id, { gstin: 'NOT-A-GSTIN' });
    expect(wrong.status).toBe(400);
    expect((await Supplier.findById(other.body.supplier._id).lean()).gstin).toBeUndefined();
  });
});

describe('a new supplier', () => {
  it('keeps the contact person, PAN and MSME status typed on the form', async () => {
    const res = await post('/supplier/create-supplier', {
      name: 'Sri Yarns', phoneNumber: '9000000001', contactPerson: ' Murugan ', pan: 'abcde1234f',
      msme: { category: 'micro', udyam: 'udyam-tn-01-0000001', agreedDays: 30 },
    });
    expect(res.status).toBe(201);
    expect(await Supplier.findById(res.body.supplier._id).lean()).toMatchObject({
      contactPerson: 'Murugan', pan: 'ABCDE1234F',
      msme: { category: 'micro', udyam: 'UDYAM-TN-01-0000001', agreedDays: 30 },
    });
  });

  it('CONTROL: left out, they are as they always were; an MSME class that is not one is refused', async () => {
    const plain = await post('/supplier/create-supplier', { name: 'Sri Yarns', phoneNumber: '9000000001' });
    expect(await Supplier.findById(plain.body.supplier._id).lean()).toMatchObject({
      pan: '', msme: { category: '', udyam: '', agreedDays: 0 },
    });
    const bad = await post('/supplier/create-supplier', {
      name: 'Kovai Threads', phoneNumber: '9000000002', msme: { category: 'huge' },
    });
    expect(bad.status).toBe(400);
    expect(await Supplier.countDocuments({ name: 'Kovai Threads' })).toBe(0);
  });
});
