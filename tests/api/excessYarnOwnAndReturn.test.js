'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE YARN A JOB DRAWS FOR ITS OVER-PLANNED METRES
//
//  Found reading services/jobRaise.js and services/excessPlanning.js
//  line by line.
//
//  Approving an order draws yarn for what was ORDERED. A job planned
//  past that draws the yarn for the extra metres itself, when it is
//  raised. Three things were wrong with that draw:
//
//  1. A SECOND JOB PAID FOR THE FIRST ONE'S EXTRA AGAIN. The extra was
//     measured for the whole order ("planned on all its jobs, less what
//     was ordered") and the yarn was drawn for that whole figure every
//     time. On an order for 1,000 m: the first job, for 1,100 m, drew
//     yarn for 100 m. A second job adding 100 m drew yarn for 200 m —
//     its own 100 and the first job's 100 over again.
//
//  2. CANCELLING THE JOB NEVER PUT ITS YARN BACK. Nothing reversed the
//     draw, and the order's requirement sheet stayed at the cancelled
//     plan. The app's own advice when a quantity cannot be edited is
//     "Cancel this job and raise it again at the quantity you want, so
//     the material is drawn once and correctly" — which drew it twice.
//     Held: a job cancelled with nothing woven gives back exactly what
//     was drawn for it; one that has woven keeps it (the yarn may be in
//     the cloth) and the answer says so. Yarn the stores issued to the
//     job by hand is never touched.
//
//  3. THE STOCK FIGURE was moved by a bare subtraction: 999.6 − 0.8 was
//     kept as 998.8000000000001.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, admin;
const M = {};
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
const post = (url, body) => request(app).post(`/api/v2${url}`).set('Cookie', cookie()).send(body);

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  for (const n of ['User', 'Order', 'JobOrder', 'Customer', 'Elastic', 'RawMaterial', 'Warping', 'Covering']) M[n] = require(`../../models/${n}.js`);
  M.MaterialOutward = require('../../models/MaterialOut.cjs');
  admin = await M.User.create({ name: 'Owner', email: 'excess-yarn@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
});

let seq = 0;
/** An approved order for 1,000 m of an elastic that takes 4 g of nylon a metre. */
async function scene(ordered = 1000) {
  seq += 1;
  const nylon = await M.RawMaterial.create({ name: `Nylon ${seq}`, category: 'yarn', price: 300, avgCost: 300, stock: 1000 });
  const elastic = await M.Elastic.create({
    name: `Elastic ${seq}`, weaveType: '8', spandexEnds: 40, pick: 30, noOfHook: 12, weight: 5,
    warpYarn: [{ id: nylon._id, ends: 40, weight: 4 }],
  });
  const customer = await M.Customer.create({ name: `C${seq}`, contactName: 'X', phoneNumber: '9000000001' });
  const order = await M.Order.create({
    date: new Date('2026-05-01'), po: `PO-${seq}`, customer: customer._id,
    supplyDate: new Date('2026-07-15'), status: 'Approved',
    elasticOrdered: [{ elastic: elastic._id, quantity: ordered, rate: 10 }],
    pendingElastic: [{ elastic: elastic._id, quantity: ordered }],
    producedElastic: [{ elastic: elastic._id, quantity: 0 }],
    packedElastic: [{ elastic: elastic._id, quantity: 0 }],
    rawMaterialRequired: [{ rawMaterial: nylon._id, name: nylon.name, requiredWeight: 4 }],
  });
  return { nylon, elastic, order };
}
const raise = (s, quantity, extra = {}) => post('/job/create', {
  orderId: String(s.order._id), date: '2026-05-03',
  elastics: [{ elastic: String(s.elastic._id), quantity }], ...extra,
});
const cancel = (jobId, reason = 'Raised at the wrong quantity') => post('/job/cancel', { jobId: String(jobId), reason });
const stock = async (s) => (await M.RawMaterial.findById(s.nylon._id).lean()).stock;
const draws = (jobId) => M.MaterialOutward.find({ job: jobId, type: 'JOB_CONSUMPTION' }).lean();
const requirement = async (s) => (await M.Order.findById(s.order._id).lean()).rawMaterialRequired[0].requiredWeight;

// ══════════════════════════════════════════════════════════════════
describe('a second job on an order that is already over-planned', () => {
  it('draws the yarn for the metres it adds, not for the first job\'s again', async () => {
    const s = await scene();
    const a = await raise(s, 1100);
    expect(a.status).toBe(201);
    expect(await stock(s)).toBe(999.6);          // 100 m over, at 4 g a metre

    const b = await raise(s, 100);
    expect(b.status).toBe(201);
    // Before: 998.8 — yarn for 200 m, the first job's 100 m over again.
    expect(await stock(s)).toBe(999.2);
    const [row] = await draws(b.body.data.job._id);
    expect(row.quantity).toBe(0.4);
  });

  it('a job that takes the order past its quantity draws for all it is over by', async () => {
    const s = await scene();
    expect((await raise(s, 600)).status).toBe(201);
    expect(await stock(s)).toBe(1000);             // inside the order: nothing to draw
    expect((await raise(s, 600)).status).toBe(201); // 1,200 planned: 200 m over, all of it this job's
    expect(await stock(s)).toBe(999.2);
  });

  it('the allowance is still judged on the order as a whole', async () => {
    const s = await scene();
    expect((await raise(s, 1150)).status).toBe(201);         // 15% over: no reason needed
    const second = await raise(s, 100);                      // 25% over between them
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('EXCESS_PLANNING_REASON_REQUIRED');
  });
});

