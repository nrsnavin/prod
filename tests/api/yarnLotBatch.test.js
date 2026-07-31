'use strict';
// ══════════════════════════════════════════════════════════════════
//  YARN LOTS + WARPING BATCHES
//
//  Yarn arrives dyed in lots and is warped in batches drawn from known
//  lots, so a shade complaint can be traced back to the bag it came out
//  of. What these tests pin down:
//
//    • inward with a lot number opens (and tops up) a lot bucket
//    • issuing a batch draws the lot down and leaves RawMaterial.stock
//      ALONE — that was already debited at order approval, and debiting
//      it again here is the one mistake that would corrupt every stock
//      figure in the system
//    • a lot cannot be overdrawn, including by two concurrent issues
//    • cancelling an issued batch puts the yarn back; cancelling a
//      planned one has nothing to put back
//    • a lot traces forward to the batches, jobs and customers it reached
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app;
let RawMaterial, YarnLot, WarpingBatch, Warping, WarpingPlan, JobOrder,
  Order, Customer, Elastic, Supplier, PurchaseOrder, MaterialOutward, User, admin;

const adminCookie = () => [
  `token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`,
];

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
  Supplier = require('../../models/Supplier');
  PurchaseOrder = require('../../models/PurchaseOrder');
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

// ── fixtures ──────────────────────────────────────────────────────
const makeMaterial = (over = {}) =>
  RawMaterial.create({ name: 'Nylon 70D', category: 'Yarn', stock: 500, price: 320, ...over });

const makeSupplier = () =>
  Supplier.create({ name: 'Kumar Dyeing', phoneNumber: '9000000000' });

async function makeLot(material, over = {}) {
  return YarnLot.create({
    rawMaterial: material._id,
    lotNo: 'D-4471',
    shade: 'Off White',
    receivedQty: 100,
    ...over,
  });
}

/** A job hanging off a real order + customer, so traces have somewhere to go. */
async function makeJob() {
  const customer = await Customer.create({
    name: 'Aravind Garments', contactName: 'Aravind', phoneNumber: '9111111111',
    address: 'Tiruppur', email: 'a@t.co',
  });
  const elastic = await Elastic.create({
    name: '25mm Woven', weight: 5, noOfHook: 24, pick: 40, spandexEnds: 8,
  });
  const order = await Order.create({
    customer: customer._id, po: 'PO-9001', date: new Date(), supplyDate: new Date(),
    elasticOrdered: [{ elastic: elastic._id, quantity: 5000 }],
  });
  const job = await JobOrder.create({
    order: order._id, customer: customer._id, date: new Date(),
    elastics: [{ elastic: elastic._id, quantity: 5000 }],
  });
  return { customer, order, job, elastic };
}

/** A warping with a two-beam plan, ready to batch against. */
async function makeWarping(material) {
  const { job, order, customer } = await makeJob();
  const warping = await Warping.create({ job: job._id, status: 'open' });
  const plan = await WarpingPlan.create({
    warping: warping._id,
    job: job._id,
    noOfBeams: 2,
    beams: [
      { beamNo: 1, totalEnds: 240, sections: [{ warpYarn: material._id, ends: 240, maxMeters: 3000 }] },
      { beamNo: 2, totalEnds: 240, sections: [{ warpYarn: material._id, ends: 240, maxMeters: 3000 }] },
    ],
  });
  warping.warpingPlan = plan._id;
  await warping.save();
  return { warping, plan, job, order, customer };
}

const createBatch = (body) =>
  request(app).post('/api/v2/warping/batch/create').set('Cookie', adminCookie()).send(body);

const issueBatch = (id) =>
  request(app).post(`/api/v2/warping/batch/${id}/issue`).set('Cookie', adminCookie()).send({});

/** Batch created and issued in one go — the common setup. */
async function issuedBatch(material, lot, qty = 40) {
  const { warping, job, order, customer } = await makeWarping(material);
  const res = await createBatch({
    warpingId: String(warping._id),
    beamNos: [1],
    allocations: [{ rawMaterial: String(material._id), yarnLot: String(lot._id), quantity: qty }],
  });
  const batch = res.body.batch;
  await issueBatch(batch._id);
  return { batch, warping, job, order, customer };
}

