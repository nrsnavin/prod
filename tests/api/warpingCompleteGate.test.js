'use strict';
// ══════════════════════════════════════════════════════════════════
//  COMPLETING A WARPING BEFORE ITS YARN LEFT THE RACK
//
//  Completing says the beams are built. Beams are built from yarn, and
//  yarn leaves the rack by being issued against a warping batch — that
//  issue is what moves the lot balances and what ties the finished beam
//  to the dye lot inside it.
//
//  Completing without it leaves the lot ledger claiming yarn that is
//  physically gone and the beam with no lot behind it: a hole in the
//  shade trail exactly where it exists to cover.
//
//  The rule cannot be a blanket refusal. A programme is allowed to name
//  no lots — undyed or untracked yarn has none — and blocking those
//  would strand every job running plain yarn. So the gate applies only
//  where the programme actually committed to a lot.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
// Start, complete and batch issue all run in transactions.
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app;
let Warping, WarpingPlan, WarpingBatch, YarnLot, RawMaterial, Supplier,
  JobOrder, Order, Customer, Elastic, User, admin;

const adminCookie = () => [
  `token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`,
];

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
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
    name: 'Owner', email: 'o@t.co', password: 'pass1234', role: 'admin', department: 'admin',
  });
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
});

/**
 * A warping in progress. `withLot` decides whether its programme names
 * a dye lot — the thing the gate keys off.
 */
async function seed({ withLot = true } = {}) {
  const supplier = await Supplier.create({ name: 'Kumar Yarns', phoneNumber: '9000000001' });
  const yarn = await RawMaterial.create({
    name: 'Nylon 70D', category: 'Yarn', stock: 500, price: 300, supplier: supplier._id,
  });
  const lot = await YarnLot.create({
    rawMaterial: yarn._id, lotNo: 'D-4471', shade: 'Ecru', receivedQty: 200,
  });
  const elastic = await Elastic.create({
    name: '20mm', weaveType: '8',
    spandexEnds: 40, yarnEnds: 120, pick: 12, noOfHook: 8, weight: 2.4,
  });
  const customer = await Customer.create({ name: 'Acme', contactName: 'R', phoneNumber: '9000000002' });
  const order = await Order.create({
    orderNo: Math.floor(Math.random() * 100000),
    customer: customer._id, status: 'InProgress', po: 'PO-1',
    date: new Date(), supplyDate: new Date(),
    elasticOrdered: [{ elastic: elastic._id, quantity: 1000 }],
  });
  const job = await JobOrder.create({
    date: new Date(), order: order._id, customer: customer._id, status: 'preparatory',
    elastics: [{ elastic: elastic._id, quantity: 500 }],
  });
  const warping = await Warping.create({
    date: new Date(), job: job._id,
    elasticOrdered: [{ elastic: elastic._id, quantity: 500 }],
  });
  const plan = await WarpingPlan.create({
    warping: warping._id, job: job._id, noOfBeams: 1,
    beams: [{
      beamNo: 1, totalEnds: 480,
      sections: [{
        warpYarn: yarn._id, ends: 240, maxMeters: 5000,
        ...(withLot ? { yarnLot: lot._id, lotNo: 'D-4471', shade: 'Ecru' } : {}),
      }],
    }],
  });
  await Warping.findByIdAndUpdate(warping._id, { warpingPlan: plan._id });
  await JobOrder.findByIdAndUpdate(job._id, { warping: warping._id });

  const started = await request(app).post('/api/v2/warping/start')
    .set('Cookie', adminCookie()).send({ id: String(warping._id) });
  if (started.status >= 400) {
    throw new Error(`start failed: ${started.status} ${JSON.stringify(started.body)}`);
  }
  return { warping, job, yarn, lot, elastic };
}

const complete = (warping, body = {}) =>
  request(app).post('/api/v2/warping/complete')
    .set('Cookie', adminCookie())
    .send({ id: String(warping._id), ...body });

async function makeBatch({ warping, job, yarn, lot, elastic }, { issue = true } = {}) {
  const batch = await WarpingBatch.create({
    batchNo: `WB-${Math.floor(Math.random() * 100000)}`,
    warping: warping._id, job: job._id, beamNos: [1],
    elastics: [elastic._id], status: 'planned',
    allocations: [{
      rawMaterial: yarn._id, yarnLot: lot._id, lotNo: 'D-4471',
      materialName: 'Nylon 70D', quantity: 30,
    }],
  });
  if (issue) {
    const res = await request(app).post(`/api/v2/warping/batch/${batch._id}/issue`)
      .set('Cookie', adminCookie()).send({});
    if (res.status >= 400) {
      throw new Error(`issue failed: ${res.status} ${JSON.stringify(res.body)}`);
    }
  }
  return batch;
}

const statusOf = async (warping) =>
  (await Warping.findById(warping._id)).status;

// ── The gate ──────────────────────────────────────────────────────────