describe('the stock figure after a draw', () => {
  it('is the figure, not a float beside it', async () => {
    const s = await scene();
    await raise(s, 1100);
    await raise(s, 200, { excessReason: 'Customer asked for a margin on this lot' });
    // 1000 − 0.4 − 0.8. Before: 998.8000000000001 (and more had been drawn besides).
    expect(await stock(s)).toBe(998.8);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('cancelling an over-planned job that never started', () => {
  it('puts back exactly the yarn that was drawn for it', async () => {
    const s = await scene();
    const job = (await raise(s, 1100)).body.data.job;
    expect(await stock(s)).toBe(999.6);

    const res = await cancel(job._id);
    expect(res.status).toBe(200);
    // Before: 999.6 for good.
    expect(await stock(s)).toBe(1000);
    expect(res.body.yarnReturned).toEqual([{ rawMaterial: String(s.nylon._id), name: s.nylon.name, quantity: 0.4 }]);
    expect(res.body.message).toMatch(/0\.4 kg of Nylon \d+ went back to stock/);

    const [row] = await draws(job._id);
    expect(row.reversed).toBe(true);
    const ledger = (await M.RawMaterial.findById(s.nylon._id).select('+stockMovements').lean()).stockMovements;
    expect(ledger[ledger.length - 1]).toMatchObject({ type: 'JOB_CANCEL_REFUND', quantity: 0.4, balance: 1000, refNo: String(job.jobOrderNo) });
    const trail = (await M.JobOrder.findById(job._id).lean()).fingerprints.map((f) => f.code);
    expect(trail).toEqual(expect.arrayContaining(['RAW_MATERIAL_RESTORED', 'JOB_CANCELLED']));
  });

  it('and the order\'s requirement goes back to what is still planned', async () => {
    const s = await scene();
    const job = (await raise(s, 1100)).body.data.job;
    expect(await requirement(s)).toBeCloseTo(4.4, 6);   // restated for 1,100 m
    await cancel(job._id);
    // Before: 4.4 — the sheet still asked for a job that was gone.
    expect(await requirement(s)).toBeCloseTo(4, 6);
  });

  it('so "cancel it and raise it again" draws the yarn once', async () => {
    const s = await scene();
    const first = (await raise(s, 1300, { excessReason: 'Typed 1300 for 1100 by mistake' })).body.data.job;
    await cancel(first._id);
    expect((await raise(s, 1100)).status).toBe(201);
    // Before: 998.4 — the 300 m of the cancelled job and the 100 m of this one.
    expect(await stock(s)).toBe(999.6);
  });

  it('cancelling it twice gives nothing back twice', async () => {
    const s = await scene();
    const job = (await raise(s, 1100)).body.data.job;
    await cancel(job._id);
    expect((await cancel(job._id)).status).toBe(400);
    expect(await stock(s)).toBe(1000);
  });
});

describe('cancelling one that has woven', () => {
  it('leaves its yarn where it is, and says so', async () => {
    const s = await scene();
    const job = (await raise(s, 1100)).body.data.job;
    await M.JobOrder.updateOne({ _id: job._id }, { $set: { status: 'weaving', producedElastic: [{ elastic: s.elastic._id, quantity: 300 }] } });
    await M.Warping.updateMany({ job: job._id }, { $set: { status: 'completed' } });
    await M.Covering.updateMany({ job: job._id }, { $set: { status: 'completed' } });

    const res = await cancel(job._id, 'Loom broke down');
    expect(res.status).toBe(200);
    expect(await stock(s)).toBe(999.6);
    expect(res.body.yarnReturned).toEqual([]);
    expect(res.body.yarnKept).toEqual([{ rawMaterial: String(s.nylon._id), name: s.nylon.name, quantity: 0.4 }]);
    expect(res.body.message).toMatch(/stays issued/);
    expect((await draws(job._id))[0].reversed).toBe(false);
  });
});

describe('what a cancellation does not touch', () => {
  it('yarn the stores issued to the job by hand', async () => {
    const s = await scene();
    const job = (await raise(s, 1100)).body.data.job;
    const issued = await M.MaterialOutward.create({
      rawMaterial: s.nylon._id, quantity: 5, job: job._id, order: s.order._id,
      type: 'JOB_CONSUMPTION', unitPrice: 300, remarks: `Issued to J-${job.jobOrderNo}: extra weft`,
    });
    await cancel(job._id);
    expect((await M.MaterialOutward.findById(issued._id).lean()).reversed).toBe(false);
    expect(await stock(s)).toBe(1000);   // the 0.4 came back; the 5 kg was never part of this
  });

  it('a job that drew nothing for itself: nothing comes back and the sheet is left alone', async () => {
    const s = await scene();
    const job = (await raise(s, 800)).body.data.job;
    const res = await cancel(job._id);
    expect(res.status).toBe(200);
    expect(res.body.yarnReturned).toEqual([]);
    expect(res.body.yarnKept).toEqual([]);
    expect(await stock(s)).toBe(1000);
    expect(await requirement(s)).toBe(4);
    expect(res.body.message).toBe('Job cancelled and quantities restored to order');
  });
});
