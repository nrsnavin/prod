'use strict';
// ══════════════════════════════════════════════════════════════════
//  SCALE AUDIT — the fixes for the large-data findings, pinned.
//
//  These are the failures that arrive as a cliff rather than a slope:
//  an unindexed sort that errors outright past 32 MB, a list endpoint
//  that returns the whole collection, and an embedded array that grows
//  until every write to the document fails.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, Order, RawMaterial, Elastic, Customer, Employee, ShiftDetail, User, admin;
let appendStockMovement, MAX_EMBEDDED_MOVEMENTS;

const adminCookie = () => [
  `token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`,
];

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  Order = require('../../models/Order');
  RawMaterial = require('../../models/RawMaterial');
  Elastic = require('../../models/Elastic');
  Customer = require('../../models/Customer');
  Employee = require('../../models/Employee');
  ShiftDetail = require('../../models/ShiftDetail');
  User = require('../../models/User');
  ({ appendStockMovement, MAX_EMBEDDED_MOVEMENTS } = require('../../utils/stockLedger'));
  admin = await User.create({
    name: 'Owner', email: 'o@t.co', password: 'pass1234', role: 'admin', department: 'admin',
  });
  // Indexes are declared on the schemas; build them so the assertions below
  // read the real thing rather than a hopeful comment.
  await Promise.all([Order.syncIndexes(), RawMaterial.syncIndexes()]);
}, 90_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

const mkCustomer = () => Customer.create({
  name: 'Sri Kumaran Mills', contactName: 'Ravi', phoneNumber: '9000000000',
});
const mkMaterial = (over = {}) => RawMaterial.create({
  name: 'Nylon 40D', category: 'yarn', stock: 1000, unit: 'kg', price: 100, ...over,
});

describe('AUDIT A: Order is indexed', () => {
  test('the order list filter+sort is served by an index, not a collection scan', async () => {
    const names = (await Order.collection.indexes()).map((i) => i.name);
    // status + createdAt together: the same index has to serve the filter
    // AND the sort, or Mongo still sorts in memory.
    expect(names).toContain('status_1_createdAt_-1');
    expect(names).toContain('createdAt_-1');
    expect(names).toContain('customer_1_createdAt_-1');
  });

  test('the planner explains the order list with an index scan and no in-memory sort', async () => {
    const plan = await Order.find({ status: 'Open' }).sort({ createdAt: -1 }).limit(50).explain();
    const stages = JSON.stringify(plan.queryPlanner.winningPlan);
    expect(stages).toContain('IXSCAN');
    // SORT here would mean a blocking in-memory sort — the 32 MB cliff.
    expect(stages).not.toContain('"stage":"SORT"');
  });

  test('orderNo is unique in the database, not just by convention', async () => {
    const idx = (await Order.collection.indexes()).find((i) => i.name === 'orderNo_1');
    expect(idx?.unique).toBe(true);
  });
});

describe('AUDIT B: /order/list is paginated', () => {
  beforeAll(async () => {
    const customer = await mkCustomer();
    const elastic = await Elastic.create({
      name: 'E-100', weight: 10, noOfHook: 24, pick: 12, spandexEnds: 4,
    });
    await Order.insertMany(
      Array.from({ length: 120 }, () => ({
        customer: customer._id, date: new Date(), supplyDate: new Date(), po: 'PO-1',
        status: 'Open',
        elasticOrdered: [{ elastic: elastic._id, quantity: 100 }],
      })),
      // insertMany skips the auto-increment hook, so orderNo stays unset —
      // the unique index is sparse precisely so that is allowed.
      { ordered: true }
    );
  });
  afterAll(async () => { await Order.deleteMany({}); });

  const list = (q = {}) =>
    request(app).get('/api/v2/order/list').query({ status: 'All', ...q }).set('Cookie', adminCookie());

  test('reports the page envelope every caller needs to page', async () => {
    const res = await list();
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(120);
    expect(res.body.page).toBe(1);
    // Generous default so today's unpaged mobile client stays whole.
    expect(res.body.limit).toBe(200);
    expect(res.body.hasMore).toBe(false);
  });

  test('pages through, and the last page reports no more', async () => {
    const p1 = await list({ limit: 50 });
    expect(p1.body.orders).toHaveLength(50);
    expect(p1.body.totalPages).toBe(3);
    expect(p1.body.hasMore).toBe(true);

    const p3 = await list({ limit: 50, page: 3 });
    expect(p3.body.orders).toHaveLength(20);
    expect(p3.body.hasMore).toBe(false);
  });

  test('refuses to let a caller ask for the whole collection anyway', async () => {
    const res = await list({ limit: 100000 });
    expect(res.body.orders.length).toBeLessThanOrEqual(500);
    expect(res.body.limit).toBe(500);
  });

  test('pages do not overlap or skip', async () => {
    const [p1, p2] = await Promise.all([list({ limit: 10 }), list({ limit: 10, page: 2 })]);
    const ids1 = p1.body.orders.map((o) => o._id);
    const ids2 = p2.body.orders.map((o) => o._id);
    expect(ids1.filter((id) => ids2.includes(id))).toEqual([]);
  });
});

