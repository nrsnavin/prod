'use strict';
// ══════════════════════════════════════════════════════════════════
//  BATCH TRACKING — AUDIT PROBES
//
//  Written to find out where the feature actually breaks, rather than
//  to confirm it works. Each case is a way an operator could put the
//  lot trail into a state that reads as fact but is not.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app;
let RawMaterial, YarnLot, WarpingBatch, Warping, WarpingPlan, JobOrder,
  Order, Customer, Elastic, User, admin;

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

const makeMaterial = (over = {}) =>
  RawMaterial.create({ name: 'Nylon 70D', category: 'Yarn', stock: 500, price: 320, ...over });

const makeLot = (material, over = {}) =>
  YarnLot.create({ rawMaterial: material._id, lotNo: 'D-4471', receivedQty: 500, ...over });

async function makeWarping(material, over = {}) {
  const customer = await Customer.create({
    name: 'Aravind', contactName: 'A', phoneNumber: '9111111111', address: 'T', email: 'a@t.co',
  });
  const elastic = await Elastic.create({
    name: '25mm', weight: 5, noOfHook: 24, pick: 40, spandexEnds: 8,
  });
  const order = await Order.create({
    customer: customer._id, po: 'PO-1', date: new Date(), supplyDate: new Date(),
    elasticOrdered: [{ elastic: elastic._id, quantity: 5000 }],
  });
  const job = await JobOrder.create({
    order: order._id, customer: customer._id, date: new Date(),
    elastics: [{ elastic: elastic._id, quantity: 5000 }],
  });
  const warping = await Warping.create({ job: job._id, status: 'open', ...over });
  const plan = await WarpingPlan.create({
    warping: warping._id, job: job._id, noOfBeams: 2,
    beams: [
      { beamNo: 1, totalEnds: 240, sections: [{ warpYarn: material._id, ends: 240 }] },
      { beamNo: 2, totalEnds: 240, sections: [{ warpYarn: material._id, ends: 240 }] },
    ],
  });
  warping.warpingPlan = plan._id;
  await warping.save();
  return { warping, plan, job };
}

const createBatch = (body) =>
  request(app).post('/api/v2/warping/batch/create').set('Cookie', adminCookie()).send(body);
const issueBatch = (id) =>
  request(app).post(`/api/v2/warping/batch/${id}/issue`).set('Cookie', adminCookie()).send({});

const alloc = (material, lot, quantity = 40) => ([
  { rawMaterial: String(material._id), yarnLot: String(lot._id), quantity },
]);

