'use strict';
// ══════════════════════════════════════════════════════════════════
//  A DELETE THAT COULD NEVER SAY IT DELETED NOTHING
//
//  Removing a beam entry pulled it out and then checked whether it was
//  still there:
//
//      const updated = await Covering.findOneAndUpdate(
//        { _id }, { $pull: { beamEntries: { _id: entryId } } },
//        { new: true, session });
//      const stillHasEntry = updated.beamEntries.find(...);
//      if (stillHasEntry) throw new ErrorHandler("Beam entry not found", 404);
//
//  `{ new: true }` is the document AFTER the pull. If the entry was
//  there it has just been removed; if it was never there it is equally
//  absent. Either way the find returns nothing, so `stillHasEntry` is
//  always falsy and the 404 is unreachable — deleting an entry that did
//  not exist answered 200, with a recomputed producedWeight, exactly as
//  though something had happened.
//
//  Which is the shape that matters: the caller cannot tell a delete that
//  worked from one that had nothing to work on.
//
//  ── And the sum that quietly absorbs a duplicate ─────────────────
//  producedWeight is the sum of the entries. Logging the same beam
//  twice adds its weight twice, and because the result is a single
//  number there is nothing left to compare it against — the duplicate
//  disappears into the total the moment it lands.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app;
let Covering, JobOrder, Order, Elastic, Customer, User, admin;
let customer, elastic;

const cookie = () => [
  `token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`,
];

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app      = require('../../app.js');
  Covering = require('../../models/Covering');
  JobOrder = require('../../models/JobOrder');
  Order    = require('../../models/Order');
  Elastic  = require('../../models/Elastic');
  Customer = require('../../models/Customer');
  User     = require('../../models/User');
  admin = await User.create({
    name: 'Owner', email: 'cov@t.co', password: 'pass1234',
    role: 'admin', department: 'admin',
  });
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

let seq = 0;
beforeEach(async () => {
  customer = await Customer.create({
    name: 'Acme', contactName: 'R', phoneNumber: '9000000001',
  });
  elastic = await Elastic.create({
    name: `20mm-${seq++}`, weaveType: '8', spandexEnds: 40,
    yarnEnds: 120, pick: 12, noOfHook: 8, weight: 2.4,
  });
});

afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
});

async function seed({ status = 'in_progress' } = {}) {
  const order = await Order.create({
    customer: customer._id, po: 'PO-1',
    date: new Date(), supplyDate: new Date(), status: 'InProgress',
    elasticOrdered: [{ elastic: elastic._id, quantity: 1000, rate: 10 }],
  });
  const job = await JobOrder.create({
    order: order._id, customer: customer._id, date: new Date(),
    status: 'preparatory',
    elastics: [{ elastic: elastic._id, quantity: 1000 }],
  });
  const covering = await Covering.create({
    date: new Date(), job: job._id, status,
    elasticPlanned: [{ elastic: elastic._id, quantity: 1000 }],
  });
  await JobOrder.updateOne({ _id: job._id }, { $set: { covering: covering._id } });
  return { order, job, covering };
}

const addBeam = (id, body) =>
  request(app).post('/api/v2/covering/beam-entry')
    .set('Cookie', cookie()).send({ id, ...body });

const dropBeam = (coveringId, entryId) =>
  request(app).delete(
    `/api/v2/covering/beam-entry?coveringId=${coveringId}&entryId=${entryId}`
  ).set('Cookie', cookie());

const weightOf = async (id) =>
  (await Covering.findById(id).lean()).producedWeight;

// ══════════════════════════════════════════════════════════════════
describe('deleting a beam entry', () => {
  it('removes it and drops the total', async () => {
    const { covering } = await seed();
    await addBeam(covering._id, { beamNo: 1, weight: 40 });
    await addBeam(covering._id, { beamNo: 2, weight: 35 });
    expect(await weightOf(covering._id)).toBeCloseTo(75);

    const fresh = await Covering.findById(covering._id).lean();
    const first = fresh.beamEntries[0]._id;

    expect((await dropBeam(covering._id, first)).status).toBe(200);
    expect(await weightOf(covering._id)).toBeCloseTo(35);
  });

  it('says so when the entry is not there', async () => {
    // The route's own 404 was unreachable: it looked for the entry in
    // the POST-pull array, where it is absent whether it was removed or
    // never existed. So a delete of nothing reported success.
    const { covering } = await seed();
    await addBeam(covering._id, { beamNo: 1, weight: 40 });

    const ghost = new mongoose.Types.ObjectId();
    const res = await dropBeam(covering._id, ghost);

    expect(res.status).toBe(404);
    expect(res.body.message).toMatch(/not found/i);
  });

  it('leaves the total alone when it finds nothing to delete', async () => {
    // The old route recomputed and saved regardless, so a no-op delete
    // still wrote to the document — a change with no cause.
    const { covering } = await seed();
    await addBeam(covering._id, { beamNo: 1, weight: 40 });

    await dropBeam(covering._id, new mongoose.Types.ObjectId());

    expect(await weightOf(covering._id)).toBeCloseTo(40);
    const fresh = await Covering.findById(covering._id).lean();
    expect(fresh.beamEntries).toHaveLength(1);
  });

  it('answers 400 rather than 500 for a malformed id', async () => {
    const { covering } = await seed();
    expect((await dropBeam(covering._id, 'not-an-id')).status).toBe(400);
  });
});

