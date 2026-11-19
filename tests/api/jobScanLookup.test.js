'use strict';
// ══════════════════════════════════════════════════════════════════
//  RESOLVING A SCANNED LABEL TO A JOB
//
//  Three of the four labels the mill prints name their job by NUMBER
//  and not by id — a covering beam carries `COVB|J:1042|…`, a warping
//  beam `WARP|J:1042|…`, and a packing box `BOX|<id>|J:1042`. The
//  phone can open a job screen from an id on its own; from a number
//  it has to ask. That is what /job/by-number is for.
//
//  ── And the shadowing this file also pins ──────────────────────
//  api/job.js registers `GET /:jobId` at line ~1540 and then
//  `GET /stale` and `GET /wastage-outliers` several hundred lines
//  LATER. Express matches in registration order, so both of those
//  were being caught by `/:jobId`, which rejects anything that is not
//  24 hex characters with a 400. They have never run.
//
//  Nothing complained because the only caller — the mobile AI
//  advisor, ai_advisor.dart:229 and :233 — wraps every probe in a
//  `_safe(...)` that swallows failures. So the advisor has silently
//  had no stale-job and no wastage-outlier data at all, and reported
//  that as "no stale jobs" rather than as an error.
//
//  These run the two routes for real. A 400 here means the ordering
//  regressed and they are dead again.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app;
let Order, Customer, Elastic, JobOrder, User, admin;

const adminCookie = () => [
  `token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`,
];

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  Order    = require('../../models/Order');
  Customer = require('../../models/Customer');
  Elastic  = require('../../models/Elastic');
  JobOrder = require('../../models/JobOrder');
  User     = require('../../models/User');
  admin = await User.create({
    name: 'Owner', email: 'jobscan@t.co', password: 'pass1234',
    role: 'admin', department: 'admin',
  });
}, 120_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
});

let seq = 0;

const makeCustomer = () =>
  Customer.create({
    name: `Acme ${++seq}`, contactName: 'R. Nair', phoneNumber: '9000000001',
    gstin: '33AABCA1234A1Z5',
  });

const makeOrder = (customer) =>
  Order.create({
    customer: customer._id, status: 'Open', po: `PO-${++seq}`,
    date: new Date(), supplyDate: new Date(),
    elasticOrdered: [], rawMaterialRequired: [],
  });

// `jobOrderNo` is `immutable: true` and assigned by the AutoIncrement
// plugin (models/JobOrder.js:38, :149), so passing one to create() is
// silently ignored — the first draft of this file did exactly that and
// every lookup 404'd against a job that existed under a different
// number. Tests read the number back instead of choosing it.
const makeJob = (order, customer, over = {}) =>
  JobOrder.create({
    date: new Date(), order: order._id, customer: customer._id,
    status: 'weaving', elastics: [], packedElastic: [], ...over,
  });

// Force a second job onto an existing number. `immutable` blocks this
// through the model, which is the point — a duplicate can only arrive
// by going round Mongoose, which is precisely the "data has been
// through surgery" case the route refuses to guess about.
const forceJobNo = (job, n) =>
  mongoose.connection
    .collection('joborders')
    .updateOne({ _id: job._id }, { $set: { jobOrderNo: n } });

const byNumber = (n) =>
  request(app).get(`/api/v2/job/by-number/${n}`).set('Cookie', adminCookie());