describe('AUDIT C: the embedded stock ledger is bounded and not shipped by default', () => {
  afterEach(async () => { await RawMaterial.deleteMany({}); });

  test('appending past the cap keeps the newest rows and drops the oldest', async () => {
    const mat = await mkMaterial();
    const total = MAX_EMBEDDED_MOVEMENTS + 25;
    for (let i = 0; i < total; i++) {
      await appendStockMovement(mat._id, { type: 'STOCK_ADJUST', quantity: 1, balance: i });
    }

    const fresh = await RawMaterial.findById(mat._id).select('+stockMovements').lean();
    expect(fresh.stockMovements).toHaveLength(MAX_EMBEDDED_MOVEMENTS);
    // Newest kept: the last balance written is still there, the first is gone.
    expect(fresh.stockMovements.at(-1).balance).toBe(total - 1);
    expect(fresh.stockMovements[0].balance).toBe(total - MAX_EMBEDDED_MOVEMENTS);
  });

  test('a normal read does not carry the ledger', async () => {
    const mat = await mkMaterial();
    await appendStockMovement(mat._id, { type: 'PO_INWARD', quantity: 5, balance: 5 });

    const plain = await RawMaterial.findById(mat._id).lean();
    expect(plain.stockMovements).toBeUndefined();
    expect(plain.name).toBe('Nylon 40D');

    // …and is still there when explicitly asked for.
    const withLedger = await RawMaterial.findById(mat._id).select('+stockMovements').lean();
    expect(withLedger.stockMovements).toHaveLength(1);
  });

  test('the material list omits the ledger for every row', async () => {
    await mkMaterial({ name: 'A' });
    await mkMaterial({ name: 'B' });

    const res = await request(app)
      .get('/api/v2/materials/get-raw-materials').set('Cookie', adminCookie());

    expect(res.status).toBe(200);
    expect(res.body.materials).toHaveLength(2);
    expect(res.body.materials.every((m) => m.stockMovements === undefined)).toBe(true);
  });

  test('the detail view still shows the ledger', async () => {
    const mat = await mkMaterial();
    await appendStockMovement(mat._id, { type: 'PO_INWARD', quantity: 5, balance: 5 });

    const res = await request(app)
      .get('/api/v2/materials/get-raw-material-detail')
      .query({ id: String(mat._id) }).set('Cookie', adminCookie());

    expect(res.status).toBe(200);
    expect(res.body.material.stockMovements).toHaveLength(1);
  });
});

describe('AUDIT D: order detail resolves materials in one query', () => {
  afterEach(async () => {
    await Promise.all([Order.deleteMany({}), RawMaterial.deleteMany({})]);
  });

  test('one round trip regardless of how many materials the order needs', async () => {
    const customer = await mkCustomer();
    const elastic = await Elastic.create({
      name: 'E-200', weight: 10, noOfHook: 24, pick: 12, spandexEnds: 4,
    });
    const materials = await Promise.all(
      Array.from({ length: 12 }, (_, i) => mkMaterial({ name: `Yarn ${i}` }))
    );
    const order = await Order.create({
      customer: customer._id, date: new Date(), supplyDate: new Date(), po: 'PO-1',
      elasticOrdered: [{ elastic: elastic._id, quantity: 100 }],
      rawMaterialRequired: materials.map((m) => ({
        rawMaterial: m._id, requiredWeight: 10, name: m.name,
      })),
    });

    const spy = jest.spyOn(RawMaterial, 'find');
    const findById = jest.spyOn(RawMaterial, 'findById');

    const res = await request(app).get('/api/v2/order/get-orderDetail')
      .query({ id: String(order._id) }).set('Cookie', adminCookie());

    expect(res.status).toBe(200);
    expect(res.body.data.rawMaterialRequired).toHaveLength(12);
    // The whole point: one $in query, not one findById per material.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(findById).not.toHaveBeenCalled();

    spy.mockRestore();
    findById.mockRestore();
  });
});

describe('AUDIT E: a shift plan gives each operator only their own shift', () => {
  afterEach(async () => {
    await Promise.all([Employee.deleteMany({}), ShiftDetail.deleteMany({})]);
  });

  test('three operators on one plan get one shift each, not three', async () => {
    const Machine = require('../../models/Machine');
    const [m1, m2, m3] = await Promise.all([
      Machine.create({ ID: 'M-01', manufacturer: 'Comez', NoOfHead: 8, NoOfHooks: 24 }),
      Machine.create({ ID: 'M-02', manufacturer: 'Comez', NoOfHead: 8, NoOfHooks: 24 }),
      Machine.create({ ID: 'M-03', manufacturer: 'Comez', NoOfHead: 8, NoOfHooks: 24 }),
    ]);
    const ops = await Promise.all([
      Employee.create({ name: 'A', hourlyRate: 100 }),
      Employee.create({ name: 'B', hourlyRate: 100 }),
      Employee.create({ name: 'C', hourlyRate: 100 }),
    ]);

    const res = await request(app).post('/api/v2/shift/create-shift-plan')
      .set('Cookie', adminCookie())
      .send({
        date: '2026-03-02', shiftType: 'DAY', description: 'Day plan',
        machines: [
          { machine: String(m1._id), operator: String(ops[0]._id) },
          { machine: String(m2._id), operator: String(ops[1]._id) },
          { machine: String(m3._id), operator: String(ops[2]._id) },
        ],
      });
    expect(res.status).toBe(201);

    for (const op of ops) {
      const fresh = await Employee.findById(op._id).lean();
      // Previously every operator received all three ids.
      expect(fresh.shifts).toHaveLength(1);
      const detail = await ShiftDetail.findById(fresh.shifts[0]).lean();
      expect(String(detail.employee)).toBe(String(op._id));
    }
  });
});
