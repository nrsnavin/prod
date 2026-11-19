'use strict';
// ══════════════════════════════════════════════════════════════════
//  A WARPING BATCH: THREE RULES THAT HAD A WAY ROUND THEM
//
//  1. Completing a warping is refused until its yarn has been issued,
//     because otherwise the lot ledger claims yarn that is in the beams.
//     Cancelling the issued batch AFTER the warping was completed put
//     that yarn back on the rack all the same.
//
//  2. Issuing a batch spends the order's earmark on the lot down (the
//     yarn has left the rack). Cancelling the batch put the yarn back
//     but not the promise: the kilos became free for any other order,
//     and drawing the same lot again was refused as "not one of the
//     lots this order set aside".
//
//  3. Drawing a lot the order had not set aside needs a reason, and
//     the reason goes on the job's trail. It was written before the
//     batch existed, so a batch that was then refused left the trail
//     describing a batch nobody could find — and it, like every batch
//     issue, was labelled "Warping Started".
//
//  None of the earmark behaviour at batch time had a test before this.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app;
let RawMaterial, YarnLot, WarpingBatch, Warping, WarpingPlan, JobOrder, Order, Customer, Elastic, User, admin;

const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  RawMaterial = require('../../models/RawMaterial');
  YarnLot = require('../../models/YarnLot');
  WarpingBatch = require('../../models/WarpingBatch');
  Warping = require('../../models/Warping');
  WarpingPlan = require('../../models/WarpingPlan');
  JobOrder = require('../../models/JobOrder');
  Order = require('../../models/Order');
  Customer = require('../../models/Customer');
  Elastic = require('../../models/Elastic');
  User = require('../../models/User');
  admin = await User.create({ name: 'Owner', email: 'o@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
});

// ── fixtures ──────────────────────────────────────────────────────
let seq = 0;
const makeMaterial = () => { seq += 1; return RawMaterial.create({ name: `Nylon 70D ${seq}`, category: 'Yarn', stock: 500, price: 320 }); };
const makeLot = (material, over = {}) => YarnLot.create({ rawMaterial: material._id, lotNo: 'D-4471', shade: 'Off White', receivedQty: 100, ...over });

/**
 * A job on an approved order, with a two-beam plan to batch against.
 * `earmarks` — [{ lot, quantity }] the order has set aside of `material`.
 * `lotOnPlan` — programme the beams off this lot (which is what makes
 * completing the warping wait for an issue).
 */
async function makeWarping(material, { earmarks = [], required = 100, lotOnPlan = null, orderStatus = 'Approved' } = {}) {
  const customer = await Customer.create({ name: 'Aravind Garments', contactName: 'Aravind', phoneNumber: '9111111111', address: 'Tiruppur', email: 'a@t.co' });
  const elastic = await Elastic.create({ name: `25mm Woven ${Math.random().toString(36).slice(2, 8)}`, weight: 5, noOfHook: 24, pick: 40, spandexEnds: 8 });
  const order = await Order.create({
    customer: customer._id, po: 'PO-9001', date: new Date(), supplyDate: new Date(), status: orderStatus,
    elasticOrdered: [{ elastic: elastic._id, quantity: 5000 }],
    rawMaterialRequired: [{
      rawMaterial: material._id, name: material.name, requiredWeight: required,
      lots: earmarks.map((e) => ({ yarnLot: e.lot._id, lotNo: e.lot.lotNo, shade: e.lot.shade, quantity: e.quantity })),
    }],
  });
  const job = await JobOrder.create({ order: order._id, customer: customer._id, date: new Date(), elastics: [{ elastic: elastic._id, quantity: 5000 }] });
  const warping = await Warping.create({ job: job._id, status: 'open' });
  const section = { warpYarn: material._id, ends: 240, maxMeters: 3000, ...(lotOnPlan ? { yarnLot: lotOnPlan._id, lotNo: lotOnPlan.lotNo } : {}) };
  const plan = await WarpingPlan.create({
    warping: warping._id, job: job._id, noOfBeams: 2,
    beams: [{ beamNo: 1, totalEnds: 240, sections: [section] }, { beamNo: 2, totalEnds: 240, sections: [section] }],
  });
  warping.warpingPlan = plan._id;
  await warping.save();
  return { warping, plan, job, order };
}

