'use strict';
// ══════════════════════════════════════════════════════════════════
//  WASTAGE MUST NOT BE SUBTRACTED TWICE
//
//  `producedElastic` is GROSS: it is what came off the loom, and
//  api/wastage.js never decrements it — recording wastage only adds to
//  `wastageElastic`. The wasted meters are therefore ALREADY inside
//  `produced`.
//
//  The job summary computed `remaining = planned - produced - wasted`,
//  which takes them out a second time. A job that ran its full planned
//  quantity and rejected 50 m read as 50 m still to run — so the floor
//  was told to keep weaving something that was finished, and the
//  under-statement grew with every wastage entry.
//
//  Wastage is a record, not a claim on the plan. Remaining is
//  planned − produced.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongo, app, M = {}, admin, fx;
const cookie = (id, role) => [`token=${jwt.sign({ id, role }, process.env.JWT_SECRET_KEY)}`];
const adminCookie = () => cookie(admin._id, 'admin');
let seq = 0;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  for (const n of ['User', 'Order', 'JobOrder', 'Customer', 'Elastic']) {
    M[n] = require(`../../models/${n}.js`);
  }
  admin = await M.User.create({
    name: 'Owner', email: 'wastage-owner@t.co', password: 'pass1234',
    role: 'admin', department: 'admin',
  });
  const customer = await M.Customer.create({
    name: 'C', contactName: 'X', phoneNumber: '9000000002',
  });
  const elastic = await M.Elastic.create({
    name: 'Woven Elastic 25mm', weaveType: '8', spandexEnds: 40,
    pick: 30, noOfHook: 12, weight: 5,
  });
  const order = await M.Order.create({
    date: new Date(), po: 'PO-W', customer: customer._id, supplyDate: new Date(),
    status: 'InProgress', elasticOrdered: [{ elastic: elastic._id, quantity: 1000, rate: 10 }],
  });
  fx = { customer, elastic, order };
}, 180_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

/** A job with GROSS production and a separately recorded wastage. */
const makeJob = ({ planned, produced, wasted, packed = 0 }) =>
  M.JobOrder.create({
    date: new Date(), order: fx.order._id, customer: fx.customer._id,
    status: 'weaving', jobOrderNoSeed: ++seq,
    elastics:        [{ elastic: fx.elastic._id, quantity: planned }],
    producedElastic: [{ elastic: fx.elastic._id, quantity: produced }],
    packedElastic:   [{ elastic: fx.elastic._id, quantity: packed }],
    wastageElastic:  [{ elastic: fx.elastic._id, quantity: wasted }],
  });

const summaryOf = async (job) => {
  const res = await request(app)
    .get(`/api/v2/job/summary?jobId=${job._id}`).set('Cookie', adminCookie());
  expect(res.status).toBe(200);
  return res.body.summary[0];
};

// ══════════════════════════════════════════════════════════════════
describe('remaining is planned less produced', () => {
  test('a fully-run job with wastage has nothing remaining', async () => {
    const job = await makeJob({ planned: 1000, produced: 1000, wasted: 50 });
    const row = await summaryOf(job);

    // The old formula gave 1000 - 1000 - 50 → clamped to 0 here, so
    // this case alone would not have caught it. The next one does.
    expect(row.remaining).toBe(0);
    // And the wastage is still reported, just not deducted.
    expect(row.wasted).toBe(50);
  });

  test('a part-run job is not short-changed by its wastage', async () => {
    const job = await makeJob({ planned: 1000, produced: 600, wasted: 50 });
    const row = await summaryOf(job);

    // 1000 − 600. NOT 350: those 50 m are already inside the 600.
    expect(row.remaining).toBe(400);
    expect(row.produced).toBe(600);
    expect(row.wasted).toBe(50);
  });

  test('recording more wastage does not move remaining at all', async () => {
    const job = await makeJob({ planned: 1000, produced: 600, wasted: 0 });
    const before = await summaryOf(job);

    await M.JobOrder.updateOne(
      { _id: job._id },
      { $set: { 'wastageElastic.0.quantity': 120 } }
    );
    const after = await summaryOf(job);

    expect(after.wasted).toBe(120);
    expect(after.remaining).toBe(before.remaining);
  });

  test('a job with no wastage is unchanged', async () => {
    const job = await makeJob({ planned: 1000, produced: 250, wasted: 0 });
    expect((await summaryOf(job)).remaining).toBe(750);
  });

  // Over-production is a data issue, not a negative quantity to run —
  // the same rule the order-side summary already applies.
  test('over-production floors at zero rather than going negative', async () => {
    const job = await makeJob({ planned: 1000, produced: 1100, wasted: 30 });
    expect((await summaryOf(job)).remaining).toBe(0);
  });

  test('packing percentage is unaffected by wastage', async () => {
    const job = await makeJob({ planned: 1000, produced: 1000, wasted: 200, packed: 800 });
    const row = await summaryOf(job);
    expect(row.packed).toBe(800);
    expect(row.packingPct).toBe(80);
  });
});
