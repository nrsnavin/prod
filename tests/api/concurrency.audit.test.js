'use strict';
// ══════════════════════════════════════════════════════════════════
//  CONCURRENCY AUDIT — real concurrent requests, not code reading.
//
//  Every other transactional route in the codebase uses
//  session.withTransaction(), which retries a TransientTransactionError
//  (the WriteConflict two racing transactions produce). /order/approve is
//  the one exception: it drives the session by hand with startTransaction()
//  + commitTransaction() and no retry — on the single most contended write
//  in the system, the raw-material stock deduction.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, Order, RawMaterial, Elastic, Customer, User, MaterialOutward, admin;

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
  MaterialOutward = require('../../models/MaterialOut.cjs');
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

const approve = (orderId) =>
  request(app).post('/api/v2/order/approve').set('Cookie', adminCookie()).send({ orderId: String(orderId) });

/** Two orders that each draw on the SAME raw material — the contended case. */
async function seedTwoOrdersSharingAMaterial({ stock = 100_000 } = {}) {
  const customer = await Customer.create({
    name: 'Sri Kumaran Mills', contactName: 'Ravi', phoneNumber: '9000000000',
  });
  const material = await RawMaterial.create({ name: 'Nylon 40D', stock, unit: 'kg', price: 100, category: 'yarn' });
  const elastic = await Elastic.create({
    name: 'E-100 20mm', weight: 10, noOfHook: 24, pick: 12, spandexEnds: 4,
  });

  const mk = () => Order.create({
    customer: customer._id, date: new Date(), supplyDate: new Date(), po: 'PO-1',
    status: 'Open',
    elasticOrdered:  [{ elastic: elastic._id, quantity: 100 }],
    producedElastic: [{ elastic: elastic._id, quantity: 0 }],
    packedElastic:   [{ elastic: elastic._id, quantity: 0 }],
    pendingElastic:  [{ elastic: elastic._id, quantity: 100 }],
    rawMaterialRequired: [{ rawMaterial: material._id, requiredWeight: 10, name: 'Nylon 40D' }],
  });

  return { a: await mk(), b: await mk(), material, elastic };
}

describe('AUDIT: concurrent approvals contending for the same raw material', () => {
  test('two orders drawing on one material can be approved at the same time', async () => {
    const { a, b, material } = await seedTwoOrdersSharingAMaterial();

    const [ra, rb] = await Promise.all([approve(a._id), approve(b._id)]);
    const statuses = [ra.status, rb.status].sort();

    // Both are legitimate: different orders, ample stock, no business reason
    // for either to fail. A 500 here is the missing transaction retry.
    const failures = [ra, rb].filter((r) => r.status >= 500);
    expect(
      failures.map((f) => f.body?.message ?? f.text).join(' | ')
    ).toBe('');
    expect(statuses).toEqual([200, 200]);

    // And the shared stock must reflect BOTH deductions, not one.
    const after = await RawMaterial.findById(material._id).lean();
    expect(after.stock).toBe(100_000 - 20);
  });

  test('the same order approved twice deducts stock only once', async () => {
    const { a, material } = await seedTwoOrdersSharingAMaterial();

    const [r1, r2] = await Promise.all([approve(a._id), approve(a._id)]);

    // Exactly one may succeed; the loser must be refused, not silently
    // allowed to double-deduct.
    const ok = [r1, r2].filter((r) => r.status === 200);
    expect(ok).toHaveLength(1);

    const after = await RawMaterial.findById(material._id).lean();
    expect(after.stock).toBe(100_000 - 10);

    // One approval => one outward row. Two would mean the ledger
    // double-counted the draw even if the stock number happened to survive.
    const outwards = await MaterialOutward.countDocuments({
      order: a._id, type: 'ORDER_APPROVAL',
    });
    expect(outwards).toBe(1);
  });
});