describe('recording a beam weight', () => {
  it('refuses the same beam twice', async () => {
    // producedWeight is a sum, so a duplicate is indistinguishable from
    // a second real beam the moment it is added.
    const { covering } = await seed();
    expect((await addBeam(covering._id, { beamNo: 3, weight: 42 })).status).toBe(201);

    const res = await addBeam(covering._id, { beamNo: 3, weight: 39 });
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/already recorded/i);
    expect(await weightOf(covering._id)).toBeCloseTo(42);
  });

  it('allows the beam again once the first entry is deleted', async () => {
    // Correcting a weight has to remain possible — the refusal is about
    // two live entries, not about the number ever being reused.
    const { covering } = await seed();
    await addBeam(covering._id, { beamNo: 3, weight: 42 });
    const fresh = await Covering.findById(covering._id).lean();
    await dropBeam(covering._id, fresh.beamEntries[0]._id);

    expect((await addBeam(covering._id, { beamNo: 3, weight: 39 })).status).toBe(201);
    expect(await weightOf(covering._id)).toBeCloseTo(39);
  });

  it('refuses a beam number that is not a number', async () => {
    // It reached the model as NaN and came back as a cast error — a 500
    // for a mistyped field.
    const { covering } = await seed();
    const res = await addBeam(covering._id, { beamNo: 'three', weight: 40 });
    expect(res.status).toBe(400);
  });

  it('refuses a fractional beam number', async () => {
    const { covering } = await seed();
    expect((await addBeam(covering._id, { beamNo: 2.5, weight: 40 })).status).toBe(400);
  });

  it('refuses a weight no beam could have', async () => {
    // The same idea as the metre cap on a packing record: the figure is
    // keyed by hand at a scale, and there is no second number anywhere
    // for a slipped decimal to disagree with.
    const { covering } = await seed();
    const res = await addBeam(covering._id, { beamNo: 1, weight: 999_999 });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/exceeds/i);
  });

  it('still takes an ordinary beam', async () => {
    const { covering } = await seed();
    expect((await addBeam(covering._id, { beamNo: 1, weight: 47.5 })).status).toBe(201);
    expect(await weightOf(covering._id)).toBeCloseTo(47.5);
  });
});

describe('cancelling a covering', () => {
  const cancel = (id, body = {}) =>
    request(app).post('/api/v2/covering/cancel')
      .set('Cookie', cookie()).send({ id, ...body });

  it('records why on the job timeline', async () => {
    // Start, complete and every beam entry write to the job's trail.
    // The transition that STOPS the job reaching weaving — the one
    // somebody comes asking about — wrote nothing at all.
    const { job, covering } = await seed();
    expect((await cancel(covering._id, { remarks: 'yarn short' })).status).toBe(200);

    const fresh = await JobOrder.findById(job._id).lean();
    const fp = fresh.fingerprints.find((f) => f.code === 'COVERING_CANCELLED');
    expect(fp).toBeDefined();
    expect(fp.meta.remarks).toBe('yarn short');
  });

  it('still refuses to cancel a completed covering', async () => {
    const { covering } = await seed({ status: 'completed' });
    expect((await cancel(covering._id)).status).toBe(400);
  });

  it('refuses a second cancellation', async () => {
    // It used to succeed and stamp nothing, so the trail showed one
    // cancellation for any number of clicks.
    const { covering } = await seed();
    await cancel(covering._id);
    expect((await cancel(covering._id)).status).toBe(400);
  });
});

describe('listing coverings', () => {
  it('survives page 0', async () => {
    // (page - 1) * limit is a negative skip, which Mongo rejects
    // outright — a 500 from a paginator's opening request.
    const res = await request(app).get('/api/v2/covering/list?page=0&status=all')
      .set('Cookie', cookie());
    expect(res.status).toBe(200);
    expect(res.body.pagination.page).toBe(1);
  });

  it('still rejects a status that is not one', async () => {
    const res = await request(app).get('/api/v2/covering/list?status=nonsense')
      .set('Cookie', cookie());
    expect(res.status).toBe(400);
  });
});

