'use strict';
// ══════════════════════════════════════════════════════════════════
//  WASTAGE: WHOSE IT IS, WHAT IT COSTS THEM, AND WHAT THE SUMMARY SHOWS
//
//  Found reading api/wastage.js line by line.
//
//  1. WHOSE IT IS. Both forms (web and phone) pick the operator the
//     wastage is recorded against. The server took that only from the
//     admin; from a supervisor it was ignored and the entry — and its
//     penalty, which payroll deducts — was put on the supervisor's own
//     employee record. A supervisor's login with no employee linked was
//     refused altogether. And nothing kept who entered a record.
//     Held: the admin names anybody; anyone else names an operator who
//     ran the job (the list the forms offer) or themselves.
//
//  2. THE PERFORMANCE SCORE. An employee's performance is a score out of
//     100 that the admin sets. Every wastage entry overwrote it with the
//     employee's all-time wastage in metres: 3,450 m wasted read as
//     "performance 3450.5", a full bar.
//
//  3. THE PENALTY was taken as sent: any amount, a negative one too, on
//     the way in and on an edit.
//
//  4. THE SUMMARY has a 7 / 30 / 90 day switch. Only the trend followed
//     it; the totals, the top employees and the top elastics were all
//     time, whatever was chosen. And days were cut at UTC midnight, so
//     wastage logged before 05:30 was counted on the day before.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, M, admin, supervisor, unlinkedSupervisor, supervisorEmp;

const cookieOf = (u) => [`token=${jwt.sign({ id: u._id, role: u.role }, process.env.JWT_SECRET_KEY)}`];
const as = (u) => ({
  post: (url, body) => request(app).post(`/api/v2/wastage${url}`).set('Cookie', cookieOf(u)).send(body),
  put:  (url, body) => request(app).put(`/api/v2/wastage${url}`).set('Cookie', cookieOf(u)).send(body),
  get:  (url) => request(app).get(`/api/v2/wastage${url}`).set('Cookie', cookieOf(u)),
});

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  M = {};
  for (const n of ['Customer', 'Elastic', 'Employee', 'Order', 'JobOrder', 'Wastage', 'User', 'ShiftDetail', 'Machine']) M[n] = require(`../../models/${n}`);
  admin = await M.User.create({ name: 'Owner', email: 'waste-admin@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

beforeEach(async () => {
  supervisorEmp = await M.Employee.create({ name: 'Supervisor Selvi', department: 'weaving', hourlyRate: 120 });
  supervisor = await M.User.create({
    name: 'Selvi', email: 'waste-sup@t.co', password: 'pass1234', role: 'production', department: 'production',
    features: ['/', '/jobs', '/wastage'], employee: supervisorEmp._id,
  });
  unlinkedSupervisor = await M.User.create({
    name: 'Kannan', email: 'waste-sup2@t.co', password: 'pass1234', role: 'production', department: 'production',
    features: ['/', '/wastage'],
  });
});
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
  await M.User.deleteMany({ _id: { $ne: admin._id } });
});

