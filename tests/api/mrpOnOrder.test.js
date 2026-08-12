'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE "ON ORDER" COLUMN ON THE MRP SHEET
//
//  Reported as: the column shows nothing for a material that has an
//  open purchase order against it.
//
//  It matters because of what somebody does when it is blank. A
//  shortfall with no "on order" beside it reads as unbought, and the
//  natural response is to raise the purchase order — so the yarn
//  arrives twice and the money goes out twice. That is the whole reason
//  the column exists.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

const { onOrderByMaterial, computeMaterialRequirement } =
  require('../../utils/materialRequirement');

let mongo, app;
let Order, JobOrder, Customer, Elastic, RawMaterial, PurchaseOrder, Supplier, User, admin;

const adminCookie = () => [
  `token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`,
];

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  Order         = require('../../models/Order');
  JobOrder      = require('../../models/JobOrder');
  Customer      = require('../../models/Customer');
  Elastic       = require('../../models/Elastic');
  RawMaterial   = require('../../models/RawMaterial');
  PurchaseOrder = require('../../models/PurchaseOrder');
  Supplier      = require('../../models/Supplier');
  User          = require('../../models/User');
  admin = await User.create({
    name: 'Owner', email: 'mrp@t.co', password: 'pass1234',
    role: 'admin', department: 'admin',
  });
}, 120_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
});

let seq = 0;

/** An elastic whose recipe needs 1 kg of `yarn` per 1000 m. */
async function seedJob({ stock = 0, orderedMetres = 1000 } = {}) {
  const yarn = await RawMaterial.create({
    name: `Nylon ${++seq}`, category: 'warp', price: 300, stock,
  });
  const elastic = await Elastic.create({
    name: `20mm ${Math.random().toString(36).slice(2, 8)}`, weaveType: '8',
    spandexEnds: 40, yarnEnds: 120, pick: 12, noOfHook: 8, weight: 2.4,
    warpYarn: [{ id: yarn._id, ends: 40, weight: 1 }],
  });
  const customer = await Customer.create({
    name: `Acme ${seq}`, contactName: 'R', phoneNumber: '9000000001',
  });
  const order = await Order.create({
    customer: customer._id, po: `PO-${seq}`, date: new Date(), supplyDate: new Date(),
    elasticOrdered: [{ elastic: elastic._id, quantity: orderedMetres }],
    status: 'InProgress',
  });
  const job = await JobOrder.create({
    date: new Date(), order: order._id, customer: customer._id,
    status: 'preparatory', elastics: [{ elastic: elastic._id, quantity: orderedMetres }],
  });
  return { yarn, elastic, order, job };
}

const makePo = async (yarn, { quantity = 100, received = 0, status = 'Open' } = {}) => {
  const supplier = await Supplier.create({
    name: `Kumar ${++seq}`, phoneNumber: '9000000002',
  });
  return PurchaseOrder.create({
    supplier: supplier._id, date: new Date(), status,
    items: [{ rawMaterial: yarn._id, quantity, price: 300, receivedQuantity: received }],
  });
};

const mrp = (job) =>
  request(app).get(`/api/v2/job/${job._id}/mrp`).set('Cookie', adminCookie());

const rowFor = (res, yarn) =>
  res.body.data.materials.find((m) => String(m.rawMaterial) === String(yarn._id));

