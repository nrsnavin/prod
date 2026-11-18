'use strict';
// ══════════════════════════════════════════════════════════════════
//  CLONING A PURCHASE ORDER
//
//  "Clone" on a purchase order (web and phone) raises the same purchase
//  again. The route checked two values, forOrder and forJob, that it
//  never read from the request, so every clone stopped at
//  "forOrder is not defined" and nothing was made.
//
//    • a clone is a new Open PO, next number, same supplier and lines,
//      nothing received on it, the source untouched
//    • by default it is for nobody in particular; the caller may say
//      which order or job it is for, and a bad one is refused
//    • an id that is not a PO is "not found", not a database error
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, RawMaterial, Supplier, PurchaseOrder, Customer, Elastic, Order, User, admin;

const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
const clone = (body) => request(app).post('/api/v2/supplier/clone-po').set('Cookie', cookie()).send(body);

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  RawMaterial   = require('../../models/RawMaterial');
  Supplier      = require('../../models/Supplier');
  PurchaseOrder = require('../../models/PurchaseOrder');
  Customer      = require('../../models/Customer');
  Elastic       = require('../../models/Elastic');
  Order         = require('../../models/Order');
  User          = require('../../models/User');
  admin = await User.create({ name: 'Owner', email: 'clone@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
});

async function seedPo() {
  const supplier = await Supplier.create({ name: 'Kumar Yarns', phoneNumber: '9000000001' });
  const yarn = await RawMaterial.create({ name: 'Nylon 70D', category: 'Yarn', stock: 0, price: 300, supplier: supplier._id });
  const rubber = await RawMaterial.create({ name: 'Rubber 40', category: 'Rubber', stock: 0, price: 410, supplier: supplier._id });
  const po = await PurchaseOrder.create({
    poNo: 41, supplier: supplier._id, status: 'Partial',
    items: [
      { rawMaterial: yarn._id, quantity: 100, price: 300, receivedQuantity: 60 },
      { rawMaterial: rubber._id, quantity: 25, price: 410, receivedQuantity: 0 },
    ],
  });
  return { supplier, yarn, rubber, po };
}

describe('POST /supplier/clone-po', () => {
  it('raises the same purchase again: a new Open PO with nothing received', async () => {
    const { supplier, yarn, rubber, po } = await seedPo();
    const res = await clone({ id: String(po._id) });
    expect(res.status).toBe(201);
    const made = res.body.po;
    expect(String(made._id)).not.toBe(String(po._id));
    expect(made.status).toBe('Open');
    expect(made.poNo).toBeGreaterThan(41);
    expect(String(made.supplier._id)).toBe(String(supplier._id));
    expect(made.items.map((i) => [String(i.rawMaterial._id), i.quantity, i.price, i.receivedQuantity])).toEqual([
      [String(yarn._id), 100, 300, 0],
      [String(rubber._id), 25, 410, 0],
    ]);
    expect(made.forOrder).toBeUndefined();
    expect(made.forJob).toBeUndefined();

    // The source is as it was.
    const source = await PurchaseOrder.findById(po._id).lean();
    expect(source.status).toBe('Partial');
    expect(source.items[0].receivedQuantity).toBe(60);
    expect(await PurchaseOrder.countDocuments({})).toBe(2);
  });

  it('can be said to be for an order, and refuses one that does not exist', async () => {
    const { po } = await seedPo();
    const customer = await Customer.create({ name: 'Sunrise Garments', contactName: 'Ravi', phoneNumber: '9000000002' });
    const elastic = await Elastic.create({ name: '20mm Knitted', weaveType: '8', spandexEnds: 40, yarnEnds: 120, pick: 12, noOfHook: 8, weight: 2.4 });
    const order = await Order.create({ customer: customer._id, po: 'PO-9', date: new Date(), supplyDate: new Date(), status: 'Open', elasticOrdered: [{ elastic: elastic._id, quantity: 500 }] });

    const linked = await clone({ id: String(po._id), forOrder: String(order._id) });
    expect(linked.status).toBe(201);
    expect(String((await PurchaseOrder.findById(linked.body.po._id).lean()).forOrder)).toBe(String(order._id));

    const ghost = await clone({ id: String(po._id), forOrder: String(new mongoose.Types.ObjectId()) });
    expect(ghost.status).toBe(400);
    expect(ghost.body.message).toBe('That order does not exist');
    expect((await clone({ id: String(po._id), forJob: 'nope' })).body.message).toBe('forJob must be a valid id');
  });

  it('an id that is not a purchase order is not found', async () => {
    await seedPo();
    expect((await clone({ id: String(new mongoose.Types.ObjectId()) })).status).toBe(404);
    const bad = await clone({ id: 'not-an-id' });
    expect(bad.status).toBe(404);
    expect(bad.body.message).toBe('Source PO not found');
    expect((await clone({})).status).toBe(404);
    expect(await PurchaseOrder.countDocuments({})).toBe(1);
  });
});
