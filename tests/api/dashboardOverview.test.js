'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE DASHBOARD, BY ROLE
//
//  The home screen leads with what needs a decision. These pin:
//
//    • who sees what — the owner everything, production the floor and
//      its own queue, accounts the money and its own queue;
//    • "orders at risk" counts an order the forecast says will be late,
//      not only one whose date has already passed — the old tile said
//      "everything on time" while the planner showed late lines;
//    • "waiting for an IRN" appears only where e-invoicing is in use,
//      and only for invoices that need one;
//    • metres per working day leaves out today (still being made) and
//      days nothing was made, and compares like with like.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

// The forecast engine is the subject of its own tests; here it says
// which in-flight orders it thinks will be late.
const mockForecastLate = new Set();
jest.mock('../../services/etaService', () => ({
  _loadPlantMetersPerMachineDay: async () => 1000,
  _loadFreeMachineCount: async () => 1,
  _computeRunningEtaForOrder: async (order) =>
    mockForecastLate.has(String(order._id))
      ? { ok: true, expectedDate: new Date(Date.now() + 9 * 86_400_000), risk: { late: true, lateWorkingDays: 4 } }
      : { ok: true, expectedDate: new Date(Date.now() + 2 * 86_400_000), risk: { late: false } },
}));

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, forgetShared, users = {};
const DAY = 86_400_000;
const as = (who) => request(app).get('/api/v2/dashboard/overview').set('Cookie', [`token=${jwt.sign({ id: users[who]._id, role: users[who].role }, process.env.JWT_SECRET_KEY)}`]);
const keys = (res) => res.body.data.attention.map((a) => a.key);
const item = (res, key) => res.body.data.attention.find((a) => a.key === key);

let lateOrder, riskOrder, fineOrder;

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  ({ forgetShared } = require('../../utils/sharedResult'));
  const User = require('../../models/User');
  for (const [k, role] of [['owner', 'admin'], ['production', 'production'], ['accounts', 'accounts']]) {
    users[k] = await User.create({ name: k, email: `${k}@dash.t`, password: 'pass1234', role, department: role === 'accounts' ? 'finance' : role });
  }
  const db = mongoose.connection.db;
  const { insertedId: customer } = await db.collection('customers').insertOne({ name: 'Sunrise Garments' });
  const now = Date.now();
  lateOrder = (await db.collection('orders').insertOne({ orderNo: 4, status: 'Approved', supplyDate: new Date(now - 3 * DAY), customer, elasticOrdered: [], producedElastic: [] })).insertedId;
  riskOrder = (await db.collection('orders').insertOne({ orderNo: 7, status: 'InProgress', supplyDate: new Date(now + 5 * DAY), customer, elasticOrdered: [], producedElastic: [] })).insertedId;
  fineOrder = (await db.collection('orders').insertOne({ orderNo: 9, status: 'InProgress', supplyDate: new Date(now + 20 * DAY), customer, elasticOrdered: [], producedElastic: [] })).insertedId;
  mockForecastLate.add(String(riskOrder));

  await db.collection('rawmaterials').insertMany([
    { name: 'Nylon 70D', category: 'warp', stock: 20, minStock: 100, price: 1 },
    { name: 'Spandex 40D', category: 'weft', stock: 500, minStock: 100, price: 1 },
  ]);
  await db.collection('leaverequests').insertOne({ status: 'pending' });
  await db.collection('invoices').insertOne({
    invoiceNumber: 'INV/26-27/0001', status: 'issued', invoiceDate: new Date(now - 40 * DAY),
    customer, buyer: { name: 'Sunrise Garments', gstin: '33AAEPS1111F1Z2' }, totals: { grand: 13125 },
    einvoice: { status: 'pending' }, paidAmount: 0,
  });
  // Metres: 14 past working days, the last 12 at 1,200 and the two
  // before at 600; a Sunday with nothing; today's partial shift.
  // "Today" is the floor's shift day, as the dashboard reads it: until the
  // day shift starts at 08:00 in India the night shift keeps yesterday's
  // date. Counting from the UTC date instead failed this test every
  // morning from 05:30 to 08:00 there.
  const plans = [];
  const today = require('../../utils/factoryDay').shiftDay().getTime();
  const day = (n) => new Date(today - n * DAY);
  for (let n = 1; n <= 14; n++) plans.push({ date: day(n), shift: 'DAY', totalProduction: n <= 12 ? 1200 : 600 });
  plans.push({ date: day(15), shift: 'DAY', totalProduction: 0 });
  plans.push({ date: day(0), shift: 'DAY', totalProduction: 90 });
  await db.collection('shiftplans').insertMany(plans);
  await db.collection('machines').insertMany([
    { ID: 'L1', status: 'running', loading: false }, { ID: 'L2', status: 'running', loading: true },
    { ID: 'L3', status: 'maintenance' }, { ID: 'L4', status: 'free' },
  ]);
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(() => forgetShared());

