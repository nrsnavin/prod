'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE SAME QUESTION, ASKED AT ONE DOOR AND NOT THE OTHER
//
//  Warping and covering are siblings: two preparatory stages, the same
//  four statuses, the same start/complete/cancel shape, and a job that
//  advances to weaving only when BOTH are completed. Where they differ,
//  one of them is wrong.
//
//    api/covering.js  /cancel   refuses a COMPLETED covering
//    api/warping.js   /cancel   had no guard of any kind
//
//  So a completed warping could be cancelled — after the job had
//  already advanced to weaving on the strength of it — leaving the job
//  in production behind a warping that says it never happened. And
//  nothing anywhere recorded that it had been done, or by whom: cancel
//  was the one transition in either module that wrote no fingerprint.
//
//  ── And a layout that contradicts its own printed assumption ─────
//  /optimize-layout returns, in the response the planner reads:
//
//      "A yarn only splits across beams when it exceeds one beam's
//       capacity."
//
//  It did not. Any yarn that missed the first-fit search was fed to a
//  split loop that grabbed the first beam with ANY room left, so a
//  400-end yarn was cut in half against a 600-end beam — an extra
//  changeover on the floor, promised away in the same payload.
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

const cancel = (id, body = {}) =>
  request(app).patch(`/api/v2/warping/cancel/${id}`)
    .set('Cookie', cookie()).send(body);

const makeBatch = (body) =>
  request(app).post('/api/v2/warping/batch/create')
    .set('Cookie', cookie()).send(body);

// ══════════════════════════════════════════════════════════════════
describe('cancelling a warping', () => {
  it('refuses a completed one, as its covering sibling always did', async () => {
    // The beams are built and the job has already moved past
    // preparatory on the strength of it.
    const { warping } = await seed({ status: 'completed' });
    const res = await cancel(warping._id);

    expect(res.status).toBe(400);
    expect((await Warping.findById(warping._id).lean()).status).toBe('completed');
  });

  it('does not strand a weaving job behind a cancelled warping', async () => {
    // The state the guard exists to prevent, said as the invariant:
    // a job past preparatory and a warping that says it never ran.
    const { job, warping } = await seed({ status: 'completed' });
    await JobOrder.updateOne({ _id: job._id }, { $set: { status: 'weaving' } });

    await cancel(warping._id);

    const freshJob  = await JobOrder.findById(job._id).lean();
    const freshWarp = await Warping.findById(warping._id).lean();
    expect(freshJob.status === 'weaving' && freshWarp.status === 'cancelled')
      .toBe(false);
  });

  it('records the cancellation on the job timeline', async () => {
    // Start and complete both write to the trail. Cancel — the
    // transition that stops the job reaching weaving — wrote nothing.
    const { job, warping } = await seed({ status: 'in_progress' });
    expect((await cancel(warping._id, { remarks: 'order pulled' })).status).toBe(200);

    const fresh = await JobOrder.findById(job._id).lean();
    const fp = fresh.fingerprints.find((f) => f.code === 'WARPING_CANCELLED');
    expect(fp).toBeDefined();
    expect(fp.meta.remarks).toBe('order pulled');
  });

  it('refuses a second cancellation', async () => {
    const { warping } = await seed();
    await cancel(warping._id);
    expect((await cancel(warping._id)).status).toBe(400);
  });

  it('answers 400 rather than 500 for a malformed id', async () => {
    expect((await cancel('not-an-id')).status).toBe(400);
  });

  it('refuses while yarn is still issued against it', async () => {
    // /batch/:id/cancel is the only thing that credits a lot back, and
    // it cannot run once the warping is gone. Cancelling around an
    // issued batch leaves draws standing for beams nobody is building,
    // with nothing left that can put them back.
    const { warping, lot, plan } = await seed({ withLot: true });
    const created = await makeBatch({
      warpingId: warping._id, beamNos: [1],
      allocations: [{ rawMaterial: yarn._id, yarnLot: lot._id, quantity: 30 }],
    });
    expect(created.status).toBe(201);
    await request(app).post(`/api/v2/warping/batch/${created.body.batch._id}/issue`)
      .set('Cookie', cookie()).send({});

    const res = await cancel(warping._id);
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/WB-/);
    expect(plan).toBeTruthy();
  });
});

