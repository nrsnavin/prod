'use strict';
// ══════════════════════════════════════════════════════════════════
//  RAISING PURCHASE ORDERS FROM A JOB'S MATERIAL SHORTFALL
//
//  The MRP already said what was short; there was no way to act on it
//  without re-keying the same numbers into the PO screen, which lost
//  the connection to the job that needed them.
//
//  What these pin down:
//    • only the gap is ordered, not the whole requirement
//    • one PO per supplier — that is what the document is
//    • the PO points back at the job and its order
//    • a material with no supplier is reported, never silently dropped
//    • a material that could not be resolved is never ordered on, since
//      its "shortfall" is computed from a placeholder stock figure
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app;
let RawMaterial, Supplier, PurchaseOrder, Elastic, Customer, Order, JobOrder, User, admin;

const adminCookie = () => [
  `token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`,
];

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  RawMaterial = require('../../models/RawMaterial');
  Supplier = require('../../models/Supplier');
  PurchaseOrder = require('../../models/PurchaseOrder');
  Elastic = require('../../models/Elastic');
  Customer = require('../../models/Customer');
  Order = require('../../models/Order');
  JobOrder = require('../../models/JobOrder');
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

const makeSupplier = (name) => Supplier.create({ name, phoneNumber: '9000000000' });

const makeMaterial = (over = {}) =>
  RawMaterial.create({ name: 'Nylon 70D', category: 'Yarn', stock: 0, price: 320, ...over });

/**
 * A job for 1000 m of an elastic whose BOM draws `grams` per metre from
 * each given material — so the requirement is grams × 1000 / 1000 = kg.
 */
async function makeJob(bom, metres = 1000) {
  const customer = await Customer.create({
    name: 'Aravind Garments', contactName: 'Aravind', phoneNumber: '9111111111',
    address: 'Tiruppur', email: 'a@t.co',
  });
  const elastic = await Elastic.create({
    name: '25mm Woven', weight: 5, noOfHook: 24, pick: 40, spandexEnds: 8,
    warpYarn: bom.map((b) => ({ id: b.material._id, weight: b.grams })),
  });
  const order = await Order.create({
    customer: customer._id, po: 'PO-9001', date: new Date(), supplyDate: new Date(),
    elasticOrdered: [{ elastic: elastic._id, quantity: metres }],
  });
  const job = await JobOrder.create({
    order: order._id, customer: customer._id, date: new Date(),
    elastics: [{ elastic: elastic._id, quantity: metres }],
  });
  return { job, order, customer, elastic };
}

const raise = (jobId, body = {}) =>
  request(app).post(`/api/v2/job/${jobId}/raise-po`).set('Cookie', adminCookie()).send(body);