// ══════════════════════════════════════════════════════════════════
describe('a beam already covered by a live batch', () => {
  it('is not claimed twice', async () => {
    // Two batches on beam 1 means the same beam gets yarn issued twice,
    // and the trace shows two different lots in one beam — the exact
    // thing lot tracking exists to prevent.
    const material = await makeMaterial();
    const a = await makeLot(material, { lotNo: 'D-1' });
    const b = await makeLot(material, { lotNo: 'D-2' });
    const { warping } = await makeWarping(material);

    const first = await createBatch({
      warpingId: String(warping._id), beamNos: [1], allocations: alloc(material, a),
    });
    expect(first.status).toBe(201);

    const second = await createBatch({
      warpingId: String(warping._id), beamNos: [1], allocations: alloc(material, b),
    });
    expect(second.status).toBe(409);
    expect(second.body.message).toMatch(/beam 1/i);
  });

  it('is claimable again once the covering batch is cancelled', async () => {
    const material = await makeMaterial();
    const a = await makeLot(material, { lotNo: 'D-1' });
    const { warping } = await makeWarping(material);

    const first = await createBatch({
      warpingId: String(warping._id), beamNos: [1], allocations: alloc(material, a),
    });
    await request(app).patch(`/api/v2/warping/batch/${first.body.batch._id}/cancel`)
      .set('Cookie', adminCookie()).send({});

    const again = await createBatch({
      warpingId: String(warping._id), beamNos: [1], allocations: alloc(material, a),
    });
    expect(again.status).toBe(201);
  });

  it('leaves a different beam alone', async () => {
    const material = await makeMaterial();
    const a = await makeLot(material, { lotNo: 'D-1' });
    const { warping } = await makeWarping(material);

    await createBatch({
      warpingId: String(warping._id), beamNos: [1], allocations: alloc(material, a),
    });
    const other = await createBatch({
      warpingId: String(warping._id), beamNos: [2], allocations: alloc(material, a),
    });
    expect(other.status).toBe(201);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('a warping that is no longer running', () => {
  it('takes no new batch once completed', async () => {
    // The beams are off the machine. Drawing yarn against them records a
    // draw that never physically happened.
    const material = await makeMaterial();
    const lot = await makeLot(material);
    const { warping } = await makeWarping(material, { status: 'completed' });

    const res = await createBatch({
      warpingId: String(warping._id), beamNos: [1], allocations: alloc(material, lot),
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/completed/i);
  });

  it('will not issue a batch whose warping was cancelled meanwhile', async () => {
    const material = await makeMaterial();
    const lot = await makeLot(material);
    const { warping } = await makeWarping(material);

    const created = await createBatch({
      warpingId: String(warping._id), beamNos: [1], allocations: alloc(material, lot),
    });
    await Warping.updateOne({ _id: warping._id }, { status: 'cancelled' });

    const res = await issueBatch(created.body.batch._id);
    expect(res.status).toBe(409);
    expect((await YarnLot.findById(lot._id)).consumedQty).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('the lot programmed on the plan', () => {
  it('is what the batch must draw for that beam', async () => {
    // Programming says beam 1 runs off D-1. Issuing it from D-2 leaves
    // the programme sheet and the trace telling different stories, and
    // the sheet is the one the warper actually followed.
    const material = await makeMaterial();
    const programmed = await makeLot(material, { lotNo: 'D-1' });
    const other = await makeLot(material, { lotNo: 'D-2' });
    const { warping, plan } = await makeWarping(material);

    await WarpingPlan.updateOne(
      { _id: plan._id },
      { $set: { 'beams.0.sections.0.yarnLot': programmed._id, 'beams.0.sections.0.lotNo': 'D-1' } }
    );

    const res = await createBatch({
      warpingId: String(warping._id), beamNos: [1], allocations: alloc(material, other),
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/D-1/);
  });

  it('is satisfied when the batch draws the same lot', async () => {
    const material = await makeMaterial();
    const programmed = await makeLot(material, { lotNo: 'D-1' });
    const { warping, plan } = await makeWarping(material);

    await WarpingPlan.updateOne(
      { _id: plan._id },
      { $set: { 'beams.0.sections.0.yarnLot': programmed._id, 'beams.0.sections.0.lotNo': 'D-1' } }
    );

    const res = await createBatch({
      warpingId: String(warping._id), beamNos: [1], allocations: alloc(material, programmed),
    });
    expect(res.status).toBe(201);
  });

  it('does not constrain a beam that was programmed without a lot', async () => {
    const material = await makeMaterial();
    const any = await makeLot(material, { lotNo: 'D-9' });
    const { warping } = await makeWarping(material);

    const res = await createBatch({
      warpingId: String(warping._id), beamNos: [1], allocations: alloc(material, any),
    });
    expect(res.status).toBe(201);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('batch numbering', () => {
  it('does not repeat a number once past four digits', async () => {
    // The counter seeds from the highest existing batchNo by STRING
    // sort, so "WB-9999" sorts above "WB-10000" and the seed goes
    // backwards — handing out a number that already exists.
    const material = await makeMaterial();
    const lot = await makeLot(material);
    const { warping } = await makeWarping(material);

    await WarpingBatch.create({
      batchNo: 'WB-10000', warping: warping._id, job: warping.job, allocations: [],
    });
    await WarpingBatch.create({
      batchNo: 'WB-9999', warping: warping._id, job: warping.job, allocations: [],
    });

    const res = await createBatch({
      warpingId: String(warping._id), beamNos: [1], allocations: alloc(material, lot),
    });

    expect(res.status).toBe(201);
    const nums = (await WarpingBatch.find({}).select('batchNo').lean()).map((b) => b.batchNo);
    expect(new Set(nums).size).toBe(nums.length);
  });
});