// ══════════════════════════════════════════════════════════════════
//  Found reading api/covering.js line by line.
// ══════════════════════════════════════════════════════════════════
describe('the covered weight of a job', () => {
  it('is the sum of its beams to the gram, through adding and removing', async () => {
    const { covering } = await seed();
    // 41.7 + 38.4 + 42.3 is 122.39999999999999, and it was stored like that.
    let last;
    for (const [beamNo, weight] of [[1, 41.7], [2, 38.4], [3, 42.3]]) {
      last = await addBeam(covering._id, { beamNo, weight });
      expect(last.status).toBe(201);
    }
    expect(last.body.producedWeight).toBe(122.4);
    expect(await weightOf(covering._id)).toBe(122.4);

    // Without the first: 38.4 + 42.3 is 80.69999999999999.
    const fresh = await Covering.findById(covering._id).lean();
    expect((await dropBeam(covering._id, fresh.beamEntries[0]._id)).body.producedWeight).toBe(80.7);
    expect(await weightOf(covering._id)).toBe(80.7);
  });

  it('keeps a beam\'s weight to the gram, as a sheet of them is kept', async () => {
    const { covering } = await seed();
    const res = await addBeam(covering._id, { beamNo: 1, weight: 41.23456 });
    expect(res.status).toBe(201);
    expect(res.body.beamEntry.weight).toBe(41.235);
    expect(await weightOf(covering._id)).toBe(41.235);
  });
});

describe('removing a beam entry', () => {
  it('is recorded on the job: which beam, at what weight, and what the total became', async () => {
    const { covering, job } = await seed();
    await addBeam(covering._id, { beamNo: 1, weight: 40 });
    await addBeam(covering._id, { beamNo: 2, weight: 35 });
    const fresh = await Covering.findById(covering._id).lean();

    expect((await dropBeam(covering._id, fresh.beamEntries[0]._id)).status).toBe(200);

    // Before: nothing. Adding a beam was on the trail; taking one off was not,
    // and correcting a weight is done by removing the entry and adding it again.
    const trail = (await JobOrder.findById(job._id).lean()).fingerprints;
    const removed = trail.filter((f) => f.code === 'COVERING_BEAM_REMOVED');
    expect(removed).toHaveLength(1);
    expect(removed[0].meta).toMatchObject({
      coveringId: String(covering._id), beamNo: 1, weight: 40, unit: 'kg', producedWeight: 35, totalBeams: 1,
    });
    expect(removed[0].actor).toMatchObject({ name: 'Owner' });
  });

  it('records nothing when there was nothing to remove', async () => {
    const { covering, job } = await seed();
    expect((await dropBeam(covering._id, new mongoose.Types.ObjectId())).status).toBe(404);
    expect((await JobOrder.findById(job._id).lean()).fingerprints.filter((f) => f.code === 'COVERING_BEAM_REMOVED')).toEqual([]);
  });
});

describe('a note or a remark that is not text', () => {
  it('is taken as what was typed, not answered with a server error', async () => {
    const { covering } = await seed();
    // Before: 500 — "note.trim is not a function".
    const beam = await addBeam(covering._id, { beamNo: 1, weight: 40, note: 7 });
    expect(beam.status).toBe(201);
    expect(beam.body.beamEntry.note).toBe('7');

    const done = await request(app).post('/api/v2/covering/complete').set('Cookie', cookie())
      .send({ id: String(covering._id), remarks: 12 });
    expect(done.status).toBe(200);
    expect((await Covering.findById(covering._id).lean()).remarks).toBe('12');
  });
});

describe('searching the covering and warping lists', () => {
  const list = (what, search) =>
    request(app).get(`/api/v2/${what}/list?status=all&search=${encodeURIComponent(search)}`).set('Cookie', cookie());

  it('is by job number: that job\'s, and for text that is no number, none', async () => {
    const Warping = require('../../models/Warping');
    const a = await seed();
    const b = await seed();
    for (const s of [a, b]) {
      await Warping.create({ date: new Date(), job: s.job._id, status: 'open', elasticOrdered: [{ elastic: elastic._id, quantity: 1000 }] });
    }
    const number = (await JobOrder.findById(a.job._id).lean()).jobOrderNo;

    for (const what of ['covering', 'warping']) {
      const all = await list(what, '');
      expect(all.body.data).toHaveLength(2);

      const one = await list(what, String(number));
      expect(one.body.data.map((r) => String(r.job._id))).toEqual([String(a.job._id)]);

      // Before: both, as though "acme" had matched them.
      const none = await list(what, 'acme');
      expect(none.status).toBe(200);
      expect(none.body.data).toEqual([]);
      expect(none.body.pagination.total).toBe(0);

      // "12abc" is not job 12.
      expect((await list(what, `${number}abc`)).body.data).toEqual([]);
    }
  });
});