describe('completing a warping whose programme names a lot', () => {
  it('is refused when no batch exists at all', async () => {
    const s = await seed();
    const res = await complete(s.warping);

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/has not left the rack/i);
    expect(await statusOf(s.warping)).toBe('in_progress');
  });

  it('is refused when a batch exists but was never issued', async () => {
    // Different from having no batch, and it needs a different action —
    // the batch is there, somebody just has not issued it.
    const s = await seed();
    await makeBatch(s, { issue: false });

    const res = await complete(s.warping);
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/created but not issued/i);
  });

  it('is refused when every batch was cancelled', async () => {
    // A cancelled batch put its yarn back on the rack, so nothing has
    // been drawn for these beams.
    const s = await seed();
    const batch = await makeBatch(s, { issue: true });
    await request(app).patch(`/api/v2/warping/batch/${batch._id}/cancel`)
      .set('Cookie', adminCookie()).send({ reason: 'wrong beam' });

    const res = await complete(s.warping);
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/cancelled/i);
  });

  it('is allowed once the yarn is issued', async () => {
    const s = await seed();
    await makeBatch(s, { issue: true });

    const res = await complete(s.warping);
    expect(res.status).toBeLessThan(400);
    expect(await statusOf(s.warping)).toBe('completed');
  });

  it('says what is missing in a form the screen can act on', async () => {
    const s = await seed();
    await makeBatch(s, { issue: false });
    const res = await complete(s.warping);

    expect(res.body.code ?? res.body.details?.code).toBeDefined();
    // The counts, so the UI can say "1 batch waiting to be issued"
    // rather than only repeating the sentence.
    const details = res.body.details ?? {};
    expect(details.batches).toMatchObject({ planned: 1, issued: 0 });
    expect(details.lotsPlanned).toBe(1);
  });
});

// ── Yarn that is not lot-tracked ──────────────────────────────────────

describe('a programme that names no lot at all', () => {
  it('completes without a batch', async () => {
    // Undyed or untracked yarn has no lot, and the system has allowed
    // that since lots were added. A blanket rule would strand every job
    // running plain yarn — permanently, since no batch would ever come.
    const s = await seed({ withLot: false });

    const res = await complete(s.warping);
    expect(res.status).toBeLessThan(400);
    expect(await statusOf(s.warping)).toBe('completed');
  });
});

// ── The override ──────────────────────────────────────────────────────

describe('forcing a completion through', () => {
  it('needs a reason', async () => {
    // Warpings already in flight when this rule arrived have beams on
    // the floor and no issued batch behind them. The escape exists for
    // those, but a bare force would be a loophole.
    const s = await seed();

    expect((await complete(s.warping, { force: true })).status).toBe(400);
    expect((await complete(s.warping, { force: true, forceReason: 'x' })).status).toBe(400);
    expect(await statusOf(s.warping)).toBe('in_progress');
  });

  it('goes through with one', async () => {
    const s = await seed();
    const res = await complete(s.warping, {
      force: true, forceReason: 'beams built before lot tracking was switched on',
    });

    expect(res.status).toBeLessThan(400);
    expect(await statusOf(s.warping)).toBe('completed');
  });

  it('is recorded, so a forced completion is not mistaken for a clean one', async () => {
    const s = await seed();
    await complete(s.warping, { force: true, forceReason: 'beams already off the machine' });

    const job = await JobOrder.findById(s.job._id);
    const fp = (job.fingerprints || []).find((f) => f.code === 'WARPING_COMPLETED');
    expect(fp.meta.forcedWithoutIssue).toBe(true);
    expect(fp.meta.forceReason).toMatch(/already off the machine/);
  });

  it('does not mark a completion that met the rule', async () => {
    const s = await seed();
    await makeBatch(s, { issue: true });
    await complete(s.warping, { force: true, forceReason: 'not actually needed here' });

    const job = await JobOrder.findById(s.job._id);
    const fp = (job.fingerprints || []).find((f) => f.code === 'WARPING_COMPLETED');
    // force was passed but the gate would have let it through anyway,
    // so the record must not accuse this of skipping the check.
    expect(fp.meta.forcedWithoutIssue).toBeUndefined();
    expect(fp.meta.yarnIssued).toBe(1);
  });
});

// ── The rest of the route still holds ─────────────────────────────────

describe('what the gate must not break', () => {
  it('still refuses a warping that is not in progress', async () => {
    const s = await seed();
    await makeBatch(s, { issue: true });
    await complete(s.warping);

    const again = await complete(s.warping);
    expect(again.status).toBe(400);
    expect(again.body.message).toMatch(/not in progress/i);
  });

  it('still advances the job when the warping completes', async () => {
    const s = await seed();
    await makeBatch(s, { issue: true });

    const res = await complete(s.warping);
    expect(res.status).toBeLessThan(400);
    // Covering is not done, so the job holds — but the route answered
    // with the job's state rather than failing.
    expect(res.body).toHaveProperty('job');
  });
});
