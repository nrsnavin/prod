'use strict';
// ══════════════════════════════════════════════════════════════════
//  FOUR THINGS IN THE SHIFT ROUTES
//
//  Found reading api/shift.js line by line.
//
//  1. DELETING A PLAN. A verified entry's metres are on its job and its
//     order, and a finalised shift is locked "for payroll and reports".
//     Deleting one entry respects both — it needs a reason, refuses on a
//     finalised shift and takes the metres back off. Deleting the whole
//     plan did neither: the entries went, the metres stayed, and a plan
//     made again for that day counted the production twice.
//
//  2. THE OPERATOR ON A SHIFT. Ten lookups returned the employee whole —
//     pay rate, date of birth, home address, Aadhaar check — to anyone
//     who could open a shift, and GET /shiftDetail wrote it to the log.
//
//  3. /active-job/:empId had no guard; /active-jobs/:empId, the same
//     lookup, was given one because it "returned any employee's loom and
//     job to any production login that changed the id".
//
//  4. THE PRODUCTION-DROP ALERT. A shift is closed when it is verified,
//     usually after it has run — so today's total was 0 for every loom,
//     and every loom with a month of history was a "100% drop": the
//     advisor's "N machines producing below trend", every morning.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, M, admin, factoryDay;

const cookieOf = (user) => [`token=${jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET_KEY)}`];
const adminCookie = () => cookieOf(admin);

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  M = {};
  for (const n of ['Customer', 'Elastic', 'Employee', 'Order', 'JobOrder', 'Machine', 'ShiftPlan', 'ShiftDetail', 'User']) {
    M[n] = require(`../../models/${n}`);
  }
  factoryDay = require('../../utils/factoryDay');
  admin = await M.User.create({ name: 'Owner', email: 'srr@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
  await M.User.deleteMany({ _id: { $ne: admin._id } });
});

let seq = 0;
/** A running loom with a job on it and an operator who has an HR file. */
async function loom() {
  seq += 1;
  const customer = await M.Customer.create({ name: `Acme ${seq}`, contactName: 'R', phoneNumber: '9000000001' });
  const elastic = await M.Elastic.create({
    name: `20mm ${seq}-${Math.random().toString(36).slice(2, 6)}`, weaveType: '8',
    spandexEnds: 40, yarnEnds: 120, pick: 12, noOfHook: 8, weight: 2.4,
  });
  const order = await M.Order.create({
    customer: customer._id, status: 'InProgress', po: `PO-${seq}`, date: new Date(), supplyDate: new Date(),
    elasticOrdered: [{ elastic: elastic._id, quantity: 5000 }],
  });
  const job = await M.JobOrder.create({
    date: new Date(), order: order._id, customer: customer._id, status: 'weaving',
    elastics: [{ elastic: elastic._id, quantity: 3000 }],
  });
  const machine = await M.Machine.create({
    ID: `M-${seq}`, manufacturer: 'Comez', NoOfHead: 1, NoOfHooks: 8, status: 'running', orderRunning: job._id,
    elastics: [{ head: 1, elastic: elastic._id }],
  });
  const operator = await M.Employee.create({
    name: `Op ${seq}`, phoneNumber: `90000${String(seq).padStart(5, '0')}`, role: 'operator', department: 'production',
    hourlyRate: 85, bonusPercent: 8.33, dob: '1990-04-12', gender: 'female', address: '14 Mill Road, Tiruppur', pincode: '641601',
    aadhaarCheck: { last4: '4321', nameOnCard: `Op ${seq}` },
  });
  return { machine, operator, job, order, elastic };
}

const post = (url, body = {}) => request(app).post(`/api/v2/shift${url}`).set('Cookie', adminCookie()).send(body);
const get = (url, cookie = adminCookie()) => request(app).get(`/api/v2/shift${url}`).set('Cookie', cookie);
const plan = (rows, { date = '2026-06-10', shiftType = 'DAY' } = {}) => post('/create-shift-plan', {
  date, shiftType, machines: rows.map((r) => ({ machine: String(r.machine._id), operator: String(r.operator._id) })),
});
const del = (id) => request(app).delete('/api/v2/shift/deletePlan').query({ id: String(id) }).set('Cookie', adminCookie());
const producedOn = async (job) => ((await M.JobOrder.findById(job._id).lean()).producedElastic || []).reduce((t, p) => t + (p.quantity || 0), 0);

