'use strict';
// ══════════════════════════════════════════════════════════════════
//  PACKING RECORDS THAT RAISE STOCK AND COUNT FOR NOTHING
//
//  Recording a packing does four things at once: it writes a Packing
//  row, adds the metres to the JOB's packed figure, mirrors that onto
//  the ORDER, and raises the elastic's stock. Three of the four always
//  happened. The second was guarded:
//
//      const idx = jobDoc.packedElastic.findIndex(...)
//      if (idx >= 0) jobDoc.packedElastic[idx].quantity += meter
//
//  — with no else. `packedElastic` is seeded from the job's own
//  elastics, so when the row was missing the metres simply went
//  nowhere. Stock went up. The audit trail said N metres were packed.
//  The job said none were, and the order, which is recomputed FROM the
//  job, agreed with the job.
//
//  Nothing errored, and the only trace was the trail contradicting the
//  numbers — on two screens nobody reads side by side.
//
//  There are two ways to reach that state, and they want different
//  answers. An elastic the job is not making should never have been
//  accepted at all; an elastic the job IS making, whose row is absent
//  for any other reason, should be recorded.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app;
let Packing, JobOrder, Order, Elastic, Customer, Employee, User, admin;
let customer, elastic, other, checker;

const cookie = () => [
  `token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`,
];

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app      = require('../../app.js');
  Packing  = require('../../models/Packing');
  JobOrder = require('../../models/JobOrder');
  Order    = require('../../models/Order');
  Elastic  = require('../../models/Elastic');
  Customer = require('../../models/Customer');
  Employee = require('../../models/Employee');
  User     = require('../../models/User');
  admin = await User.create({
    name: 'Packer', email: 'pack@t.co', password: 'pass1234',
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
    yarnEnds: 120, pick: 12, noOfHook: 8, weight: 2.4, stock: 0,
  });
  other = await Elastic.create({
    name: `32mm-${seq++}`, weaveType: '8', spandexEnds: 40,
    yarnEnds: 120, pick: 12, noOfHook: 8, weight: 3.1, stock: 0,
  });
  checker = await Employee.create({
    name: 'Ravi', phoneNumber: '9000000002', department: 'checking',
  });
});

afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
});

/** An order with one job on it, mid-production, nothing packed yet. */
async function seed({ jobStatus = 'packing', packedRows = true } = {}) {
  const order = await Order.create({
    customer: customer._id, po: 'PO-1',
    date: new Date(), supplyDate: new Date(), status: 'InProgress',
    elasticOrdered:  [{ elastic: elastic._id, quantity: 1000, rate: 10 }],
    producedElastic: [{ elastic: elastic._id, quantity: 0 }],
    packedElastic:   [{ elastic: elastic._id, quantity: 0 }],
  });
  const job = await JobOrder.create({
    order: order._id, customer: customer._id, date: new Date(),
    status: jobStatus,
    elastics:        [{ elastic: elastic._id, quantity: 1000 }],
    producedElastic: [{ elastic: elastic._id, quantity: 1000 }],
    packedElastic:   packedRows ? [{ elastic: elastic._id, quantity: 0 }] : [],
  });
  return { order, job };
}

const box = (over = {}) => ({
  meter: 100, joints: 0,
  tareWeight: 2, netWeight: 24, grossWeight: 26,
  checkedBy: checker._id, packedBy: checker._id,
  ...over,
});

const pack = (body) =>
  request(app).post('/api/v2/packing/create-packing')
    .set('Cookie', cookie()).send(body);

const packedOnJob = async (jobId, elasticId) => {
  const j = await JobOrder.findById(jobId).lean();
  const row = (j.packedElastic || []).find(
    (e) => e.elastic.toString() === elasticId.toString()
  );
  return row ? row.quantity : null;
};

const packedOnOrder = async (orderId, elasticId) => {
  const o = await Order.findById(orderId).lean();
  const row = (o.packedElastic || []).find(
    (e) => e.elastic.toString() === elasticId.toString()
  );
  return row ? row.quantity : null;
};

