'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE LOT YOU PICKED WHILE PROGRAMMING, SEEN AFTERWARDS
//
//  Reported as: choosing a batch in the warping programme leaves the
//  job, the order and the warping screen saying nothing was recorded.
//  The decision was made, saved and printed on the sheet at the
//  machine, and every screen that should have reflected it was blank —
//  because all three read warping BATCHES, which only exist once the
//  yarn physically leaves the rack, days later.
//
//  The other half of the report is the opposite case: a section left
//  without a lot must stay OPEN. Not defaulted, not hidden — counted
//  and named, so "two beams still undecided" is something a person can
//  see and act on.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongo, app;
let RawMaterial, YarnLot, Elastic, Customer, Order, JobOrder, Warping, WarpingPlan, WarpingBatch, User, admin;

const adminCookie = () => [
  `token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`,
];

beforeAll(async () => {
  mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 60_000 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  RawMaterial  = require('../../models/RawMaterial');
  YarnLot      = require('../../models/YarnLot');
  Elastic      = require('../../models/Elastic');
  Customer     = require('../../models/Customer');
  Order        = require('../../models/Order');
  JobOrder     = require('../../models/JobOrder');
  Warping      = require('../../models/Warping');
  WarpingPlan  = require('../../models/WarpingPlan');
  WarpingBatch = require('../../models/WarpingBatch');
  User         = require('../../models/User');
  admin = await User.create({
    name: 'Owner', email: 'o@t.co', password: 'pass1234', role: 'admin', department: 'admin',
  });
}, 120_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
});

/**
 * An order with one job, one elastic and one yarn, warping open, plus
 * two dye lots of that yarn to choose between.
 */
async function seed() {
  const yarn = await RawMaterial.create({ name: 'Nylon 70D', category: 'Yarn', stock: 500, price: 300 });
  const lotA = await YarnLot.create({ rawMaterial: yarn._id, lotNo: 'D-4471', shade: 'Ecru', receivedQty: 200 });
  const lotB = await YarnLot.create({ rawMaterial: yarn._id, lotNo: 'D-4472', shade: 'Ecru', receivedQty: 200 });
  const elastic = await Elastic.create({
    name: '20mm', weaveType: '8',
    spandexEnds: 40, yarnEnds: 120, pick: 12, noOfHook: 8, weight: 2.4,
    warpYarn: [{ id: yarn._id, weight: 1 }],
  });
  const customer = await Customer.create({ name: 'Acme', contactName: 'R', phoneNumber: '9000000001' });
  const order = await Order.create({
    orderNo: Math.floor(Math.random() * 100000),
    customer: customer._id, status: 'InProgress', po: 'PO-1',
    date: new Date(), supplyDate: new Date(),
    elasticOrdered: [{ elastic: elastic._id, quantity: 1000 }],
  });
  const job = await JobOrder.create({
    date: new Date(), order: order._id, customer: customer._id, status: 'preparatory',
    elastics: [{ elastic: elastic._id, quantity: 400 }],
  });
  const warping = await Warping.create({
    date: new Date(), job: job._id, elasticOrdered: [{ elastic: elastic._id, quantity: 400 }],
  });
  await JobOrder.findByIdAndUpdate(job._id, { warping: warping._id });
  await Order.findByIdAndUpdate(order._id, { $push: { jobs: { job: job._id, no: job.jobOrderNo } } });
  return { yarn, lotA, lotB, elastic, order, job, warping };
}

/** Save a programme through the real route, exactly as the form does. */
const programme = (warping, beams) =>
  request(app).post('/api/v2/warping/warpingPlan/create')
    .set('Cookie', adminCookie())
    .send({ warpingId: String(warping._id), beams });

const beam = (beamNo, elastic, sections) => ({ beamNo, elastic: String(elastic._id), totalEnds: 480, sections });
const section = (yarn, lot) => ({
  warpYarn: String(yarn._id), ends: 240, maxMeters: 5000,
  // An unfilled picker submits "", which is what the form really sends.
  yarnLot: lot ? String(lot._id) : '',
});

const jobLots = (job) =>
  request(app).get(`/api/v2/job/${job._id}/yarn-lots`).set('Cookie', adminCookie());
const orderLots = (order) =>
  request(app).get(`/api/v2/order/${order._id}/yarn-lots`).set('Cookie', adminCookie());
