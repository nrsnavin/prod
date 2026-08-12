'use strict';
// ══════════════════════════════════════════════════════════════════
//  EDITING A JOB'S QUANTITIES BEFORE THE FLOOR TOUCHES IT
//
//  A job's lines can be corrected while it is still PREPARATORY and
//  neither its warping nor its covering has started. Those are two
//  different conditions and both matter: the status says the job has
//  not reached the loom, the stages say nobody has begun building a
//  beam for it.
//
//  Once a programme is in progress the commitment is physical —
//  sections chosen, lots drawn, a beam part-built — and changing the
//  quantity underneath it leaves the programme and the job describing
//  different work, with the programme winning, because it is what the
//  machine follows.
//
//  What these tests pin down:
//
//    • the edit applies, and reaches the warping and covering sheets
//    • the order's requirement is recalculated from what is now planned
//    • it is refused once warping, covering or a batch has started
//    • it is refused when it would change the over-planned quantity,
//      because that yarn has already been drawn from stock
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app;
let Order, JobOrder, Customer, Elastic, RawMaterial, Warping, Covering,
  WarpingBatch, User, admin;

const adminCookie = () => [
  `token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`,
];

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  Order        = require('../../models/Order');
  JobOrder     = require('../../models/JobOrder');
  Customer     = require('../../models/Customer');
  Elastic      = require('../../models/Elastic');
  RawMaterial  = require('../../models/RawMaterial');
  Warping      = require('../../models/Warping');
  Covering     = require('../../models/Covering');
  WarpingBatch = require('../../models/WarpingBatch');
  User         = require('../../models/User');
  admin = await User.create({
    name: 'Owner', email: 'je@t.co', password: 'pass1234',
    role: 'admin', department: 'admin',
  });
}, 120_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
});

let seq = 0;

/** An order for 1000 m with a job planned for `planned` of it. */
async function seed({ ordered = 1000, planned = 1000 } = {}) {
  const yarn = await RawMaterial.create({
    name: `Nylon ${++seq}`, category: 'warp', price: 300, stock: 5000,
  });
  const elastic = await Elastic.create({
    name: `20mm ${Math.random().toString(36).slice(2, 8)}`, weaveType: '8',
    spandexEnds: 40, yarnEnds: 120, pick: 12, noOfHook: 8, weight: 2.4,
    warpYarn: [{ id: yarn._id, ends: 40, weight: 1 }],
  });
  const customer = await Customer.create({
    name: `Acme ${seq}`, contactName: 'R', phoneNumber: '9000000001',
  });
  const order = await Order.create({
    customer: customer._id, po: `PO-${seq}`, date: new Date(), supplyDate: new Date(),
    elasticOrdered: [{ elastic: elastic._id, quantity: ordered }],
    pendingElastic: [{ elastic: elastic._id, quantity: ordered }],
    status: 'InProgress',
  });
  const zero = [{ elastic: elastic._id, quantity: 0 }];
  const job = await JobOrder.create({
    date: new Date(), order: order._id, customer: customer._id, status: 'preparatory',
    elastics: [{ elastic: elastic._id, quantity: planned }],
    producedElastic: zero, packedElastic: zero, wastageElastic: zero,
  });
  const warping  = await Warping.create({
    date: new Date(), job: job._id, status: 'open',
    elasticOrdered: [{ elastic: elastic._id, quantity: planned }],
  });
  const covering = await Covering.create({
    date: new Date(), job: job._id, status: 'open',
    elasticPlanned: [{ elastic: elastic._id, quantity: planned }],
  });
  job.warping = warping._id; job.covering = covering._id;
  order.jobs.push({ job: job._id, no: job.jobOrderNo });
  await Promise.all([job.save(), order.save()]);
  return { order, job, elastic, warping, covering, yarn };
}

const edit = (job, elastics, extra = {}) =>
  request(app).post('/api/v2/job/update-elastics')
    .set('Cookie', adminCookie())
    .send({
      jobId: String(job._id), elastics,
      auditReason: 'customer reduced the order',
      ...extra,
    });

