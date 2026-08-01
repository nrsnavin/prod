'use strict';
// ══════════════════════════════════════════════════════════════════
//  A WARPING STARTS FROM THE ELASTIC'S TEMPLATE
//
//  An elastic is warped the same way every time it runs. Recording that
//  once on the product means a warping raised for a job carrying it
//  arrives already programmed, instead of being retyped per job — which
//  is how two runs of one product end up built differently.
//
//  Driven through the real app: the plan the floor gets is the one this
//  route creates, not the one a unit test builds in memory.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
// /warping/create claims the job in a transaction.
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, JobOrder, Elastic, RawMaterial, WarpingPlan, Warping, User, admin;

const adminCookie = () => [
  `token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`,
];

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({
    replSet: { count: 1 },
    instanceOpts: [{ launchTimeout: 60_000 }],
  });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  JobOrder = require('../../models/JobOrder');
  Elastic = require('../../models/Elastic');
  RawMaterial = require('../../models/RawMaterial');
  WarpingPlan = require('../../models/WarpingPlan');
  Warping = require('../../models/Warping');
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

async function yarn(name) {
  return RawMaterial.create({ name, category: 'Yarn', stock: 500, price: 300 });
}

async function makeElastic(name, beams) {
  return Elastic.create({
    name,
    weaveType: '8',
    spandexEnds: 40, yarnEnds: 120, pick: 12, noOfHook: 8, weight: 2.4,
    warpingPlanTemplate: beams ? { noOfBeams: beams.length, beams } : undefined,
  });
}

async function makeJob(elastics) {
  return JobOrder.create({
    date: new Date(),
    order: new mongoose.Types.ObjectId(),
    customer: new mongoose.Types.ObjectId(),
    status: 'preparatory',
    elastics: elastics.map((e) => ({ elastic: e._id, quantity: 1000 })),
  });
}

const createWarping = (job) =>
  request(app).post('/api/v2/warping/create')
    .set('Cookie', adminCookie())
    .send({ jobId: String(job._id) });

describe('raising a warping for a job whose elastic has a template', () => {
  it('arrives already programmed, with the template\'s beams', async () => {
    const y = await yarn('Nylon 70D');
    const e = await makeElastic('20mm', [
      { beamNo: 1, sections: [{ warpYarn: y._id, ends: 120, maxMeters: 5000 }] },
    ]);
    const job = await makeJob([e]);

    const res = await createWarping(job);
    expect(res.status).toBeLessThan(400);

    const plan = await WarpingPlan.findOne({ job: job._id });
    expect(plan).toBeTruthy();
    expect(plan.noOfBeams).toBe(1);
    expect(plan.beams[0].totalEnds).toBe(120);
    expect(String(plan.beams[0].sections[0].warpYarn)).toBe(String(y._id));

    // The warping points at it, so the programme opens on the plan.
    const warping = await Warping.findOne({ job: job._id });
    expect(String(warping.warpingPlan)).toBe(String(plan._id));
  });

  it('takes the beams of EVERY elastic on the job', async () => {
    const y1 = await yarn('Nylon 70D');
    const y2 = await yarn('Poly 150D');
    const a = await makeElastic('20mm', [
      { beamNo: 1, sections: [{ warpYarn: y1._id, ends: 100 }] },
    ]);
    const b = await makeElastic('32mm', [
      { beamNo: 1, sections: [{ warpYarn: y2._id, ends: 60 }] },
      { beamNo: 2, sections: [{ warpYarn: y2._id, ends: 60 }] },
    ]);
    const job = await makeJob([a, b]);

    await createWarping(job);

    const plan = await WarpingPlan.findOne({ job: job._id });
    // Previously only the first elastic was taken and 32mm's two beams
    // were silently missing from the programme.
    expect(plan.beams).toHaveLength(3);
    expect(plan.noOfBeams).toBe(3);
    expect(plan.beams.map((x) => x.beamNo)).toEqual([1, 2, 3]);
    expect(plan.beams.map((x) => String(x.elastic))).toEqual([
      String(a._id), String(b._id), String(b._id),
    ]);
  });

  it('names the products it was built from, so the plan explains itself', async () => {
    const y = await yarn('Nylon 70D');
    const a = await makeElastic('20mm', [{ beamNo: 1, sections: [{ warpYarn: y._id, ends: 100 }] }]);
    const b = await makeElastic('32mm', [{ beamNo: 1, sections: [{ warpYarn: y._id, ends: 60 }] }]);
    const job = await makeJob([a, b]);

    await createWarping(job);

    const plan = await WarpingPlan.findOne({ job: job._id });
    expect(plan.remarks).toMatch(/20mm/);
    expect(plan.remarks).toMatch(/32mm/);
  });

  it('creates no plan when no elastic has a template', async () => {
    // An empty plan is worse than none: it reads as programmed.
    const e = await makeElastic('20mm', null);
    const job = await makeJob([e]);

    await createWarping(job);

    expect(await WarpingPlan.findOne({ job: job._id })).toBeNull();
    const warping = await Warping.findOne({ job: job._id });
    expect(warping.warpingPlan == null).toBe(true);
  });

  it('keeps its own copy — editing the template later leaves the plan alone', async () => {
    const y = await yarn('Nylon 70D');
    const e = await makeElastic('20mm', [
      { beamNo: 1, sections: [{ warpYarn: y._id, ends: 120 }] },
    ]);
    const job = await makeJob([e]);
    await createWarping(job);

    // The product's recipe changes for future runs.
    await Elastic.findByIdAndUpdate(e._id, {
      warpingPlanTemplate: {
        noOfBeams: 1,
        beams: [{ beamNo: 1, sections: [{ warpYarn: y._id, ends: 999 }] }],
      },
    });

    const plan = await WarpingPlan.findOne({ job: job._id });
    // A programme already on the floor must not change under it.
    expect(plan.beams[0].sections[0].ends).toBe(120);
  });
});

