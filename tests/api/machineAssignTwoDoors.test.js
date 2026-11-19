'use strict';
// ══════════════════════════════════════════════════════════════════
//  ONE HEAD MAP, TWO ROUTES
//
//  Found reading api/jobPlanning.js and api/jobMachines.js line by line.
//
//  A job is put on a loom by POST /job/plan-weaving (the web app) or by
//  POST /job/assign-machine (the phone). Both write the same head map on
//  the same machine. Each had a rule the other did not:
//
//  1. WHAT MAY GO ON A HEAD. The phone's route refused an elastic the
//     job does not make. The web's route did not look: any elastic id
//     went onto the loom, and the shifts verified after that credited
//     the job with metres of a product it was never raised for.
//
//  2. THE SHIFTS ALREADY OPEN. Re-planning the heads of the loom a job
//     is on changes what its open shifts are running. The web's route
//     carried the new plan onto those shifts; the phone's left them
//     showing the old one until somebody verified them.
//
//  3. THE TRAIL. Moving a job that is already weaving to another loom is
//     a production event with no stage change to record it. The web's
//     route wrote "machine changed", naming both looms; the phone's
//     wrote nothing.
//
//  Also on the same file: GET /job/summary gave "remaining" as a bare
//  subtraction (1000.3 − 400.1 = 600.1999999999999).
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
  for (const n of ['JobOrder', 'Order', 'Customer', 'Elastic', 'Machine', 'Warping', 'Covering', 'ShiftDetail', 'User']) M[n] = require(`../../models/${n}`);
  admin = await M.User.create({ name: 'Owner', email: 'two-doors@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
});

let n = 0;
const makeElastic = () => M.Elastic.create({
  name: `20mm ${(n += 1)}`, weaveType: '8', spandexEnds: 40, yarnEnds: 120, pick: 12, noOfHook: 8, weight: 2.4,
});
const makeMachine = (heads = 4) => M.Machine.create({
  ID: `M-${(n += 1)}`, manufacturer: 'Comez', DateOfPurchase: new Date('2020-01-01'),
  NoOfHead: heads, NoOfHooks: 8, status: 'free', orderRunning: null, elastics: [],
});
/** A job with two elastics, prepared (warping and covering done), and one elastic that is NOT on it. */
async function scene({ status = 'preparatory' } = {}) {
  const customer = await M.Customer.create({ name: `Acme ${(n += 1)}`, contactName: 'R', phoneNumber: '9000000001' });
  const [a, b, stranger] = [await makeElastic(), await makeElastic(), await makeElastic()];
  const order = await M.Order.create({
    customer: customer._id, status: 'InProgress', po: `PO-${n}`, date: new Date(), supplyDate: new Date(),
    elasticOrdered: [{ elastic: a._id, quantity: 1000 }, { elastic: b._id, quantity: 1000 }],
  });
  const job = await M.JobOrder.create({
    date: new Date(), order: order._id, customer: customer._id, status,
    elastics: [{ elastic: a._id, quantity: 1000 }, { elastic: b._id, quantity: 1000 }],
    producedElastic: [{ elastic: a._id, quantity: 0 }, { elastic: b._id, quantity: 0 }],
  });
  const warping = await M.Warping.create({ job: job._id, status: 'completed' });
  const covering = await M.Covering.create({ job: job._id, status: 'completed' });
  await M.JobOrder.updateOne({ _id: job._id }, { warping: warping._id, covering: covering._id });
  return { job, a, b, stranger, order };
}
const viaWeb = (job, machine, elasticsByHead) => post('/job/plan-weaving', {
  jobId: String(job._id), machineId: String(machine._id),
  headElasticMap: Object.fromEntries(elasticsByHead.map((e, i) => [String(i), e ? String(e._id) : null])),
});
const viaPhone = (job, machine, elasticsByHead) => post('/job/assign-machine', {
  jobId: String(job._id), machineId: String(machine._id),
  elastics: elasticsByHead.map((e, i) => ({ head: i + 1, elastic: e ? String(e._id) : null })),
});
const trail = async (job) => (await M.JobOrder.findById(job._id).lean()).fingerprints;
const headsOf = async (shift) => (await M.ShiftDetail.findById(shift._id).lean()).elastics.map((h) => String(h.elastic));