describe('the beam layout it proposes', () => {
  /** Two yarns that both fit a beam, but not the same one. */
  async function twoYarns() {
    const second = await RawMaterial.create({
      name: `Poly-${seq++}`, category: 'Yarn', stock: 500, price: 200,
      supplier: supplier._id,
    });
    const wide = await Elastic.create({
      name: `50mm-${seq++}`, weaveType: '8', spandexEnds: 40,
      yarnEnds: 900, pick: 12, noOfHook: 8, weight: 5,
      warpYarn: [{ id: yarn._id, ends: 500 }, { id: second._id, ends: 400 }],
    });
    const order = await Order.create({
      customer: customer._id, po: 'PO-2',
      date: new Date(), supplyDate: new Date(), status: 'InProgress',
      elasticOrdered: [{ elastic: wide._id, quantity: 500, rate: 10 }],
    });
    const job = await JobOrder.create({
      order: order._id, customer: customer._id, date: new Date(),
      status: 'preparatory', elastics: [{ elastic: wide._id, quantity: 500 }],
    });
    const warping = await Warping.create({ date: new Date(), job: job._id });
    return warping;
  }

  it('keeps a yarn whole when it fits inside one beam', async () => {
    // 500 and 400 ends at a capacity of 600. The old pack produced
    // [500, 100] and [300]: the same two beams, the second yarn cut in
    // half, and a changeover bought for nothing.
    const warping = await twoYarns();
    const res = await request(app)
      .get(`/api/v2/warping/optimize-layout/${warping._id}?capacity=600`)
      .set('Cookie', cookie());

    expect(res.status).toBe(200);
    for (const beam of res.body.beams) {
      expect(beam.sections).toHaveLength(1);
    }
    expect(res.body.metrics.changeovers).toBe(0);
  });

  it('holds to the assumption it prints alongside the answer', async () => {
    // The response tells the planner a yarn only splits when it exceeds
    // a beam. Every section is checked against that claim rather than
    // against a beam count, because the claim is what gets read.
    const warping = await twoYarns();
    const res = await request(app)
      .get(`/api/v2/warping/optimize-layout/${warping._id}?capacity=600`)
      .set('Cookie', cookie());

    const promise = res.body.assumptions.find((a) => /only splits/i.test(a));
    expect(promise).toBeDefined();

    const placed = {};
    for (const beam of res.body.beams) {
      for (const s of beam.sections) {
        placed[s.warpYarnId] = (placed[s.warpYarnId] || 0) + 1;
      }
    }
    // Neither yarn exceeds 600, so neither may appear on two beams.
    expect(Object.values(placed).every((n) => n === 1)).toBe(true);
  });

  it('still splits a yarn that genuinely exceeds a beam', async () => {
    // The rule is about yarns that FIT. One that does not has to be cut,
    // and refusing to would be the opposite mistake.
    const warping = await twoYarns();
    const res = await request(app)
      .get(`/api/v2/warping/optimize-layout/${warping._id}?capacity=300`)
      .set('Cookie', cookie());

    expect(res.status).toBe(200);
    const totalSections = res.body.beams.reduce((s, b) => s + b.sections.length, 0);
    expect(totalSections).toBeGreaterThan(2);
    expect(res.body.metrics.totalEnds).toBe(900);
  });
});

