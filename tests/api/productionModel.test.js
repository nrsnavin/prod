'use strict';
// ══════════════════════════════════════════════════════════════════
//  PREDICTED PRODUCTION — the routes
//
//  Trained from verified shifts in the database: the machine page reads
//  a machine's rate and a prediction, the entry screen reads what a
//  planned shift should make, and a worker reads it for their own shift
//  only. With too little history, every route says so plainly instead
//  of guessing.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, pm, admin, worker, otherWorker, workerEmp, otherEmp;
let Machine, ShiftDetail, Elastic, fast, slow, e12, e24, plan;
const cookie = (u) => [`token=${jwt.sign({ id: u._id, role: u.role }, process.env.JWT_SECRET_KEY)}`];
const get = (u, url) => request(app).get(url).set('Cookie', cookie(u));
const DAY = 86_400_000;

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  pm = require('../../services/productionModel');
  const User = require('../../models/User');
  const Employee = require('../../models/Employee');
  const ShiftPlan = require('../../models/ShiftPlan');
  Machine = require('../../models/Machine');
  ShiftDetail = require('../../models/ShiftDetail');
  Elastic = require('../../models/Elastic');
  const { ALWAYS_ON } = require('../../utils/features');

  workerEmp = await Employee.create({ name: 'Ravi', department: 'weaving' });
  otherEmp = await Employee.create({ name: 'Kumar', department: 'weaving' });
  admin = await User.create({ name: 'Admin', email: 'a@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  const w = (name, emp) => User.create({
    name, email: `${name}@t.co`, password: 'pass1234', role: 'production', department: 'production',
    features: [...ALWAYS_ON], employee: emp._id,
  });
  worker = await w('ravi', workerEmp);
  otherWorker = await w('kumar', otherEmp);

  const elastic = (pick) => Elastic.create({ name: `E${pick}`, weaveType: '8', spandexEnds: 40, yarnEnds: 120, pick, noOfHook: 8, weight: 2.4 });
  e12 = await elastic(12);
  e24 = await elastic(24);
  fast = await Machine.create({ ID: 'LOOM-01', manufacturer: 'Comez', NoOfHead: 4, NoOfHooks: 12, elastics: [1, 2, 3, 4].map((head) => ({ head, elastic: e12._id })) });
  slow = await Machine.create({ ID: 'LOOM-02', manufacturer: 'Comez', NoOfHead: 2, NoOfHooks: 12, elastics: [1, 2].map((head) => ({ head, elastic: e24._id })) });
  plan = await ShiftPlan.create({ date: new Date(), shift: 'DAY' });

  // 60 verified shifts each: LOOM-01 at speed 12, LOOM-02 at speed 9,
  // a little scatter, run times from 6 to 10 hours. Stored metres are per
  // head × heads, as /verify-production stores them.
  const rows = [];
  for (const [m, speed, el] of [[fast, 12, e12], [slow, 9, e24]]) {
    for (let i = 0; i < 60; i++) {
      const minutes = 360 + (i % 5) * 60;
      const perHead = (speed * minutes) / el.pick * (1 + ((i % 7) - 3) * 0.01);
      rows.push({
        date: new Date(Date.now() - (120 - i * 2) * DAY), shift: i % 2 ? 'NIGHT' : 'DAY', status: 'closed',
        timer: `${Math.floor(minutes / 60)}:00:00`, productionMeters: perHead * m.NoOfHead,
        elastics: m.elastics.map((h) => ({ head: h.head, elastic: h.elastic })),
        employee: otherEmp._id, shiftPlan: plan._id, machine: m._id,
      });
    }
  }
  await ShiftDetail.insertMany(rows);
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
beforeEach(() => pm.getModel.invalidate());

describe('the model summary', () => {
  it('reports what it learned from and how it scored against simpler guesses', async () => {
    const res = await get(admin, '/api/v2/production-model/summary');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ available: true, data: { read: 120, used: 120 } });
    expect(res.body.evaluation).toMatchObject({ trainedOn: 96, testedOn: 24 });
    expect(Object.keys(res.body.evaluation.methods)).toEqual(['model', 'machineAverage', 'machinePerHour', 'plantPhysics']);
    const [one, two] = res.body.machines;
    expect(one).toMatchObject({ code: 'LOOM-01', basis: 'machine', shifts: 60 });
    expect(one.speedIndex).toBeGreaterThan(two.speedIndex);
  });

  it('is not for a worker', async () => {
    expect((await get(worker, '/api/v2/production-model/summary')).status).toBe(403);
  });
});