// ══════════════════════════════════════════════════════════════════
describe('GET /job/by-number/:jobNo', () => {
  it('gives the id of the job with that number', async () => {
    const c = await makeCustomer();
    const o = await makeOrder(c);
    const job = await makeJob(o, c);

    const res = await byNumber(job.jobOrderNo);

    expect(res.status).toBe(200);
    expect(res.body.job.id).toBe(String(job._id));
    expect(res.body.job.jobOrderNo).toBe(job.jobOrderNo);
  });

  it('carries enough to label the screen before it loads', async () => {
    // The phone pushes the job screen as soon as this returns. Without
    // a number and a status to show, the screen is blank until the
    // detail fetch lands, which on mill wifi reads as a hang.
    const c = await makeCustomer();
    const o = await makeOrder(c);
    const job = await makeJob(o, c, { status: 'packing' });

    const res = await byNumber(job.jobOrderNo);

    expect(res.body.job.status).toBe('packing');
    expect(res.body.job.customerName).toBe(c.name);
  });

  it('says the number is unknown rather than returning nothing', async () => {
    const res = await byNumber(999999);

    expect(res.status).toBe(404);
    expect(res.body.message).toMatch(/999999/);
  });

  it('refuses a number that is not one', async () => {
    const res = await byNumber('abc');

    expect(res.status).toBe(400);
  });

  it('refuses zero', async () => {
    // Guards the `?? 0` an unlinked label would produce if anything
    // ever coerced the em-dash the web prints for a missing job.
    expect((await byNumber(0)).status).toBe(400);
  });

  it('asks rather than guessing when a number is duplicated', async () => {
    // jobOrderNo comes from an auto-increment counter, so two jobs
    // sharing one means the data has been through surgery. Opening
    // either would show a real screen for the wrong job — worse than
    // opening none.
    //
    // The database now refuses a second job with the same number (a
    // unique index), so this is data from before it existed: the index
    // is set aside to make it, and rebuilt after.
    const c = await makeCustomer();
    const o = await makeOrder(c);
    const first  = await makeJob(o, c);
    const second = await makeJob(o, c);
    await JobOrder.collection.dropIndex('job_jobOrderNo_unique').catch(() => {});
    try {
      await forceJobNo(second, first.jobOrderNo);

      const res = await byNumber(first.jobOrderNo);

      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/more than one/i);
    } finally {
      await JobOrder.deleteMany({ _id: second._id });
      await JobOrder.createIndexes();
    }
  });

  it('CONTROL: the id route still works and is not shadowed in turn', async () => {
    // by-number has two path segments and /:jobId has one, so they
    // cannot collide — but this is the file that would notice if a
    // later edit made them.
    const c = await makeCustomer();
    const o = await makeOrder(c);
    const job = await makeJob(o, c);

    const res = await request(app)
      .get(`/api/v2/job/${job._id}`)
      .set('Cookie', adminCookie());

    expect(res.status).toBe(200);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('the collection routes that /:jobId was swallowing', () => {
  it('GET /job/stale runs instead of being parsed as an id', async () => {
    const res = await request(app)
      .get('/api/v2/job/stale?days=14')
      .set('Cookie', adminCookie());

    // The bug returned 400 {message: 'Invalid job ID.'} — /:jobId
    // matched first and rejected the word "stale" as a bad ObjectId.
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('jobs');
    expect(Array.isArray(res.body.jobs)).toBe(true);
  });

  it('GET /job/wastage-outliers runs too', async () => {
    const res = await request(app)
      .get('/api/v2/job/wastage-outliers')
      .set('Cookie', adminCookie());

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('machines');
  });

  it('CONTROL: a genuinely bad id is still a 400, not a 404', async () => {
    // The guard inside /:jobId is what made the shadowing invisible.
    // It has to keep working — moving the routes above it must not
    // turn a typo'd id into a silent empty result.
    const res = await request(app)
      .get('/api/v2/job/not-a-real-id')
      .set('Cookie', adminCookie());

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/invalid job id/i);
  });
});

// ══════════════════════════════════════════════════════════════════
//  Found reading api/jobLookup.js line by line: the job detail both
//  apps load (GET /job/:jobId).
//
//  THE CUSTOMER'S PHONE was always blank: the route asked the customer
//  for `phone`, and the field is `phoneNumber`.
//
//  THE BOXES PACKED. Each packing row was mapped from `quantity`,
//  `rolls`, `metersPerRoll`, `total`, `batch` and `status` — none of
//  which a packing record has (it has metres, joints, three weights, a
//  size, a stretch, who packed and who checked). Every row went out as
//  0 m, 0 rolls, batch "-", status "open": the phone's Packing tab on a
//  job read "Packed 0m · Rolls 0" whatever had been packed.
// ══════════════════════════════════════════════════════════════════
describe('GET /job/:jobId — the detail', () => {
  const Packing  = () => require('../../models/Packing');
  const Employee = () => require('../../models/Employee');
  const detail = (id) => request(app).get(`/api/v2/job/${id}`).set('Cookie', adminCookie());

  async function jobWithBoxes() {
    const customer = await Customer.create({ name: 'Sri Textiles', contactName: 'S', phoneNumber: '9876543210' });
    const elastic = await Elastic.create({ name: `25mm ${Date.now()}`, weaveType: '8', spandexEnds: 40, yarnEnds: 120, pick: 12, noOfHook: 8, weight: 2.4 });
    const order = await Order.create({
      customer: customer._id, status: 'InProgress', po: 'PO-9', date: new Date(), supplyDate: new Date(),
      elasticOrdered: [{ elastic: elastic._id, quantity: 1000 }],
    });
    const job = await JobOrder.create({
      date: new Date(), order: order._id, customer: customer._id, status: 'packing',
      elastics: [{ elastic: elastic._id, quantity: 1000 }],
    });
    const packer = await Employee().create({ name: 'Mani', department: 'packing' });
    const checker = await Employee().create({ name: 'Ravi', department: 'checking' });
    const boxes = await Packing().create([
      { job: job._id, elastic: elastic._id, meter: 250.5, joints: 2, tareWeight: 1.5, netWeight: 12.4, grossWeight: 13.9, size: '25mm', stretch: '120%', checkedBy: checker._id, packedBy: packer._id },
      { job: job._id, elastic: elastic._id, meter: 300, joints: 0, tareWeight: 1.5, netWeight: 14.8, grossWeight: 16.3, checkedBy: checker._id, packedBy: packer._id },
    ]);
    await JobOrder.updateOne({ _id: job._id }, { packingDetails: boxes.map((b) => b._id) });
    return { job, elastic };
  }

  it('carries the customer\'s phone number', async () => {
    const { job } = await jobWithBoxes();
    const res = await detail(job._id);
    expect(res.status).toBe(200);
    // Before: "".
    expect(res.body.data.customerPhone).toBe('9876543210');
    await Employee().deleteMany({});
    await Packing().deleteMany({});
  });

  it('gives each box as it was packed', async () => {
    const { job, elastic } = await jobWithBoxes();
    const res = await detail(job._id);
    const [first, second] = res.body.data.packingDetails;
    expect(first).toMatchObject({
      elasticName: elastic.name, meter: 250.5, joints: 2,
      netWeight: 12.4, tareWeight: 1.5, grossWeight: 13.9,
      size: '25mm', stretch: '120%', packedBy: 'Mani', checkedBy: 'Ravi',
    });
    expect(second).toMatchObject({ meter: 300, joints: 0, size: '', stretch: '' });
    expect(typeof first.date).toBe('string');
    await Employee().deleteMany({});
    await Packing().deleteMany({});
  });

  it('and under the names the installed phone app reads, so it shows metres and not 0', async () => {
    const { job } = await jobWithBoxes();
    const res = await detail(job._id);
    const [first] = res.body.data.packingDetails;
    // Before: quantity 0, total 0, rolls 0, employeeName undefined, status "open".
    expect(first).toMatchObject({ quantity: 250.5, total: 250.5, rolls: 1, employeeName: 'Mani', weight: 12.4, status: 'packed' });
    await Employee().deleteMany({});
    await Packing().deleteMany({});
  });
});
