'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE SHIFTS RUN ON A JOB
//
//  Reported as: the job detail page shows no shifts, ever.
//
//  The page reads `job.shiftDetails` — a denormalised array of ids on
//  the job. Creating a shift plan pushes the new detail onto the shift
//  plan and onto each operator's `shifts`, and onto nothing else. No
//  code anywhere pushes onto JobOrder.shiftDetails, so the array is
//  empty for every job ever created and the populate returns nothing.
//
//  The fix reads the shifts from ShiftDetail by job rather than from
//  the array, which is why the first test here creates a shift the way
//  the app really does — through /create-shift-plan — instead of
//  writing the array by hand. Writing the array by hand would test the
//  thing that never happens.
//
//  A denormalised list nothing maintains is worse than no list: it is
//  a fact-shaped empty. Deriving it means the job can only ever say
//  what the shifts say.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongo, app;
let JobOrder, Order, Customer, Elastic, Employee, Machine, ShiftDetail, User, admin;

const adminCookie = () => [
  `token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`,
];

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  JobOrder    = require('../../models/JobOrder');
  Order       = require('../../models/Order');
  Customer    = require('../../models/Customer');
  Elastic     = require('../../models/Elastic');
  Employee    = require('../../models/Employee');
  Machine     = require('../../models/Machine');
  ShiftDetail = require('../../models/ShiftDetail');
  User        = require('../../models/User');
  admin = await User.create({
    name: 'Owner', email: 'o@t.co', password: 'pass1234', role: 'admin', department: 'admin',
  });
}, 120_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
});

async function seed() {
  const customer = await Customer.create({ name: 'Acme', contactName: 'R', phoneNumber: '9000000001' });
  const elastic  = await Elastic.create({
    name: `20mm ${Math.random().toString(36).slice(2, 8)}`, weaveType: '8',
    spandexEnds: 40, yarnEnds: 120, pick: 12, noOfHook: 8, weight: 2.4,
  });
  const operator = await Employee.create({
    name: 'Ravi', phoneNumber: '9000000002', role: 'operator', salary: 600,
  });
  const order = await Order.create({
    orderNo: Math.floor(Math.random() * 100000),
    customer: customer._id, status: 'InProgress', po: 'PO-1',
    date: new Date(), supplyDate: new Date(),
    elasticOrdered: [{ elastic: elastic._id, quantity: 5000 }],
  });
  const job = await JobOrder.create({
    date: new Date(), order: order._id, customer: customer._id, status: 'weaving',
    elastics: [{ elastic: elastic._id, quantity: 3000 }],
  });
  const machine = await Machine.create({
    ID: `M-${Math.floor(Math.random() * 10000)}`, manufacturer: 'Comez',
    NoOfHead: 4, NoOfHooks: 8,
    status: 'running', orderRunning: job._id,
    elastics: [{ head: 1, elastic: elastic._id }],
  });
  return { job, order, machine, operator, elastic, customer };
}

/** Create a shift plan the way the app does — the only path that exists. */
const planShift = (machine, operator, { date = '2026-06-10', shiftType = 'DAY' } = {}) =>
  request(app).post('/api/v2/shift/create-shift-plan')
    .set('Cookie', adminCookie())
    .send({
      date, shiftType, description: 'Day shift',
      machines: [{ machine: String(machine._id), operator: String(operator._id) }],
    });

const jobDetail = (job) =>
  request(app).get(`/api/v2/job/${job._id}`).set('Cookie', adminCookie());

// ── The reported fault ────────────────────────────────────────────────

describe('a shift planned on the job reaches the job page', () => {
  it('shows the shift, which it never did', async () => {
    const { job, machine, operator } = await seed();
    const res = await planShift(machine, operator);
    expect(res.status).toBe(201);

    const { body } = await jobDetail(job);
    expect(body.data.shiftDetails).toHaveLength(1);
    expect(body.data.shiftDetails[0]).toMatchObject({
      shift: 'DAY', operatorName: 'Ravi',
    });
  });

  it('does not depend on the job carrying a list of them', async () => {
    // JobOrder.shiftDetails is a denormalised array that nothing has
    // ever pushed to. Reading the shifts by their `job` ref instead
    // means every shift already recorded shows up, including the years
    // of them written before this was noticed.
    const { job, machine, operator } = await seed();
    await planShift(machine, operator);

    const stored = await JobOrder.findById(job._id).select('shiftDetails').lean();
    const { body } = await jobDetail(job);
    // Whatever the array says, the page shows the shifts that exist.
    expect(await ShiftDetail.countDocuments({ job: job._id })).toBe(1);
    expect(body.data.shiftDetails).toHaveLength(1);
    expect(Array.isArray(stored.shiftDetails)).toBe(true);
  });

  it('shows several shifts, oldest first', async () => {
    const { job, machine, operator } = await seed();
    await planShift(machine, operator, { date: '2026-06-11', shiftType: 'DAY' });
    await planShift(machine, operator, { date: '2026-06-10', shiftType: 'NIGHT' });

    const { body } = await jobDetail(job);
    expect(body.data.shiftDetails).toHaveLength(2);
    expect(body.data.shiftDetails.map((s) => s.shift)).toEqual(['NIGHT', 'DAY']);
  });

  it('keeps one job\'s shifts off another job', async () => {
    const a = await seed();
    const b = await seed();
    await planShift(a.machine, a.operator, { date: '2026-06-10' });
    await planShift(b.machine, b.operator, { date: '2026-06-11' });

    expect((await jobDetail(a.job)).body.data.shiftDetails).toHaveLength(1);
    expect((await jobDetail(b.job)).body.data.shiftDetails).toHaveLength(1);
  });
});