describe('who sees what', () => {
  it('the owner: attention, money and the floor', async () => {
    const res = await as('owner');
    expect(res.status).toBe(200);
    expect(res.body.data.role).toBe('owner');
    expect(res.body.data.money).toBeDefined();
    expect(res.body.data.floor).toBeDefined();
    expect(keys(res)).toEqual(expect.arrayContaining(['ordersAtRisk', 'overdueInvoices', 'pendingLeaves', 'lowStock']));
  });

  it('production: the floor and its own queue, no money', async () => {
    const res = await as('production');
    expect(res.body.data.role).toBe('production');
    expect(res.body.data.money).toBeUndefined();
    expect(res.body.data.floor).toBeDefined();
    expect(keys(res).every((k) => ['ordersAtRisk', 'shiftsToVerify'].includes(k))).toBe(true);
  });

  it('accounts: the money and its own queue, no floor', async () => {
    const res = await as('accounts');
    expect(res.body.data.role).toBe('accounts');
    expect(res.body.data.floor).toBeUndefined();
    expect(res.body.data.money.receivable.overdue).toBe(13125);
    expect(keys(res)).toEqual(expect.arrayContaining(['overdueInvoices', 'pendingLeaves', 'lowStock']));
  });

  it('nobody signed in: refused', async () => {
    const res = await request(app).get('/api/v2/dashboard/overview');
    expect(res.status).toBe(401);
  });
});

describe('orders at risk', () => {
  it('counts the late order and the one the forecast says will be late, not the one on time', async () => {
    const res = await as('owner');
    const risk = item(res, 'ordersAtRisk');
    expect(risk.count).toBe(2);
    expect(risk.items.map((i) => i.title)).toEqual(['Order #4 · Sunrise Garments', 'Order #7 · Sunrise Garments']);
    expect(risk.items[0].detail).toMatch(/3 days late/);
    expect(risk.items[1].detail).toMatch(/^due .*, forecast /);
    expect(risk.summary).toBe('1 late, 1 forecast late');
    expect(res.body.data.ordersAtRisk).toMatchObject({ count: 2, late: 1 });
  });
});

describe('waiting for an IRN', () => {
  it('is not raised while e-invoicing has never been used', async () => {
    const res = await as('owner');
    expect(keys(res)).not.toContain('irnPending');
  });

  it('is raised once an IRN has been registered, for the B2B invoices still without one', async () => {
    await mongoose.connection.db.collection('invoices').insertOne({
      invoiceNumber: 'INV/26-27/0000', status: 'issued', invoiceDate: new Date(), buyer: { name: 'Old', gstin: '33AAEPS1111F1Z2' },
      totals: { grand: 100 }, einvoice: { status: 'registered', irn: 'x' }, paidAmount: 100,
    });
    const res = await as('owner');
    expect(item(res, 'irnPending')).toMatchObject({ count: 1, items: [expect.objectContaining({ title: 'INV/26-27/0001 · Sunrise Garments' })] });
  });
});

describe('the floor', () => {
  it('metres per working day: the last twelve days made, against the twelve before', async () => {
    const res = await as('owner');
    const m = res.body.data.floor.metres;
    expect(m.perWorkingDay).toBe(1200);
    expect(m.days).toBe(12);
    // Only two days before those: an average, said with how few days it rests on.
    expect(m.previousPerWorkingDay).toBe(600);
    expect(m.previousDays).toBe(2);
    expect(m.series).toHaveLength(14);
    expect(m.series.every((d) => d.metres > 0)).toBe(true);
  });

  it('counts a loom being loaded apart from one weaving', async () => {
    const res = await as('production');
    expect(res.body.data.floor.looms).toEqual({ total: 4, running: 1, loading: 1, maintenance: 1 });
  });
});