// ══════════════════════════════════════════════════════════════════
//  THE SAME BEAMS, FOR A PLAN MADE BY HAND
//
//  /plan-context feeds the plan form. It has to offer the same beams
//  auto-creation would build, or the plan someone types for a job
//  quietly differs from the plan the same job gets on its own — and
//  the difference only shows up on the floor.
// ══════════════════════════════════════════════════════════════════

const planContext = (job) =>
  request(app).get(`/api/v2/warping/plan-context/${job._id}`).set('Cookie', adminCookie());

describe('the plan form is offered the template beams', () => {
  it('offers the same beams auto-creation builds, across every elastic', async () => {
    const y1 = await yarn('Nylon 70D');
    const y2 = await yarn('Poly 150D');
    const a = await makeElastic('20mm', [
      { beamNo: 1, sections: [{ warpYarn: y1._id, ends: 120, maxMeters: 5000 }] },
    ]);
    const b = await makeElastic('32mm', [
      { beamNo: 1, sections: [{ warpYarn: y2._id, ends: 60 }] },
    ]);
    const job = await makeJob([a, b]);

    const { body } = await planContext(job);

    expect(body.templateBeams).toHaveLength(2);
    expect(body.templateBeams.map((x) => x.beamNo)).toEqual([1, 2]);
    expect(body.templateBeams[0]).toMatchObject({
      elasticId: String(a._id), elasticName: '20mm', totalEnds: 120,
    });
    expect(body.templateBeams[0].sections[0]).toMatchObject({
      warpYarnId: String(y1._id), warpYarnName: 'Nylon 70D', ends: 120, maxMeters: 5000,
    });
    expect(body.templateBeams[1]).toMatchObject({
      elasticId: String(b._id), elasticName: '32mm',
    });
  });

  it('offers nothing when no elastic carries a template', async () => {
    const e = await makeElastic('20mm', null);
    const job = await makeJob([e]);

    const { body } = await planContext(job);
    expect(body.templateBeams).toEqual([]);
  });
});

describe('a plan saved from the form keeps the elastic on each beam', () => {
  const createPlan = (warping, beams) =>
    request(app).post('/api/v2/warping/warpingPlan/create')
      .set('Cookie', adminCookie())
      .send({ warpingId: String(warping._id), beams });

  it('stores the elastic when it is one of the job\'s own', async () => {
    const y = await yarn('Nylon 70D');
    // No template, so the warping creates no plan and the form makes one.
    const e = await makeElastic('20mm', null);
    const job = await makeJob([e]);
    await createWarping(job);
    const warping = await Warping.findOne({ job: job._id });

    const res = await createPlan(warping, [
      { beamNo: 1, elastic: String(e._id), sections: [{ warpYarn: String(y._id), ends: 120 }] },
    ]);

    expect(res.status).toBe(201);
    const plan = await WarpingPlan.findOne({ warping: warping._id });
    expect(String(plan.beams[0].elastic)).toBe(String(e._id));
  });

  it('drops an elastic that is not on the job rather than storing the claim', async () => {
    const y = await yarn('Nylon 70D');
    const e = await makeElastic('20mm', null);
    const stranger = await makeElastic('not on this job', null);
    const job = await makeJob([e]);
    await createWarping(job);
    const warping = await Warping.findOne({ job: job._id });

    const res = await createPlan(warping, [
      { beamNo: 1, elastic: String(stranger._id), sections: [{ warpYarn: String(y._id), ends: 120 }] },
    ]);

    expect(res.status).toBe(201);
    const plan = await WarpingPlan.findOne({ warping: warping._id });
    expect(plan.beams[0].elastic).toBeNull();
  });
});
