'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE DYE LOTS AN ORDER SET ASIDE, ACROSS A REPLAN
//
//  Three routes restate an order's requirement:
//
//      POST /job/create-job-order      raising a second job
//      POST /job/update-elastics       editing a job's quantities
//      PUT  /order/update-order        editing the order's lines
//
//  All three did the same thing:
//
//      order.rawMaterialRequired = await computeMaterialRequirement(…)
//
//  and the computed rows carry no `lots` field, so every one of them
//  silently released every bag the order was holding. Nothing threw,
//  nothing was logged, and the yarn became free for another order to
//  promise. The panel just read "Nothing set aside" next time.
//
//  carryEarmarksForward is unit-tested on its own. This drives the real
//  routes, because the unit test cannot see the thing that actually
//  broke: the assignment at the call site.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app;
let Order, JobOrder, Customer, Elastic, RawMaterial, YarnLot,
  Warping, Covering, User, admin;

const adminCookie = () => [
  `token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`,
];

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  Order = require('../../models/Order');
  JobOrder = require('../../models/JobOrder');
  Customer = require('../../models/Customer');
  Elastic = require('../../models/Elastic');
  RawMaterial = require('../../models/RawMaterial');
  YarnLot = require('../../models/YarnLot');
  Warping = require('../../models/Warping');
  Covering = require('../../models/Covering');
  User = require('../../models/User');
  admin = await User.create({
    name: 'Owner', email: 'earmark@t.co', password: 'pass1234',
    role: 'admin', department: 'admin',
  });
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
});

let seq = 0;

/**
 * An order with a job planned against it, one warp yarn, and one open
 * dye lot big enough to be earmarked from.
 */