const post = (url, body = {}) => request(app).post(`/api/v2/warping${url}`).set('Cookie', cookie()).send(body);
const patch = (url, body = {}) => request(app).patch(`/api/v2/warping${url}`).set('Cookie', cookie()).send(body);
const createBatch = (warping, material, lot, quantity, extra = {}) => post('/batch/create', {
  warpingId: String(warping._id), beamNos: [1],
  allocations: [{ rawMaterial: String(material._id), yarnLot: String(lot._id), quantity }],
  ...extra,
});
const earmarkOf = async (order, lot) => {
  const fresh = await Order.findById(order._id).lean();
  const row = (fresh.rawMaterialRequired[0].lots || []).find((l) => String(l.yarnLot) === String(lot._id));
  return row ? row.quantity : 0;
};
const trail = async (job) => (await JobOrder.findById(job._id).lean()).fingerprints || [];

// ══════════════════════════════════════════════════════════════════
describe('cancelling a batch after its warping is completed', () => {
  async function completedWarpingWithIssuedBatch() {
    const material = await makeMaterial();
    const lot = await makeLot(material);
    const ctx = await makeWarping(material, { lotOnPlan: lot });
    const batch = (await createBatch(ctx.warping, material, lot, 40)).body.batch;
    expect((await post(`/batch/${batch._id}/issue`)).status).toBe(200);
    expect((await post('/start', { id: String(ctx.warping._id) })).status).toBe(200);
    expect((await post('/complete', { id: String(ctx.warping._id) })).status).toBe(200);
    return { ...ctx, material, lot, batch };
  }

  it('refuses to put the yarn of built beams back on the rack', async () => {
    const { lot, batch } = await completedWarpingWithIssuedBatch();

    const res = await patch(`/batch/${batch._id}/cancel`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('WARPING_COMPLETED');
    expect(res.body.message).toMatch(/warping is completed/);

    // Nothing moved: the batch is still issued and the lot still drawn.
    expect((await WarpingBatch.findById(batch._id)).status).toBe('issued');
    expect((await YarnLot.findById(lot._id)).consumedQty).toBe(40);
  });

  it('still lets a batch that never drew anything be cancelled', async () => {
    const { warping, material, lot } = await completedWarpingWithIssuedBatch();
    // Raised (beam 2) before completion and never issued. Put there
    // directly: the route refuses a new batch on a completed warping.
    const planned = await WarpingBatch.create({
      batchNo: 'WB-9001', warping: warping._id, job: warping.job, beamNos: [2],
      allocations: [{ rawMaterial: material._id, yarnLot: lot._id, lotNo: lot.lotNo, quantity: 10 }],
    });
    const res = await patch(`/batch/${planned._id}/cancel`);
    expect(res.status).toBe(200);
    expect(res.body.batch.status).toBe('cancelled');
    expect((await YarnLot.findById(lot._id)).consumedQty).toBe(40);
  });

  it('lets an issued batch be cancelled while the warping is still running', async () => {
    const material = await makeMaterial();
    const lot = await makeLot(material);
    const { warping } = await makeWarping(material, { lotOnPlan: lot });
    const batch = (await createBatch(warping, material, lot, 40)).body.batch;
    await post(`/batch/${batch._id}/issue`);
    await post('/start', { id: String(warping._id) });

    const res = await patch(`/batch/${batch._id}/cancel`);
    expect(res.status).toBe(200);
    expect((await YarnLot.findById(lot._id)).consumedQty).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════
describe("the order's earmark when a batch is issued and then cancelled", () => {
  it('spends the earmark on issue and gives it back on cancel', async () => {
    const material = await makeMaterial();
    const lot = await makeLot(material);
    const { warping, order } = await makeWarping(material, { earmarks: [{ lot, quantity: 100 }] });

    const batch = (await createBatch(warping, material, lot, 40)).body.batch;
    expect((await post(`/batch/${batch._id}/issue`)).status).toBe(200);
    expect(await earmarkOf(order, lot)).toBe(60);
    expect((await WarpingBatch.findById(batch._id)).allocations[0].earmarkSpent).toBe(40);

    expect((await patch(`/batch/${batch._id}/cancel`)).status).toBe(200);
    // The yarn is back on the rack AND still spoken for by this order.
    expect((await YarnLot.findById(lot._id)).balance).toBe(100);
    expect(await earmarkOf(order, lot)).toBe(100);
  });

  it('puts back a promise that had been drawn to nothing', async () => {
    const material = await makeMaterial();
    const lot = await makeLot(material);
    const { warping, order } = await makeWarping(material, { earmarks: [{ lot, quantity: 40 }] });

    const batch = (await createBatch(warping, material, lot, 40)).body.batch;
    await post(`/batch/${batch._id}/issue`);
    // Spent to nothing, so the row was removed.
    expect((await Order.findById(order._id).lean()).rawMaterialRequired[0].lots).toHaveLength(0);

    await patch(`/batch/${batch._id}/cancel`);
    const rows = (await Order.findById(order._id).lean()).rawMaterialRequired[0].lots;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ lotNo: 'D-4471', shade: 'Off White', quantity: 40 });
    expect(String(rows[0].yarnLot)).toBe(String(lot._id));
  });

  it('gives back only what the batch spent when it drew more than was promised', async () => {
    const material = await makeMaterial();
    const lot = await makeLot(material);
    const { warping, order } = await makeWarping(material, { earmarks: [{ lot, quantity: 25 }] });

    const batch = (await createBatch(warping, material, lot, 40)).body.batch;
    await post(`/batch/${batch._id}/issue`);
    expect((await WarpingBatch.findById(batch._id)).allocations[0].earmarkSpent).toBe(25);

    await patch(`/batch/${batch._id}/cancel`);
    expect(await earmarkOf(order, lot)).toBe(25);
  });

  it('lets the same lot be drawn again afterwards with no override', async () => {
    const material = await makeMaterial();
    const lot = await makeLot(material);
    const other = await makeLot(material, { lotNo: 'D-5002' });
    const { warping } = await makeWarping(material, { earmarks: [{ lot, quantity: 40 }, { lot: other, quantity: 30 }], required: 100 });

    const first = (await createBatch(warping, material, lot, 40)).body.batch;
    await post(`/batch/${first._id}/issue`);
    await patch(`/batch/${first._id}/cancel`);

    // Before: the lot's row was gone, D-5002's was not, so this drew
    // "a lot the order had not set aside".
    const again = await createBatch(warping, material, lot, 40);
    expect(again.status).toBe(201);
  });

  it('adds nothing when the order has since set aside all it needs elsewhere', async () => {
    const material = await makeMaterial();
    const lot = await makeLot(material);
    const other = await makeLot(material, { lotNo: 'D-5002' });
    const { warping, order } = await makeWarping(material, { earmarks: [{ lot, quantity: 40 }], required: 40 });

    const batch = (await createBatch(warping, material, lot, 40)).body.batch;
    await post(`/batch/${batch._id}/issue`);
    // The planner re-earmarks the whole requirement from another lot.
    await Order.updateOne({ _id: order._id }, { $set: { 'rawMaterialRequired.0.lots': [{ yarnLot: other._id, lotNo: other.lotNo, shade: '', quantity: 40 }] } });

    await patch(`/batch/${batch._id}/cancel`);
    expect(await earmarkOf(order, lot)).toBe(0);
    expect(await earmarkOf(order, other)).toBe(40);
  });

  it('gives nothing back to an order that no longer holds yarn', async () => {
    const material = await makeMaterial();
    const lot = await makeLot(material);
    const { warping, order } = await makeWarping(material, { earmarks: [{ lot, quantity: 100 }] });

    const batch = (await createBatch(warping, material, lot, 40)).body.batch;
    await post(`/batch/${batch._id}/issue`);
    await Order.updateOne({ _id: order._id }, { $set: { status: 'Cancelled', 'rawMaterialRequired.0.lots': [] } });

    expect((await patch(`/batch/${batch._id}/cancel`)).status).toBe(200);
    expect((await Order.findById(order._id).lean()).rawMaterialRequired[0].lots).toHaveLength(0);
    expect((await YarnLot.findById(lot._id)).balance).toBe(100);
  });
});

// ══════════════════════════════════════════════════════════════════
describe("drawing a lot the order had not set aside", () => {
  async function offTheEarmark() {
    const material = await makeMaterial();
    const lot = await makeLot(material);
    const other = await makeLot(material, { lotNo: 'D-5002' });
    const ctx = await makeWarping(material, { earmarks: [{ lot, quantity: 100 }] });
    return { ...ctx, material, lot, other };
  }

  it('asks for a reason, by name', async () => {
    const { warping, material, other, job } = await offTheEarmark();
    const res = await createBatch(warping, material, other, 40);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('LOT_NOT_EARMARKED');
    expect(await trail(job)).toHaveLength(0);
  });

  it('records the reason on the job with the batch it was for', async () => {
    const { warping, material, other, job } = await offTheEarmark();
    const res = await createBatch(warping, material, other, 40, { lotOverrideReason: 'D-4471 came up short on the rack' });
    expect(res.status).toBe(201);

    const rows = await trail(job);
    expect(rows).toHaveLength(1);
    expect(rows[0].code).toBe('WARPING_LOT_OVERRIDE');
    expect(rows[0].label).toBe('Lot Drawn Off the Earmark');
    expect(rows[0].meta).toMatchObject({ batchNo: res.body.batch.batchNo, reason: 'D-4471 came up short on the rack' });
  });

  it('records nothing when the batch is then refused', async () => {
    const { warping, material, lot, other, job } = await offTheEarmark();
    // Beam 1 is taken by a batch on the earmarked lot.
    expect((await createBatch(warping, material, lot, 10)).status).toBe(201);

    const res = await createBatch(warping, material, other, 40, { lotOverrideReason: 'D-4471 came up short on the rack' });
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/Beam 1 is already on batch/);
    // Before: an override line for a batch that does not exist.
    expect(await trail(job)).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════
describe("what a batch leaves on the job's trail", () => {
  it('says yarn was issued, not that warping started', async () => {
    const material = await makeMaterial();
    const lot = await makeLot(material);
    const { warping, job } = await makeWarping(material);
    const batch = (await createBatch(warping, material, lot, 40)).body.batch;

    const res = await post(`/batch/${batch._id}/issue`);
    expect(res.body.fingerprint.code).toBe('WARPING_BATCH_ISSUED');
    const rows = await trail(job);
    expect(rows.map((r) => r.label)).toEqual(['Yarn Issued to Warping']);
  });

  it('says a batch was cancelled, and whether its yarn went back', async () => {
    const material = await makeMaterial();
    const lot = await makeLot(material);
    const { warping, job } = await makeWarping(material);
    const batch = (await createBatch(warping, material, lot, 40)).body.batch;
    await post(`/batch/${batch._id}/issue`);

    await patch(`/batch/${batch._id}/cancel`, { reason: 'wrong beam' });
    const last = (await trail(job)).at(-1);
    expect(last.code).toBe('WARPING_BATCH_CANCELLED');
    expect(last.meta).toMatchObject({ batchNo: batch.batchNo, yarnReturned: true, lots: ['D-4471 (40)'], reason: 'wrong beam' });
  });

  it('keeps "Warping Started" for the start itself', async () => {
    const material = await makeMaterial();
    const { warping, job } = await makeWarping(material);
    await post('/start', { id: String(warping._id) });
    expect((await trail(job)).map((r) => r.code)).toEqual(['WARPING_STARTED']);
  });
});