describe('raising a PO from the shortfall', () => {
  it('orders the gap, not the whole requirement', async () => {
    // 100 kg required, 30 already on hand — buy 70.
    const supplier = await makeSupplier('Kumar Yarns');
    const material = await makeMaterial({ stock: 30, supplier: supplier._id });
    const { job } = await makeJob([{ material, grams: 100 }]);

    const res = await raise(job._id);

    expect(res.status).toBe(201);
    expect(res.body.purchaseOrders).toHaveLength(1);
    expect(res.body.purchaseOrders[0].lines[0].quantity).toBe(70);

    const po = await PurchaseOrder.findById(res.body.purchaseOrders[0].poId);
    expect(po.items[0].quantity).toBe(70);
    expect(po.status).toBe('Open');
  });

  it('points the PO back at the job and its order', async () => {
    const supplier = await makeSupplier('Kumar Yarns');
    const material = await makeMaterial({ stock: 0, supplier: supplier._id });
    const { job, order } = await makeJob([{ material, grams: 50 }]);

    const res = await raise(job._id);
    const po = await PurchaseOrder.findById(res.body.purchaseOrders[0].poId);

    expect(String(po.forJob)).toBe(String(job._id));
    expect(String(po.forOrder)).toBe(String(order._id));
  });

  it('splits into one PO per supplier', async () => {
    // A purchase order goes to one supplier — splitting is not a design
    // choice, it is what the document is.
    const kumar = await makeSupplier('Kumar Yarns');
    const raja = await makeSupplier('Raja Spandex');
    const nylon = await makeMaterial({ name: 'Nylon 70D', stock: 0, supplier: kumar._id });
    const spandex = await makeMaterial({ name: 'Spandex 40D', stock: 0, supplier: raja._id });
    const { job } = await makeJob([
      { material: nylon, grams: 40 },
      { material: spandex, grams: 20 },
    ]);

    const res = await raise(job._id);

    expect(res.body.purchaseOrders).toHaveLength(2);
    const names = res.body.purchaseOrders.map((p) => p.supplierName).sort();
    expect(names).toEqual(['Kumar Yarns', 'Raja Spandex']);
    expect(await PurchaseOrder.countDocuments({ forJob: job._id })).toBe(2);
  });

  it('puts several materials from one supplier on a single PO', async () => {
    const kumar = await makeSupplier('Kumar Yarns');
    const nylon = await makeMaterial({ name: 'Nylon 70D', stock: 0, supplier: kumar._id });
    const poly = await makeMaterial({ name: 'Polyester 150D', stock: 0, supplier: kumar._id });
    const { job } = await makeJob([
      { material: nylon, grams: 40 },
      { material: poly, grams: 20 },
    ]);

    const res = await raise(job._id);

    expect(res.body.purchaseOrders).toHaveLength(1);
    expect(res.body.purchaseOrders[0].lines).toHaveLength(2);
  });

  it('leaves out a material that is already covered by stock', async () => {
    const kumar = await makeSupplier('Kumar Yarns');
    const short = await makeMaterial({ name: 'Nylon 70D', stock: 0, supplier: kumar._id });
    const covered = await makeMaterial({ name: 'Polyester 150D', stock: 9999, supplier: kumar._id });
    const { job } = await makeJob([
      { material: short, grams: 40 },
      { material: covered, grams: 20 },
    ]);

    const res = await raise(job._id);
    expect(res.body.purchaseOrders[0].lines.map((l) => l.name)).toEqual(['Nylon 70D']);
  });

  it('carries the material price onto the PO line', async () => {
    const kumar = await makeSupplier('Kumar Yarns');
    const material = await makeMaterial({ stock: 0, price: 415, supplier: kumar._id });
    const { job } = await makeJob([{ material, grams: 50 }]);

    const res = await raise(job._id);
    expect(res.body.purchaseOrders[0].lines[0].price).toBe(415);
    expect(res.body.purchaseOrders[0].value).toBe(50 * 415);
  });

  it('allocates a real PO number', async () => {
    const kumar = await makeSupplier('Kumar Yarns');
    const material = await makeMaterial({ stock: 0, supplier: kumar._id });
    const { job } = await makeJob([{ material, grams: 50 }]);

    const res = await raise(job._id);
    expect(typeof res.body.purchaseOrders[0].poNo).toBe('number');
    expect(res.body.purchaseOrders[0].poNo).toBeGreaterThan(0);
  });

  it('records the raise on the job audit trail', async () => {
    const kumar = await makeSupplier('Kumar Yarns');
    const material = await makeMaterial({ stock: 0, supplier: kumar._id });
    const { job } = await makeJob([{ material, grams: 50 }]);

    await raise(job._id);

    const after = await JobOrder.findById(job._id);
    const fp = after.fingerprints[after.fingerprints.length - 1];
    expect(fp.code).toBe('PO_RAISED');
    expect(fp.meta.source).toBe('mrp-shortfall');
  });
});

describe('what cannot be ordered', () => {
  it('refuses when nothing is short', async () => {
    const kumar = await makeSupplier('Kumar Yarns');
    const material = await makeMaterial({ stock: 9999, supplier: kumar._id });
    const { job } = await makeJob([{ material, grams: 50 }]);

    const res = await raise(job._id);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Nothing is short/i);
    expect(await PurchaseOrder.countDocuments({})).toBe(0);
  });

  it('names a short material that has no supplier instead of dropping it', async () => {
    // Silently leaving it off the PO is how a job waits on stock nobody
    // ever ordered.
    const kumar = await makeSupplier('Kumar Yarns');
    const ordered = await makeMaterial({ name: 'Nylon 70D', stock: 0, supplier: kumar._id });
    const orphan = await makeMaterial({ name: 'Rubber Tape', stock: 0, supplier: null });
    const { job } = await makeJob([
      { material: ordered, grams: 40 },
      { material: orphan, grams: 20 },
    ]);

    const res = await raise(job._id);

    expect(res.status).toBe(201);
    expect(res.body.purchaseOrders).toHaveLength(1);
    expect(res.body.skipped).toEqual([
      expect.objectContaining({ name: 'Rubber Tape', reason: 'no supplier set' }),
    ]);
  });

  it('refuses outright when no short material has a supplier', async () => {
    const orphan = await makeMaterial({ name: 'Rubber Tape', stock: 0, supplier: null });
    const { job } = await makeJob([{ material: orphan, grams: 20 }]);

    const res = await raise(job._id);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/has a supplier set/i);
    expect(await PurchaseOrder.countDocuments({})).toBe(0);
  });

  it('never orders on a material that could not be resolved', async () => {
    // Its stock figure is a placeholder, so the "shortfall" is not a
    // reading and buying against it would be guessing.
    const kumar = await makeSupplier('Kumar Yarns');
    const real = await makeMaterial({ name: 'Nylon 70D', stock: 0, supplier: kumar._id });
    const ghost = await makeMaterial({ name: 'Deleted yarn', stock: 0, supplier: kumar._id });
    const { job } = await makeJob([
      { material: real, grams: 40 },
      { material: ghost, grams: 20 },
    ]);
    await RawMaterial.deleteOne({ _id: ghost._id });

    const res = await raise(job._id);

    expect(res.body.purchaseOrders[0].lines).toHaveLength(1);
    expect(res.body.skipped).toEqual([
      expect.objectContaining({ reason: 'material not found' }),
    ]);
  });

  it('rejects an unknown job', async () => {
    const res = await raise(new mongoose.Types.ObjectId());
    expect(res.status).toBe(404);
  });
});