describe('programming a warping', () => {
  const createPlan = (body) =>
    request(app).post('/api/v2/warping/warpingPlan/create')
      .set('Cookie', cookie()).send(body);

  it('refuses a plan for a warping that is already finished', async () => {
    // Editing and deleting a plan are both refused unless the warping
    // is open, because the plan is the sheet the machine was set up
    // from. Writing one for the first time was not gated at all, so it
    // could describe beams that were built from something else.
    const { warping } = await seed({ status: 'completed', withPlan: false });
    const res = await createPlan({
      warpingId: warping._id,
      beams: [{ beamNo: 1, totalEnds: 120, sections: [{ warpYarn: yarn._id, ends: 120 }] }],
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/open/i);
  });

  it('still accepts a plan while the warping is open', async () => {
    const { warping } = await seed({ status: 'open', withPlan: false });
    const res = await createPlan({
      warpingId: warping._id,
      beams: [{ beamNo: 1, totalEnds: 120, sections: [{ warpYarn: yarn._id, ends: 120 }] }],
    });
    expect(res.status).toBe(201);
  });

  it('answers 400 rather than 500 for a malformed warpingId', async () => {
    const res = await createPlan({
      warpingId: 'nope',
      beams: [{ beamNo: 1, sections: [{ warpYarn: yarn._id, ends: 120 }] }],
    });
    expect(res.status).toBe(400);
  });
});

describe('deleting a warping plan', () => {
  const dropPlan = (id) =>
    request(app).delete(`/api/v2/warping/warpingPlan/${id}`)
      .set('Cookie', cookie()).send({ auditReason: 'rebuild it' });

  it('refuses while batches are raised against its beams', async () => {
    // The completion gate counts the lots the PLAN committed to. With no
    // plan there are none, so it reports ready — deleting the plan
    // silently switched off the rule that yarn must have been issued
    // before a warping can be completed.
    const { warping, plan, lot } = await seed({ status: 'open', withLot: true });
    const created = await makeBatch({
      warpingId: warping._id, beamNos: [1],
      allocations: [{ rawMaterial: yarn._id, yarnLot: lot._id, quantity: 30 }],
    });
    expect(created.status).toBe(201);

    const res = await dropPlan(plan._id);
    expect(res.status).toBe(409);
    expect(await WarpingPlan.countDocuments({ _id: plan._id })).toBe(1);
  });

  it('goes through once the batch is cancelled', async () => {
    const { warping, plan, lot } = await seed({ status: 'open', withLot: true });
    const created = await makeBatch({
      warpingId: warping._id, beamNos: [1],
      allocations: [{ rawMaterial: yarn._id, yarnLot: lot._id, quantity: 30 }],
    });
    await request(app).patch(`/api/v2/warping/batch/${created.body.batch._id}/cancel`)
      .set('Cookie', cookie()).send({});

    expect((await dropPlan(plan._id)).status).toBe(200);
  });

  it('goes through when there were never any batches', async () => {
    const { plan } = await seed({ status: 'open' });
    expect((await dropPlan(plan._id)).status).toBe(200);
  });
});

describe('allocating lots to a batch', () => {
  it('checks every line for the material, not only the first', async () => {
    // parseAllocations forbids the same LOT twice, not the same
    // MATERIAL, so a batch may draw two lots of one yarn. The mismatch
    // check used `find`, which stopped at the first — naming the
    // programmed lot in one line let any second lot through unexamined,
    // which is the exact substitution the check exists to catch.
    const { warping, lot } = await seed({ status: 'open', withLot: true });
    const otherLot = await YarnLot.create({
      rawMaterial: yarn._id, lotNo: 'D-9999', shade: 'Ecru', receivedQty: 200,
    });

    const res = await makeBatch({
      warpingId: warping._id, beamNos: [1],
      allocations: [
        { rawMaterial: yarn._id, yarnLot: lot._id,      quantity: 20 },
        { rawMaterial: yarn._id, yarnLot: otherLot._id, quantity: 10 },
      ],
    });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/D-9999/);
    expect(await WarpingBatch.countDocuments()).toBe(0);
  });

  it('still accepts the lot the programme names', async () => {
    const { warping, lot } = await seed({ status: 'open', withLot: true });
    const res = await makeBatch({
      warpingId: warping._id, beamNos: [1],
      allocations: [{ rawMaterial: yarn._id, yarnLot: lot._id, quantity: 30 }],
    });
    expect(res.status).toBe(201);
  });

  it('still refuses a beam another live batch already holds', async () => {
    const { warping, lot } = await seed({ status: 'open', withLot: true });
    await makeBatch({
      warpingId: warping._id, beamNos: [1],
      allocations: [{ rawMaterial: yarn._id, yarnLot: lot._id, quantity: 30 }],
    });
    const res = await makeBatch({
      warpingId: warping._id, beamNos: [1],
      allocations: [{ rawMaterial: yarn._id, yarnLot: lot._id, quantity: 20 }],
    });
    expect(res.status).toBe(409);
  });

  it('leaves no batch behind when the beam clash is refused', async () => {
    // The check and the create used to be separate statements with
    // nothing joining them. They are one unit now, so a refusal cannot
    // half-apply.
    const { warping, lot } = await seed({ status: 'open', withLot: true });
    await makeBatch({
      warpingId: warping._id, beamNos: [1],
      allocations: [{ rawMaterial: yarn._id, yarnLot: lot._id, quantity: 30 }],
    });
    await makeBatch({
      warpingId: warping._id, beamNos: [1],
      allocations: [{ rawMaterial: yarn._id, yarnLot: lot._id, quantity: 20 }],
    });
    expect(await WarpingBatch.countDocuments()).toBe(1);
  });
});