const warpingDetail = (warping) =>
  request(app).get(`/api/v2/warping/detail/${warping._id}`).set('Cookie', adminCookie());

// ── The job ───────────────────────────────────────────────────────────

describe('the job shows what the programme chose', () => {
  it('reports the lot as soon as the programme is saved, with no batch issued', async () => {
    const { yarn, lotA, elastic, job, warping } = await seed();
    const res = await programme(warping, [beam(1, elastic, [section(yarn, lotA)])]);
    expect(res.status).toBe(201);

    const { body } = await jobLots(job);
    expect(body.data.lots.map((l) => l.lotNo)).toEqual(['D-4471']);
    const group = body.data.byElastic.find((g) => String(g.elasticId) === String(elastic._id));
    expect(group.lots).toHaveLength(1);
    expect(group.lots[0]).toMatchObject({
      source: 'planned', lotNo: 'D-4471', shade: 'Ecru', beamNos: [1],
    });
  });

  it('names the beams a lot runs on, and folds its sections into one row', async () => {
    // One lot across three sections of a beam is one decision, not three.
    const { yarn, lotA, elastic, job, warping } = await seed();
    await programme(warping, [
      beam(1, elastic, [section(yarn, lotA), section(yarn, lotA)]),
      beam(2, elastic, [section(yarn, lotA)]),
    ]);

    const { body } = await jobLots(job);
    const [row] = body.data.byElastic.find((g) => String(g.elasticId) === String(elastic._id)).lots;
    expect(row.beamNos).toEqual([1, 2]);
    expect(row.sections).toBe(3);
  });

  it('keeps two lots apart rather than reporting one', async () => {
    const { yarn, lotA, lotB, elastic, job, warping } = await seed();
    await programme(warping, [
      beam(1, elastic, [section(yarn, lotA)]),
      beam(2, elastic, [section(yarn, lotB)]),
    ]);

    const { body } = await jobLots(job);
    expect(body.data.lots.map((l) => l.lotNo).sort()).toEqual(['D-4471', 'D-4472']);
  });

  it('does not weigh a planned lot', async () => {
    // Programming names the lot; it does not draw it. A kilogram figure
    // here would be invented, and it would be believed.
    const { yarn, lotA, elastic, job, warping } = await seed();
    await programme(warping, [beam(1, elastic, [section(yarn, lotA)])]);

    const { body } = await jobLots(job);
    const [row] = body.data.byElastic.find((g) => g.elasticId).lots;
    expect(row.quantity).toBeNull();
  });
});

// ── Left open ─────────────────────────────────────────────────────────

describe('a section with no lot stays open', () => {
  it('counts the open sections instead of hiding them', async () => {
    const { yarn, lotA, elastic, job, warping } = await seed();
    await programme(warping, [
      beam(1, elastic, [section(yarn, lotA)]),
      beam(2, elastic, [section(yarn, null), section(yarn, null)]),
    ]);

    const { body } = await jobLots(job);
    expect(body.data.sections).toEqual({ total: 3, withLot: 1, open: 2 });
    // Which beams, so the gap can be closed without hunting for it.
    expect(body.data.openBeamNos).toEqual([2]);
  });

  it('never invents a lot for an open section', async () => {
    const { yarn, elastic, job, warping } = await seed();
    const res = await programme(warping, [beam(1, elastic, [section(yarn, null)])]);
    // A programme with no lots at all is legitimate — undyed yarn has none.
    expect(res.status).toBe(201);

    const { body } = await jobLots(job);
    expect(body.data.lots).toEqual([]);
    expect(body.data.sections.open).toBe(1);
  });
});

// ── Planned against issued ────────────────────────────────────────────