// ── A machine with no job on it ───────────────────────────────────────

describe('a shift planned on an idle machine', () => {
  it('is not filed against a job that does not exist', async () => {
    // The creation site fell back to the MACHINE id when the machine
    // had no job running, so `job` — declared ref: JobOrder — held an
    // id from the wrong collection entirely. It resolves to nothing,
    // and the shift is lost rather than merely unattributed.
    const { machine, operator } = await seed();
    await Machine.findByIdAndUpdate(machine._id, { orderRunning: null, status: 'free' });

    const res = await planShift(machine, operator);
    expect(res.status).toBe(201);

    const detail = await ShiftDetail.findOne({ machine: machine._id }).lean();
    expect(detail).toBeTruthy();
    // Unattributed, honestly — not pointed at a machine pretending to
    // be a job.
    expect(detail.job).toBeFalsy();
    expect(String(detail.job ?? '')).not.toBe(String(machine._id));
  });
});

// ── The summary ───────────────────────────────────────────────────────

describe('the shift summary on the job', () => {
  it('counts the shifts and adds up what they made', async () => {
    const { job, machine, operator } = await seed();
    await planShift(machine, operator, { date: '2026-06-10', shiftType: 'DAY' });
    await planShift(machine, operator, { date: '2026-06-11', shiftType: 'NIGHT' });

    await ShiftDetail.updateMany({ job: job._id }, {
      status: 'closed', productionMeters: 400, timer: '10:30:00',
    });

    const { body } = await jobDetail(job);
    const s = body.data.shiftSummary;
    expect(s.shifts).toBe(2);
    expect(s.produced).toBe(800);
    // 10h30 each, in minutes.
    expect(s.workedMinutes).toBe(1260);
  });

  it('reads a submitted shift at what was submitted, not at zero', async () => {
    // Until an admin verifies, the operator's numbers live in the
    // submitted* fields. Reporting the canonical 0 makes a shift that
    // ran all night look idle. utils/shiftFigures.js owns this rule and
    // the summary has to use it rather than re-deriving it.
    const { job, machine, operator } = await seed();
    await planShift(machine, operator);
    await ShiftDetail.updateMany({ job: job._id }, {
      status: 'pending_verification',
      productionMeters: 0, submittedProductionMeters: 350,
      timer: '00:00:00', submittedTimer: '11:00:00',
    });

    const { body } = await jobDetail(job);
    expect(body.data.shiftSummary.produced).toBe(350);
    expect(body.data.shiftSummary.workedMinutes).toBe(660);
  });

  it('splits day from night, and says what is still unverified', async () => {
    const { job, machine, operator } = await seed();
    await planShift(machine, operator, { date: '2026-06-10', shiftType: 'DAY' });
    await planShift(machine, operator, { date: '2026-06-10', shiftType: 'NIGHT' });
    await ShiftDetail.updateOne({ job: job._id, shift: 'DAY' },
      { status: 'closed', productionMeters: 500 });
    await ShiftDetail.updateOne({ job: job._id, shift: 'NIGHT' },
      { status: 'pending_verification', submittedProductionMeters: 300 });

    const { body } = await jobDetail(job);
    const s = body.data.shiftSummary;
    expect(s.byShift).toEqual({ DAY: 500, NIGHT: 300 });
    // The reader has to be able to tell a verified figure from a claim.
    expect(s.awaitingVerification).toBe(1);
    expect(s.closed).toBe(1);
  });

  it('names the span the shifts cover', async () => {
    const { job, machine, operator } = await seed();
    await planShift(machine, operator, { date: '2026-06-10' });
    await planShift(machine, operator, { date: '2026-06-14' });

    const { body } = await jobDetail(job);
    const s = body.data.shiftSummary;
    expect(String(s.firstDate).slice(0, 10)).toBe('2026-06-10');
    expect(String(s.lastDate).slice(0, 10)).toBe('2026-06-14');
  });

  it('reports zeroes for a job that has not run yet', async () => {
    // Not null, not absent — a job in preparatory has genuinely made
    // nothing, and the panel should say so rather than break.
    const { job } = await seed();
    const { body } = await jobDetail(job);
    expect(body.data.shiftSummary).toMatchObject({
      shifts: 0, produced: 0, workedMinutes: 0,
    });
  });
});
