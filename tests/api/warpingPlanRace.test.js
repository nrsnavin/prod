'use strict';
// ══════════════════════════════════════════════════════════════════
//  A WARPING PLAN CHANGED WHILE SOMEONE ELSE ACTS ON IT
//
//  Each door checked the warping on a copy read at the start, then
//  wrote with nothing tying the write to that check:
//    • a plan created as the run was started: the machine was already
//      set up from something else;
//    • a plan deleted as a batch was raised against its beams: the
//      batch pointed at beam numbers nothing defines any more;
//    • a batch raised against a plan deleted meanwhile: the same, from
//      the other side.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app;
let Warping, WarpingPlan, WarpingBatch, YarnLot, RawMaterial, Supplier;
let JobOrder, Order, Customer, Elastic, User, admin;
let customer, elastic, yarn, supplier;

const cookie = () => [
  `token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`,
];

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app          = require('../../app.js');
  Warping      = require('../../models/Warping');
  WarpingPlan  = require('../../models/WarpingPlan');
  WarpingBatch = require('../../models/WarpingBatch');
  YarnLot      = require('../../models/YarnLot');
  RawMaterial  = require('../../models/RawMaterial');
  Supplier     = require('../../models/Supplier');
  JobOrder     = require('../../models/JobOrder');
  Order        = require('../../models/Order');
  Customer     = require('../../models/Customer');
  Elastic      = require('../../models/Elastic');
  User         = require('../../models/User');
  admin = await User.create({
    name: 'Owner', email: 'warp@t.co', password: 'pass1234',
    role: 'admin', department: 'admin',
  });
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

let seq = 0;
beforeEach(async () => {
  supplier = await Supplier.create({ name: 'Kumar Yarns', phoneNumber: '9000000001' });
  yarn = await RawMaterial.create({
    name: `Nylon-${seq}`, category: 'Yarn', stock: 500, price: 300,
    supplier: supplier._id,
  });
  customer = await Customer.create({
    name: 'Acme', contactName: 'R', phoneNumber: '9000000002',
  });
  elastic = await Elastic.create({
    name: `20mm-${seq++}`, weaveType: '8', spandexEnds: 40,
    yarnEnds: 120, pick: 12, noOfHook: 8, weight: 2.4,
    warpYarn: [{ id: yarn._id, ends: 120 }],
  });
});

afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
});

async function seed({ status = 'in_progress', withPlan = true, withLot = false } = {}) {
  const order = await Order.create({
    customer: customer._id, po: 'PO-1',
    date: new Date(), supplyDate: new Date(), status: 'InProgress',
    elasticOrdered: [{ elastic: elastic._id, quantity: 1000, rate: 10 }],
  });
  const job = await JobOrder.create({
    order: order._id, customer: customer._id, date: new Date(),
    status: 'preparatory',
    elastics: [{ elastic: elastic._id, quantity: 1000 }],
  });
  const warping = await Warping.create({
    date: new Date(), job: job._id, status,
    elasticOrdered: [{ elastic: elastic._id, quantity: 1000 }],
  });
  await JobOrder.updateOne({ _id: job._id }, { $set: { warping: warping._id } });

  let plan = null, lot = null;
  if (withLot) {
    lot = await YarnLot.create({
      rawMaterial: yarn._id, lotNo: 'D-4471', shade: 'Ecru', receivedQty: 200,
    });
  }
  if (withPlan) {
    plan = await WarpingPlan.create({
      warping: warping._id, job: job._id, noOfBeams: 2,
      beams: [
        { beamNo: 1, totalEnds: 120, sections: [{
          warpYarn: yarn._id, ends: 120,
          ...(lot ? { yarnLot: lot._id, lotNo: lot.lotNo } : {}),
        }] },
        { beamNo: 2, totalEnds: 120, sections: [{ warpYarn: yarn._id, ends: 120 }] },
      ],
    });
    await Warping.updateOne({ _id: warping._id }, { $set: { warpingPlan: plan._id } });
  }
  return { order, job, warping, plan, lot };
}

const post = (url, body) => request(app).post(url).set('Cookie', cookie()).send(body);
const beamsBody = () => [{ beamNo: 1, sections: [{ warpYarn: String(yarn._id), ends: 120 }] }];