let n = 0;
/** A job on the loom with one elastic, and an operator who has run a shift on it. */
async function scene(over = {}) {
  n += 1;
  const customer = await M.Customer.create({ name: `Acme ${n}`, contactName: 'R', phoneNumber: '9000000001' });
  const elastic = await M.Elastic.create({ name: `20mm ${n}`, weaveType: '8', spandexEnds: 40, yarnEnds: 120, pick: 12, noOfHook: 8, weight: 2.4 });
  const order = await M.Order.create({
    customer: customer._id, status: 'InProgress', po: `PO-${n}`, date: new Date(), supplyDate: new Date(),
    elasticOrdered: [{ elastic: elastic._id, quantity: 5000 }],
  });
  const job = await M.JobOrder.create({
    date: new Date(), order: order._id, customer: customer._id, status: 'weaving',
    elastics: [{ elastic: elastic._id, quantity: 3000 }], wastageElastic: [{ elastic: elastic._id, quantity: 0 }],
  });
  const operator = await M.Employee.create({ name: `Operator ${n}`, department: 'weaving', hourlyRate: 100, performance: 80, ...over });
  const machine = await M.Machine.create({
    ID: `M-${n}`, manufacturer: 'Comez', DateOfPurchase: new Date('2020-01-01'), NoOfHead: 4, NoOfHooks: 8, status: 'running',
  });
  await M.ShiftDetail.create({
    date: new Date(), shift: 'DAY', timer: '08:00:00', elastics: [], status: 'closed', productionMeters: 900,
    employee: operator._id, job: job._id, shiftPlan: new mongoose.Types.ObjectId(), machine: machine._id,
  });
  return { job, elastic, operator, machine };
}
const entry = (s, over = {}) => ({
  job: String(s.job._id), elastic: String(s.elastic._id), employee: String(s.operator._id),
  quantity: 40, penalty: 100, reason: 'Selvedge torn', ...over,
});