describe('choosing which materials to order', () => {
  it('orders only the materials named', async () => {
    const kumar = await makeSupplier('Kumar Yarns');
    const nylon = await makeMaterial({ name: 'Nylon 70D', stock: 0, supplier: kumar._id });
    const poly = await makeMaterial({ name: 'Polyester 150D', stock: 0, supplier: kumar._id });
    const { job } = await makeJob([
      { material: nylon, grams: 40 },
      { material: poly, grams: 20 },
    ]);

    const res = await raise(job._id, { materials: [String(nylon._id)] });

    expect(res.body.purchaseOrders[0].lines).toHaveLength(1);
    expect(res.body.purchaseOrders[0].lines[0].name).toBe('Nylon 70D');
  });

  it('takes an expected date and notes', async () => {
    const kumar = await makeSupplier('Kumar Yarns');
    const material = await makeMaterial({ stock: 0, supplier: kumar._id });
    const { job } = await makeJob([{ material, grams: 50 }]);

    const res = await raise(job._id, {
      expectedDate: '2026-09-15', notes: 'Urgent — job is waiting',
    });

    const po = await PurchaseOrder.findById(res.body.purchaseOrders[0].poId);
    expect(po.notes).toBe('Urgent — job is waiting');
    expect(po.expectedDate.toISOString().slice(0, 10)).toBe('2026-09-15');
  });

  it('defaults the note to name the job it was raised for', async () => {
    const kumar = await makeSupplier('Kumar Yarns');
    const material = await makeMaterial({ stock: 0, supplier: kumar._id });
    const { job } = await makeJob([{ material, grams: 50 }]);

    const res = await raise(job._id);
    const po = await PurchaseOrder.findById(res.body.purchaseOrders[0].poId);
    expect(po.notes).toMatch(new RegExp(`J-${job.jobOrderNo}`));
  });
});

