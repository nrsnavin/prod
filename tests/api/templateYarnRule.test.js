'use strict';
// ══════════════════════════════════════════════════════════════════
//  A WARPING TEMPLATE USES THE ELASTIC'S OWN WARP YARNS
//
//  The warp yarn list is what the elastic is costed and issued on. A
//  template beam on any other yarn builds a different product, so every
//  door that writes a template refuses one: the template route, an
//  elastic edit, and creating an elastic.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, admin, Elastic, nylon, poly, tan;
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
const put = (url, body) => request(app).put(url).set('Cookie', cookie()).send(body);
const post = (url, body) => request(app).post(url).set('Cookie', cookie()).send(body);

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  const User = require('../../models/User');
  const RawMaterial = require('../../models/RawMaterial');
  const Supplier = require('../../models/Supplier');
  Elastic = require('../../models/Elastic');
  admin = await User.create({ name: 'Owner', email: 'o@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  const supplier = await Supplier.create({ name: 'Kumar Yarns', phoneNumber: '9000000001' });
  const yarn = (name) => RawMaterial.create({ name, category: 'warp', stock: 100, price: 300, supplier: supplier._id });
  nylon = await yarn('VHB1108 DENIM BLUE');
  poly = await yarn('WH6134 TAN');
  tan = await yarn('Some other warp');
}, 120_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

const template = (...yarns) => ({
  beams: yarns.map((y, i) => ({ beamNo: i + 1, sections: [{ warpYarn: String(y._id), ends: 140, maxMeters: 2250 }] })),
});

async function elastic() {
  return Elastic.create({
    name: `POOMI ${new mongoose.Types.ObjectId()}`, weaveType: '8', spandexEnds: 40, yarnEnds: 120, pick: 12,
    noOfHook: 8, weight: 2.4, warpYarn: [{ id: nylon._id, weight: 1 }, { id: poly._id, weight: 1 }],
  });
}

describe('the template route', () => {
  it("takes the elastic's own warp yarns", async () => {
    const e = await elastic();
    const res = await put('/api/v2/elastic/warping-plan-template', { elasticId: String(e._id), template: template(nylon, poly) });
    expect(res.status).toBe(200);
    expect((await Elastic.findById(e._id).lean()).warpingPlanTemplate.beams).toHaveLength(2);
  });

  it('refuses any other yarn, naming it, and changes nothing', async () => {
    const e = await elastic();
    const res = await put('/api/v2/elastic/warping-plan-template', { elasticId: String(e._id), template: template(nylon, tan) });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Beam 2 uses "Some other warp", which is not one of this elastic's warp yarns/);
    expect((await Elastic.findById(e._id).lean()).warpingPlanTemplate?.beams ?? []).toHaveLength(0);
  });

  it('still clears a template', async () => {
    const e = await elastic();
    await put('/api/v2/elastic/warping-plan-template', { elasticId: String(e._id), template: template(nylon) });
    const res = await put('/api/v2/elastic/warping-plan-template', { elasticId: String(e._id), template: null });
    expect(res.status).toBe(200);
  });
});

describe('editing and creating an elastic', () => {
  it('checks against the warp yarns as edited in the same save', async () => {
    const e = await elastic();
    // Adds the yarn and uses it in the template at once: fine.
    const ok = await put('/api/v2/elastic/update-elastic', {
      _id: String(e._id),
      warpYarn: [{ id: String(nylon._id), weight: 1 }, { id: String(tan._id), weight: 1 }],
      warpingPlanTemplate: template(tan),
    });
    expect(ok.status).toBe(200);
    // Uses a yarn this save takes off the list: refused.
    const bad = await put('/api/v2/elastic/update-elastic', {
      _id: String(e._id),
      warpYarn: [{ id: String(nylon._id), weight: 1 }],
      warpingPlanTemplate: template(tan),
    });
    expect(bad.status).toBe(400);
  });

  it('refuses a new elastic whose template uses a yarn it does not list', async () => {
    const res = await post('/api/v2/elastic/create-elastic', {
      name: 'POOMI NEW', weaveType: '8', spandexEnds: 40, yarnEnds: 120, pick: 12, noOfHook: 8, weight: 2.4,
      warpYarn: [{ id: String(nylon._id), weight: 1 }],
      warpingPlanTemplate: template(poly),
    });
    expect(res.status).toBe(400);
    expect(await Elastic.exists({ name: 'POOMI NEW' })).toBeNull();
  });
});
