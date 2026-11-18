'use strict';
// ══════════════════════════════════════════════════════════════════
//  A LIST ASKED FOR A PAGE THAT IS NOT ONE
//
//  Five lists read `page` and `limit` straight off the address:
//  customers, a customer's orders, suppliers, purchase orders, elastics.
//  `?page=-1` became a negative skip, which the database refuses, and
//  the screen got "Something went wrong on the server". Any page that is
//  not a whole number from 1 is now page 1, and no page is more than 200
//  long (utils/paging.js). The bill check answered 500 the same way when
//  the date on the form was not yet a date.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { pageOf } = require('../../utils/paging');

let mongo, app, admin, M;
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
const get = (url) => request(app).get(`/api/v2${url}`).set('Cookie', cookie());

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  M = {};
  for (const n of ['User', 'Customer', 'Supplier', 'Elastic', 'PurchaseOrder', 'RawMaterial']) M[n] = require(`../../models/${n}`);
  admin = await M.User.create({ name: 'Owner', email: 'page@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  for (let i = 0; i < 3; i++) {
    await M.Customer.create({ name: `Customer ${i}`, contactName: 'A', phoneNumber: `900000000${i}` });
    const s = await M.Supplier.create({ name: `Supplier ${i}`, phoneNumber: `910000000${i}` });
    await M.Elastic.create({ name: `Elastic ${i}`, weaveType: '8', spandexEnds: 40, yarnEnds: 120, pick: 12, noOfHook: 8, weight: 2.4 });
    const m = await M.RawMaterial.create({ name: `Yarn ${i}`, category: 'Yarn', stock: 0, price: 10, supplier: s._id });
    await M.PurchaseOrder.create({ poNo: 100 + i, supplier: s._id, status: 'Open', items: [{ rawMaterial: m._id, quantity: 5, price: 10, receivedQuantity: 0 }] });
  }
}, 180_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

describe('which page', () => {
  it('counts from 1, takes a default, and has a longest page', () => {
    expect(pageOf({})).toEqual({ page: 1, limit: 20, skip: 0 });
    expect(pageOf({ page: '3', limit: '50' })).toEqual({ page: 3, limit: 50, skip: 100 });
    for (const page of ['-1', '0', 'abc', '', null, undefined, '1e400']) expect(pageOf({ page }).page).toBe(1);
    expect(pageOf({ limit: '100000' }).limit).toBe(200);
    expect(pageOf({ limit: '-5' }, { def: 10 }).limit).toBe(10);
    expect(pageOf({ page: '2.9', limit: '7.9' })).toEqual({ page: 2, limit: 7, skip: 7 });
    expect(pageOf(undefined)).toEqual({ page: 1, limit: 20, skip: 0 });
  });
});

describe('lists asked for a page that is not one', () => {
  const lists = [
    ['/customer/all-customers', 'customers'],
    ['/supplier/get-suppliers', 'suppliers'],
    ['/supplier/get-pos', 'pos'],
    ['/elastic/get-elastics', 'elastics'],
  ];

  it.each(lists)('%s answers its first page', async (url, key) => {
    for (const q of ['?page=-1', '?page=0&limit=abc', '?page=junk', '?limit=-3']) {
      const res = await get(url + q);
      expect({ q, status: res.status }).toEqual({ q, status: 200 });
      expect(res.body[key]).toHaveLength(3);
    }
  });

  it.each(lists)('%s still pages', async (url, key) => {
    const first = await get(`${url}?page=1&limit=2`);
    const second = await get(`${url}?page=2&limit=2`);
    expect(first.body[key]).toHaveLength(2);
    expect(second.body[key]).toHaveLength(1);
    const ids = [...first.body[key], ...second.body[key]].map((r) => String(r._id));
    expect(new Set(ids).size).toBe(3);
  });

  it("a customer's orders, too", async () => {
    const c = await M.Customer.findOne({}).lean();
    expect((await get(`/customer/orders?id=${c._id}&page=-1`)).status).toBe(200);
  });
});

describe('the bill check while the form is half filled', () => {
  it('answers with no flags rather than failing on a date that is not one yet', async () => {
    const res = await request(app).post('/api/v2/accounts/bills/check').set('Cookie', cookie())
      .send({ billDate: 'junk', lines: 'x', supplier: 'x' });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.flags)).toBe(true);
  });
});
