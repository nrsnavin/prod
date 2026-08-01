'use strict';
// ══════════════════════════════════════════════════════════════════
//  ARCHIVING A CUSTOMER
//
//  The detail page has offered a "Deactivate" button for some time
//  with nothing behind it: the route did not exist, so pressing it
//  404'd. This is that button's other half.
//
//  A customer is never removed. Their orders, delivery challans and
//  ledger rows keep pointing at them, and deleting the record would
//  leave that history unreadable. Archiving hides them from lists —
//  a display filter, not a deletion — and is reversible.
//
//  Mirrors the elastic archive deliberately: two soft deletes with
//  different shapes is how one of them ends up forgotten.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongo, app, Customer, Order, User, admin;

const adminCookie = () => [
  `token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`,
];

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  Customer = require('../../models/Customer');
  Order = require('../../models/Order');
  User = require('../../models/User');
  admin = await User.create({
    name: 'Owner', email: 'o@t.co', password: 'pass1234', role: 'admin', department: 'admin',
  });
}, 90_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
});

const makeCustomer = (over = {}) =>
  Customer.create({ name: 'Acme Textiles', contactName: 'R', phoneNumber: '9000000001', ...over });

const makeOrder = (customer, status) =>
  Order.create({
    orderNo: Math.floor(Math.random() * 100000),
    customer: customer._id,
    status,
    po: 'PO-1',
    date: new Date(),
    supplyDate: new Date(),
    elasticOrdered: [],
  });

const archive = (customer, archived) =>
  request(app).patch(`/api/v2/customer/${customer._id}/archive`)
    .set('Cookie', adminCookie())
    .send(archived === undefined ? {} : { archived });

const list = (params = {}) =>
  request(app).get('/api/v2/customer/all-customers').query(params).set('Cookie', adminCookie());

describe('archiving', () => {
  it('hides the customer from lists without deleting anything', async () => {
    const c = await makeCustomer();

    const res = await archive(c);
    expect(res.status).toBe(200);
    expect(res.body.archived).toBe(true);
    expect(res.body.message).toMatch(/hidden from lists/);

    // Gone from the list…
    const { body } = await list();
    expect(body.customers.map((x) => x._id)).not.toContain(String(c._id));
    // …but still there, with a record of when.
    const saved = await Customer.findById(c._id);
    expect(saved).toBeTruthy();
    expect(saved.archivedAt).toBeTruthy();
  });

  it('can be asked for anyway', async () => {
    const c = await makeCustomer();
    await archive(c);

    const { body } = await list({ includeArchived: 'true' });
    expect(body.customers.map((x) => x._id)).toContain(String(c._id));
  });

  it('is reversible', async () => {
    const c = await makeCustomer();
    await archive(c);

    const res = await archive(c, false);
    expect(res.status).toBe(200);
    expect(res.body.archived).toBe(false);
    expect(res.body.message).toMatch(/restored/);

    const { body } = await list();
    expect(body.customers.map((x) => x._id)).toContain(String(c._id));
    expect((await Customer.findById(c._id)).archivedAt).toBeUndefined();
  });

  it('leaves a customer who was never archived in the list', async () => {
    // Records predating the field have no key at all, so the filter has
    // to read "not archived" rather than "archived === false".
    const c = await makeCustomer();
    await Customer.collection.updateOne({ _id: c._id }, { $unset: { archived: '' } });

    const { body } = await list();
    expect(body.customers.map((x) => x._id)).toContain(String(c._id));
  });
});

describe('the guard on live work', () => {
  it.each(['Open', 'Approved', 'InProgress'])(
    'refuses while an order is %s, and says how many',
    async (status) => {
      const c = await makeCustomer();
      await makeOrder(c, status);

      const res = await archive(c);
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/1 order is still open/i);
      // Refused means unchanged, not half-applied.
      expect((await Customer.findById(c._id)).archived).toBe(false);
    }
  );

  it('counts them, so the message is actionable', async () => {
    const c = await makeCustomer();
    await makeOrder(c, 'Open');
    await makeOrder(c, 'Approved');

    const res = await archive(c);
    expect(res.body.message).toMatch(/2 orders are still open/i);
  });

  it('allows it once the work is finished or cancelled', async () => {
    const c = await makeCustomer();
    await makeOrder(c, 'Completed');
    await makeOrder(c, 'Cancelled');

    expect((await archive(c)).status).toBe(200);
  });

  it('never blocks a restore — only archiving is guarded', async () => {
    const c = await makeCustomer({ archived: true });
    await makeOrder(c, 'Open');

    const res = await archive(c, false);
    expect(res.status).toBe(200);
    expect(res.body.archived).toBe(false);
  });
});

describe('bad input', () => {
  it('400s a malformed id and 404s an unknown one', async () => {
    const bad = await request(app).patch('/api/v2/customer/not-an-id/archive')
      .set('Cookie', adminCookie()).send({});
    expect(bad.status).toBe(400);

    const missing = await request(app)
      .patch(`/api/v2/customer/${new mongoose.Types.ObjectId()}/archive`)
      .set('Cookie', adminCookie()).send({});
    expect(missing.status).toBe(404);
  });
});