describe('what has been ordered for a job', () => {
  it('lists the POs raised against it', async () => {
    const kumar = await makeSupplier('Kumar Yarns');
    const material = await makeMaterial({ stock: 0, supplier: kumar._id });
    const { job } = await makeJob([{ material, grams: 50 }]);
    await raise(job._id);

    const res = await request(app)
      .get(`/api/v2/job/${job._id}/purchase-orders`)
      .set('Cookie', adminCookie());

    expect(res.status).toBe(200);
    expect(res.body.purchaseOrders).toHaveLength(1);
    expect(res.body.purchaseOrders[0].supplier.name).toBe('Kumar Yarns');
  });

  it('does not pick up a PO raised for something else', async () => {
    const kumar = await makeSupplier('Kumar Yarns');
    const material = await makeMaterial({ stock: 0, supplier: kumar._id });
    const { job } = await makeJob([{ material, grams: 50 }]);
    await PurchaseOrder.create({
      supplier: kumar._id, poNo: 9999,
      items: [{ rawMaterial: material._id, quantity: 10, price: 1 }],
    });

    const res = await request(app)
      .get(`/api/v2/job/${job._id}/purchase-orders`)
      .set('Cookie', adminCookie());

    expect(res.body.purchaseOrders).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════
//  ORDER-LEVEL — the whole order, before it is split into jobs
// ══════════════════════════════════════════════════════════════════
describe('raising a PO for a whole order', () => {
  const orderMrp = (id) =>
    request(app).get(`/api/v2/order/${id}/mrp`).set('Cookie', adminCookie());
  const raiseForOrder = (id, body = {}) =>
    request(app).post(`/api/v2/order/${id}/raise-po`).set('Cookie', adminCookie()).send(body);

  it('computes the requirement for everything ordered', async () => {
    const kumar = await makeSupplier('Kumar Yarns');
    const material = await makeMaterial({ stock: 30, supplier: kumar._id });
    const { order } = await makeJob([{ material, grams: 100 }]);

    const res = await orderMrp(order._id);
    expect(res.status).toBe(200);
    expect(res.body.data.materials[0]).toMatchObject({ requiredWeight: 100, inStock: 30, shortfall: 70 });
  });

  it('covers quantity no job has been raised for', async () => {
    // The job-level MRP only sees what was planned into a run. The order
    // one sees the whole commitment, which is what has to be bought.
    const kumar = await makeSupplier('Kumar Yarns');
    const material = await makeMaterial({ stock: 0, supplier: kumar._id });
    const { order } = await makeJob([{ material, grams: 100 }]);

    const res = await raiseForOrder(order._id);
    expect(res.status).toBe(201);
    expect(res.body.purchaseOrders[0].lines[0].quantity).toBe(100);
  });

  it('links the PO to the order and to no job', async () => {
    const kumar = await makeSupplier('Kumar Yarns');
    const material = await makeMaterial({ stock: 0, supplier: kumar._id });
    const { order } = await makeJob([{ material, grams: 50 }]);

    const res = await raiseForOrder(order._id);
    const po = await PurchaseOrder.findById(res.body.purchaseOrders[0].poId);
    expect(String(po.forOrder)).toBe(String(order._id));
    expect(po.forJob).toBeUndefined();
  });

  it('splits by supplier, exactly as the job-level one does', async () => {
    const kumar = await makeSupplier('Kumar Yarns');
    const raja = await makeSupplier('Raja Spandex');
    const nylon = await makeMaterial({ name: 'Nylon 70D', stock: 0, supplier: kumar._id });
    const spandex = await makeMaterial({ name: 'Spandex 40D', stock: 0, supplier: raja._id });
    const { order } = await makeJob([
      { material: nylon, grams: 40 },
      { material: spandex, grams: 20 },
    ]);

    const res = await raiseForOrder(order._id);
    expect(res.body.purchaseOrders).toHaveLength(2);
  });

  it('names a short material with no supplier rather than dropping it', async () => {
    const kumar = await makeSupplier('Kumar Yarns');
    const ordered = await makeMaterial({ name: 'Nylon 70D', stock: 0, supplier: kumar._id });
    const orphan = await makeMaterial({ name: 'Rubber Tape', stock: 0, supplier: null });
    const { order } = await makeJob([
      { material: ordered, grams: 40 },
      { material: orphan, grams: 20 },
    ]);

    const res = await raiseForOrder(order._id);
    expect(res.body.skipped).toEqual([
      expect.objectContaining({ name: 'Rubber Tape', reason: 'no supplier set' }),
    ]);
  });

  it('refuses when nothing is short', async () => {
    const kumar = await makeSupplier('Kumar Yarns');
    const material = await makeMaterial({ stock: 9999, supplier: kumar._id });
    const { order } = await makeJob([{ material, grams: 50 }]);

    const res = await raiseForOrder(order._id);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Nothing is short/i);
  });

  it('lists everything bought for the order, jobs included', async () => {
    // From the order's point of view a PO raised off one of its jobs is
    // the same spend, so both belong on the one list.
    const kumar = await makeSupplier('Kumar Yarns');
    const material = await makeMaterial({ stock: 0, supplier: kumar._id });
    const { order, job } = await makeJob([{ material, grams: 50 }]);

    await raiseForOrder(order._id);
    await raise(job._id);

    const res = await request(app)
      .get(`/api/v2/order/${order._id}/purchase-orders`)
      .set('Cookie', adminCookie());
    expect(res.body.purchaseOrders).toHaveLength(2);
  });

  it('records the raise on the order audit trail', async () => {
    const kumar = await makeSupplier('Kumar Yarns');
    const material = await makeMaterial({ stock: 0, supplier: kumar._id });
    const { order } = await makeJob([{ material, grams: 50 }]);

    await raiseForOrder(order._id);

    const after = await Order.findById(order._id);
    const fp = after.fingerprints[after.fingerprints.length - 1];
    expect(fp.code).toBe('PO_RAISED');
    expect(fp.meta.source).toBe('order-mrp-shortfall');
  });
});