// ══════════════════════════════════════════════════════════════════
//  THE HELPER
// ══════════════════════════════════════════════════════════════════
describe('onOrderByMaterial', () => {
  it('counts what an open purchase order still owes', async () => {
    const { yarn } = await seedJob();
    await makePo(yarn, { quantity: 100 });

    const due = await onOrderByMaterial([yarn._id]);
    expect(due.get(String(yarn._id))).toBe(100);
  });

  it('counts only the remainder of a part-received line', async () => {
    const { yarn } = await seedJob();
    await makePo(yarn, { quantity: 100, received: 40, status: 'Partial' });

    const due = await onOrderByMaterial([yarn._id]);
    expect(due.get(String(yarn._id))).toBe(60);
  });

  it('ignores a cancelled order — it owes nothing', async () => {
    const { yarn } = await seedJob();
    await makePo(yarn, { quantity: 100, status: 'Cancelled' });

    expect((await onOrderByMaterial([yarn._id])).get(String(yarn._id))).toBeUndefined();
  });

  it('ignores a completed one — it has arrived', async () => {
    const { yarn } = await seedJob();
    await makePo(yarn, { quantity: 100, received: 100, status: 'Completed' });

    expect((await onOrderByMaterial([yarn._id])).get(String(yarn._id))).toBeUndefined();
  });

  it('adds up several open orders for the same material', async () => {
    const { yarn } = await seedJob();
    await makePo(yarn, { quantity: 100 });
    await makePo(yarn, { quantity: 60 });

    expect((await onOrderByMaterial([yarn._id])).get(String(yarn._id))).toBe(160);
  });

  it('accepts string ids as well as ObjectIds', async () => {
    // computeMaterialRequirement hands it whatever the recipe carried,
    // which is not always an ObjectId.
    const { yarn } = await seedJob();
    await makePo(yarn, { quantity: 100 });

    expect((await onOrderByMaterial([String(yarn._id)])).get(String(yarn._id))).toBe(100);
  });
});

