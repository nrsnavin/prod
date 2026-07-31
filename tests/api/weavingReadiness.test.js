'use strict';
//
// Moving a job from preparatory to weaving by hand.
//
// The auto-advance in utils/jobStatusHelper.js fires when the second of
// warping/covering is completed. It cannot help a job whose covering was
// created after the warping finished, or one whose links were repaired
// later — those sit in preparatory with nothing to nudge them.
//
// So the same rule is available as a deliberate action, and these tests
// pin BOTH halves of the user's requirement: it moves when warping and
// covering are both completed, and when they are not it says why and
// leaves the status exactly as it was.

jest.mock('../../middleware/auth.js', () => ({
  isAuthenticated: (req, _res, next) => {
    req.user = { _id: '507f1f77bcf86cd799439011', role: 'admin', name: 'Tester' };
    next();
  },
  isAdmin:        () => (_req, _res, next) => next(),
  requireFeature: () => (_req, _res, next) => next(),
  selfOrAdmin:    (_req, _res, next) => next(),
}));

const express = require('express');
const bodyParser = require('body-parser');
const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

let app, mongo, JobOrder, Warping, Covering;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  JobOrder = require('../../models/JobOrder');
  Warping  = require('../../models/Warping');
  Covering = require('../../models/Covering');
  const jobRouter = require('../../api/job.js');
  const errorHandler = require('../../middleware/error.js');

  app = express();
  app.use(bodyParser.json());
  app.use('/api/v2/job', jobRouter);
  // The real error middleware — the WEAVING_NOT_READY code and the
  // blocker details reach the client only if it forwards them.
  app.use(errorHandler);
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
    date: new Date(),
    order: new mongoose.Types.ObjectId(),
    customer: new mongoose.Types.ObjectId(),
    status: 'preparatory',
    elastics: [],
    ...over,
  });
}

/** A job with warping and covering in the given statuses, both linked. */
async function makePrepared({ warpingStatus, coveringStatus } = {}) {
  const job = await makeJob();
  const patch = {};
  if (warpingStatus) {
    const w = await Warping.create({ date: new Date(), job: job._id, status: warpingStatus });
    patch.warping = w._id;
  }
  if (coveringStatus) {
    const c = await Covering.create({ date: new Date(), job: job._id, status: coveringStatus });
    patch.covering = c._id;
  }
  await JobOrder.updateOne({ _id: job._id }, patch);
  return job;
}

const move = (jobId) =>
  request(app).post('/api/v2/job/update-status').send({ jobId, nextStatus: 'weaving' });
const readiness = (jobId) => request(app).get(`/api/v2/job/${jobId}/weaving-readiness`);

describe('preparatory → weaving is allowed when both stages are done', () => {
  test('moves the job and stamps the weaving timestamp', async () => {
    const job = await makePrepared({ warpingStatus: 'completed', coveringStatus: 'completed' });

    const res = await move(job._id.toString());
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('weaving');

    const saved = await JobOrder.findById(job._id);
    expect(saved.status).toBe('weaving');
    expect(saved.weavingAt).toBeTruthy();
    // The move is auditable like every other stage change.
    expect(saved.fingerprints.some((f) => f.code === 'JOB_STAGE_UPDATED')).toBe(true);
  });
});

describe('preparatory → weaving is refused when a stage is still open', () => {
  test.each([
    ['warping still in progress', { warpingStatus: 'in_progress', coveringStatus: 'completed' }, /warping is in progress/i],
    ['covering still open',       { warpingStatus: 'completed', coveringStatus: 'open' },        /covering is open/i],
    ['no covering created',       { warpingStatus: 'completed' },                                 /No covering has been created/i],
    ['no warping created',        { coveringStatus: 'completed' },                                /No warping has been created/i],
  ])('%s → 409, status unchanged', async (_name, setup, expected) => {
    const job = await makePrepared(setup);

    const res = await move(job._id.toString());
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('WEAVING_NOT_READY');
    expect(res.body.message).toMatch(expected);
    expect(res.body.details.blockers.length).toBeGreaterThan(0);

    // The whole point: an alert, not a partial move.
    const saved = await JobOrder.findById(job._id);
    expect(saved.status).toBe('preparatory');
    expect(saved.weavingAt).toBeFalsy();
  });

  test('both open lists both blockers', async () => {
    const job = await makePrepared({ warpingStatus: 'open', coveringStatus: 'open' });
    const res = await move(job._id.toString());
    expect(res.status).toBe(409);
    expect(res.body.details.blockers).toHaveLength(2);
  });

  test('a dangling warping reference is reported as a broken record, not as absent', async () => {
    const job = await makePrepared({ warpingStatus: 'completed', coveringStatus: 'completed' });
    await Warping.deleteMany({ job: job._id });

    const res = await move(job._id.toString());
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/warping record no longer exists/i);
  });
});

describe('GET /:jobId/weaving-readiness', () => {
  test('reports ready with both stages done', async () => {
    const job = await makePrepared({ warpingStatus: 'completed', coveringStatus: 'completed' });
    const res = await readiness(job._id.toString());
    expect(res.status).toBe(200);
    expect(res.body.data.ready).toBe(true);
    expect(res.body.data.blockers).toEqual([]);
    expect(res.body.data.stages.map((s) => s.stage)).toEqual(['warping', 'covering']);
    expect(res.body.data.stages.every((s) => s.done)).toBe(true);
  });

  test('reports the blockers without changing anything', async () => {
    const job = await makePrepared({ warpingStatus: 'in_progress' });
    const res = await readiness(job._id.toString());
    expect(res.status).toBe(200);
    expect(res.body.data.ready).toBe(false);
    expect(res.body.data.jobStatus).toBe('preparatory');
    expect(res.body.data.blockers).toHaveLength(2);

    const saved = await JobOrder.findById(job._id);
    expect(saved.status).toBe('preparatory');
  });

  test('404 for an unknown job and 400 for a malformed id', async () => {
    expect((await readiness(new mongoose.Types.ObjectId().toString())).status).toBe(404);
    expect((await readiness('not-an-id')).status).toBe(400);
  });
});

describe('the gate applies only to the preparatory step', () => {
  test('weaving → finishing is untouched by the readiness check', async () => {
    const job = await makeJob({ status: 'weaving' });
    const res = await request(app)
      .post('/api/v2/job/update-status')
      .send({ jobId: job._id.toString(), nextStatus: 'finishing' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('finishing');
  });

  test('a job already past preparatory cannot be sent back to weaving', async () => {
    const job = await makeJob({ status: 'checking' });
    const res = await move(job._id.toString());
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Invalid transition/);
  });
});
