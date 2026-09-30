'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE DASHBOARD KPIs
//
//  The most-polled endpoint in the system: every open dashboard asks
//  every ten seconds, and each answer used to cost two identical
//  collection scans (`$expr` comparing two fields cannot use an index).
//  Now it is one scan, shared by everyone asking within five seconds.
//
//  Nothing pinned this route's answer before. The first block pins it
//  — against the two OLD queries run side by side, so "the same answer"
//  is checked rather than asserted.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, RawMaterial, User, admin, forgetShared;

const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
const kpis = () => request(app).get('/api/v2/dashboard/kpis').set('Cookie', cookie());

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  RawMaterial = require('../../models/RawMaterial');
  User = require('../../models/User');
  ({ forgetShared } = require('../../utils/sharedResult'));
  admin = await User.create({
    name: 'Owner', email: 'kpi@t.co', password: 'pass1234', role: 'admin', department: 'admin',
  });
  // Eight below minimum, at distinct stock levels so the order is
  // unambiguous; four healthy; one exactly AT minimum, which counts.
  const rows = [];
  for (let i = 0; i < 8; i++) rows.push({ name: `Low ${i}`, category: 'warp', stock: 10 + i * 5, minStock: 100, price: 1 });
  for (let i = 0; i < 4; i++) rows.push({ name: `Fine ${i}`, category: 'weft', stock: 500, minStock: 100, price: 1 });
  rows.push({ name: 'At min', category: 'warp', stock: 100, minStock: 100, price: 1 });
  await RawMaterial.insertMany(rows);
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(() => forgetShared());

describe('what the dashboard is told', () => {
  it('is the same answer the two old queries gave', async () => {
    const res = await kpis();
    expect(res.status).toBe(200);

    const oldItems = await RawMaterial.find({ $expr: { $lte: ['$stock', '$minStock'] } })
      .select('name category stock minStock').sort({ stock: 1 }).limit(5).lean();
    const oldCount = await RawMaterial.countDocuments({ $expr: { $lte: ['$stock', '$minStock'] } });

    expect(res.body.data.lowStock.count).toBe(oldCount);
    expect(res.body.data.lowStock.items.map((m) => m.name)).toEqual(oldItems.map((m) => m.name));
  });

  it('counts a material exactly at its minimum as low', async () => {
    const res = await kpis();
    expect(res.body.data.lowStock.count).toBe(9);
  });

  it('keeps the shape the web app reads', async () => {
    const { data } = (await kpis()).body;
    expect(Object.keys(data).sort()).toEqual(['attendanceToday', 'lateOrders', 'lowStock', 'openJobs', 'pendingLeaves']);
    expect(Object.keys(data.lowStock.items[0]).sort()).toEqual(['category', 'id', 'minStock', 'name', 'stock']);
    expect(Object.keys(data.attendanceToday).sort()).toEqual(
      ['attendancePct', 'breakdown', 'totalEmployees', 'totalMarked', 'unmarked']
    );
  });

  it('reports zero, not an error, when nothing is low', async () => {
    await RawMaterial.updateMany({}, { $set: { stock: 1000 } });
    const res = await kpis();
    expect(res.body.data.lowStock).toEqual({ count: 0, items: [] });
    // Put the fixture back for the tests after.
    await RawMaterial.deleteMany({});
    const rows = [];
    for (let i = 0; i < 8; i++) rows.push({ name: `Low ${i}`, category: 'warp', stock: 10 + i * 5, minStock: 100, price: 1 });
    for (let i = 0; i < 4; i++) rows.push({ name: `Fine ${i}`, category: 'weft', stock: 500, minStock: 100, price: 1 });
    rows.push({ name: 'At min', category: 'warp', stock: 100, minStock: 100, price: 1 });
    await RawMaterial.insertMany(rows);
  });
});

describe('what it costs', () => {
  let scans;
  beforeEach(() => {
    scans = 0;
    mongoose.set('debug', (coll, method) => {
      if (coll === 'rawmaterials' && ['aggregate', 'find', 'countDocuments'].includes(method)) scans += 1;
    });
  });
  afterEach(() => mongoose.set('debug', false));

  it('scans the materials once per answer, not twice', async () => {
    await kpis();
    expect(scans).toBe(1);
  });

  it('answers twenty simultaneous dashboards with one scan', async () => {
    const all = await Promise.all(Array.from({ length: 20 }, () => kpis()));
    expect(all.every((r) => r.status === 200)).toBe(true);
    expect(scans).toBe(1);
  });

  it('computes again once the shared answer is dropped', async () => {
    await kpis();
    forgetShared();
    await kpis();
    expect(scans).toBe(2);
  });
});

describe('late orders', () => {
  it('counts open orders past their supply date, and nothing finished, cancelled or still in time', async () => {
    const Order = require('../../models/Order');
    const Customer = require('../../models/Customer');
    const c = await Customer.create({ name: 'Late Co', contactName: 'R', phoneNumber: '9000000077' });
    const day = 86_400_000;
    const base = { customer: c._id, po: 'PO', date: new Date(Date.now() - 30 * day), elastics: [] };
    const past = new Date(Date.now() - 3 * day);
    const future = new Date(Date.now() + 3 * day);
    // Validation is beside the point here, and each status has its own
    // required fields; insert the documents directly.
    await Order.collection.insertMany([
      { ...base, orderNo: 9001, status: 'Open', supplyDate: past },
      { ...base, orderNo: 9002, status: 'Approved', supplyDate: past },
      { ...base, orderNo: 9003, status: 'InProgress', supplyDate: past },
      { ...base, orderNo: 9004, status: 'InProgress', supplyDate: future },
      { ...base, orderNo: 9005, status: 'Completed', supplyDate: past },
      { ...base, orderNo: 9006, status: 'Cancelled', supplyDate: past },
      { ...base, orderNo: 9007, status: 'Deleted', supplyDate: past },
      // Due today is not late yet — there is still the day to ship it.
      { ...base, orderNo: 9008, status: 'Open', supplyDate: (() => { const d = new Date(); d.setHours(12, 0, 0, 0); return d; })() },
    ]);
    try {
      expect((await kpis()).body.data.lateOrders).toBe(3);
    } finally {
      await Order.collection.deleteMany({ orderNo: { $gte: 9001, $lte: 9008 } });
    }
  });
});
