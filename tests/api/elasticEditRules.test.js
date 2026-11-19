'use strict';
// ══════════════════════════════════════════════════════════════════
//  EDITING AN ELASTIC
//
//  Found reading api/elastic.js line by line.
//
//  1. "Yarn ends" is on the form, the detail page, the compare page, the
//     spec sheet and the operator's own sheet. Creating an elastic kept
//     it; the edit route copies a fixed list of fields and it was not
//     on the list — so an edit answered "saved" and kept the old figure.
//
//  2. A warping template may only use the elastic's own warp yarns, and
//     that was checked only when a template arrived in the request. An
//     edit that took a yarn off the elastic without sending the template
//     left the template on it — and every job's plan is built from that.
//
//  3. Both create and edit ended `catch (err) → 400, err.message`, so a
//     crash or a database error was read out to the screen as though the
//     person had typed something wrong. A duplicate name that slipped
//     past the first check came back as "E11000 duplicate key error
//     collection…".
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, Elastic, admin, nylon, poly, tan;

const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
const put = (body) => request(app).put('/api/v2/elastic/update-elastic').set('Cookie', cookie()).send(body);
const post = (body) => request(app).post('/api/v2/elastic/create-elastic').set('Cookie', cookie()).send(body);

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  const User = require('../../models/User');
  const RawMaterial = require('../../models/RawMaterial');
  const Supplier = require('../../models/Supplier');
  Elastic = require('../../models/Elastic');
  await Elastic.init(); // the unique index on the name is part of what is tested
  admin = await User.create({ name: 'Owner', email: 'o@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  const supplier = await Supplier.create({ name: 'Kumar Yarns', phoneNumber: '9000000001' });
  const yarn = (name) => RawMaterial.create({ name, category: 'warp', stock: 100, price: 300, supplier: supplier._id });
  nylon = await yarn('VHB1108 DENIM BLUE');
  poly = await yarn('WH6134 TAN');
  tan = await yarn('Some other warp');
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(() => jest.restoreAllMocks());

const template = (...yarns) => ({
  noOfBeams: yarns.length,
  beams: yarns.map((y, i) => ({ beamNo: i + 1, totalEnds: 140, sections: [{ warpYarn: y._id, ends: 140, maxMeters: 2250 }] })),
});

const elastic = (over = {}) => Elastic.create({
  name: `POOMI ${new mongoose.Types.ObjectId()}`, weaveType: '8', spandexEnds: 40, yarnEnds: 120, pick: 12,
  noOfHook: 8, weight: 2.4, warpYarn: [{ id: nylon._id, weight: 1 }, { id: poly._id, weight: 1 }], ...over,
});
const stored = (e) => Elastic.findById(e._id).lean();

// ══════════════════════════════════════════════════════════════════
describe('yarn ends', () => {
  it('is saved when it is edited', async () => {
    const e = await elastic();
    const res = await put({ _id: String(e._id), yarnEnds: 96 });
    expect(res.status).toBe(200);
    expect(res.body.elastic.yarnEnds).toBe(96);
    expect((await stored(e)).yarnEnds).toBe(96);
  });

  it('is saved from the whole form, as the web sends it', async () => {
    const e = await elastic();
    const res = await put({
      _id: String(e._id), name: e.name, weaveType: '8', spandexEnds: 40, yarnEnds: 132, pick: 12, noOfHook: 8, weight: 2.4,
      warpYarn: [{ id: String(nylon._id), weight: 1 }, { id: String(poly._id), weight: 1 }],
      testingParameters: { elongation: 120, recovery: 90 },
    });
    expect(res.status).toBe(200);
    expect((await stored(e)).yarnEnds).toBe(132);
  });

  it('is left alone by an edit that does not mention it', async () => {
    const e = await elastic();
    expect((await put({ _id: String(e._id), pick: 14 })).status).toBe(200);
    expect((await stored(e)).yarnEnds).toBe(120);
  });

  it('can be cleared', async () => {
    const e = await elastic();
    expect((await put({ _id: String(e._id), yarnEnds: '' })).status).toBe(200);
    expect((await stored(e)).yarnEnds).toBeUndefined();
  });

  it('takes zero, and refuses what is not a count', async () => {
    const e = await elastic();
    expect((await put({ _id: String(e._id), yarnEnds: 0 })).status).toBe(200);
    expect((await stored(e)).yarnEnds).toBe(0);
    for (const bad of [-1, 'many']) {
      const res = await put({ _id: String(e._id), yarnEnds: bad });
      expect(res.status).toBe(400);
      expect(res.body.message).toBe('Yarn ends must be a number, 0 or more');
    }
    expect((await stored(e)).yarnEnds).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('a template the elastic already has', () => {
  it('stops an edit that takes one of its yarns off the elastic', async () => {
    const e = await elastic({ warpingPlanTemplate: template(nylon, poly) });
    // Only the yarns are sent, as the phone's form does.
    const res = await put({ _id: String(e._id), warpYarn: [{ id: String(nylon._id), weight: 1 }] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('TEMPLATE_YARN_NOT_ON_ELASTIC');
    expect(res.body.message).toMatch(/takes a warp yarn off the elastic that its warping template still uses\. Beam 2 uses "WH6134 TAN"/);
    // Nothing changed.
    const after = await stored(e);
    expect(after.warpYarn.map((w) => String(w.id))).toEqual([String(nylon._id), String(poly._id)]);
    expect(after.warpingPlanTemplate.beams).toHaveLength(2);
  });

  it('does not stand in the way of an edit that keeps its yarns', async () => {
    const e = await elastic({ warpingPlanTemplate: template(nylon, poly) });
    const res = await put({
      _id: String(e._id),
      warpYarn: [{ id: String(nylon._id), weight: 1.2 }, { id: String(poly._id), weight: 1 }, { id: String(tan._id), weight: 0.5 }],
    });
    expect(res.status).toBe(200);
    expect((await stored(e)).warpYarn).toHaveLength(3);
  });

  it('can be cleared in the same edit that drops the yarn', async () => {
    const e = await elastic({ warpingPlanTemplate: template(nylon, poly) });
    const res = await put({ _id: String(e._id), warpYarn: [{ id: String(nylon._id), weight: 1 }], warpingPlanTemplate: null });
    expect(res.status).toBe(200);
    expect((await stored(e)).warpingPlanTemplate?.beams ?? []).toHaveLength(0);
  });

  it('is not looked at by an edit that leaves the yarns alone', async () => {
    const e = await elastic({ warpingPlanTemplate: template(nylon, poly) });
    expect((await put({ _id: String(e._id), pick: 16 })).status).toBe(200);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('when a save fails', () => {
  /**
   * nameClash() looks first; this makes it see nothing, as the loser of
   * a race does. `nth` is which findOne that is: the first on create,
   * the second on an edit (loading the elastic is a findOne too).
   */
  const blindTheNameCheck = (nth = 1) => {
    const real = Elastic.findOne.bind(Elastic);
    let n = 0;
    jest.spyOn(Elastic, 'findOne').mockImplementation((...args) => {
      n += 1;
      return n === nth ? { select: () => ({ lean: () => Promise.resolve(null) }) } : real(...args);
    });
  };

  it('says a name is taken when the index is what caught it — on create', async () => {
    const first = await elastic({ name: 'Newday Romeo Black' });
    blindTheNameCheck();
    const res = await post({ name: 'NEWDAY  ROMEO BLACK', weaveType: '8', spandexEnds: 40, pick: 12, noOfHook: 8, weight: 2.4 });
    expect(res.status).toBe(409);
    expect(res.body.message).toBe('An elastic called "NEWDAY  ROMEO BLACK" already exists.');
    expect(await Elastic.countDocuments({ nameKey: first.nameKey })).toBe(1);
  });

  it('says a name is taken when the index is what caught it — on a rename', async () => {
    await elastic({ name: 'Zenith Grey' });
    const e = await elastic();
    blindTheNameCheck(2);
    const res = await put({ _id: String(e._id), name: 'zenith grey' });
    expect(res.status).toBe(409);
    expect(res.body.message).toBe('An elastic called "zenith grey" already exists.');
  });

  it('still says a missing field in plain words', async () => {
    const res = await post({ name: `No pick ${Date.now()}`, weaveType: '8', spandexEnds: 40, noOfHook: 8, weight: 2.4 });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Pick is required');
  });
});

describe('asCallerError', () => {
  const { asCallerError } = require('../../utils/routeError');
  const ErrorHandler = require('../../utils/ErrorHandler');

  it('keeps what was said on purpose', () => {
    const said = new ErrorHandler('Completed warping cannot be cancelled', 409);
    expect(asCallerError(said)).toBe(said);
    const withStatus = Object.assign(new Error('nope'), { statusCode: 404 });
    expect(asCallerError(withStatus)).toBe(withStatus);
  });

  it("makes a rule stated as a plain Error the caller's to fix, in its own words", () => {
    const out = asCallerError(new Error('Nylon 70D has no price'));
    expect(out).toBeInstanceOf(ErrorHandler);
    expect(out).toMatchObject({ statusCode: 400, message: 'Nylon 70D has no price' });
  });

  it('passes a crash on untouched, so it is answered with a reference and not read out', () => {
    for (const fault of [new TypeError("Cannot read properties of undefined (reading 'gstin')"),
      Object.assign(new Error('connect ECONNREFUSED 10.0.1.5:27017'), { code: 'ECONNREFUSED', syscall: 'connect' }),
      Object.assign(new Error('pool destroyed'), { name: 'MongoPoolClosedError' })]) {
      expect(asCallerError(fault)).toBe(fault);
    }
  });

  it('passes on what the central handler already has words for', () => {
    for (const known of [Object.assign(new Error('x'), { name: 'ValidationError', errors: {} }),
      Object.assign(new Error('x'), { name: 'CastError', path: '_id' }),
      Object.assign(new Error('x'), { name: 'VersionError' }),
      Object.assign(new Error('E11000 duplicate key'), { code: 11000, keyValue: { nameKey: 'a' } })]) {
      expect(asCallerError(known)).toBe(known);
    }
  });
});