/** A plan with one loom, entered and verified at `metres`. */
async function verifiedPlan(metres = 800) {
  const a = await loom();
  const planId = (await plan([a])).body.shiftPlanId;
  const detail = await M.ShiftDetail.findOne({}).lean();
  expect((await post('/enter-shift-production', { id: String(detail._id), production: metres, timer: '08:00:00' })).status).toBe(200);
  expect((await post('/verify-production', { shiftId: String(detail._id), productionMeters: metres })).status).toBe(200);
  expect(await producedOn(a.job)).toBe(metres);
  return { ...a, planId, detail };
}

// ══════════════════════════════════════════════════════════════════
describe('deleting a shift plan', () => {
  it('refuses while an entry on it is verified, and leaves everything as it was', async () => {
    const { planId, job } = await verifiedPlan(800);
    const res = await del(planId);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PLAN_HAS_VERIFIED_PRODUCTION');
    expect(res.body.message).toMatch(/^1 entry on this plan is verified, so its metres are already counted on the jobs and orders\./);
    expect(await M.ShiftPlan.countDocuments({})).toBe(1);
    expect(await M.ShiftDetail.countDocuments({})).toBe(1);
    expect(await producedOn(job)).toBe(800);
  });

  it('goes through once the verified entry is deleted — which takes its metres back off', async () => {
    const { planId, job, detail } = await verifiedPlan(800);
    const undo = await request(app).delete(`/api/v2/shift/production-entry/${detail._id}`)
      .set('Cookie', adminCookie()).send({ auditReason: 'plan made for the wrong day' });
    expect(undo.status).toBe(200);
    expect(await producedOn(job)).toBe(0);

    expect((await del(planId)).status).toBe(200);
    expect(await M.ShiftPlan.countDocuments({})).toBe(0);
    expect(await M.ShiftDetail.countDocuments({})).toBe(0);
    // Nothing left on the job that no shift accounts for.
    expect(await producedOn(job)).toBe(0);
  });

  it('refuses a finalised shift', async () => {
    const { planId } = await verifiedPlan(800);
    expect((await post(`/finalize-plan/${planId}`)).status).toBe(200);
    const res = await del(planId);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PLAN_FINALISED');
    expect(await M.ShiftPlan.countDocuments({})).toBe(1);
  });

  it('still deletes a plan nothing has been verified on — entered or not', async () => {
    const a = await loom();
    const b = await loom();
    const planId = (await plan([a, b])).body.shiftPlanId;
    const first = await M.ShiftDetail.findOne({ machine: a.machine._id }).lean();
    await post('/enter-shift-production', { id: String(first._id), production: 500 });
    expect((await M.ShiftDetail.findById(first._id).lean()).status).toBe('pending_verification');

    expect((await del(planId)).status).toBe(200);
    expect(await M.ShiftPlan.countDocuments({})).toBe(0);
    expect(await M.ShiftDetail.countDocuments({})).toBe(0);
  });

  it('counts the verified entries it is refusing for', async () => {
    const a = await loom();
    const b = await loom();
    const planId = (await plan([a, b])).body.shiftPlanId;
    for (const d of await M.ShiftDetail.find({}).lean()) {
      await post('/enter-shift-production', { id: String(d._id), production: 300 });
      await post('/verify-production', { shiftId: String(d._id), productionMeters: 300 });
    }
    const res = await del(planId);
    expect(res.status).toBe(409);
    expect(res.body.details).toEqual({ verified: 2 });
    expect(res.body.message).toMatch(/^2 entries on this plan are verified, so their metres/);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('what a shift says about its operator', () => {
  const HR_FILE = ['hourlyRate', 'bonusPercent', 'dob', 'gender', 'address', 'pincode', 'aadhaarCheck', 'offboarding', 'pastOffboardings', 'performance', 'shifts'];
  const expectFloorOnly = (employee, operator) => {
    expect(employee).toMatchObject({ name: operator.name, role: 'operator', department: 'production', phoneNumber: operator.phoneNumber });
    for (const key of HR_FILE) expect(employee).not.toHaveProperty(key);
  };

  it('names them on a shift, without their HR file', async () => {
    const a = await loom();
    await plan([a]);
    const detail = await M.ShiftDetail.findOne({}).lean();
    const res = await get(`/shiftDetail?id=${detail._id}`);
    expect(res.status).toBe(200);
    expectFloorOnly(res.body.shift.employee, a.operator);
    // The loom and its job are still there, as the phone reads them.
    expect(res.body.shift.machine.ID).toBe(a.machine.ID);
    expect(res.body.shift.machine.orderRunning.jobOrderNo).toBe(a.job.jobOrderNo);
  });

  it('does not write the shift to the server log', async () => {
    const a = await loom();
    await plan([a]);
    const detail = await M.ShiftDetail.findOne({}).lean();
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    await get(`/shiftDetail?id=${detail._id}`);
    const said = log.mock.calls.map((c) => c.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')).join('\n');
    log.mockRestore();
    expect(said).not.toContain(a.operator.name);
    expect(said).not.toContain(String(detail._id));
  });

  it('is the same on every plan and list', async () => {
    const a = await loom();
    const planId = (await plan([a], { date: factoryDay.ymd(), shiftType: 'DAY' })).body.shiftPlanId;

    const byPlan = (await get(`/shiftPLan?id=${planId}`)).body.shift.plan[0].employee;
    const byDate = (await get(`/shiftPlanToday?date=${factoryDay.ymd()}`)).body.shifts[0].plan[0].employee;
    const today = (await get(`/today?date=${factoryDay.ymd()}`)).body.data.dayShift.plan[0].employee;
    const open = (await get('/open')).body.shifts[0].employee;
    const allOpen = (await get('/all-open-shifts')).body.shifts[0].employee;
    const own = (await get(`/employee-open-shifts?id=${a.operator._id}`)).body.shifts[0].employee;
    for (const employee of [byPlan, byDate, today, open, allOpen, own]) expectFloorOnly(employee, a.operator);
  });
});

// ══════════════════════════════════════════════════════════════════
describe("one operator's running shift", () => {
  it("is not read by another operator's login", async () => {
    const mine = await loom();
    const theirs = await loom();
    await plan([mine, theirs]);
    const me = await M.User.create({
      name: mine.operator.name, email: `op${seq}@t.co`, password: 'pass1234', role: 'production', department: 'production', employee: mine.operator._id,
    });

    const own = await get(`/active-job/${mine.operator._id}`, cookieOf(me));
    expect(own.status).toBe(200);
    expect(own.body.shift.machine.ID).toBe(mine.machine.ID);

    const other = await get(`/active-job/${theirs.operator._id}`, cookieOf(me));
    expect(other.status).toBe(403);
    // As its sibling already answered.
    expect((await get(`/active-jobs/${theirs.operator._id}`, cookieOf(me))).status).toBe(403);
  });

  it('is still read by the office', async () => {
    const a = await loom();
    await plan([a]);
    expect((await get(`/active-job/${a.operator._id}`)).status).toBe(200);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('machines producing below their trend', () => {
  const DAY = 86_400_000;
  /** Closed shifts on a loom: one per entry of `days` (0 = the shift day running now). */
  async function closedShifts(a, days, metres, shift = 'DAY') {
    const today = factoryDay.shiftDay();
    const plans = [];
    const details = [];
    for (const n of days) {
      const date = new Date(today.getTime() - n * DAY);
      const planId = new mongoose.Types.ObjectId();
      plans.push({ _id: planId, date, shift });
      details.push({
        machine: a.machine._id, date, shift, status: 'closed', shiftPlan: planId, employee: a.operator._id,
        productionMeters: metres, elastics: [{ head: 1, elastic: a.elastic._id }],
      });
    }
    await M.ShiftPlan.insertMany(plans);
    await M.ShiftDetail.insertMany(details);
  }
  const anomalies = async () => (await get('/production-anomalies')).body;

  it('does not call a loom with nothing verified yet today a drop', async () => {
    const a = await loom();
    await closedShifts(a, [1, 2, 3, 4, 5, 6], 1000);
    // Before: listed, "today 0, 100% under its average".
    expect(await anomalies()).toMatchObject({ count: 0, machines: [] });
  });

  it('does report a shift verified today well under the average', async () => {
    const a = await loom();
    await closedShifts(a, [1, 2, 3, 4, 5, 6], 1000);
    await closedShifts(a, [0], 500);
    const out = await anomalies();
    expect(out.count).toBe(1);
    expect(out.machines[0]).toMatchObject({ machineCode: a.machine.ID, today: 500, todayShifts: 1, avg: 1000, dropPct: 50, sampleSize: 6 });
  });

  it('compares shift for shift when both of today\'s are verified', async () => {
    const a = await loom();
    await closedShifts(a, [1, 2, 3, 4, 5, 6], 1000);
    // Two shifts at 600 each. Summed they are 1,200 — "above" the
    // average of one shift, so this was missed.
    await closedShifts(a, [0], 600, 'DAY');
    await closedShifts(a, [0], 600, 'NIGHT');
    const out = await anomalies();
    expect(out.machines[0]).toMatchObject({ today: 600, todayShifts: 2, dropPct: 40 });
  });

  it('leaves a loom running to its average alone', async () => {
    const a = await loom();
    await closedShifts(a, [1, 2, 3, 4, 5, 6], 1000);
    await closedShifts(a, [0], 950);
    expect((await anomalies()).count).toBe(0);
  });
});