describe('planned and issued are told apart', () => {
  it('shows both, labelled, once a batch is issued', async () => {
    const { yarn, lotA, elastic, job, warping } = await seed();
    await programme(warping, [beam(1, elastic, [section(yarn, lotA)])]);
    await WarpingBatch.create({
      batchNo: 'WB-0001', warping: warping._id, job: job._id, beamNos: [1],
      elastics: [elastic._id], status: 'issued', issuedDate: new Date(),
      allocations: [{
        rawMaterial: yarn._id, yarnLot: lotA._id, lotNo: 'D-4471',
        shade: 'Ecru', materialName: 'Nylon 70D', quantity: 42,
      }],
    });

    const { body } = await jobLots(job);
    const rows = body.data.byElastic.find((g) => String(g.elasticId) === String(elastic._id)).lots;
    expect(rows.map((r) => r.source).sort()).toEqual(['issued', 'planned']);
    // One lot, two facts about it — not two lots.
    expect(body.data.lots).toHaveLength(1);
    // The stronger fact wins the summary: the yarn is off the rack.
    expect(body.data.lots[0].source).toBe('issued');
  });

  it('leaves a cancelled batch out, but keeps what was programmed', async () => {
    // The yarn went back on the rack, so it is not in the goods — but
    // the programme still says which lot the beam is meant to run.
    const { yarn, lotA, elastic, job, warping } = await seed();
    await programme(warping, [beam(1, elastic, [section(yarn, lotA)])]);
    await WarpingBatch.create({
      batchNo: 'WB-0002', warping: warping._id, job: job._id, beamNos: [1],
      elastics: [elastic._id], status: 'cancelled',
      allocations: [{
        rawMaterial: yarn._id, yarnLot: lotA._id, lotNo: 'D-4471',
        materialName: 'Nylon 70D', quantity: 42,
      }],
    });

    const { body } = await jobLots(job);
    const rows = body.data.byElastic.find((g) => String(g.elasticId) === String(elastic._id)).lots;
    expect(rows.map((r) => r.source)).toEqual(['planned']);
  });
});

// ── The order ─────────────────────────────────────────────────────────

describe('the order shows the lots of every job on it', () => {
  it('rolls the jobs up', async () => {
    const { yarn, lotA, elastic, order, warping } = await seed();
    await programme(warping, [beam(1, elastic, [section(yarn, lotA)])]);

    const { body } = await orderLots(order);
    expect(body.data.byJob).toHaveLength(1);
    expect(body.data.byJob[0].planned[0].lotNo).toBe('D-4471');
    expect(body.data.lots.map((l) => l.lotNo)).toEqual(['D-4471']);
  });

  it('adds up what is still open across the whole order', async () => {
    const { yarn, lotA, lotB, elastic, order, job, warping } = await seed();
    await programme(warping, [
      beam(1, elastic, [section(yarn, lotA)]),
      beam(2, elastic, [section(yarn, null)]),
    ]);
    // A second job on the same order, programmed with the other lot.
    const job2 = await JobOrder.create({
      date: new Date(), order: order._id, customer: job.customer, status: 'preparatory',
      elastics: [{ elastic: elastic._id, quantity: 300 }],
    });
    const warping2 = await Warping.create({ date: new Date(), job: job2._id });
    await programme(warping2, [beam(1, elastic, [section(yarn, lotB), section(yarn, null)])]);

    const { body } = await orderLots(order);
    expect(body.data.byJob).toHaveLength(2);
    expect(body.data.sections).toEqual({ total: 4, withLot: 2, open: 2 });
    expect(body.data.lots.map((l) => l.lotNo).sort()).toEqual(['D-4471', 'D-4472']);
  });

  it('lists a job with no programme rather than dropping it', async () => {
    // "No lots on this job" and "no such job" are different answers, and
    // only one of them is true.
    const { order } = await seed();
    const { body } = await orderLots(order);
    expect(body.data.byJob).toHaveLength(1);
    expect(body.data.byJob[0].planned).toEqual([]);
    expect(body.data.byJob[0].sections.total).toBe(0);
  });
});

// ── The warping screen ────────────────────────────────────────────────

describe('the warping detail carries its own trail', () => {
  it('summarises the lots its programme names', async () => {
    const { yarn, lotA, elastic, warping } = await seed();
    await programme(warping, [
      beam(1, elastic, [section(yarn, lotA), section(yarn, lotA)]),
      beam(2, elastic, [section(yarn, null)]),
    ]);

    const { body } = await warpingDetail(warping);
    expect(body.yarnLots.lots.map((l) => l.lotNo)).toEqual(['D-4471']);
    expect(body.yarnLots.sections).toEqual({ total: 3, withLot: 2, open: 1 });
    expect(body.yarnLots.openBeamNos).toEqual([2]);
  });

  it('reports an empty trail before a programme exists', async () => {
    const { warping } = await seed();
    const { body } = await warpingDetail(warping);
    expect(body.yarnLots.planned).toEqual([]);
    expect(body.yarnLots.sections.total).toBe(0);
  });
});