const stockOf = async (id) => (await Elastic.findById(id).lean()).stock;

// ══════════════════════════════════════════════════════════════════
describe('recording a packing', () => {
  it('reaches the job, the order and the stock together', async () => {
    const { order, job } = await seed();
    const res = await pack({ job: job._id, elastic: elastic._id, ...box() });

    expect(res.status).toBe(201);
    expect(await packedOnJob(job._id, elastic._id)).toBe(100);
    expect(await packedOnOrder(order._id, elastic._id)).toBe(100);
    expect(await stockOf(elastic._id)).toBe(100);
  });

  it('records the metres even when the job carries no row for the elastic yet', async () => {
    // The row is normally seeded at job creation. When it is not there,
    // the metres were dropped — silently, while stock still rose. The
    // elastic IS on the job, so the figure has somewhere to belong: the
    // row is created rather than the number discarded.
    const { order, job } = await seed({ packedRows: false });
    const res = await pack({ job: job._id, elastic: elastic._id, ...box() });

    expect(res.status).toBe(201);
    expect(await packedOnJob(job._id, elastic._id)).toBe(100);
    expect(await packedOnOrder(order._id, elastic._id)).toBe(100);
  });

  it('never lets the trail claim metres the job denies', async () => {
    // The failure this whole file is about, stated as the invariant it
    // breaks: a PACKING_CREATED fingerprint and a packed figure of zero
    // cannot both be true.
    const { job } = await seed({ packedRows: false });
    await pack({ job: job._id, elastic: elastic._id, ...box() });

    const fresh = await JobOrder.findById(job._id).lean();
    const claimed = fresh.fingerprints
      .filter((f) => f.code === 'PACKING_CREATED')
      .reduce((s, f) => s + (f.meta?.meter || 0), 0);

    expect(await packedOnJob(job._id, elastic._id)).toBe(claimed);
  });
});

describe('an elastic the job is not making', () => {
  it('is refused', async () => {
    const { job } = await seed();
    const res = await pack({ job: job._id, elastic: other._id, ...box() });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/not on job/i);
  });

  it('does not raise its stock on the way to being refused', async () => {
    // The old route wrote the Packing row, raised stock and stamped the
    // job — and only then hit the guard that recorded nothing. The
    // refusal has to happen before any of that, not around it.
    const { job } = await seed();
    await pack({ job: job._id, elastic: other._id, ...box() });

    expect(await stockOf(other._id)).toBe(0);
    expect(await Packing.countDocuments()).toBe(0);
  });
});

describe('a job that is finished or abandoned', () => {
  it('takes no more packing when completed', async () => {
    const { job } = await seed({ jobStatus: 'completed' });
    const res = await pack({ job: job._id, elastic: elastic._id, ...box() });

    expect(res.status).toBe(409);
    expect(await stockOf(elastic._id)).toBe(0);
  });

  it('takes no more packing when cancelled', async () => {
    const { job } = await seed({ jobStatus: 'cancelled' });
    expect((await pack({ job: job._id, elastic: elastic._id, ...box() })).status)
      .toBe(409);
  });
});