describe('a machine', () => {
  it('predicts its metres for a run time at its current pick', async () => {
    const res = await get(admin, `/api/v2/production-model/machine/${fast._id}?runTime=8:00`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ pick: 12, pickFrom: 'heads', runTimeFrom: 'entered', machine: { code: 'LOOM-01', heads: 4 } });
    expect(res.body.elastics).toEqual([expect.objectContaining({ name: 'E12', pick: 12, heads: 4 })]);
    // 12 × 480 ÷ 12 = 480 m per head; four heads.
    expect(res.body.prediction.perHead).toBeGreaterThan(465);
    expect(res.body.prediction.perHead).toBeLessThan(495);
    expect(res.body.prediction.total).toBeCloseTo(res.body.prediction.perHead * 4, 0);
    expect(res.body.summary.metresPerHeadHour).toBeCloseTo(60, -1);
  });

  it('answers "what if" for another pick, and a full shift when no run time is given', async () => {
    const res = await get(admin, `/api/v2/production-model/machine/${fast._id}?pick=24`);
    expect(res.body).toMatchObject({ pick: 24, pickFrom: 'entered', runTimeFrom: 'full-shift' });
    expect(res.body.prediction.minutes).toBe(720);
    expect(res.body.prediction.perHead).toBeCloseTo(360, -1); // 12 × 720 ÷ 24
  });

  it.each([
    ['?runTime=banana', /7:45/],
    ['?pick=-3', /pick/],
  ])('refuses %s with 400', async (q, why) => {
    const res = await get(admin, `/api/v2/production-model/machine/${fast._id}${q}`);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(why);
  });

  it('is 404 for a machine that does not exist and 400 for a bad id', async () => {
    expect((await get(admin, `/api/v2/production-model/machine/${new mongoose.Types.ObjectId()}`)).status).toBe(404);
    expect((await get(admin, '/api/v2/production-model/machine/nope')).status).toBe(400);
  });
});

describe('a planned shift, as the entry screen asks', () => {
  let open;
  beforeAll(async () => {
    open = await ShiftDetail.create({
      date: new Date(), shift: 'DAY', status: 'open', employee: workerEmp._id, shiftPlan: plan._id, machine: slow._id,
      elastics: slow.elastics.map((h) => ({ head: h.head, elastic: h.elastic })),
    });
  });

  it('predicts from the run time being typed', async () => {
    const res = await get(admin, `/api/v2/production-model/shift/${open._id}?runTime=8:00:00`);
    expect(res.status).toBe(200);
    expect(res.body.runTimeFrom).toBe('entered');
    // 9 × 480 ÷ 24 = 180 m per head on the slow loom.
    expect(res.body.prediction.perHead).toBeGreaterThan(172);
    expect(res.body.prediction.perHead).toBeLessThan(188);
    expect(res.body.prediction.checkLow).toBeLessThan(res.body.prediction.low);
  });

  it('has no prediction until there is a run time', async () => {
    const res = await get(admin, `/api/v2/production-model/shift/${open._id}`);
    expect(res.body).toMatchObject({ available: true, prediction: null, runTimeFrom: null });
    expect(res.body.summary.metresPerHeadHour).toBeGreaterThan(0);
  });

  it('lets the worker see it for their own shift, and only theirs', async () => {
    const mine = await get(worker, `/api/v2/me/shifts/${open._id}/expected?runTime=8:00`);
    expect(mine.status).toBe(200);
    expect(mine.body.prediction.perHead).toBeGreaterThan(172);
    expect(mine.body).not.toHaveProperty('summary');
    expect(mine.body).not.toHaveProperty('elastics');
    expect((await get(otherWorker, `/api/v2/me/shifts/${open._id}/expected`)).status).toBe(404);
    expect((await get(worker, `/api/v2/production-model/shift/${open._id}`)).status).toBe(403);
  });
});

describe('with too little history', () => {
  it('says so, and predicts nothing', async () => {
    const saved = await ShiftDetail.find({ status: 'closed' }).lean();
    await ShiftDetail.deleteMany({ status: 'closed', _id: { $nin: saved.slice(0, 10).map((s) => s._id) } });
    try {
      const res = await get(admin, `/api/v2/production-model/machine/${fast._id}?runTime=8:00`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ available: false, prediction: null, summary: null });
      expect(res.body.reason).toMatch(/Not enough verified shifts/);
      expect((await get(admin, '/api/v2/production-model/summary')).body).toMatchObject({ available: false, machines: [] });
    } finally {
      await ShiftDetail.deleteMany({ status: 'closed' });
      await ShiftDetail.insertMany(saved);
    }
  });
});