// ══════════════════════════════════════════════════════════════════
describe('editing a preparatory job', () => {
  it('changes the quantity', async () => {
    const { job, elastic } = await seed({ ordered: 1000, planned: 1000 });

    const res = await edit(job, [{ elastic: String(elastic._id), quantity: 600 }]);
    expect(res.status).toBe(200);

    const after = await JobOrder.findById(job._id).lean();
    expect(after.elastics[0].quantity).toBe(600);
  });

  it('reaches the warping and covering sheets', async () => {
    // They mirror the job's lines and are what goes to the machine —
    // left behind, the sheet would carry the old figure.
    const { job, elastic, warping, covering } = await seed();

    await edit(job, [{ elastic: String(elastic._id), quantity: 600 }]);

    expect((await Warping.findById(warping._id).lean()).elasticOrdered[0].quantity).toBe(600);
    expect((await Covering.findById(covering._id).lean()).elasticPlanned[0].quantity).toBe(600);
  });

  it('recalculates the order requirement from what is now planned', async () => {
    // The "calculate the MRP again" half. 1 kg per 1000 m of recipe.
    const { job, order, elastic, yarn } = await seed({ ordered: 1000, planned: 1000 });
    await edit(job, [{ elastic: String(elastic._id), quantity: 600 }]);

    const after = await Order.findById(order._id).lean();
    const row = after.rawMaterialRequired
      .find((r) => String(r.rawMaterial) === String(yarn._id));
    // Restated for max(ordered, planned) — the order still asks for
    // 1000, so the requirement stays with the order, not the job.
    expect(row.requiredWeight).toBe(1);
    expect(after.updatedItemsAt).toBeTruthy();
  });

  it('records the change, with the reason', async () => {
    const { job, elastic } = await seed();
    await edit(job, [{ elastic: String(elastic._id), quantity: 600 }]);

    const after = await JobOrder.findById(job._id).lean();
    const fp = after.fingerprints.at(-1);
    expect(fp.meta.auditReason).toMatch(/customer reduced/);
    expect(fp.meta.before[0].quantity).toBe(1000);
    expect(fp.meta.after[0].quantity).toBe(600);
  });

  it('wants a reason', async () => {
    const { job, elastic } = await seed();
    const res = await edit(job, [{ elastic: String(elastic._id), quantity: 600 }],
      { auditReason: '' });
    expect(res.status).toBe(400);
  });

  it('refuses a quantity of zero or less', async () => {
    const { job, elastic } = await seed();
    const res = await edit(job, [{ elastic: String(elastic._id), quantity: 0 }]);
    expect(res.status).toBe(400);
  });

  it('refuses an elastic that is not on the order', async () => {
    const { job } = await seed();
    const stranger = await Elastic.create({
      name: `30mm ${Math.random().toString(36).slice(2, 8)}`, weaveType: '8',
      spandexEnds: 40, pick: 12, noOfHook: 8, weight: 2.4,
    });
    const res = await edit(job, [{ elastic: String(stranger._id), quantity: 100 }]);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/not part of this order/i);
  });

  it('refuses the same elastic listed twice', async () => {
    const { job, elastic } = await seed();
    const res = await edit(job, [
      { elastic: String(elastic._id), quantity: 300 },
      { elastic: String(elastic._id), quantity: 300 },
    ]);
    expect(res.status).toBe(400);
  });
});

// ══════════════════════════════════════════════════════════════════
//  ONCE THE FLOOR HAS STARTED
// ══════════════════════════════════════════════════════════════════
describe('a job whose preparation has begun', () => {
  it('is refused when warping is in progress', async () => {
    const { job, elastic, warping } = await seed();
    await Warping.updateOne({ _id: warping._id }, { $set: { status: 'in_progress' } });

    const res = await edit(job, [{ elastic: String(elastic._id), quantity: 600 }]);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('JOB_PREPARATION_STARTED');
    expect(res.body.message).toMatch(/warping is in_progress/);
    expect((await JobOrder.findById(job._id).lean()).elastics[0].quantity).toBe(1000);
  });

  it('is refused when covering is in progress', async () => {
    const { job, elastic, covering } = await seed();
    await Covering.updateOne({ _id: covering._id }, { $set: { status: 'in_progress' } });

    const res = await edit(job, [{ elastic: String(elastic._id), quantity: 600 }]);
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/covering is in_progress/);
  });

  it('is refused when a warping batch has been raised', async () => {
    // Yarn off the rack, whatever the stage status says.
    const { job, elastic, warping } = await seed();
    await WarpingBatch.create({
      job: job._id, warping: warping._id,
      batchNo: 'B-1', status: 'issued', beamNos: [1],
    });

    const res = await edit(job, [{ elastic: String(elastic._id), quantity: 600 }]);
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/batch/i);
  });

  it('is refused once the job has left preparatory', async () => {
    const { job, elastic } = await seed();
    await JobOrder.updateOne({ _id: job._id }, { $set: { status: 'weaving' } });

    const res = await edit(job, [{ elastic: String(elastic._id), quantity: 600 }]);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/only be changed while the job is preparatory/i);
  });

  it('still allows it while both stages are merely open', async () => {
    const { job, elastic } = await seed();
    expect((await edit(job, [{ elastic: String(elastic._id), quantity: 600 }])).status).toBe(200);
  });
});

// ══════════════════════════════════════════════════════════════════
//  THE YARN THAT WAS ALREADY DRAWN
// ══════════════════════════════════════════════════════════════════
describe('an edit that would change the over-planned quantity', () => {
  it('is refused, because that yarn has already left stock', async () => {
    // Planned 1300 against 1000 ordered — 300 of excess, and the yarn
    // for it came out of stock when the job was raised. Changing the
    // quantity changes that excess, and redrawing stock is not
    // something this route should do quietly.
    const { job, elastic } = await seed({ ordered: 1000, planned: 1300 });

    const res = await edit(job, [{ elastic: String(elastic._id), quantity: 1100 }]);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('JOB_EXCESS_WOULD_CHANGE');
    expect(res.body.message).toMatch(/already been drawn from stock/i);
    expect((await JobOrder.findById(job._id).lean()).elastics[0].quantity).toBe(1300);
  });

  it('says what to do instead, rather than just refusing', async () => {
    const { job, elastic } = await seed({ ordered: 1000, planned: 1300 });
    const res = await edit(job, [{ elastic: String(elastic._id), quantity: 1100 }]);
    expect(res.body.message).toMatch(/cancel this job and raise it again/i);
  });

  it('allows an edit that leaves the excess where it was', async () => {
    // No excess before, none after — nothing was drawn, nothing to redraw.
    const { job, elastic } = await seed({ ordered: 1000, planned: 800 });
    expect((await edit(job, [{ elastic: String(elastic._id), quantity: 600 }])).status).toBe(200);
  });

  it('refuses an edit that would create an excess where there was none', async () => {
    const { job, elastic } = await seed({ ordered: 1000, planned: 800 });

    const res = await edit(job, [{ elastic: String(elastic._id), quantity: 1200 }]);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('JOB_EXCESS_WOULD_CHANGE');
  });
});