// ══════════════════════════════════════════════════════════════════
//  THROUGH THE REQUIREMENT
// ══════════════════════════════════════════════════════════════════
describe('computeMaterialRequirement', () => {
  it('puts the pending purchase quantity on the row', async () => {
    const { yarn, elastic } = await seedJob();
    await makePo(yarn, { quantity: 100 });

    const rows = await computeMaterialRequirement([
      { elastic: elastic._id, quantity: 1000 },
    ]);
    const row = rows.find((r) => String(r.rawMaterial) === String(yarn._id));
    expect(row.onOrder).toBe(100);
  });

  it('does not net it off the shortfall', async () => {
    // On-order is stock bought, not stock in the building. Subtracting
    // it would report a material as covered while the machine has
    // nothing to run.
    const { yarn, elastic } = await seedJob({ stock: 0 });
    await makePo(yarn, { quantity: 100 });

    const rows = await computeMaterialRequirement([
      { elastic: elastic._id, quantity: 1000 },
    ]);
    const row = rows.find((r) => String(r.rawMaterial) === String(yarn._id));
    expect(row.shortfall).toBe(1);   // 1 kg per 1000 m, none in stock
    expect(row.onOrder).toBe(100);
    // ...but buying again would be money out twice.
    expect(row.toBuy).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════
//  THE SHEET ITSELF
// ══════════════════════════════════════════════════════════════════
describe('the MRP sheet', () => {
  it('carries On order for a material with an open PO', async () => {
    const { yarn, job } = await seedJob({ stock: 0 });
    await makePo(yarn, { quantity: 100 });

    const res = await mrp(job);
    expect(res.status).toBe(200);
    expect(rowFor(res, yarn).onOrder).toBe(100);
  });

  it('carries it on a part-received PO too', async () => {
    const { yarn, job } = await seedJob({ stock: 0 });
    await makePo(yarn, { quantity: 100, received: 40, status: 'Partial' });

    expect(rowFor(await mrp(job), yarn).onOrder).toBe(60);
  });

  it('reports zero rather than nothing when there is no PO', async () => {
    // A missing field renders as a blank, which reads as "unknown"
    // instead of "none on order".
    const { yarn, job } = await seedJob({ stock: 0 });

    expect(rowFor(await mrp(job), yarn).onOrder).toBe(0);
  });

  it('still carries it once the order has drawn its material', async () => {
    // The requirement is recomputed with an `allocated` map after
    // approval. That second pass must not lose the on-order figure.
    const { yarn, job, order } = await seedJob({ stock: 0 });
    await makePo(yarn, { quantity: 100 });
    await Order.updateOne(
      { _id: order._id },
      { $set: { rawMaterialRequired: [{ rawMaterial: yarn._id, requiredWeight: 1 }] } }
    );

    expect(rowFor(await mrp(job), yarn).onOrder).toBe(100);
  });
});

// ── Through the routes a person actually uses ─────────────────────────
//
// The tests above build the purchase order by hand. These raise it the
// way the app does, because a difference between the two is exactly
// where a column goes blank in production and not in a test.

describe('a PO raised through the app', () => {
  it('shows up as On order on the MRP sheet', async () => {
    const { yarn, job } = await seedJob({ stock: 0 });

    const raised = await request(app)
      .post('/api/v2/materials/raise-po')
      .set('Cookie', adminCookie())
      .send({
        supplier: String((await Supplier.create({
          name: `S${++seq}`, phoneNumber: '9000000003',
        }))._id),
        items: [{ rawMaterial: String(yarn._id), quantity: 100, price: 300 }],
      });
    expect(raised.status).toBe(201);

    expect(rowFor(await mrp(job), yarn).onOrder).toBe(100);
  });

  it('shows up when raised from the job shortfall', async () => {
    const { yarn, job } = await seedJob({ stock: 0 });
    await RawMaterial.updateOne(
      { _id: yarn._id },
      { $set: { supplier: (await Supplier.create({
        name: `S${++seq}`, phoneNumber: '9000000004',
      }))._id } }
    );

    const raised = await request(app)
      .post(`/api/v2/job/${job._id}/raise-po`)
      .set('Cookie', adminCookie())
      .send({});
    expect(raised.status).toBeLessThan(400);

    const row = rowFor(await mrp(job), yarn);
    expect(row.onOrder).toBeGreaterThan(0);
    // And the shortfall is no longer something to buy again.
    expect(row.toBuy).toBe(0);
  });
});

describe('the order-level material sheet', () => {
  const orderMrp = (order) =>
    request(app).get(`/api/v2/order/${order._id}/mrp`).set('Cookie', adminCookie());

  it('carries On order there too', async () => {
    const { yarn, order } = await seedJob({ stock: 0 });
    await makePo(yarn, { quantity: 100 });

    const res = await orderMrp(order);
    expect(res.status).toBe(200);
    const row = (res.body.data.materials || res.body.data)
      .find((m) => String(m.rawMaterial) === String(yarn._id));
    expect(row.onOrder).toBe(100);
  });
});

// ── Rows written before the schema settled ────────────────────────────
//
// The column works on every document this app writes today, so a blank
// in production points at a row that predates something. These are the
// shapes that actually turn up.

describe('a purchase order missing fields', () => {
  const raw = () => mongoose.connection.collection('purchaseorders');

  it('counts one with no status at all', async () => {
    // $nin matches a missing field, so this should already work — but
    // "should" is why it is worth a test.
    const { yarn, job } = await seedJob({ stock: 0 });
    await raw().insertOne({
      supplier: new mongoose.Types.ObjectId(), date: new Date(),
      items: [{ rawMaterial: yarn._id, quantity: 100, price: 300 }],
    });

    expect(rowFor(await mrp(job), yarn).onOrder).toBe(100);
  });

  it('counts one whose line never recorded a received quantity', async () => {
    const { yarn, job } = await seedJob({ stock: 0 });
    await raw().insertOne({
      supplier: new mongoose.Types.ObjectId(), date: new Date(), status: 'Open',
      items: [{ rawMaterial: yarn._id, quantity: 100 }],
    });

    expect(rowFor(await mrp(job), yarn).onOrder).toBe(100);
  });

  it('counts one whose material reference was stored as a string', async () => {
    // The one shape that would silently miss: an $in of ObjectIds does
    // not match a string, and nothing would say so.
    const { yarn, job } = await seedJob({ stock: 0 });
    await raw().insertOne({
      supplier: new mongoose.Types.ObjectId(), date: new Date(), status: 'Open',
      items: [{ rawMaterial: String(yarn._id), quantity: 100, price: 300 }],
    });

    expect(rowFor(await mrp(job), yarn).onOrder).toBe(100);
  });
});
