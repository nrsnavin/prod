'use strict';
//
// CHARACTERIZATION test for api/job.js POST /update-status.
//
// This pins the CURRENT behaviour of the job stage-transition handler
// so the upcoming status-state-machine refactor (Phase B3) can be
// verified behaviour-identical. It is intentionally descriptive of
// what the code does today, not what it "should" do.
//
// The /job router applies isAuthenticated internally, so we mock it to
// inject an admin user (the standard harness pattern used by the notify
// integration tests).

jest.mock('../../middleware/auth.js', () => ({
  isAuthenticated: (req, _res, next) => { req.user = { _id: '507f1f77bcf86cd799439011', role: 'admin', name: 'Tester' }; next(); },
  isAdmin:         () => (_req, _res, next) => next(),
  selfOrAdmin:     (_req, _res, next) => next(),
}));

const express  = require('express');
const bodyParser = require('body-parser');
const request  = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

let app, mongo, JobOrder, Order, Machine;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  JobOrder = require('../../models/JobOrder');
  Order    = require('../../models/Order');
  Machine  = require('../../models/Machine');
  const jobRouter = require('../../api/job.js');

  app = express();
  app.use(bodyParser.json());
  app.use('/api/v2/job', jobRouter);
  app.use((err, _req, res, _next) => {
    res.status(err.statusCode || 500).json({ success: false, message: err.message });
  });
}, 60_000);

afterAll(async () => {
  if (mongo) { await mongoose.disconnect(); await mongo.stop(); }
});
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    await c.deleteMany({});
  }
});

async function makeJob(over = {}) {
  return JobOrder.create({
    date:     new Date(),
    order:    over.order || new mongoose.Types.ObjectId(),
    customer: new mongoose.Types.ObjectId(),
    status:   'weaving',
    elastics: [],
    ...over,
  });
}

const post = (body) => request(app).post('/api/v2/job/update-status').send(body);

describe('POST /update-status — validation guards', () => {
  test('400 when jobId is missing', async () => {
    const res = await post({ nextStatus: 'finishing' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/jobId is required/);
  });

  test('400 when nextStatus is missing', async () => {
    const res = await post({ jobId: new mongoose.Types.ObjectId().toString() });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/nextStatus is required/);
  });

  test('404 when the job does not exist', async () => {
    const res = await post({ jobId: new mongoose.Types.ObjectId().toString(), nextStatus: 'finishing' });
    expect(res.status).toBe(404);
    expect(res.body.message).toMatch(/Job not found/);
  });

  test('400 when the job cannot advance further (no transition from status)', async () => {
    const job = await makeJob({ status: 'preparatory' });
    const res = await post({ jobId: job._id.toString(), nextStatus: 'weaving' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/cannot advance further/);
  });

  test('400 on an invalid transition target', async () => {
    const job = await makeJob({ status: 'weaving' }); // expected → finishing
    const res = await post({ jobId: job._id.toString(), nextStatus: 'checking' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Invalid transition.*Expected: "finishing"/);
  });
});

describe('POST /update-status — happy path + side effects', () => {
  test('weaving → finishing releases the machine and clears job.machine', async () => {
    const machine = await Machine.create({
      ID: 'M-1', manufacturer: 'Acme', NoOfHead: 4, NoOfHooks: 8,
      status: 'running', orderRunning: new mongoose.Types.ObjectId(),
    });
    const job = await makeJob({ status: 'weaving', machine: machine._id });

    const res = await post({ jobId: job._id.toString(), nextStatus: 'finishing' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('finishing');

    const freed = await Machine.findById(machine._id);
    expect(freed.status).toBe('free');
    expect(freed.orderRunning).toBeNull();

    const saved = await JobOrder.findById(job._id);
    expect(saved.machine).toBeUndefined();
    // A JOB_STAGE_UPDATED fingerprint is recorded, flagged machineReleased.
    const fp = saved.fingerprints.find(f => f.code === 'JOB_STAGE_UPDATED');
    expect(fp).toBeTruthy();
    expect(fp.meta.machineReleased).toBe(true);
    // stampStage sets the finishing timestamp.
    expect(saved.finishingAt).toBeTruthy();
  });

  test('a mid-flow transition (finishing → checking) advances without touching a machine', async () => {
    const job = await makeJob({ status: 'finishing' });
    const res = await post({ jobId: job._id.toString(), nextStatus: 'checking' });
    expect(res.status).toBe(200);
    const saved = await JobOrder.findById(job._id);
    expect(saved.status).toBe('checking');
    expect(saved.checkingAt).toBeTruthy();
  });
});

describe('POST /update-status — completion cascade to the parent Order', () => {
  test('packing → completed CLOSES the order when all siblings are done', async () => {
    const order = await Order.create({
      orderNo: 9001, status: 'InProgress', po: 'PO-1',
      date: new Date(), supplyDate: new Date(),
      customer: new mongoose.Types.ObjectId(),
      elasticOrdered: [],
    });
    const job = await makeJob({ status: 'packing', order: order._id });

    const res = await post({ jobId: job._id.toString(), nextStatus: 'completed' });
    expect(res.status).toBe(200);
    expect(res.body.completionFingerprint).toBeTruthy();

    const savedOrder = await Order.findById(order._id);
    expect(savedOrder.status).toBe('Completed');
    expect(savedOrder.completedAt).toBeTruthy();
    const ofp = savedOrder.fingerprints.find(f => f.code === 'ORDER_COMPLETED');
    expect(ofp).toBeTruthy();
    expect(ofp.meta.triggerJobNo).toBe(job.jobOrderNo);
  });

  test('packing → completed does NOT close the order when a sibling is still active', async () => {
    const order = await Order.create({
      orderNo: 9002, status: 'InProgress', po: 'PO-2',
      date: new Date(), supplyDate: new Date(),
      customer: new mongoose.Types.ObjectId(),
      elasticOrdered: [],
    });
    const jobA = await makeJob({ status: 'packing', order: order._id });
    await makeJob({ status: 'weaving', order: order._id }); // sibling still in flight

    const res = await post({ jobId: jobA._id.toString(), nextStatus: 'completed' });
    expect(res.status).toBe(200);
    expect(res.body.completionFingerprint.meta.allSiblingsDone).toBe(false);

    const savedOrder = await Order.findById(order._id);
    expect(savedOrder.status).toBe('InProgress'); // untouched
  });
});