describe('the weights on a box', () => {
  it('refuses a negative net weight', async () => {
    // `!weight || isNaN(weight)` passed every negative number — the one
    // wrong figure a scale actually produces.
    const { job } = await seed();
    const res = await pack({
      job: job._id, elastic: elastic._id, ...box({ netWeight: -24 }),
    });
    expect(res.status).toBe(400);
  });

  it('refuses a negative tare weight', async () => {
    const { job } = await seed();
    expect((await pack({
      job: job._id, elastic: elastic._id, ...box({ tareWeight: -2 }),
    })).status).toBe(400);
  });

  it('refuses a gross lighter than the net', async () => {
    // Gross is net plus the packaging. Smaller than net is not a box.
    const { job } = await seed();
    const res = await pack({
      job: job._id, elastic: elastic._id, ...box({ netWeight: 24, grossWeight: 20 }),
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/gross/i);
  });

  it('refuses negative joints', async () => {
    const { job } = await seed();
    expect((await pack({
      job: job._id, elastic: elastic._id, ...box({ joints: -3 }),
    })).status).toBe(400);
  });

  it('still accepts an ordinary box', async () => {
    const { job } = await seed();
    expect((await pack({
      job: job._id, elastic: elastic._id,
      ...box({ tareWeight: 2, netWeight: 24, grossWeight: 26 }),
    })).status).toBe(201);
  });
});

describe('correcting a packing', () => {
  const edit = (id, body) =>
    request(app).put(`/api/v2/packing/${id}`)
      .set('Cookie', cookie()).send(body);

  it('applies the same ceiling the create path applies', async () => {
    // 50,000 m is refused on the way in. Editing a record to exactly
    // that figure was not checked at all, so the cap was on one door of
    // two — and the door left open is the one that reaches the same
    // stock ledger.
    const { job } = await seed();
    const created = await pack({ job: job._id, elastic: elastic._id, ...box() });

    const res = await edit(created.body.packing._id, {
      meter: 999_999, auditReason: 'typo',
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/exceeds/i);
  });

  it('carries a correction through to the order', async () => {
    const { order, job } = await seed();
    const created = await pack({ job: job._id, elastic: elastic._id, ...box() });

    await edit(created.body.packing._id, { meter: 250, auditReason: 'recount' });

    expect(await packedOnJob(job._id, elastic._id)).toBe(250);
    expect(await packedOnOrder(order._id, elastic._id)).toBe(250);
  });
});

describe('deleting a packing', () => {
  const remove = (id) =>
    request(app).delete(`/api/v2/packing/${id}`)
      .set('Cookie', cookie()).send({ auditReason: 'wrong job' });

  it('takes the metres back off the job and the order', async () => {
    const { order, job } = await seed();
    const created = await pack({ job: job._id, elastic: elastic._id, ...box() });

    expect((await remove(created.body.packing._id)).status).toBe(200);
    expect(await packedOnJob(job._id, elastic._id)).toBe(0);
    expect(await packedOnOrder(order._id, elastic._id)).toBe(0);
  });

  it('floors the job figure at zero instead of leaving it alone', async () => {
    // The guard was `quantity >= packing.meter` — so when the stored
    // figure was SMALLER than the record being reversed, the subtraction
    // was skipped entirely and the whole amount stayed behind. Clamping
    // to zero is wrong by less; skipping is wrong by everything.
    const { job } = await seed();
    const created = await pack({ job: job._id, elastic: elastic._id, ...box() });

    // Something else corrected the job's figure downwards in between.
    await JobOrder.updateOne(
      { _id: job._id, 'packedElastic.elastic': elastic._id },
      { $set: { 'packedElastic.$.quantity': 40 } }
    );

    await remove(created.body.packing._id);

    expect(await packedOnJob(job._id, elastic._id)).toBe(0);
  });
});

describe('the jobs offered for packing', () => {
  it('includes jobs already at the packing stage', async () => {
    // The list ran weaving → finishing → checking and stopped one short
    // of the stage the screen is named after: moving a job to `packing`
    // made it disappear from the packing screen.
    const { job } = await seed({ jobStatus: 'packing' });

    const res = await request(app).get('/api/v2/packing/jobs-packing')
      .set('Cookie', cookie());

    expect(res.status).toBe(200);
    expect(res.body.jobs.map((j) => String(j._id))).toContain(String(job._id));
  });

  it('leaves out jobs that are finished', async () => {
    await seed({ jobStatus: 'completed' });
    const res = await request(app).get('/api/v2/packing/jobs-packing')
      .set('Cookie', cookie());
    expect(res.body.jobs).toHaveLength(0);
  });
});

describe('listing packings', () => {
  it('survives a nonsense page size', async () => {
    // `Number("abc")` is NaN and a negative skip is a Mongo error, so an
    // unchecked query string turned a listing into a 500.
    const res = await request(app).get('/api/v2/packing/all?limit=abc&skip=-5')
      .set('Cookie', cookie());
    expect(res.status).toBe(200);
  });
});
