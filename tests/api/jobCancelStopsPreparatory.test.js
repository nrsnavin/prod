'use strict';
// ══════════════════════════════════════════════════════════════════
//  CANCELLING A JOB STOPS THE WORK THAT WAS PREPARING IT
//
//  Found reading api/jobProgress.js line by line.
//
//  Raising a job opens a warping programme and a covering programme for
//  it. Cancelling the job released its machines and gave its metres back
//  to the order — and left both programmes exactly as they were. They
//  stayed on the warping and covering lists as open work, with nothing
//  on either list to say the job behind them was gone (neither app
//  shows the job's status there). The floor could go on warping beams,
//  issuing yarn and recording covering weights for a job nobody would
//  ever weave.
//
//  A cancelled job is final: it cannot be brought back. So its
//  programmes are cancelled with it, by the rules their own cancel
//  buttons follow:
//
//    - a covering that is not completed is cancelled;
//    - a warping that is not completed is cancelled — unless yarn has
//      been issued on one of its batches. That yarn is physically off
//      the rack and only cancelling the batch puts it back, so such a
//      warping is left as it is and the answer says which batches.
//
//  What is finished stays finished: the beams exist.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, M, admin;
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
const cancelJob = (job, reason) =>
  request(app).post('/api/v2/job/cancel').set('Cookie', cookie()).send({ jobId: String(job._id), reason });

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  M = {};
  for (const n of ['Customer', 'Elastic', 'Order', 'JobOrder', 'Warping', 'Covering', 'WarpingBatch', 'RawMaterial', 'YarnLot', 'User']) {
    M[n] = require(`../../models/${n}`);
  }
  admin = await M.User.create({ name: 'Owner', email: 'job-cancel-prep@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
});

let n = 0;
/** An order with one job in preparation, and the two programmes raising a job opens. */
async function scene({ warping = 'open', covering = 'open', jobStatus = 'preparatory' } = {}) {
  n += 1;
  const customer = await M.Customer.create({ name: `Acme ${n}`, contactName: 'R', phoneNumber: '9000000001' });
  const elastic = await M.Elastic.create({ name: `20mm ${n}`, weaveType: '8', spandexEnds: 40, yarnEnds: 120, pick: 12, noOfHook: 8, weight: 2.4 });
  const order = await M.Order.create({
    customer: customer._id, status: 'InProgress', po: `PO-${n}`, date: new Date(), supplyDate: new Date(),
    elasticOrdered: [{ elastic: elastic._id, quantity: 5000 }],
    pendingElastic: [{ elastic: elastic._id, quantity: 0 }],
  });
  const job = await M.JobOrder.create({
    date: new Date(), order: order._id, customer: customer._id, status: jobStatus,
    elastics: [{ elastic: elastic._id, quantity: 5000 }],
  });
  const w = await M.Warping.create({ job: job._id, status: warping, elasticOrdered: [{ elastic: elastic._id, quantity: 5000 }] });
  const c = await M.Covering.create({ job: job._id, status: covering, elasticPlanned: [{ elastic: elastic._id, quantity: 5000 }] });
  job.warping = w._id;
  job.covering = c._id;
  await job.save();
  return { order, job, elastic, warping: w, covering: c };
}
const statusOf = async (Model, doc) => (await Model.findById(doc._id).lean()).status;
const trail = async (job) => (await M.JobOrder.findById(job._id).lean()).fingerprints.map((f) => f.code);