// ══════════════════════════════════════════════════════════════════
describe('an elastic the job does not make', () => {
  it('is refused by the web\'s route, as it is by the phone\'s', async () => {
    const s = await scene();
    const machine = await makeMachine(2);

    const phone = await viaPhone(s.job, machine, [s.a, s.stranger]);
    expect(phone.status).toBe(400);
    expect(phone.body.message).toMatch(/not part of this job/i);

    const web = await viaWeb(s.job, machine, [s.a, s.stranger]);
    // Before: 200 — and the loom was running somebody else's product for this job.
    expect(web.status).toBe(400);
    expect(web.body.message).toMatch(/head 2.*not part of this job/i);
    expect((await M.Machine.findById(machine._id).lean()).status).toBe('free');
  });

  it('a head left free, and the job\'s own elastics, go on as before', async () => {
    const s = await scene();
    const machine = await makeMachine(3);
    const res = await viaWeb(s.job, machine, [s.a, s.b, null]);
    expect(res.status).toBe(200);
    expect((await M.Machine.findById(machine._id).lean()).elastics.map((h) => (h.elastic ? String(h.elastic) : null)))
      .toEqual([String(s.a._id), String(s.b._id), null]);
  });

  it('something that is not an elastic id at all is a bad request, not a server error', async () => {
    const s = await scene();
    const machine = await makeMachine(2);
    const res = await post('/job/plan-weaving', {
      jobId: String(s.job._id), machineId: String(machine._id), headElasticMap: { 0: 'the wide one', 1: String(s.a._id) },
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/head 1/i);
  });
});

describe('re-planning the heads of the loom a job is on', () => {
  async function running(s, machine) {
    expect((await viaWeb(s.job, machine, [s.a, s.a])).status).toBe(200);
    return M.ShiftDetail.create({
      date: new Date(), shift: 'DAY', timer: '00:00:00', status: 'open', productionMeters: 0,
      employee: new mongoose.Types.ObjectId(), job: s.job._id, shiftPlan: new mongoose.Types.ObjectId(), machine: machine._id,
      elastics: [{ head: 1, elastic: s.a._id }, { head: 2, elastic: s.a._id }],
    });
  }

  it('from the phone carries the new plan onto its open shifts, as the web does', async () => {
    const s = await scene();
    const machine = await makeMachine(2);
    const shift = await running(s, machine);

    const res = await viaPhone(s.job, machine, [s.a, s.b]);
    expect(res.status).toBe(200);
    // Before: both heads still shown on the first elastic.
    expect(await headsOf(shift)).toEqual([String(s.a._id), String(s.b._id)]);
  });

  it('the web route does the same (unchanged)', async () => {
    const s = await scene();
    const machine = await makeMachine(2);
    const shift = await running(s, machine);
    expect((await viaWeb(s.job, machine, [s.b, s.b])).status).toBe(200);
    expect(await headsOf(shift)).toEqual([String(s.b._id), String(s.b._id)]);
  });

  it('a verified shift keeps what it ran', async () => {
    const s = await scene();
    const machine = await makeMachine(2);
    const shift = await running(s, machine);
    await M.ShiftDetail.updateOne({ _id: shift._id }, { status: 'closed', productionMeters: 900, headsRun: 2 });
    await viaPhone(s.job, machine, [s.b, s.b]);
    expect(await headsOf(shift)).toEqual([String(s.a._id), String(s.a._id)]);
  });
});

describe('moving a weaving job to another loom', () => {
  it('from the phone is written on the job\'s trail, naming both looms', async () => {
    const s = await scene();
    const first = await makeMachine(2);
    const second = await makeMachine(2);
    expect((await viaPhone(s.job, first, [s.a, s.a])).status).toBe(200);
    expect((await M.JobOrder.findById(s.job._id).lean()).status).toBe('weaving');

    const res = await viaPhone(s.job, second, [s.a, s.a]);
    expect(res.status).toBe(200);
    const moved = (await trail(s.job)).filter((f) => f.code === 'JOB_MACHINE_CHANGED');
    // Before: nothing — the move left no mark at all.
    expect(moved).toHaveLength(1);
    expect(moved[0].meta).toMatchObject({
      fromMachineId: String(first._id), toMachineId: String(second._id), toMachineName: second.ID,
    });
  });

  it('putting it on its first loom, or re-planning the same one, is not a move', async () => {
    const s = await scene();
    const machine = await makeMachine(2);
    await viaPhone(s.job, machine, [s.a, s.a]);
    await viaPhone(s.job, machine, [s.a, s.b]);
    expect((await trail(s.job)).filter((f) => f.code === 'JOB_MACHINE_CHANGED')).toHaveLength(0);
  });
});

describe('GET /job/summary', () => {
  it('gives what is left to weave as a figure, not a float', async () => {
    const s = await scene({ status: 'weaving' });
    await M.JobOrder.updateOne({ _id: s.job._id }, {
      elastics: [{ elastic: s.a._id, quantity: 1000.3 }, { elastic: s.b._id, quantity: 1000 }],
      producedElastic: [{ elastic: s.a._id, quantity: 400.1 }, { elastic: s.b._id, quantity: 0 }],
    });
    const res = await request(app).get(`/api/v2/job/summary?jobId=${s.job._id}`).set('Cookie', cookie());
    expect(res.status).toBe(200);
    // Before: 600.1999999999999
    expect(res.body.summary[0].remaining).toBe(600.2);
  });
});