// ══════════════════════════════════════════════════════════════════
describe('whose wastage it is', () => {
  it('a supervisor\'s entry is against the operator they picked, not themselves', async () => {
    const s = await scene();
    const res = await as(supervisor).post('/add-wastage', entry(s));
    expect(res.status).toBe(201);
    // Before: Supervisor Selvi — who then paid the ₹100.
    expect(res.body.wastage.employee.name).toBe(s.operator.name);
    expect(await M.Wastage.countDocuments({ employee: supervisorEmp._id })).toBe(0);
    expect(await M.Wastage.countDocuments({ employee: s.operator._id, penalty: 100 })).toBe(1);
  });

  it('a supervisor whose login has no employee linked can record it too', async () => {
    const s = await scene();
    const res = await as(unlinkedSupervisor).post('/add-wastage', entry(s));
    // Before: 403 "Cannot determine employee — your account has no linked employee".
    expect(res.status).toBe(201);
    expect(res.body.wastage.employee.name).toBe(s.operator.name);
  });

  it('with nobody picked it is the login\'s own, and with nobody to fall back on it says so', async () => {
    const s = await scene();
    const own = await as(supervisor).post('/add-wastage', entry(s, { employee: undefined }));
    expect(own.status).toBe(201);
    expect(own.body.wastage.employee.name).toBe('Supervisor Selvi');
    const none = await as(unlinkedSupervisor).post('/add-wastage', entry(s, { employee: undefined }));
    expect(none.status).toBe(400);
    expect(none.body.message).toMatch(/whose wastage/i);
  });

  it('keeps who entered it', async () => {
    const s = await scene();
    const res = await as(supervisor).post('/add-wastage', entry(s));
    const stored = await M.Wastage.findById(res.body.wastage._id).lean();
    expect(stored.recordedByName).toBe('Selvi');
    expect(String(stored.recordedBy)).toBe(String(supervisor._id));
    const detail = (await as(admin).get(`/get-detail?id=${stored._id}`)).body.wastage;
    expect(detail.recordedByName).toBe('Selvi');
  });

  it('only the admin puts it on somebody who has no shift on the job', async () => {
    const s = await scene();
    const bystander = await M.Employee.create({ name: 'Packer Priya', department: 'packing', hourlyRate: 90 });
    const refused = await as(supervisor).post('/add-wastage', entry(s, { employee: String(bystander._id) }));
    expect(refused.status).toBe(403);
    expect(refused.body.message).toMatch(/no shift on this job/i);
    expect(await M.Wastage.countDocuments({})).toBe(0);

    const byAdmin = await as(admin).post('/add-wastage', entry(s, { employee: String(bystander._id) }));
    expect(byAdmin.status).toBe(201);
    expect(byAdmin.body.wastage.employee.name).toBe('Packer Priya');
  });

  it('an employee who does not exist, or an id that is not one, is refused', async () => {
    const s = await scene();
    expect((await as(admin).post('/add-wastage', entry(s, { employee: String(new mongoose.Types.ObjectId()) }))).status).toBe(404);
    expect((await as(admin).post('/add-wastage', entry(s, { employee: 'ravi' }))).status).toBe(400);
    expect(await M.Wastage.countDocuments()).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════
describe("an employee's performance score", () => {
  it('is not touched by a wastage entry', async () => {
    const s = await scene();
    await as(admin).post('/add-wastage', entry(s, { quantity: 3450.5 }));
    // Before: 3450.5 — the metres wasted, in place of the score.
    expect((await M.Employee.findById(s.operator._id).lean()).performance).toBe(80);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('the penalty on a wastage entry', () => {
  it.each([['a negative amount', -50], ['an amount beyond any penalty', 100001], ['text', 'lots']])('%s is refused', async (_what, penalty) => {
    const s = await scene();
    const res = await as(admin).post('/add-wastage', entry(s, { penalty }));
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/^The penalty /);
    expect(await M.Wastage.countDocuments()).toBe(0);
  });

  it('none given is none, and a figure as typed is kept', async () => {
    const s = await scene();
    expect((await as(admin).post('/add-wastage', entry(s, { penalty: undefined }))).body.wastage.penalty).toBe(0);
    expect((await as(admin).post('/add-wastage', entry(s, { penalty: '' }))).body.wastage.penalty).toBe(0);
    expect((await as(admin).post('/add-wastage', entry(s, { penalty: '75.5' }))).body.wastage.penalty).toBe(75.5);
  });

  it('an edit is held to the same', async () => {
    const s = await scene();
    const made = (await as(admin).post('/add-wastage', entry(s))).body.wastage;
    const bad = await as(admin).put(`/${made._id}`, { penalty: -100, auditReason: 'waived' });
    expect(bad.status).toBe(400);
    expect((await M.Wastage.findById(made._id).lean()).penalty).toBe(100);
    const good = await as(admin).put(`/${made._id}`, { penalty: 0, auditReason: 'waived by the owner' });
    expect(good.status).toBe(200);
    expect(good.body.wastage.penalty).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('the machine a wastage entry belongs to', () => {
  it('is kept on the record: the loom the operator ran the job on', async () => {
    const s = await scene();
    const made = await as(supervisor).post('/add-wastage', entry(s));
    expect(made.status).toBe(201);
    expect(String((await M.Wastage.findById(made.body.wastage._id).lean()).machine)).toBe(String(s.machine._id));
  });

  it('is still named on the root-cause page after the job has left the loom', async () => {
    const s = await scene();
    // An entry from before the machine was kept on the record, on a job
    // that has since gone to finishing and no longer points at a loom.
    const old = await M.Wastage.create({
      job: s.job._id, elastic: s.elastic._id, employee: s.operator._id, quantity: 40, penalty: 0, reason: 'Selvedge torn',
    });
    expect(old.machine).toBeUndefined();
    await M.JobOrder.updateOne({ _id: s.job._id }, { $set: { status: 'finishing' }, $unset: { machine: 1 } });

    const res = await as(admin).get('/root-cause?days=7');
    expect(res.status).toBe(200);
    // Before: machine "—" on both, and no hotspot named.
    expect(res.body.byMachine).toEqual([{ machineID: s.machine.ID, qty: 40, count: 1 }]);
    expect(res.body.reasonMachine).toEqual([{ reason: 'Selvedge torn', machineID: s.machine.ID, qty: 40, count: 1 }]);
    expect(res.body.insights.map((i) => i.title)).toContain(`Hotspot: "Selvedge torn" on ${s.machine.ID}`);
  });
});

// ══════════════════════════════════════════════════════════════════
describe("a job's wastage total", () => {
  const totalOf = async (s) => (await M.JobOrder.findById(s.job._id).lean()).wastageElastic[0].quantity;

  it('is the sum of its entries to the millimetre, through an add, an edit and a delete', async () => {
    const s = await scene();
    const first  = await as(admin).post('/add-wastage', entry(s, { quantity: 0.1, penalty: 0 }));
    const second = await as(admin).post('/add-wastage', entry(s, { quantity: 0.2, penalty: 0 }));
    expect([first.status, second.status]).toEqual([201, 201]);
    // Before: 0.30000000000000004.
    expect(await totalOf(s)).toBe(0.3);

    const edited = await as(admin).put(`/${second.body.wastage._id}`, { quantity: 0.7, auditReason: 'measured again' });
    expect(edited.status).toBe(200);
    expect(await totalOf(s)).toBe(0.8);

    const gone = await request(app).delete(`/api/v2/wastage/${first.body.wastage._id}?auditReason=entered%20twice`).set('Cookie', cookieOf(admin));
    expect(gone.status).toBe(200);
    // Before: 0.7000000000000001.
    expect(await totalOf(s)).toBe(0.7);
  });

  it('a quantity is kept to the millimetre, and one that is not a number is refused', async () => {
    const s = await scene();
    const made = await as(admin).post('/add-wastage', entry(s, { quantity: 12.34567, penalty: 0 }));
    expect(made.body.wastage.quantity).toBe(12.346);
    const bad = await as(admin).put(`/${made.body.wastage._id}`, { quantity: 'twelve', auditReason: 'measured again' });
    expect(bad.status).toBe(400);
    expect((await M.Wastage.findById(made.body.wastage._id).lean()).quantity).toBe(12.346);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('the jobs with wastage, searched', () => {
  it('a job number finds that job, and text that is no number finds none', async () => {
    const a = await scene();
    const b = await scene();
    for (const s of [a, b]) expect((await as(admin).post('/add-wastage', entry(s))).status).toBe(201);
    const numberOf = async (s) => (await M.JobOrder.findById(s.job._id).lean()).jobOrderNo;

    const all = await as(admin).get('/jobs-wastage-list');
    expect(all.body.jobs).toHaveLength(2);

    const one = await as(admin).get(`/jobs-wastage-list?search=${await numberOf(a)}`);
    expect(one.body.jobs.map((j) => String(j._id))).toEqual([String(a.job._id)]);

    // Before: both jobs, as though "selvedge" had matched them.
    const none = await as(admin).get('/jobs-wastage-list?search=selvedge');
    expect(none.status).toBe(200);
    expect(none.body.jobs).toEqual([]);

    // Spaces are no search at all.
    const blank = await as(admin).get('/jobs-wastage-list?search=%20%20');
    expect(blank.body.jobs).toHaveLength(2);
  });
});

describe('the reason on a wastage entry', () => {
  it('cannot be edited away to nothing', async () => {
    const s = await scene();
    const made = await as(admin).post('/add-wastage', entry(s));
    const id = made.body.wastage._id;
    const blanked = await as(admin).put(`/${id}`, { quantity: 40, reason: '   ', auditReason: 'tidying the record up' });
    expect(blanked.status).toBe(400);
    expect((await M.Wastage.findById(id).lean()).reason).toBe('Selvedge torn');
  });
});

// ══════════════════════════════════════════════════════════════════
describe('the wastage summary', () => {
  const DAY = 86_400_000;
  /** An entry logged `daysAgo` days before now. */
  async function logged(s, daysAgo, over = {}) {
    const at = new Date(Date.now() - daysAgo * DAY);
    await M.Wastage.collection.insertOne({
      job: s.job._id, elastic: s.elastic._id, employee: s.operator._id, quantity: 10, penalty: 5, reason: 'Wrong pick',
      incidentDate: at, createdAt: at, updatedAt: at, ...over,
    });
  }

  it('covers the days chosen — totals, top employees and top elastics, not only the trend', async () => {
    const s = await scene();
    await logged(s, 2, { quantity: 30, penalty: 20 });
    await logged(s, 20, { quantity: 50, penalty: 40 });
    await logged(s, 200, { quantity: 1000, penalty: 900 });

    const week = (await as(admin).get('/analytics?days=7')).body.analytics;
    // Before: 1,080 m, 3 entries, ₹960 — everything ever, on the 7-day view.
    expect(week).toMatchObject({ totalWastage: 30, totalCount: 1, totalPenalty: 20, days: 7 });
    expect(week.topEmployees.map((e) => [e.name, e.total, e.count])).toEqual([[s.operator.name, 30, 1]]);
    expect(week.byElastic.map((e) => [e.total, e.count])).toEqual([[30, 1]]);
    expect(week.byStatus.map((b) => [b._id, b.total])).toEqual([['weaving', 30]]);

    const month = (await as(admin).get('/analytics?days=30')).body.analytics;
    expect(month).toMatchObject({ totalWastage: 80, totalCount: 2, totalPenalty: 60 });
    const year = (await as(admin).get('/analytics?days=365')).body.analytics;
    expect(year).toMatchObject({ totalWastage: 1080, totalCount: 3 });
  });

  it('puts wastage logged before 05:30 on the day it was logged in India', async () => {
    const s = await scene();
    const factoryDay = require('../../utils/factoryDay');
    // 02:00 in India today: 20:30 UTC yesterday.
    const today = factoryDay.ymd();
    const at = new Date(factoryDay.dayStart().getTime() + 2 * 3_600_000);
    await M.Wastage.collection.insertOne({
      job: s.job._id, elastic: s.elastic._id, employee: s.operator._id, quantity: 12, penalty: 0, reason: 'Night shift',
      incidentDate: at, createdAt: at, updatedAt: at,
    });
    const trend = (await as(admin).get('/analytics?days=7')).body.analytics.trend;
    // Before: under yesterday's date.
    expect(trend).toEqual([{ date: today, total: 12, count: 1 }]);

    const [d, m, y] = [today.slice(8, 10), today.slice(5, 7), today.slice(0, 4)];
    const range = (await as(admin).get(`/get-in-range?start=${today}&less=${today}`)).body.array;
    expect(range).toEqual([{ date: `${d}-${m}-${y}`, quantity: 12 }]);
  });
});

// ══════════════════════════════════════════════════════════════════
//  Found reading api/jobProgress.js line by line.
//
//  THERE WAS A SECOND WAY IN. POST /job/create-wastage — a route no
//  screen of the web app or the phone app calls any more — recorded a
//  wastage with none of the rules above: it asked for the Jobs tick
//  rather than the Wastage one, took any employee (one who does not
//  exist, too), any penalty, kept nothing of who entered it or which
//  machine it came off, and raised no high-wastage alert.
// ══════════════════════════════════════════════════════════════════
describe('wastage has one way in', () => {
  it('the old job-side route is gone: a login with Jobs but not Wastage cannot dock anybody\'s pay', async () => {
    const s = await scene();
    const jobsOnly = await M.User.create({
      name: 'Planner', email: 'waste-jobs-only@t.co', password: 'pass1234', role: 'production', department: 'production',
      features: ['/', '/jobs'],
    });
    const viaJobs = await request(app).post('/api/v2/job/create-wastage').set('Cookie', cookieOf(jobsOnly)).send({
      jobId: String(s.job._id), elasticId: String(s.elastic._id), employeeId: String(new mongoose.Types.ObjectId()),
      quantity: 40, penalty: 99999999, reason: 'Selvedge torn',
    });
    // Before: 201 — ₹9,99,99,999 against an employee who does not exist.
    expect(viaJobs.status).toBe(404);
    expect(await M.Wastage.countDocuments({})).toBe(0);

    // And the real route still asks for the Wastage tick.
    const viaWastage = await as(jobsOnly).post('/add-wastage', entry(s));
    expect(viaWastage.status).toBe(403);
    expect(await M.Wastage.countDocuments({})).toBe(0);
  });
});
