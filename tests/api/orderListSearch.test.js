'use strict';
// GET /order/list?search= — what the app's global search sends. An order
// number in the forms people type it, or a piece of the customer PO.

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, admin;
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
const list = (search) => request(app).get('/api/v2/order/list').query({ status: 'all', search }).set('Cookie', cookie());
const numbers = (res) => res.body.orders.map((o) => o.orderNo).sort((a, b) => a - b);

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  const User = require('../../models/User');
  const Order = require('../../models/Order');
  admin = await User.create({ name: 'Owner', email: 'ols@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  const base = { customer: new mongoose.Types.ObjectId(), date: new Date(), supplyDate: new Date(), status: 'Open', elastics: [] };
  await Order.collection.insertMany([
    { ...base, orderNo: 4, po: 'PO-RUN-004' },
    { ...base, orderNo: 42, po: 'KAV/2026/118' },
    { ...base, orderNo: 7, po: 'po-run-007' },
  ]);
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

describe('order list search', () => {
  it.each(['4', '#4', 'order 4', 'Order #4'])('finds an order by its number typed as %p', async (q) => {
    expect(numbers(await list(q))).toEqual([4]);
  });

  it('matches part of the customer PO, ignoring case', async () => {
    expect(numbers(await list('po-run'))).toEqual([4, 7]);
    expect(numbers(await list('2026/118'))).toEqual([42]);
  });

  it('treats what is typed as text, not as a pattern', async () => {
    expect(numbers(await list('.*'))).toEqual([]);
    expect((await list('(a+)+$')).status).toBe(200);
  });

  it('lists everything when no search is given', async () => {
    expect(numbers(await list(''))).toEqual([4, 7, 42]);
  });
});