// ══════════════════════════════════════════════════════════════════
describe('cancelling a job that is still being prepared', () => {
  it('cancels its warping and its covering, which were left open', async () => {
    const s = await scene();
    const res = await cancelJob(s.job, 'Customer called it off');
    expect(res.status).toBe(200);
    expect(await statusOf(M.JobOrder, s.job)).toBe('cancelled');

    // Before: both 'open' — still on the floor's lists as work to do.
    expect(await statusOf(M.Warping, s.warping)).toBe('cancelled');
    expect(await statusOf(M.Covering, s.covering)).toBe('cancelled');
    expect(res.body.programmes).toEqual({ warping: 'cancelled', covering: 'cancelled' });
  });

  it('says so on the job\'s trail', async () => {
    const s = await scene();
    await cancelJob(s.job);
    const actions = await trail(s.job);
    expect(actions).toEqual(expect.arrayContaining(['WARPING_CANCELLED', 'COVERING_CANCELLED', 'JOB_CANCELLED']));
    const job = await M.JobOrder.findById(s.job._id).lean();
    const warpingFp = job.fingerprints.find((f) => f.code === 'WARPING_CANCELLED');
    expect(warpingFp.meta).toMatchObject({ warpingId: String(s.warping._id), previousStatus: 'open', becauseJobCancelled: true });
  });

  it('and they are gone from the lists of open work', async () => {
    const s = await scene();
    await cancelJob(s.job);
    const warpings = await request(app).get('/api/v2/warping/list?status=open').set('Cookie', cookie());
    expect(warpings.body.data.map((w) => String(w._id))).not.toContain(String(s.warping._id));
    const coverings = await request(app).get('/api/v2/covering/list?status=open').set('Cookie', cookie());
    expect((coverings.body.data || coverings.body.coverings || []).map((c) => String(c._id))).not.toContain(String(s.covering._id));
  });

  it('work already under way is stopped as well', async () => {
    const s = await scene({ warping: 'in_progress', covering: 'in_progress' });
    await M.Covering.updateOne({ _id: s.covering._id }, { $set: { beamEntries: [{ beamNo: 1, weight: 41.7 }], producedWeight: 41.7 } });
    const res = await cancelJob(s.job);
    expect(res.status).toBe(200);
    expect(await statusOf(M.Warping, s.warping)).toBe('cancelled');
    expect(await statusOf(M.Covering, s.covering)).toBe('cancelled');
    // What was recorded stays on the record.
    expect((await M.Covering.findById(s.covering._id).lean()).producedWeight).toBe(41.7);
  });
});

describe('what is finished stays finished', () => {
  it('a completed warping and covering are left completed', async () => {
    const s = await scene({ warping: 'completed', covering: 'completed', jobStatus: 'weaving' });
    const res = await cancelJob(s.job);
    expect(res.status).toBe(200);
    expect(await statusOf(M.Warping, s.warping)).toBe('completed');
    expect(await statusOf(M.Covering, s.covering)).toBe('completed');
    expect(res.body.programmes).toEqual({ warping: 'completed', covering: 'completed' });
    expect(await trail(s.job)).not.toEqual(expect.arrayContaining(['WARPING_CANCELLED']));
  });

  it('another job\'s programmes are not touched', async () => {
    const mine = await scene();
    const other = await scene();
    await cancelJob(mine.job);
    expect(await statusOf(M.Warping, other.warping)).toBe('open');
    expect(await statusOf(M.Covering, other.covering)).toBe('open');
  });
});

describe('a warping that yarn has been issued on', () => {
  async function withIssuedBatch(batchStatus = 'issued') {
    const s = await scene({ warping: 'in_progress' });
    const material = await M.RawMaterial.create({ name: `Nylon 70D ${n}`, category: 'Yarn', stock: 500, price: 320 });
    const lot = await M.YarnLot.create({ rawMaterial: material._id, lotNo: `D-${n}`, receivedQty: 500 });
    const batch = await M.WarpingBatch.create({
      batchNo: `WB-${9000 + n}`, warping: s.warping._id, job: s.job._id, beamNos: [1], status: batchStatus,
      allocations: [{ rawMaterial: material._id, yarnLot: lot._id, quantity: 40 }],
    });
    return { ...s, batch };
  }

  it('is left as it is, and the answer names the batch to cancel first', async () => {
    const s = await withIssuedBatch();
    const res = await cancelJob(s.job);
    // The job is cancelled all the same: that is what was asked.
    expect(res.status).toBe(200);
    expect(await statusOf(M.JobOrder, s.job)).toBe('cancelled');
    // The yarn is off the rack, and only cancelling the batch puts it back.
    expect(await statusOf(M.Warping, s.warping)).toBe('in_progress');
    expect(res.body.programmes.warping).toBe('left_open');
    expect(res.body.warpingBatches).toEqual([s.batch.batchNo]);
    expect(res.body.message).toMatch(new RegExp(s.batch.batchNo));
    // The covering has no yarn out against it.
    expect(await statusOf(M.Covering, s.covering)).toBe('cancelled');
  });

  it('a batch only planned, with nothing issued, does not hold the warping open', async () => {
    const s = await withIssuedBatch('planned');
    const res = await cancelJob(s.job);
    expect(res.status).toBe(200);
    expect(await statusOf(M.Warping, s.warping)).toBe('cancelled');
  });
});

describe('a job with no programmes at all', () => {
  it('is cancelled as before', async () => {
    const s = await scene();
    await M.Warping.deleteMany({});
    await M.Covering.deleteMany({});
    const res = await cancelJob(s.job);
    expect(res.status).toBe(200);
    expect(res.body.programmes).toEqual({ warping: null, covering: null });
    expect(res.body.message).toBe('Job cancelled and quantities restored to order');
  });
});