// ══════════════════════════════════════════════════════════════════
//  Crediting lots on inward
// ══════════════════════════════════════════════════════════════════
describe('crediting lots on inward', () => {
  async function inward(material, body) {
    const supplier = await makeSupplier();
    const po = await PurchaseOrder.create({
      supplier: supplier._id,
      items: [{ rawMaterial: material._id, quantity: 200, price: 320 }],
    });
    return request(app).post('/api/v2/materials/material-inward')
      .set('Cookie', adminCookie())
      .send({
        rawMaterialId: String(material._id),
        purchaseOrderId: String(po._id),
        quantity: 100,
        ...body,
      });
  }

  it('opens a lot bucket when the inward carries a lot number', async () => {
    const material = await makeMaterial();
    const res = await inward(material, { lotNo: 'D-4471', shade: 'Off White' });

    expect(res.status).toBe(201);
    expect(res.body.lot.lotNo).toBe('D-4471');

    const lot = await YarnLot.findOne({ rawMaterial: material._id, lotNo: 'D-4471' });
    expect(lot.receivedQty).toBe(100);
    expect(lot.consumedQty).toBe(0);
    expect(lot.balance).toBe(100);
    expect(lot.shade).toBe('Off White');
    expect(lot.status).toBe('open');
  });

  it('tops up the same bucket when a lot arrives across two deliveries', async () => {
    const material = await makeMaterial();
    await inward(material, { lotNo: 'D-4471', shade: 'Off White' });
    await inward(material, { lotNo: 'D-4471' });

    const lots = await YarnLot.find({ rawMaterial: material._id, lotNo: 'D-4471' });
    expect(lots).toHaveLength(1);
    expect(lots[0].receivedQty).toBe(200);
    // The second delivery omitted the shade; it must not blank the first.
    expect(lots[0].shade).toBe('Off White');
  });

  it('opens no bucket when no lot number is given', async () => {
    const material = await makeMaterial();
    const res = await inward(material, {});
    expect(res.status).toBe(201);
    expect(res.body.lot).toBeNull();
    expect(await YarnLot.countDocuments({ rawMaterial: material._id })).toBe(0);
  });

  it('credits lots through the PO receive path the web app uses', async () => {
    // /supplier/inward-stock, not /materials/material-inward, is what the
    // PO detail screen posts to — the lot boxes on that form have to land
    // somewhere.
    const material = await makeMaterial();
    const supplier = await makeSupplier();
    const po = await PurchaseOrder.create({
      supplier: supplier._id,
      items: [{ rawMaterial: material._id, quantity: 200, price: 320 }],
    });

    const res = await request(app).post('/api/v2/supplier/inward-stock')
      .set('Cookie', adminCookie())
      .send({
        poId: String(po._id),
        items: [{ rawMaterial: String(material._id), quantity: 120, lotNo: 'D-9001', shade: 'Navy' }],
      });
    expect(res.status).toBe(201);

    const lot = await YarnLot.findOne({ rawMaterial: material._id, lotNo: 'D-9001' });
    expect(lot.receivedQty).toBe(120);
    expect(lot.shade).toBe('Navy');
    expect(String(lot.supplier)).toBe(String(supplier._id));
  });

  it('keeps lots of the same number apart across different materials', async () => {
    const nylon = await makeMaterial({ name: 'Nylon 70D' });
    const poly = await makeMaterial({ name: 'Polyester 150D' });
    await inward(nylon, { lotNo: 'D-4471' });
    await inward(poly, { lotNo: 'D-4471' });

    expect(await YarnLot.countDocuments({ lotNo: 'D-4471' })).toBe(2);
  });
});

// ══════════════════════════════════════════════════════════════════
//  Issuing a batch
// ══════════════════════════════════════════════════════════════════
describe('issuing a warping batch', () => {
  it('draws the lot down', async () => {
    const material = await makeMaterial();
    const lot = await makeLot(material);
    await issuedBatch(material, lot, 40);

    const after = await YarnLot.findById(lot._id);
    expect(after.consumedQty).toBe(40);
    expect(after.balance).toBe(60);
  });

  it('leaves RawMaterial.stock untouched — approval already debited it', async () => {
    // The regression that matters. Lot balances subdivide stock for
    // traceability; they are not a second ledger for it. If a future
    // change makes issue deduct stock too, every material in the
    // business slowly drifts low and nobody knows why.
    const material = await makeMaterial({ stock: 500 });
    const lot = await makeLot(material);
    await issuedBatch(material, lot, 40);

    const after = await RawMaterial.findById(material._id);
    expect(after.stock).toBe(500);
    expect(after.totalConsumption).toBe(0);
  });

  it('marks a lot exhausted once it is drawn to nothing', async () => {
    const material = await makeMaterial();
    const lot = await makeLot(material, { receivedQty: 40 });
    await issuedBatch(material, lot, 40);

    const after = await YarnLot.findById(lot._id);
    expect(after.balance).toBe(0);
    expect(after.status).toBe('exhausted');
  });

  it('refuses to overdraw a lot', async () => {
    const material = await makeMaterial();
    const lot = await makeLot(material, { receivedQty: 30 });
    const { warping } = await makeWarping(material);

    const created = await createBatch({
      warpingId: String(warping._id),
      beamNos: [1],
      allocations: [{ rawMaterial: String(material._id), yarnLot: String(lot._id), quantity: 50 }],
    });
    const res = await issueBatch(created.body.batch._id);

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/only 30 left/i);

    // The refusal must leave both the lot and the batch as they were —
    // a half-applied issue is worse than none.
    expect((await YarnLot.findById(lot._id)).consumedQty).toBe(0);
    expect((await WarpingBatch.findById(created.body.batch._id)).status).toBe('planned');
  });

  it('refuses to issue a quarantined lot', async () => {
    const material = await makeMaterial();
    const lot = await makeLot(material, { status: 'quarantined' });
    const { warping } = await makeWarping(material);

    const created = await createBatch({
      warpingId: String(warping._id),
      beamNos: [1],
      allocations: [{ rawMaterial: String(material._id), yarnLot: String(lot._id), quantity: 10 }],
    });
    const res = await issueBatch(created.body.batch._id);

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/quarantined/i);
  });

  it('rolls every lot back when one line in the batch cannot be met', async () => {
    // Two lots, the second short. The first must not stay drawn.
    const material = await makeMaterial();
    const good = await makeLot(material, { lotNo: 'D-1', receivedQty: 100 });
    const short = await makeLot(material, { lotNo: 'D-2', receivedQty: 5 });
    const { warping } = await makeWarping(material);

    const created = await createBatch({
      warpingId: String(warping._id),
      beamNos: [1, 2],
      allocations: [
        { rawMaterial: String(material._id), yarnLot: String(good._id), quantity: 50 },
        { rawMaterial: String(material._id), yarnLot: String(short._id), quantity: 50 },
      ],
    });
    const res = await issueBatch(created.body.batch._id);

    expect(res.status).toBe(409);
    expect((await YarnLot.findById(good._id)).consumedQty).toBe(0);
    expect((await WarpingBatch.findById(created.body.batch._id)).status).toBe('planned');
  });

  it('cannot be issued twice', async () => {
    const material = await makeMaterial();
    const lot = await makeLot(material);
    const { batch } = await issuedBatch(material, lot, 40);

    const again = await issueBatch(batch._id);
    expect(again.status).toBe(409);
    expect(again.body.message).toMatch(/already issued/i);
    expect((await YarnLot.findById(lot._id)).consumedQty).toBe(40);
  });

  it('does not let two concurrent issues overdraw one lot', async () => {
    // The supervisor and the warper both have the screen open. Only one
    // of the two batches can be honoured by 60kg of yarn.
    const material = await makeMaterial();
    const lot = await makeLot(material, { receivedQty: 60 });
    const a = await makeWarping(material);
    const b = await makeWarping(material);

    const mk = (w) => createBatch({
      warpingId: String(w.warping._id),
      beamNos: [1],
      allocations: [{ rawMaterial: String(material._id), yarnLot: String(lot._id), quantity: 40 }],
    });
    const [ba, bb] = await Promise.all([mk(a), mk(b)]);

    const results = await Promise.all([
      issueBatch(ba.body.batch._id),
      issueBatch(bb.body.batch._id),
    ]);

    const ok = results.filter((r) => r.status === 200);
    const refused = results.filter((r) => r.status === 409);
    expect(ok).toHaveLength(1);
    expect(refused).toHaveLength(1);

    const after = await YarnLot.findById(lot._id);
    expect(after.consumedQty).toBe(40);
    expect(after.balance).toBe(20);
  });
});

