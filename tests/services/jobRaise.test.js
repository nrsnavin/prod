'use strict';
// ══════════════════════════════════════════════════════════════════
//  RAISING A JOB, WITHOUT HTTP — services/jobRaise.js
//
//  The rules of POST /job/create, called directly: refusals come back as
//  thrown ErrorHandlers with the route's status and code; a job raised on
//  an approved order exists with its warping and covering programmes,
//  and the order is running with the job on its timeline.
// ══════════════════════════════════════════════════════════════════

process.env.NODE_ENV = 'test';

const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, Order, JobOrder, Warping, Covering, Elastic, raiseJob;
const actor = { id: 'u1', name: 'Planner', role: 'admin' };

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  Order = require('../../models/Order');
  JobOrder = require('../../models/JobOrder');
  Warping = require('../../models/Warping');
  Covering = require('../../models/Covering');
  Elastic = require('../../models/Elastic');
  ({ raiseJob } = require('../../services/jobRaise'));
}, 120_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

let seq = 1;
async function order(status, qty = 1000) {
  const el = await Elastic.create({ name: `E-${seq}`, weaveType: '8', spandexEnds: 40, yarnEnds: 120, pick: 12, noOfHook: 8, weight: 2 });
  const o = await Order.create({
    customer: new mongoose.Types.ObjectId(), orderNo: seq++, date: new Date(), supplyDate: new Date(), po: 'PO',
    elasticOrdered: [{ elastic: el._id, quantity: qty }],
    pendingElastic: [{ elastic: el._id, quantity: qty }],
    producedElastic: [{ elastic: el._id, quantity: 0 }],
    status,
  });
  return { o, el };
}

it('refuses an order that is not approved yet, as the route did', async () => {
  const { o, el } = await order('Open');
  await expect(raiseJob({ orderId: o._id, date: new Date(), elastics: [{ elastic: el._id, quantity: 500 }] }, { actor }))
    .rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/Approve the order/) });
  expect(await JobOrder.countDocuments({ order: o._id })).toBe(0);
});

it('refuses an empty plan before touching anything', async () => {
  await expect(raiseJob({ orderId: new mongoose.Types.ObjectId(), date: new Date(), elastics: [] }, { actor }))
    .rejects.toMatchObject({ statusCode: 400, message: 'elastics array must not be empty' });
});

it('raises a job with its programmes, and the order starts running', async () => {
  const { o, el } = await order('Approved');
  const { job, warping, covering, jobFp } = await raiseJob(
    { orderId: o._id, date: new Date(), elastics: [{ elastic: el._id, quantity: 600 }] },
    { actor, userId: new mongoose.Types.ObjectId() }
  );
  expect(job.status).toBe('preparatory');
  expect(await Warping.exists({ _id: warping._id, job: job._id })).toBeTruthy();
  expect(await Covering.exists({ _id: covering._id, job: job._id })).toBeTruthy();
  expect(jobFp.code).toBe('JOB_CREATED');

  const after = await Order.findById(o._id);
  expect(after.status).toBe('InProgress');
  expect(after.pendingElastic[0].quantity).toBe(400);
  expect(after.fingerprints.at(-1).code).toBe('JOB_CREATED');
});