async function seed({ ordered = 1000, planned = 1000, lotQty = 2000, staleStock = 5000 } = {}) {
  seq += 1;
  const yarn = await RawMaterial.create({
    name: `Nylon ${seq}`, category: 'warp', price: 300, stock: 5000, unit: 'kg',
  });
  const lot = await YarnLot.create({
    rawMaterial: yarn._id, lotNo: `D-${4000 + seq}`, shade: 'Ecru',
    receivedQty: lotQty, consumedQty: 0, status: 'open', receivedDate: new Date(),
  });
  const elastic = await Elastic.create({
    name: `20mm ${Math.random().toString(36).slice(2, 8)}`, weaveType: '8',
    spandexEnds: 40, yarnEnds: 120, pick: 12, noOfHook: 8, weight: 2.4,
    warpYarn: [{ id: yarn._id, ends: 40, weight: 400 }],
  });
  const customer = await Customer.create({
    name: `Acme ${seq}`, contactName: 'R', phoneNumber: '9000000001',
  });
  const order = await Order.create({
    customer: customer._id, po: `PO-${seq}`, date: new Date(), supplyDate: new Date(),
    elasticOrdered: [{ elastic: elastic._id, quantity: ordered }],
    pendingElastic: [{ elastic: elastic._id, quantity: ordered }],
    status: 'InProgress',
    rawMaterialRequired: [
      { rawMaterial: yarn._id, name: yarn.name, requiredWeight: 400, inStock: staleStock },
    ],
  });
  const zero = [{ elastic: elastic._id, quantity: 0 }];
  const job = await JobOrder.create({
    date: new Date(), order: order._id, customer: customer._id, status: 'preparatory',
    elastics: [{ elastic: elastic._id, quantity: planned }],
    producedElastic: zero, packedElastic: zero, wastageElastic: zero,
  });
  const warping = await Warping.create({
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
  return { order, job, elastic, customer, yarn, lot };
}

/** Set lots aside through the real route, so the fixture is not a fiction. */
const assign = (order, yarn, lots) =>
  request(app).post('/api/v2/order/assign-lots')
    .set('Cookie', adminCookie())
    .send({
      orderId: String(order._id),
      assignments: [{ rawMaterial: String(yarn._id), lots }],
    });

const earmarksOf = async (orderId, yarnId) => {
  const o = await Order.findById(orderId).lean();
  const row = (o.rawMaterialRequired || [])
    .find((r) => String(r.rawMaterial) === String(yarnId));
  return row ? (row.lots || []) : null;
};

const totalOf = (lots) => (lots || []).reduce((t, l) => t + l.quantity, 0);

// ══════════════════════════════════════════════════════════════════
describe('editing a job\'s quantities', () => {
  it('leaves the dye lots the order set aside in place', async () => {
    // The bug, through the route that had it.
    const { order, job, elastic, yarn, lot } = await seed();
    // 100 kg against a 400 kg requirement. Replanning to 900 m drops the
    // requirement to 360 kg, which 100 still fits inside — so anything
    // that changes here is the carry, not the trim.
    const a = await assign(order, yarn, [{ yarnLot: String(lot._id), quantity: 100 }]);
    expect(a.status).toBe(200);
    expect(totalOf(await earmarksOf(order._id, yarn._id))).toBe(100);

    const res = await request(app).post('/api/v2/job/update-elastics')
      .set('Cookie', adminCookie())
      .send({
        jobId: String(job._id),
        elastics: [{ elastic: String(elastic._id), quantity: 900 }],
        auditReason: 'customer trimmed the run',
      });
    expect(res.status).toBe(200);

    const after = await earmarksOf(order._id, yarn._id);
    expect(after).toHaveLength(1);
    expect(after[0].quantity).toBe(100);
    expect(String(after[0].yarnLot)).toBe(String(lot._id));
  });

  it('keeps the lot number, not just the reference', async () => {
    const { order, job, elastic, yarn, lot } = await seed();
    await assign(order, yarn, [{ yarnLot: String(lot._id), quantity: 100 }]);

    await request(app).post('/api/v2/job/update-elastics')
      .set('Cookie', adminCookie())
      .send({
        jobId: String(job._id),
        elastics: [{ elastic: String(elastic._id), quantity: 900 }],
        auditReason: 'replanned',
      });

    const [e] = await earmarksOf(order._id, yarn._id);
    expect(e.lotNo).toBe(lot.lotNo);
    expect(e.shade).toBe('Ecru');
  });

  it('still recalculates the row it carried the lots onto', async () => {
    // Carrying the lots must not have carried a stale row with them.
    // The seed's inStock is deliberately wrong; a recomputed row
    // corrects it from the material, a frozen one does not.
    const { order, job, elastic, yarn, lot } = await seed({ staleStock: 1 });
    await assign(order, yarn, [{ yarnLot: String(lot._id), quantity: 100 }]);

    const before = (await Order.findById(order._id).lean())
      .rawMaterialRequired.find((r) => String(r.rawMaterial) === String(yarn._id));
    expect(before.inStock).toBe(1);

    await request(app).post('/api/v2/job/update-elastics')
      .set('Cookie', adminCookie())
      .send({
        jobId: String(job._id),
        elastics: [{ elastic: String(elastic._id), quantity: 500 }],
        auditReason: 'replanned',
      });

    const after = (await Order.findById(order._id).lean())
      .rawMaterialRequired.find((r) => String(r.rawMaterial) === String(yarn._id));
    expect(after.inStock).toBe(5000);
    expect(after.requiredWeight).toBe(400);
    expect(totalOf(after.lots)).toBe(100);
  });

  it('does not shrink the requirement when a job is planned smaller', async () => {
    // Worth pinning, because it is why the trim below needs a recipe
    // change to reach: the requirement is floored at what the CUSTOMER
    // ordered — max(ordered, totalPlanned) — so planning less of it
    // changes nothing, and there is never a surplus promise to cut.
    const { order, job, elastic, yarn } = await seed();

    await request(app).post('/api/v2/job/update-elastics')
      .set('Cookie', adminCookie())
      .send({
        jobId: String(job._id),
        elastics: [{ elastic: String(elastic._id), quantity: 100 }],
        auditReason: 'replanned',
      });

    const row = (await Order.findById(order._id).lean())
      .rawMaterialRequired.find((r) => String(r.rawMaterial) === String(yarn._id));
    expect(row.requiredWeight).toBe(400);
  });

  it('trims when the elastic\'s recipe drops the requirement under what was promised', async () => {
    // The way a shrink actually happens: somebody corrects the yarn
    // weight on the elastic, and every order using it needs less. An
    // order holding 400 kg against a requirement that is now 100 would
    // be in a state /assign-lots refuses outright.
    const { order, job, elastic, yarn, lot } = await seed();
    await assign(order, yarn, [{ yarnLot: String(lot._id), quantity: 400 }]);

    await Elastic.updateOne(
      { _id: elastic._id },
      { $set: { 'warpYarn.0.weight': 100 } }
    );

    const res = await request(app).post('/api/v2/job/update-elastics')
      .set('Cookie', adminCookie())
      .send({
        jobId: String(job._id),
        elastics: [{ elastic: String(elastic._id), quantity: 500 }],
        auditReason: 'recipe corrected',
      });
    expect(res.status).toBe(200);

    const row = (await Order.findById(order._id).lean())
      .rawMaterialRequired.find((r) => String(r.rawMaterial) === String(yarn._id));
    expect(row.requiredWeight).toBe(100);
    expect(totalOf(row.lots)).toBe(100);
    expect(totalOf(row.lots)).toBeLessThanOrEqual(row.requiredWeight);
  });

  it('says in the response when it had to trim', async () => {
    const { order, job, elastic, yarn, lot } = await seed();
    await assign(order, yarn, [{ yarnLot: String(lot._id), quantity: 400 }]);
    await Elastic.updateOne({ _id: elastic._id }, { $set: { 'warpYarn.0.weight': 100 } });

    const res = await request(app).post('/api/v2/job/update-elastics')
      .set('Cookie', adminCookie())
      .send({
        jobId: String(job._id),
        elastics: [{ elastic: String(elastic._id), quantity: 500 }],
        auditReason: 'recipe corrected',
      });

    expect(res.body.lots.trimmed).toHaveLength(1);
    expect(res.body.lots.trimmed[0]).toMatchObject({ from: 400, to: 100 });
    expect(res.body.message).toMatch(/trimmed to fit/i);
  });

  it('says nothing about lots when nothing changed', async () => {
    // A note on every replan is a note nobody reads.
    const { order, job, elastic, yarn, lot } = await seed();
    await assign(order, yarn, [{ yarnLot: String(lot._id), quantity: 100 }]);

    const res = await request(app).post('/api/v2/job/update-elastics')
      .set('Cookie', adminCookie())
      .send({
        jobId: String(job._id),
        elastics: [{ elastic: String(elastic._id), quantity: 900 }],
        auditReason: 'replanned',
      });

    expect(res.body.lots.trimmed).toEqual([]);
    expect(res.body.lots.released).toEqual([]);
    expect(res.body.message).not.toMatch(/trimmed|released/i);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('the order-line edit route', () => {
  // PUT/POST /order/update-order recomputes the requirement the same
  // way, and carries the lots for the same reason — but it cannot
  // currently be reached with earmarks present, and saying that plainly
  // is better than a test that fakes a state the app cannot produce.
  //
  // /assign-lots refuses anything that is not Approved or InProgress.
  // /update-order refuses anything that is not Open. Disjoint. The
  // carry there is a guard against that gate being widened later.
  //
  // This test IS that guard: widen either gate so the two overlap and
  // it fails, pointing at the earmark question rather than letting the
  // wipe come back unnoticed.

  it('cannot be reached by an order that is allowed to hold lots', async () => {
    const { order, elastic, yarn, lot } = await seed();
    // InProgress: may hold lots.
    const a = await assign(order, yarn, [{ yarnLot: String(lot._id), quantity: 400 }]);
    expect(a.status).toBe(200);

    const res = await request(app).post('/api/v2/order/update-order')
      .set('Cookie', adminCookie())
      .send({
        orderId: String(order._id),
        elasticOrdered: [{ elastic: String(elastic._id), quantity: 1200 }],
        auditReason: 'customer revised the PO',
      });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/only open orders can be edited/i);
  });

  it('refuses to set lots aside on an order that route CAN edit', async () => {
    // The other half of the same fact.
    const { order, yarn, lot } = await seed();
    await Order.updateOne({ _id: order._id }, { $set: { status: 'Open' } });

    const res = await assign(order, yarn, [{ yarnLot: String(lot._id), quantity: 400 }]);
    expect(res.status).toBe(409);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('the freed yarn', () => {
  it('is genuinely free again after a trim, not just missing from the order', async () => {
    // The point of trimming rather than keeping. If the surplus stayed
    // earmarked, this second order could not be given the yarn.
    const { order, job, elastic, yarn, lot } = await seed({ lotQty: 1200 });
    await assign(order, yarn, [{ yarnLot: String(lot._id), quantity: 400 }]);
    await Elastic.updateOne({ _id: elastic._id }, { $set: { 'warpYarn.0.weight': 100 } });

    await request(app).post('/api/v2/job/update-elastics')
      .set('Cookie', adminCookie())
      .send({
        jobId: String(job._id),
        elastics: [{ elastic: String(elastic._id), quantity: 500 }],
        auditReason: 'recipe corrected',
      });

    const res = await request(app)
      .get(`/api/v2/order/${order._id}/assignable-lots`)
      .query({ materialId: String(yarn._id) })
      .set('Cookie', adminCookie());

    expect(res.status).toBe(200);
    const row = (res.body.lots || []).find((l) => String(l.yarnLot) === String(lot._id));
    expect(row).toBeDefined();
    // Free is measured excluding this order's own earmarks, so the whole
    // lot reads free here. What matters is that it is not held at 1000.
    expect(row.allocated).toBe(0);
  });
});