// ══════════════════════════════════════════════════════════════════
//  Validation on create
// ══════════════════════════════════════════════════════════════════
describe('creating a batch', () => {
  it('refuses a beam the plan does not have', async () => {
    const material = await makeMaterial();
    const lot = await makeLot(material);
    const { warping } = await makeWarping(material);

    const res = await createBatch({
      warpingId: String(warping._id),
      beamNos: [7],
      allocations: [{ rawMaterial: String(material._id), yarnLot: String(lot._id), quantity: 10 }],
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Beam 7 is not in this warping plan/i);
  });

  it('refuses the same lot twice in one batch', async () => {
    const material = await makeMaterial();
    const lot = await makeLot(material);
    const { warping } = await makeWarping(material);

    const res = await createBatch({
      warpingId: String(warping._id),
      beamNos: [1],
      allocations: [
        { rawMaterial: String(material._id), yarnLot: String(lot._id), quantity: 10 },
        { rawMaterial: String(material._id), yarnLot: String(lot._id), quantity: 15 },
      ],
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/already allocated/i);
  });

  it('refuses a lot belonging to a different material', async () => {
    const nylon = await makeMaterial({ name: 'Nylon 70D' });
    const poly = await makeMaterial({ name: 'Polyester 150D' });
    const polyLot = await makeLot(poly, { lotNo: 'P-90' });
    const { warping } = await makeWarping(nylon);

    const res = await createBatch({
      warpingId: String(warping._id),
      beamNos: [1],
      allocations: [{ rawMaterial: String(nylon._id), yarnLot: String(polyLot._id), quantity: 10 }],
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/does not belong to the selected material/i);
  });

  it('refuses a warping with no plan', async () => {
    const material = await makeMaterial();
    const lot = await makeLot(material);
    const { job } = await makeJob();
    const warping = await Warping.create({ job: job._id, status: 'open' });

    const res = await createBatch({
      warpingId: String(warping._id),
      beamNos: [],
      allocations: [{ rawMaterial: String(material._id), yarnLot: String(lot._id), quantity: 10 }],
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/plan before batching/i);
  });

  it('snapshots the lot number onto the batch, so the trail survives', async () => {
    const material = await makeMaterial();
    const lot = await makeLot(material, { lotNo: 'D-777', shade: 'Ecru' });
    const { warping } = await makeWarping(material);

    const res = await createBatch({
      warpingId: String(warping._id),
      beamNos: [1],
      allocations: [{ rawMaterial: String(material._id), yarnLot: String(lot._id), quantity: 10 }],
    });
    const [alloc] = res.body.batch.allocations;
    expect(alloc.lotNo).toBe('D-777');
    expect(alloc.shade).toBe('Ecru');
    expect(alloc.materialName).toBe('Nylon 70D');
  });

  it('numbers batches in sequence', async () => {
    const material = await makeMaterial();
    const lot = await makeLot(material, { receivedQty: 500 });
    const a = await makeWarping(material);
    const b = await makeWarping(material);

    const mk = (w) => createBatch({
      warpingId: String(w.warping._id),
      beamNos: [1],
      allocations: [{ rawMaterial: String(material._id), yarnLot: String(lot._id), quantity: 10 }],
    });
    const first = await mk(a);
    const second = await mk(b);

    expect(first.body.batch.batchNo).toMatch(/^WB-\d{4}$/);
    expect(second.body.batch.batchNo).not.toBe(first.body.batch.batchNo);
  });
});

// ══════════════════════════════════════════════════════════════════
//  Cancelling
// ══════════════════════════════════════════════════════════════════
describe('cancelling a batch', () => {
  const cancel = (id) =>
    request(app).patch(`/api/v2/warping/batch/${id}/cancel`).set('Cookie', adminCookie()).send({});

  it('puts the yarn back when the batch had been issued', async () => {
    const material = await makeMaterial();
    const lot = await makeLot(material);
    const { batch } = await issuedBatch(material, lot, 40);

    const res = await cancel(batch._id);
    expect(res.status).toBe(200);

    const after = await YarnLot.findById(lot._id);
    expect(after.consumedQty).toBe(0);
    expect(after.balance).toBe(100);
  });

  it('reopens a lot that cancelling refills', async () => {
    const material = await makeMaterial();
    const lot = await makeLot(material, { receivedQty: 40 });
    const { batch } = await issuedBatch(material, lot, 40);
    expect((await YarnLot.findById(lot._id)).status).toBe('exhausted');

    await cancel(batch._id);
    expect((await YarnLot.findById(lot._id)).status).toBe('open');
  });

  it('has nothing to give back when the batch was never issued', async () => {
    const material = await makeMaterial();
    const lot = await makeLot(material);
    const { warping } = await makeWarping(material);
    const created = await createBatch({
      warpingId: String(warping._id),
      beamNos: [1],
      allocations: [{ rawMaterial: String(material._id), yarnLot: String(lot._id), quantity: 40 }],
    });

    await cancel(created.body.batch._id);
    expect((await YarnLot.findById(lot._id)).consumedQty).toBe(0);
  });

  it('refuses to cancel a completed batch — the beams exist', async () => {
    const material = await makeMaterial();
    const lot = await makeLot(material);
    const { batch } = await issuedBatch(material, lot, 40);
    await request(app).post(`/api/v2/warping/batch/${batch._id}/complete`)
      .set('Cookie', adminCookie()).send({});

    const res = await cancel(batch._id);
    expect(res.status).toBe(409);
    expect((await YarnLot.findById(lot._id)).consumedQty).toBe(40);
  });
});

// ══════════════════════════════════════════════════════════════════
//  Tracing
// ══════════════════════════════════════════════════════════════════
describe('tracing a lot forward', () => {
  it('reports the batches, jobs and customers the lot reached', async () => {
    const material = await makeMaterial();
    const lot = await makeLot(material);
    const { batch, job } = await issuedBatch(material, lot, 40);

    const res = await request(app)
      .get(`/api/v2/yarn-lots/${lot._id}/trace`)
      .set('Cookie', adminCookie());

    expect(res.status).toBe(200);
    expect(res.body.issuedQty).toBe(40);
    expect(res.body.batches).toHaveLength(1);

    const [t] = res.body.batches;
    expect(t.batchNo).toBe(batch.batchNo);
    expect(t.quantity).toBe(40);
    expect(t.beamNos).toEqual([1]);
    expect(String(t.job._id)).toBe(String(job._id));
    expect(t.order.customer).toBe('Aravind Garments');
  });

  it('keeps a cancelled batch in the trail but out of the issued total', async () => {
    // "We nearly used it here" is a real answer when working out how far
    // a bad lot spread.
    const material = await makeMaterial();
    const lot = await makeLot(material);
    const { batch } = await issuedBatch(material, lot, 40);
    await request(app).patch(`/api/v2/warping/batch/${batch._id}/cancel`)
      .set('Cookie', adminCookie()).send({});

    const res = await request(app)
      .get(`/api/v2/yarn-lots/${lot._id}/trace`)
      .set('Cookie', adminCookie());

    expect(res.body.batches).toHaveLength(1);
    expect(res.body.batches[0].status).toBe('cancelled');
    expect(res.body.issuedQty).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════
//  Tying a batch to the elastic it warps
// ══════════════════════════════════════════════════════════════════
describe('attributing a batch to an elastic', () => {
  it('fills in the elastic itself when the job only has one', async () => {
    // No point making someone tick the only box there is.
    const material = await makeMaterial();
    const lot = await makeLot(material);
    const { warping, job } = await makeWarping(material);

    const res = await createBatch({
      warpingId: String(warping._id),
      beamNos: [1],
      allocations: [{ rawMaterial: String(material._id), yarnLot: String(lot._id), quantity: 10 }],
    });

    const jobDoc = await JobOrder.findById(job._id);
    expect(res.body.batch.elastics).toHaveLength(1);
    expect(String(res.body.batch.elastics[0])).toBe(String(jobDoc.elastics[0].elastic));
  });

  it('leaves it blank rather than guessing when the job has several', async () => {
    const material = await makeMaterial();
    const lot = await makeLot(material);
    const { warping, job } = await makeWarping(material);
    const second = await Elastic.create({
      name: '32mm Woven', weight: 6, noOfHook: 28, pick: 42, spandexEnds: 10,
    });
    await JobOrder.updateOne(
      { _id: job._id },
      { $push: { elastics: { elastic: second._id, quantity: 2000 } } }
    );

    const res = await createBatch({
      warpingId: String(warping._id),
      beamNos: [1],
      allocations: [{ rawMaterial: String(material._id), yarnLot: String(lot._id), quantity: 10 }],
    });
    expect(res.body.batch.elastics).toEqual([]);
  });

  it('accepts an elastic the operator names', async () => {
    const material = await makeMaterial();
    const lot = await makeLot(material);
    const { warping, job } = await makeWarping(material);
    const jobDoc = await JobOrder.findById(job._id);
    const elasticId = String(jobDoc.elastics[0].elastic);

    const res = await createBatch({
      warpingId: String(warping._id),
      beamNos: [1],
      elastics: [elasticId],
      allocations: [{ rawMaterial: String(material._id), yarnLot: String(lot._id), quantity: 10 }],
    });
    expect(res.body.batch.elastics.map(String)).toEqual([elasticId]);
  });

  it('refuses an elastic that is not on the job', async () => {
    const material = await makeMaterial();
    const lot = await makeLot(material);
    const { warping } = await makeWarping(material);
    const stranger = await Elastic.create({
      name: 'Someone else', weight: 4, noOfHook: 20, pick: 38, spandexEnds: 6,
    });

    const res = await createBatch({
      warpingId: String(warping._id),
      beamNos: [1],
      elastics: [String(stranger._id)],
      allocations: [{ rawMaterial: String(material._id), yarnLot: String(lot._id), quantity: 10 }],
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/not on the job/i);
  });
});

// ══════════════════════════════════════════════════════════════════
//  Reading the trail back from a job
// ══════════════════════════════════════════════════════════════════
describe('yarn lots on a job', () => {
  const jobLots = (jobId) =>
    request(app).get(`/api/v2/job/${jobId}/yarn-lots`).set('Cookie', adminCookie());

  it('reports the lot under the elastic it was warped for', async () => {
    const material = await makeMaterial();
    const lot = await makeLot(material, { lotNo: 'D-5150', shade: 'Ecru' });
    const { job } = await issuedBatch(material, lot, 40);

    const res = await jobLots(job._id);
    expect(res.status).toBe(200);

    const { byElastic, lots } = res.body.data;
    expect(byElastic).toHaveLength(1);
    expect(byElastic[0].elasticName).toBe('25mm Woven');
    expect(byElastic[0].lots[0]).toMatchObject({
      lotNo: 'D-5150', shade: 'Ecru', materialName: 'Nylon 70D', quantity: 40,
    });
    expect(lots).toHaveLength(1);
    expect(res.body.data.hasUnattributed).toBe(false);
  });

  it('leaves an elastic with nothing recorded visible but empty', async () => {
    // Vanishing would read as "no yarn needed", which is not the same
    // thing as "nobody wrote it down".
    const material = await makeMaterial();
    await makeLot(material);
    const { job } = await makeWarping(material);

    const res = await jobLots(job._id);
    expect(res.body.data.byElastic).toHaveLength(1);
    expect(res.body.data.byElastic[0].lots).toEqual([]);
  });

  it('keeps an unattributed batch in its own group', async () => {
    const material = await makeMaterial();
    const lot = await makeLot(material);
    const { warping, job } = await makeWarping(material);
    const second = await Elastic.create({
      name: '32mm Woven', weight: 6, noOfHook: 28, pick: 42, spandexEnds: 10,
    });
    await JobOrder.updateOne(
      { _id: job._id },
      { $push: { elastics: { elastic: second._id, quantity: 2000 } } }
    );
    // Two elastics and no attribution — the batch cannot be pinned down.
    const created = await createBatch({
      warpingId: String(warping._id),
      beamNos: [1],
      allocations: [{ rawMaterial: String(material._id), yarnLot: String(lot._id), quantity: 25 }],
    });
    await issueBatch(created.body.batch._id);

    const res = await jobLots(job._id);
    const unattributed = res.body.data.byElastic.find((g) => g.elasticId === null);
    expect(res.body.data.hasUnattributed).toBe(true);
    expect(unattributed.lots).toHaveLength(1);
    expect(unattributed.lots[0].quantity).toBe(25);
  });

  it('leaves a shared quantity whole and says how many elastics it covers', async () => {
    // The batch drew its yarn once, not once per elastic. Dividing it
    // would invent a measurement nobody took.
    const material = await makeMaterial();
    const lot = await makeLot(material);
    const { warping, job } = await makeWarping(material);
    const jobDoc = await JobOrder.findById(job._id);
    const second = await Elastic.create({
      name: '32mm Woven', weight: 6, noOfHook: 28, pick: 42, spandexEnds: 10,
    });
    await JobOrder.updateOne(
      { _id: job._id },
      { $push: { elastics: { elastic: second._id, quantity: 2000 } } }
    );

    await createBatch({
      warpingId: String(warping._id),
      beamNos: [1],
      elastics: [String(jobDoc.elastics[0].elastic), String(second._id)],
      allocations: [{ rawMaterial: String(material._id), yarnLot: String(lot._id), quantity: 60 }],
    });

    const res = await jobLots(job._id);
    const groups = res.body.data.byElastic.filter((g) => g.lots.length > 0);
    expect(groups).toHaveLength(2);
    for (const g of groups) {
      expect(g.lots[0].quantity).toBe(60);
      expect(g.lots[0].sharedAcross).toBe(2);
    }
  });

  it('drops a cancelled batch — its yarn went back on the rack', async () => {
    const material = await makeMaterial();
    const lot = await makeLot(material);
    const { batch, job } = await issuedBatch(material, lot, 40);
    await request(app).patch(`/api/v2/warping/batch/${batch._id}/cancel`)
      .set('Cookie', adminCookie()).send({});

    const res = await jobLots(job._id);
    expect(res.body.data.lots).toEqual([]);
    expect(res.body.data.byElastic[0].lots).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════
//  Lot-wise stock while programming
// ══════════════════════════════════════════════════════════════════
describe('lot-wise stock in the plan context', () => {
  /** An elastic whose warp yarn is `material`, so plan-context sees it. */
  async function jobWithWarpYarn(material) {
    const customer = await Customer.create({
      name: 'Aravind Garments', contactName: 'Aravind', phoneNumber: '9111111111',
      address: 'Tiruppur', email: 'a@t.co',
    });
    const elastic = await Elastic.create({
      name: '25mm Woven', weight: 5, noOfHook: 24, pick: 40, spandexEnds: 8,
      warpYarn: [{ id: material._id, ends: 240 }],
    });
    const order = await Order.create({
      customer: customer._id, po: 'PO-9002', date: new Date(), supplyDate: new Date(),
      elasticOrdered: [{ elastic: elastic._id, quantity: 5000 }],
    });
    return JobOrder.create({
      order: order._id, customer: customer._id, date: new Date(),
      elastics: [{ elastic: elastic._id, quantity: 5000 }],
    });
  }

  it('reports each open lot and both numbers a planner weighs', async () => {
    // 300 kg spread over three lots is a different thing from 300 on one:
    // a beam wants to come off a single lot, so the largest lot is what
    // decides whether the section can be programmed as planned.
    const material = await makeMaterial();
    await makeLot(material, { lotNo: 'D-1', receivedQty: 150 });
    await makeLot(material, { lotNo: 'D-2', receivedQty: 100 });
    await makeLot(material, { lotNo: 'D-3', receivedQty: 50 });
    const job = await jobWithWarpYarn(material);

    const res = await request(app)
      .get(`/api/v2/warping/plan-context/${job._id}`)
      .set('Cookie', adminCookie());

    expect(res.status).toBe(200);
    const [entry] = res.body.lotStock;
    expect(entry.warpYarnName).toBe('Nylon 70D');
    expect(entry.totalAvailable).toBe(300);
    expect(entry.largestLot).toBe(150);
    expect(entry.lots.map((l) => l.lotNo).sort()).toEqual(['D-1', 'D-2', 'D-3']);
  });

  it('leaves out lots that are empty or held back', async () => {
    const material = await makeMaterial();
    await makeLot(material, { lotNo: 'D-1', receivedQty: 100 });
    await makeLot(material, { lotNo: 'D-2', receivedQty: 80, status: 'quarantined' });
    await makeLot(material, { lotNo: 'D-3', receivedQty: 40, consumedQty: 40, status: 'exhausted' });
    const job = await jobWithWarpYarn(material);

    const res = await request(app)
      .get(`/api/v2/warping/plan-context/${job._id}`)
      .set('Cookie', adminCookie());

    const [entry] = res.body.lotStock;
    expect(entry.lots.map((l) => l.lotNo)).toEqual(['D-1']);
    expect(entry.totalAvailable).toBe(100);
  });

  it('reports zero rather than omitting a yarn with no lots at all', async () => {
    const material = await makeMaterial();
    const job = await jobWithWarpYarn(material);

    const res = await request(app)
      .get(`/api/v2/warping/plan-context/${job._id}`)
      .set('Cookie', adminCookie());

    expect(res.body.lotStock).toHaveLength(1);
    expect(res.body.lotStock[0]).toMatchObject({ totalAvailable: 0, largestLot: 0, lots: [] });
  });
});

// ══════════════════════════════════════════════════════════════════
//  Naming the lot on a beam section, at programming time
// ══════════════════════════════════════════════════════════════════
describe('the lot on a warping plan section', () => {
  async function openWarping(material) {
    const { job } = await makeJob();
    const warping = await Warping.create({ job: job._id, status: 'open' });
    // The link back on the job is what job detail reads through — without
    // it the job reports no warping at all.
    await JobOrder.updateOne({ _id: job._id }, { warping: warping._id });
    return { warping, job, material };
  }

  const createPlan = (warping, sections) =>
    request(app).post('/api/v2/warping/warpingPlan/create')
      .set('Cookie', adminCookie())
      .send({ warpingId: String(warping._id), beams: [{ beamNo: 1, totalEnds: 240, sections }] });

  it('stamps the lot number onto the section', async () => {
    // The programme sheet is the copy that goes to the machine and gets
    // filed, so it has to read correctly without the lot record.
    const material = await makeMaterial();
    const lot = await makeLot(material, { lotNo: 'D-8800', shade: 'Ecru' });
    const { warping } = await openWarping(material);

    const res = await createPlan(warping, [
      { warpYarn: String(material._id), ends: 240, yarnLot: String(lot._id) },
    ]);

    expect(res.status).toBe(201);
    const section = res.body.plan.beams[0].sections[0];
    expect(section.lotNo).toBe('D-8800');
    expect(section.shade).toBe('Ecru');
  });

  it('is optional — an untracked yarn has no lot', async () => {
    const material = await makeMaterial();
    const { warping } = await openWarping(material);

    const res = await createPlan(warping, [{ warpYarn: String(material._id), ends: 240 }]);
    expect(res.status).toBe(201);
    expect(res.body.plan.beams[0].sections[0].lotNo).toBe('');
    expect(res.body.plan.beams[0].sections[0].yarnLot).toBeNull();
  });

  it('refuses a lot belonging to a different yarn', async () => {
    // The picker was filtered on one yarn and submitted against another.
    // Dropping it quietly would ruin the trace without saying so.
    const nylon = await makeMaterial({ name: 'Nylon 70D' });
    const poly = await makeMaterial({ name: 'Polyester 150D' });
    const polyLot = await makeLot(poly, { lotNo: 'P-90' });
    const { warping } = await openWarping(nylon);

    const res = await createPlan(warping, [
      { warpYarn: String(nylon._id), ends: 240, yarnLot: String(polyLot._id) },
    ]);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/does not belong to the yarn on that section/i);
  });

  it('refuses a quarantined lot before the beam is built', async () => {
    const material = await makeMaterial();
    const held = await makeLot(material, { status: 'quarantined' });
    const { warping } = await openWarping(material);

    const res = await createPlan(warping, [
      { warpYarn: String(material._id), ends: 240, yarnLot: String(held._id) },
    ]);
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/quarantined/i);
  });

  it('comes back on the plan read, populated', async () => {
    const material = await makeMaterial();
    const lot = await makeLot(material, { lotNo: 'D-8800' });
    const { warping } = await openWarping(material);
    await createPlan(warping, [
      { warpYarn: String(material._id), ends: 240, yarnLot: String(lot._id) },
    ]);

    const res = await request(app)
      .get(`/api/v2/warping/warpingPlan?id=${warping._id}`)
      .set('Cookie', adminCookie());

    expect(res.body.plan.beams[0].sections[0].yarnLot.lotNo).toBe('D-8800');
  });

  it('can be changed while the warping is still open', async () => {
    const material = await makeMaterial();
    const first = await makeLot(material, { lotNo: 'D-1' });
    const second = await makeLot(material, { lotNo: 'D-2' });
    const { warping } = await openWarping(material);
    const created = await createPlan(warping, [
      { warpYarn: String(material._id), ends: 240, yarnLot: String(first._id) },
    ]);

    const res = await request(app)
      .put(`/api/v2/warping/warpingPlan/${created.body.plan._id}`)
      .set('Cookie', adminCookie())
      .send({
        auditReason: 'Switched to the newer lot',
        beams: [{
          beamNo: 1, totalEnds: 240,
          sections: [{ warpYarn: String(material._id), ends: 240, yarnLot: String(second._id) }],
        }],
      });

    expect(res.status).toBe(200);
    expect(res.body.plan.beams[0].sections[0].lotNo).toBe('D-2');
  });

  it('reaches the job detail beams', async () => {
    const material = await makeMaterial();
    const lot = await makeLot(material, { lotNo: 'D-8800', shade: 'Ecru' });
    const { warping, job } = await openWarping(material);
    await createPlan(warping, [
      { warpYarn: String(material._id), ends: 240, yarnLot: String(lot._id) },
    ]);

    const res = await request(app)
      .get(`/api/v2/job/${job._id}`)
      .set('Cookie', adminCookie());

    expect(res.status).toBe(200);
    expect(res.body.data.warping.beams[0].sections[0]).toMatchObject({
      lotNo: 'D-8800', shade: 'Ecru',
    });
  });
});

// ══════════════════════════════════════════════════════════════════
//  Manual stock adjustments and the lot ledger
// ══════════════════════════════════════════════════════════════════
describe('naming a lot on a stock adjustment', () => {
  const adjust = (body) =>
    request(app).post('/api/v2/materials/bulk-adjust-stock')
      .set('Cookie', adminCookie())
      .send({ globalReason: 'Physical count', adjustments: [body] });

  it('credits the named lot when stock is added', async () => {
    const material = await makeMaterial({ stock: 100 });
    const res = await adjust({
      _id: String(material._id), adjustment: 40,
      reason: 'Found in the far rack', lotNo: 'D-6100', shade: 'Ecru',
    });

    expect(res.status).toBe(200);
    const lot = await YarnLot.findOne({ rawMaterial: material._id, lotNo: 'D-6100' });
    expect(lot.receivedQty).toBe(40);
    expect(lot.shade).toBe('Ecru');
    expect((await RawMaterial.findById(material._id)).stock).toBe(140);
  });

  it('tops up an existing lot rather than opening a rival', async () => {
    const material = await makeMaterial();
    const lot = await makeLot(material, { lotNo: 'D-6100', receivedQty: 100 });
    await adjust({ _id: String(material._id), adjustment: 25, lotNo: 'D-6100' });

    expect(await YarnLot.countDocuments({ rawMaterial: material._id })).toBe(1);
    expect((await YarnLot.findById(lot._id)).receivedQty).toBe(125);
  });

  it('draws the chosen lot down when stock is removed', async () => {
    const material = await makeMaterial({ stock: 100 });
    const lot = await makeLot(material, { receivedQty: 100 });

    const res = await adjust({
      _id: String(material._id), adjustment: -30,
      reason: 'Damaged in the store', yarnLot: String(lot._id),
    });

    expect(res.status).toBe(200);
    const after = await YarnLot.findById(lot._id);
    expect(after.consumedQty).toBe(30);
    expect(after.balance).toBe(70);
    expect((await RawMaterial.findById(material._id)).stock).toBe(70);
  });

  it('records the lot on the outward row, for the ledger', async () => {
    const material = await makeMaterial({ stock: 100 });
    const lot = await makeLot(material, { lotNo: 'D-7000', receivedQty: 100 });
    await adjust({ _id: String(material._id), adjustment: -30, yarnLot: String(lot._id) });

    const out = await MaterialOutward.findOne({ rawMaterial: material._id });
    expect(out.lotNo).toBe('D-7000');
    expect(String(out.yarnLot)).toBe(String(lot._id));
  });

  it('refuses to write off more than the lot holds', async () => {
    // Better to fail the item than to drive the lot negative and leave
    // the ledger claiming yarn that was never there.
    const material = await makeMaterial({ stock: 500 });
    const lot = await makeLot(material, { receivedQty: 20 });

    const res = await adjust({
      _id: String(material._id), adjustment: -50, yarnLot: String(lot._id),
    });

    expect(res.body.errors).toHaveLength(1);
    expect((await YarnLot.findById(lot._id)).consumedQty).toBe(0);
    // The aggregate must not have moved either — the whole item rolls back.
    expect((await RawMaterial.findById(material._id)).stock).toBe(500);
  });

  it('leaves the lot ledger alone when no lot is named', async () => {
    // Untracked or undyed material has no lot, and an adjustment for
    // stock nobody can place should not be blocked on inventing one.
    const material = await makeMaterial({ stock: 100 });
    const lot = await makeLot(material, { receivedQty: 100 });

    const res = await adjust({ _id: String(material._id), adjustment: -30 });

    expect(res.status).toBe(200);
    expect((await RawMaterial.findById(material._id)).stock).toBe(70);
    expect((await YarnLot.findById(lot._id)).consumedQty).toBe(0);
  });

  it('marks a lot exhausted when an adjustment empties it', async () => {
    const material = await makeMaterial({ stock: 40 });
    const lot = await makeLot(material, { receivedQty: 40 });
    await adjust({ _id: String(material._id), adjustment: -40, yarnLot: String(lot._id) });

    expect((await YarnLot.findById(lot._id)).status).toBe('exhausted');
  });

  it('reports which lot moved, so the UI can confirm it', async () => {
    const material = await makeMaterial({ stock: 100 });
    const lot = await makeLot(material, { lotNo: 'D-8200', receivedQty: 100 });
    const res = await adjust({
      _id: String(material._id), adjustment: -10, yarnLot: String(lot._id),
    });

    expect(res.body.updated[0].lotNo).toBe('D-8200');
  });
});

// ══════════════════════════════════════════════════════════════════
//  The lot register
// ══════════════════════════════════════════════════════════════════
describe('the lot register', () => {
  it('lists only lots with something left when asked for issuable ones', async () => {
    const material = await makeMaterial();
    await makeLot(material, { lotNo: 'D-1', receivedQty: 100 });
    await makeLot(material, { lotNo: 'D-2', receivedQty: 50, consumedQty: 50 });

    const res = await request(app)
      .get(`/api/v2/yarn-lots/list?material=${material._id}&issuable=true`)
      .set('Cookie', adminCookie());

    expect(res.status).toBe(200);
    expect(res.body.lots.map((l) => l.lotNo)).toEqual(['D-1']);
  });

  it('quarantines a lot and lets it back out again', async () => {
    const material = await makeMaterial();
    const lot = await makeLot(material);

    const held = await request(app).patch(`/api/v2/yarn-lots/${lot._id}/status`)
      .set('Cookie', adminCookie())
      .send({ status: 'quarantined', remarks: 'Shade complaint from Aravind' });
    expect(held.body.lot.status).toBe('quarantined');

    const freed = await request(app).patch(`/api/v2/yarn-lots/${lot._id}/status`)
      .set('Cookie', adminCookie()).send({ status: 'open' });
    expect(freed.body.lot.status).toBe('open');
  });

  it('reports an empty lot as exhausted rather than open', async () => {
    // Re-opening an empty lot by hand would just be undone by the next
    // issue, so the register reflects the balance instead of the wish.
    const material = await makeMaterial();
    const lot = await makeLot(material, { receivedQty: 20, consumedQty: 20, status: 'quarantined' });

    const res = await request(app).patch(`/api/v2/yarn-lots/${lot._id}/status`)
      .set('Cookie', adminCookie()).send({ status: 'open' });
    expect(res.body.lot.status).toBe('exhausted');
  });

  it('opens a lot by hand for yarn already on the rack', async () => {
    const material = await makeMaterial({ stock: 100 });
    const res = await request(app).post('/api/v2/yarn-lots/create')
      .set('Cookie', adminCookie())
      .send({ rawMaterial: String(material._id), lotNo: 'LEGACY-1', quantity: 75, shade: 'Black' });

    expect(res.status).toBe(201);
    expect(res.body.lot.receivedQty).toBe(75);
    expect(res.body.lot.balance).toBe(75);
  });

  it('refuses a lot with no quantity', async () => {
    const material = await makeMaterial();
    const res = await request(app).post('/api/v2/yarn-lots/create')
      .set('Cookie', adminCookie())
      .send({ rawMaterial: String(material._id), lotNo: 'X-1', quantity: 0 });
    expect(res.status).toBe(400);
  });
});

// ══════════════════════════════════════════════════════════════════
//  A lot may only be opened against stock that exists
// ══════════════════════════════════════════════════════════════════
describe('opening a lot by hand', () => {
  const open = (material, quantity, lotNo = 'H-1') =>
    request(app).post('/api/v2/yarn-lots/create')
      .set('Cookie', adminCookie())
      .send({ rawMaterial: String(material._id), lotNo, quantity });

  it('refuses more than the material actually holds', async () => {
    // Free-text quantities let a material holding 10 carry a lot
    // claiming 500, and every screen downstream read that as fact.
    const material = await makeMaterial({ stock: 10 });
    const res = await open(material, 500);

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Only 10 of Nylon 70D is not yet assigned/i);
    expect(await YarnLot.countDocuments({})).toBe(0);
  });

  it('takes exactly what is left unassigned', async () => {
    const material = await makeMaterial({ stock: 100 });
    const res = await open(material, 100);
    expect(res.status).toBe(201);
  });

  it('counts stock already sitting in another lot as assigned', async () => {
    const material = await makeMaterial({ stock: 100 });
    await makeLot(material, { lotNo: 'D-1', receivedQty: 70 });

    const tooMuch = await open(material, 50);
    expect(tooMuch.status).toBe(400);
    expect(tooMuch.body.message).toMatch(/Only 30 /);

    const fits = await open(material, 30, 'H-2');
    expect(fits.status).toBe(201);
  });

  it('frees up what a lot has already been drawn down by', async () => {
    // 100 received, 60 issued — the lot only stands on the 40 still in it.
    const material = await makeMaterial({ stock: 100 });
    await makeLot(material, { lotNo: 'D-1', receivedQty: 100, consumedQty: 60 });

    const res = await open(material, 60, 'H-2');
    expect(res.status).toBe(201);
  });

  it('ignores an exhausted lot, which stands on nothing', async () => {
    const material = await makeMaterial({ stock: 50 });
    await makeLot(material, { lotNo: 'D-1', receivedQty: 40, consumedQty: 40, status: 'exhausted' });

    const res = await open(material, 50, 'H-2');
    expect(res.status).toBe(201);
  });

  it('still counts a quarantined lot — the yarn is on the rack', async () => {
    const material = await makeMaterial({ stock: 100 });
    await makeLot(material, { lotNo: 'D-1', receivedQty: 100, status: 'quarantined' });

    const res = await open(material, 10, 'H-2');
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/already assigned to lots/i);
  });

  it('refuses outright when a material has no stock at all', async () => {
    const material = await makeMaterial({ stock: 0 });
    const res = await open(material, 10);

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/already assigned to lots/i);
  });

  it('tops up an existing lot only as far as the unassigned stock goes', async () => {
    // Crediting an existing lot is still an assignment of stock.
    const material = await makeMaterial({ stock: 100 });
    await makeLot(material, { lotNo: 'D-1', receivedQty: 80 });

    const tooMuch = await open(material, 50, 'D-1');
    expect(tooMuch.status).toBe(400);

    const fits = await open(material, 20, 'D-1');
    expect(fits.status).toBe(201);
    expect(fits.body.lot.receivedQty).toBe(100);
  });

  it('reports what is unassigned on the material detail', async () => {
    const material = await makeMaterial({ stock: 100 });
    await makeLot(material, { lotNo: 'D-1', receivedQty: 70 });

    const res = await request(app)
      .get(`/api/v2/materials/get-raw-material-detail?id=${material._id}`)
      .set('Cookie', adminCookie());

    expect(res.body.material.unplacedQty).toBe(30);
  });

  it('reports zero unassigned when lots already exceed stock', async () => {
    // Normal in the window between order approval debiting stock and the
    // batch drawing the lot down — the rack still holds the yarn.
    const material = await makeMaterial({ stock: 40 });
    await makeLot(material, { lotNo: 'D-1', receivedQty: 100 });

    const res = await request(app)
      .get(`/api/v2/materials/get-raw-material-detail?id=${material._id}`)
      .set('Cookie', adminCookie());

    expect(res.body.material.unplacedQty).toBe(0);
  });
});