describe('listing warpings', () => {
  it('rejects a status that is not one', async () => {
    // api/covering.js's /list carries a comment saying it mirrors this
    // endpoint. It did not: covering validated, this took any string and
    // answered with an empty list — indistinguishable, to the caller,
    // from a filter that matched nothing.
    const res = await request(app).get('/api/v2/warping/list?status=nonsense')
      .set('Cookie', cookie());
    expect(res.status).toBe(400);
  });

  it('agrees with its covering sibling on what a bad status is', async () => {
    const bad = 'in-progress';   // the plausible near-miss
    const [warp, cov] = await Promise.all([
      request(app).get(`/api/v2/warping/list?status=${bad}`).set('Cookie', cookie()),
      request(app).get(`/api/v2/covering/list?status=${bad}`).set('Cookie', cookie()),
    ]);
    expect(warp.status).toBe(cov.status);
  });

  it('survives page 0', async () => {
    const res = await request(app).get('/api/v2/warping/list?page=0&status=all')
      .set('Cookie', cookie());
    expect(res.status).toBe(200);
    expect(res.body.pagination.page).toBe(1);
  });

  it('still lists by a real status', async () => {
    await seed({ status: 'open' });
    const res = await request(app).get('/api/v2/warping/list?status=open')
      .set('Cookie', cookie());
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });
});

describe('creating a warping', () => {
  const create = (body) =>
    request(app).post('/api/v2/warping/create')
      .set('Cookie', cookie()).send(body);

  /** A job with no warping linked yet — the only shape /create accepts. */
  async function bareJob() {
    const order = await Order.create({
      customer: customer._id, po: 'PO-3',
      date: new Date(), supplyDate: new Date(), status: 'InProgress',
      elasticOrdered: [{ elastic: elastic._id, quantity: 1000, rate: 10 }],
    });
    return JobOrder.create({
      order: order._id, customer: customer._id, date: new Date(),
      status: 'preparatory', elastics: [{ elastic: elastic._id, quantity: 1000 }],
    });
  }

  it('refuses an elastic the job is not making', async () => {
    // /warpingPlan/create is careful about exactly this, dropping any
    // beam elastic not on the job "since it would be a claim nobody
    // could act on". The same claim on the warping itself went straight
    // through, unexamined.
    const job = await bareJob();
    const foreign = await Elastic.create({
      name: `99mm-${seq++}`, weaveType: '8', spandexEnds: 40,
      yarnEnds: 120, pick: 12, noOfHook: 8, weight: 2.4,
    });

    const res = await create({
      jobId: job._id,
      elasticOrdered: [{ elastic: foreign._id, quantity: 100 }],
    });
    expect(res.status).toBe(400);
    expect(await Warping.countDocuments({ job: job._id })).toBe(0);
  });

  it('refuses a negative quantity', async () => {
    const job = await bareJob();
    const res = await create({
      jobId: job._id,
      elasticOrdered: [{ elastic: elastic._id, quantity: -5 }],
    });
    expect(res.status).toBe(400);
  });

  it('refuses the same elastic listed twice', async () => {
    // A keyed-by-elastic array with two rows for one elastic has two
    // answers to every question asked of it, and which one is read
    // depends on whether the reader used `find` or a sum.
    const job = await bareJob();
    const res = await create({
      jobId: job._id,
      elasticOrdered: [
        { elastic: elastic._id, quantity: 400 },
        { elastic: elastic._id, quantity: 600 },
      ],
    });
    expect(res.status).toBe(400);
  });

  it('still falls back to the job\'s own elastics when none are given', async () => {
    const job = await bareJob();
    const res = await create({ jobId: job._id });

    expect(res.status).toBe(201);
    expect(res.body.warping.elasticOrdered).toHaveLength(1);
    expect(String(res.body.warping.elasticOrdered[0].elastic))
      .toBe(String(elastic._id));
  });

  it('still accepts a valid subset of the job\'s elastics', async () => {
    const job = await bareJob();
    const res = await create({
      jobId: job._id,
      elasticOrdered: [{ elastic: elastic._id, quantity: 750 }],
    });
    expect(res.status).toBe(201);
    expect(res.body.warping.elasticOrdered[0].quantity).toBe(750);
  });
});