describe('a plan created as the warping is started', () => {
  it('is refused, and leaves no plan behind', async () => {
    const { warping } = await seed({ status: 'open', withPlan: false });
    // The route reads the warping while it is still open...
    const stale = await Warping.findById(warping._id);
    await Warping.updateOne({ _id: warping._id }, { $set: { status: 'in_progress' } });
    jest.spyOn(Warping, 'findById').mockImplementationOnce(() => Promise.resolve(stale));

    const res = await post('/api/v2/warping/warpingPlan/create', {
      warpingId: String(warping._id), beams: beamsBody(),
    });
    jest.restoreAllMocks();

    expect(res.status).toBe(409);
    expect(await WarpingPlan.countDocuments({ warping: warping._id })).toBe(0);
    expect((await Warping.findById(warping._id).lean()).warpingPlan ?? null).toBeNull();
  });

  it('still works on an open warping', async () => {
    const { warping } = await seed({ status: 'open', withPlan: false });
    const res = await post('/api/v2/warping/warpingPlan/create', {
      warpingId: String(warping._id), beams: beamsBody(),
    });
    expect(res.status).toBe(201);
    expect(String((await Warping.findById(warping._id).lean()).warpingPlan)).toBe(String(res.body.plan._id));
  });
});

describe('a plan deleted as a batch is raised against it', () => {
  it('is refused, and the plan stays', async () => {
    const { warping, plan, lot } = await seed({ status: 'open', withLot: true });
    // A batch is raised against beam 1...
    const made = await post('/api/v2/warping/batch/create', {
      warpingId: String(warping._id), beamNos: [1],
      allocations: [{ rawMaterial: yarn._id, yarnLot: lot._id, quantity: 30 }],
    });
    expect(made.status).toBe(201);
    // ...after the delete had already looked and found none.
    jest.spyOn(WarpingBatch, 'find').mockImplementationOnce(() => ({
      select: () => ({ lean: () => Promise.resolve([]) }),
    }));

    const res = await request(app).delete(`/api/v2/warping/warpingPlan/${plan._id}`)
      .set('Cookie', cookie()).query({ auditReason: 'redo the programme' });
    jest.restoreAllMocks();

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PLAN_HAS_BATCHES');
    expect(await WarpingPlan.exists({ _id: plan._id })).toBeTruthy();
    expect(String((await Warping.findById(warping._id).lean()).warpingPlan)).toBe(String(plan._id));
  });

  it('still deletes a plan with no batches', async () => {
    const { plan, warping } = await seed({ status: 'open' });
    const res = await request(app).delete(`/api/v2/warping/warpingPlan/${plan._id}`)
      .set('Cookie', cookie()).query({ auditReason: 'redo the programme' });
    expect(res.status).toBe(200);
    expect(await WarpingPlan.exists({ _id: plan._id })).toBeFalsy();
    expect((await Warping.findById(warping._id).lean()).warpingPlan ?? null).toBeNull();
  });
});

describe('a batch raised against a plan deleted meanwhile', () => {
  it('is refused', async () => {
    const { warping, plan, lot } = await seed({ status: 'open', withLot: true });
    const stale = await WarpingPlan.findById(plan._id);
    await request(app).delete(`/api/v2/warping/warpingPlan/${plan._id}`)
      .set('Cookie', cookie()).query({ auditReason: 'redo the programme' });
    jest.spyOn(WarpingPlan, 'findOne').mockImplementationOnce(() => Promise.resolve(stale));

    const res = await post('/api/v2/warping/batch/create', {
      warpingId: String(warping._id), beamNos: [1],
      allocations: [{ rawMaterial: yarn._id, yarnLot: lot._id, quantity: 30 }],
    });
    jest.restoreAllMocks();

    expect(res.status).toBe(409);
    expect(await WarpingBatch.countDocuments({ warping: warping._id })).toBe(0);
  });
});

describe('a plan edited as the warping is started', () => {
  it('is refused, and the plan is unchanged', async () => {
    const { warping, plan } = await seed({ status: 'open' });
    const stale = await Warping.findById(warping._id);
    await Warping.updateOne({ _id: warping._id }, { $set: { status: 'in_progress' } });
    jest.spyOn(Warping, 'findById').mockImplementationOnce(() => Promise.resolve(stale));

    const res = await request(app).put(`/api/v2/warping/warpingPlan/${plan._id}`)
      .set('Cookie', cookie()).send({ auditReason: 'fix remarks', remarks: 'changed' });
    jest.restoreAllMocks();

    expect(res.status).toBe(409);
    expect((await WarpingPlan.findById(plan._id).lean()).remarks ?? '').not.toBe('changed');
  });

  it('still edits an open warping\'s plan', async () => {
    const { plan } = await seed({ status: 'open' });
    const res = await request(app).put(`/api/v2/warping/warpingPlan/${plan._id}`)
      .set('Cookie', cookie()).send({ auditReason: 'fix remarks', remarks: 'changed' });
    expect(res.status).toBe(200);
    expect((await WarpingPlan.findById(plan._id).lean()).remarks).toBe('changed');
  });
});
