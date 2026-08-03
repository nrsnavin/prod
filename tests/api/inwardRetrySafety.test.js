'use strict';
// ══════════════════════════════════════════════════════════════════
//  A GOODS RECEIPT THAT HAS TO BE RETRIED
//
//  `session.withTransaction` replays its callback when the commit
//  comes back transient or with an unknown result — a stepdown, an
//  election, a network blip. That is routine on a real replica set.
//
//  The receipt used to increment the PO's receivedQuantity BEFORE the
//  session opened, on a document held across attempts. Mongoose clears
//  a document's dirty flags once it has saved, so the replay saved
//  nothing: the stock credit and the inward rows landed, and the PO
//  did not. It stayed Open, went on reporting the delivered yarn as
//  still on order, and the shortfall panel offered to buy it again.
//
//  Intermittent by nature, which is why it survived: the fault needs a
//  retry, and a retry needs a bad moment.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { MongoServerError } = require('mongodb');

let mongo, app;
let RawMaterial, Supplier, PurchaseOrder, MaterialInward, User, admin;

const adminCookie = () => [
  `token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`,
];

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  RawMaterial    = require('../../models/RawMaterial');
  Supplier       = require('../../models/Supplier');
  PurchaseOrder  = require('../../models/PurchaseOrder');
  MaterialInward = require('../../models/MaterialInward');
  User           = require('../../models/User');
  admin = await User.create({
    name: 'Owner', email: 'o@t.co', password: 'pass1234', role: 'admin', department: 'admin',
  });
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  jest.restoreAllMocks();
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
});

async function seedPo({ ordered = 100, stock = 0 } = {}) {
  const supplier = await Supplier.create({ name: 'Kumar Yarns', phoneNumber: '9000000001' });
  const yarn = await RawMaterial.create({
    name: 'Nylon 70D', category: 'Yarn', stock, price: 300, supplier: supplier._id,
  });
  const po = await PurchaseOrder.create({
    poNo: 501, supplier: supplier._id, status: 'Open',
    items: [{ rawMaterial: yarn._id, quantity: ordered, price: 300, receivedQuantity: 0 }],
  });
  return { supplier, yarn, po };
}

const receive = (po, yarn, quantity) =>
  request(app).post('/api/v2/supplier/inward-stock')
    .set('Cookie', adminCookie())
    .send({ poId: String(po._id), items: [{ rawMaterial: String(yarn._id), quantity }] });

/**
 * Fail the first attempt the way a stepdown does.
 *
 * The driver retries only what it recognises: a MongoError carrying the
 * TransientTransactionError label. A plain Error would abort instead,
 * which would test nothing.
 */
function failFirstAttemptTransiently() {
  const real = MaterialInward.insertMany.bind(MaterialInward);
  let fired = false;
  jest.spyOn(MaterialInward, 'insertMany').mockImplementation(async (...args) => {
    if (!fired) {
      fired = true;
      const err = new MongoServerError({ message: 'primary stepped down' });
      err.addErrorLabel('TransientTransactionError');
      throw err;
    }
    return real(...args);
  });
  return () => fired;
}

describe('a receipt whose transaction is retried', () => {
  it('still lands on the purchase order', async () => {
    const { yarn, po } = await seedPo({ ordered: 100 });
    const retried = failFirstAttemptTransiently();

    const res = await receive(po, yarn, 100);
    expect(res.status).toBe(201);
    expect(retried()).toBe(true);

    const after = await PurchaseOrder.findById(po._id);
    expect(after.items[0].receivedQuantity).toBe(100);
    // Which is the part that matters downstream: an Open PO goes on
    // being counted as owed, and the MRP goes on reporting a shortfall
    // for yarn already in the building.
    expect(after.status).toBe('Completed');
  });

  it('credits the stock exactly once', async () => {
    // The other half of the same fault: a retry that re-applies its
    // writes doubles them. The abort rolls the first attempt back, so
    // 100 received is 100 credited however many attempts it took.
    const { yarn, po } = await seedPo({ ordered: 100, stock: 20 });
    failFirstAttemptTransiently();

    await receive(po, yarn, 100);

    expect((await RawMaterial.findById(yarn._id)).stock).toBe(120);
    expect(await MaterialInward.countDocuments({ purchaseOrder: po._id })).toBe(1);
  });

  it('records one audit row, not one per attempt', async () => {
    const { yarn, po } = await seedPo({ ordered: 100 });
    failFirstAttemptTransiently();

    await receive(po, yarn, 40);

    const after = await PurchaseOrder.findById(po._id);
    const inwards = after.fingerprints.filter((f) => f.code === 'PO_STOCK_INWARD');
    expect(inwards).toHaveLength(1);
    expect(after.items[0].receivedQuantity).toBe(40);
  });
});
