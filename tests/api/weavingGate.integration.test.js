'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE WEAVING GATE, THROUGH THE WHOLE STACK
//
//  weavingReadiness.test.js mounts the job router on a bare Express
//  app. That proves the rule but not the road to it: the real app puts
//  the router behind helmet, the mongo sanitiser, a JWT cookie, the
//  department gate and a feature check, and ends in the real error
//  middleware. A gate the browser cannot reach is a gate that does not
//  work, so this drives the same two endpoints exactly as the web app
//  does — real app.js, real auth, real error handler.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
// No transactions in this path, so a standalone server is enough.
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongo, app, JobOrder, Warping, Covering, User, admin;

const adminCookie = () => [
  `token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`,
];

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  JobOrder = require('../../models/JobOrder');
  Warping = require('../../models/Warping');
  Covering = require('../../models/Covering');
  User = require('../../models/User');
  admin = await User.create({
    name: 'Owner', email: 'o@t.co', password: 'pass1234', role: 'admin', department: 'admin',
  });
}, 90_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
});

async function makeJob({ warpingStatus, coveringStatus } = {}) {
  const job = await JobOrder.create({
    date: new Date(),
    order: new mongoose.Types.ObjectId(),
    customer: new mongoose.Types.ObjectId(),
    status: 'preparatory',
    elastics: [],
  });
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

const readiness = (job) =>
  request(app).get(`/api/v2/job/${job._id}/weaving-readiness`).set('Cookie', adminCookie());

const move = (job) =>
  request(app).post('/api/v2/job/update-status')
    .set('Cookie', adminCookie())
    .send({ jobId: String(job._id), nextStatus: 'weaving' });

describe('the readiness endpoint is reachable as the web app calls it', () => {
  it('answers on the real mounted path', async () => {
    const job = await makeJob({ warpingStatus: 'completed', coveringStatus: 'in_progress' });
    const res = await readiness(job);

    expect(res.status).toBe(200);
    expect(res.body.data.ready).toBe(false);
    expect(res.body.data.blockers).toEqual(['The covering is in progress, not completed']);
  });

  it('is not swallowed by the /:jobId detail route registered later', async () => {
    const job = await makeJob({ warpingStatus: 'completed', coveringStatus: 'completed' });
    const res = await readiness(job);

    // If /:jobId matched first this would be a job document, not a verdict.
    expect(res.body.data).toHaveProperty('ready', true);
    expect(res.body.data).not.toHaveProperty('jobOrderNo');
  });
});

describe('the refusal survives the real error middleware', () => {
  it('carries the code and the blockers to the browser', async () => {
    const job = await makeJob({ warpingStatus: 'open', coveringStatus: 'open' });
    const res = await move(job);

    expect(res.status).toBe(409);
    // The web app branches on exactly these two fields.
    expect(res.body.code).toBe('WEAVING_NOT_READY');
    expect(res.body.details.blockers).toHaveLength(2);

    const saved = await JobOrder.findById(job._id);
    expect(saved.status).toBe('preparatory');
  });
});

describe('the move itself works end to end', () => {
  it('advances a job whose warping and covering are both completed', async () => {
    const job = await makeJob({ warpingStatus: 'completed', coveringStatus: 'completed' });
    const res = await move(job);

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('weaving');
    expect((await JobOrder.findById(job._id)).status).toBe('weaving');
  });
});

describe('the older query-param form agrees with the new one', () => {
  it('gives the same verdict for the same job', async () => {
    const job = await makeJob({ warpingStatus: 'completed', coveringStatus: 'open' });

    const legacy = await request(app)
      .get(`/api/v2/job/weaving-readiness?id=${job._id}`)
      .set('Cookie', adminCookie());
    const current = await readiness(job);

    expect(legacy.status).toBe(200);
    // Two shapes, one rule — they must never disagree about a job.
    expect(legacy.body.readyForWeaving).toBe(current.body.data.ready);
    expect(legacy.body.warpingDone).toBe(true);
    expect(legacy.body.coveringDone).toBe(false);
    expect(legacy.body.coveringStatus).toBe('open');
    expect(legacy.body.blockers).toEqual(current.body.data.blockers);
  });
});
