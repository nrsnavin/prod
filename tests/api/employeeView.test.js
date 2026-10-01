'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE EMPLOYEE VIEW — /api/v2/me and the access rules around it
//
//  Held here:
//    • every /me route reads the worker from the login, so another
//      worker's shift or elastic is "not found", never visible;
//    • the summary's arithmetic (average, metres per hour, the plant's
//      average, the change against the window before);
//    • a worker can enter production for their own open shift only;
//    • plant-wide dashboard figures are refused to an employee login;
//    • the Flutter route for the loom is limited to the caller;
//    • admins can link a login to an employee and make it self-service.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, M;
let admin, supervisor, worker, other, workerEmp, otherEmp, loom, elasticA, elasticB, secret;
const DAY = 86_400_000;
const cookieFor = (u) => [`token=${jwt.sign({ id: u._id, role: u.role }, process.env.JWT_SECRET_KEY)}`];
const as = (u) => ({
  get: (url) => request(app).get(url).set('Cookie', cookieFor(u)),
  post: (url, body) => request(app).post(url).set('Cookie', cookieFor(u)).send(body),
  put: (url, body) => request(app).put(url).set('Cookie', cookieFor(u)).send(body),
});

let seq = 0;
async function shift(emp, { status = 'closed', daysAgo = 1, metres = 0, timer = '08:00:00', heads = [elasticA] } = {}) {
  const date = new Date(Date.now() - daysAgo * DAY);
  const plan = await M.ShiftPlan.create({ date, shift: seq++ % 2 ? 'NIGHT' : 'DAY' });
  return M.ShiftDetail.create({
    employee: emp._id, machine: loom._id, shiftPlan: plan._id, date, shift: 'DAY', status,
    productionMeters: metres, timer,
    elastics: heads.map((e, i) => ({ head: i + 1, elastic: e._id })),
  });
}

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  M = {};
  for (const n of ['User', 'Employee', 'Machine', 'Elastic', 'RawMaterial', 'ShiftPlan', 'ShiftDetail']) M[n] = require(`../../models/${n}`);
  const { ALWAYS_ON } = require('../../utils/features');

  workerEmp = await M.Employee.create({ name: 'Ravi', phoneNumber: '9100000001', department: 'weaving', role: 'operator', aadhar: '1234', hourlyRate: 90 });
  otherEmp = await M.Employee.create({ name: 'Kumar', phoneNumber: '9100000002', department: 'weaving', role: 'operator' });
  const nylon = await M.RawMaterial.create({ name: 'Nylon 70D', category: 'warp', price: 300, stock: 10, minStock: 1 });
  const elastic = (name) => M.Elastic.create({ name, weaveType: '8', spandexEnds: 40, yarnEnds: 120, pick: 12, noOfHook: 8, weight: 2, warpYarn: [{ id: nylon._id, ends: 120, weight: 1.5 }] });
  elasticA = await elastic('20mm trouser');
  elasticB = await elastic('30mm waistband');
  secret = await elastic('Not on your loom');
  loom = await M.Machine.create({ ID: 'LOOM-01', manufacturer: 'Comez', NoOfHead: 2, NoOfHooks: 8 });

  admin = await M.User.create({ name: 'Owner', email: 'own@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  supervisor = await M.User.create({ name: 'Sup', email: 'sup@t.co', password: 'pass1234', role: 'production', department: 'production' });
  worker = await M.User.create({ name: 'Ravi', email: 'ravi@t.co', password: 'pass1234', role: 'production', department: 'production', features: [...ALWAYS_ON], employee: workerEmp._id });
  other = await M.User.create({ name: 'Kumar', email: 'kumar@t.co', password: 'pass1234', role: 'production', department: 'production', features: [...ALWAYS_ON], employee: otherEmp._id });
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => { await M.ShiftDetail.deleteMany({}); await M.ShiftPlan.deleteMany({}); });

describe('a login with no employee record', () => {
  it('is told so, not shown an empty page', async () => {
    const res = await as(supervisor).get('/api/v2/me/today');
    expect(res.status).toBe(404);
    expect(res.body.message).toMatch(/not linked to an employee/i);
  });
});

describe('GET /me/today', () => {
  it('lists only this worker\'s open shifts, with each head\'s elastic in depth', async () => {
    const mine = await shift(workerEmp, { status: 'open', daysAgo: 0, heads: [elasticA, elasticB] });
    await shift(otherEmp, { status: 'open', daysAgo: 0 });
    await shift(workerEmp, { status: 'closed', daysAgo: 2 });

    const res = await as(worker).get('/api/v2/me/today');
    expect(res.status).toBe(200);
    expect(res.body.shifts.map((s) => String(s.id))).toEqual([String(mine._id)]);
    const s = res.body.shifts[0];
    expect(s.machine.code).toBe('LOOM-01');
    expect(s.heads.map((h) => h.elastic.name)).toEqual(['20mm trouser', '30mm waistband']);
    const e = s.heads[0].elastic;
    expect(e).toMatchObject({ pick: 12, hooks: 8, spandexEnds: 40, weightPerMetre: 2 });
    expect(e.warpYarn[0]).toMatchObject({ ends: 120, material: { name: 'Nylon 70D' } });
  });

  it('never carries prices, stock or another worker\'s details', async () => {
    await shift(workerEmp, { status: 'open', daysAgo: 0 });
    const text = JSON.stringify((await as(worker).get('/api/v2/me/today')).body);
    expect(text).not.toMatch(/"price"|"stock"|"costing"|"hourlyRate"|Kumar/);
  });
});

describe('GET /me/shifts', () => {
  it('summarises this worker\'s closed shifts against the plant and the window before', async () => {
    await shift(workerEmp, { metres: 400, timer: '08:00:00', daysAgo: 3 });
    await shift(workerEmp, { metres: 600, timer: '08:00:00', daysAgo: 5 });
    await shift(otherEmp, { metres: 200, daysAgo: 4 });          // plant only
    await shift(workerEmp, { metres: 400, daysAgo: 100 });       // the window before

    const res = await as(worker).get('/api/v2/me/shifts?days=90');
    expect(res.status).toBe(200);
    expect(res.body.shifts).toHaveLength(2);
    expect(res.body.shifts[0].metres).toBe(400);                 // newest first
    expect(res.body.summary).toMatchObject({
      shifts: 2,
      totalMetres: 1000,
      avgPerShift: 500,
      metresPerHour: 62.5,                                       // 1000 m over 16 h
      plantAvgPerShift: 400,                                     // (400 + 600 + 200) / 3
      previousAvgPerShift: 400,
      changePct: 25,
    });
  });

  it('includes nobody else\'s shifts', async () => {
    await shift(otherEmp, { metres: 999, daysAgo: 1 });
    const res = await as(worker).get('/api/v2/me/shifts');
    expect(res.body.shifts).toEqual([]);
    expect(res.body.summary.avgPerShift).toBeNull();
  });
});

describe('GET /me/elastic/:id', () => {
  it('opens an elastic on this worker\'s loom', async () => {
    await shift(workerEmp, { status: 'open', daysAgo: 0 });
    const res = await as(worker).get(`/api/v2/me/elastic/${elasticA._id}`);
    expect(res.status).toBe(200);
    expect(res.body.elastic.name).toBe('20mm trouser');
  });

  it('answers "not found" for one that is not, exactly as for one that does not exist', async () => {
    await shift(workerEmp, { status: 'open', daysAgo: 0 });
    await shift(otherEmp, { status: 'open', daysAgo: 0, heads: [secret] });
    const notMine = await as(worker).get(`/api/v2/me/elastic/${secret._id}`);
    const missing = await as(worker).get(`/api/v2/me/elastic/${new mongoose.Types.ObjectId()}`);
    expect(notMine.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(notMine.body.message).toBe(missing.body.message);
  });

  it('stops opening an elastic once the shift is more than 60 days old', async () => {
    await shift(workerEmp, { daysAgo: 70, heads: [elasticB] });
    expect((await as(worker).get(`/api/v2/me/elastic/${elasticB._id}`)).status).toBe(404);
  });
});

describe('POST /me/shifts/:id/production', () => {
  it('records the worker\'s entry on their own shift and sends it for verification', async () => {
    const s = await shift(workerEmp, { status: 'open', daysAgo: 0 });
    const res = await as(worker).post(`/api/v2/me/shifts/${s._id}/production`, { production: 512, timer: '7:45', feedback: ' warp break at 3am ' });
    expect(res.status).toBe(200);
    const saved = await M.ShiftDetail.findById(s._id).lean();
    expect(saved).toMatchObject({ status: 'pending_verification', submittedProductionMeters: 512, submittedTimer: '7:45', submittedFeedback: 'warp break at 3am' });
    expect(saved.productionMeters).toBe(0); // verified figure untouched
  });

  it('treats another worker\'s shift as not found', async () => {
    const s = await shift(otherEmp, { status: 'open', daysAgo: 0 });
    expect((await as(worker).post(`/api/v2/me/shifts/${s._id}/production`, { production: 1 })).status).toBe(404);
    expect((await M.ShiftDetail.findById(s._id).lean()).status).toBe('open');
  });

  it('refuses a closed shift and nonsense figures', async () => {
    const closed = await shift(workerEmp, { status: 'closed' });
    expect((await as(worker).post(`/api/v2/me/shifts/${closed._id}/production`, { production: 1 })).status).toBe(409);
    const open = await shift(workerEmp, { status: 'open', daysAgo: 0 });
    for (const body of [{}, { production: -5 }, { production: 'lots' }, { production: 10, timer: '25 hours' }]) {
      expect((await as(worker).post(`/api/v2/me/shifts/${open._id}/production`, body)).status).toBe(400);
    }
  });
});

describe('GET /me/profile', () => {
  it('shows the worker their card, without pay rates or ID numbers', async () => {
    const res = await as(worker).get('/api/v2/me/profile');
    expect(res.status).toBe(200);
    expect(res.body.profile).toMatchObject({ name: 'Ravi', department: 'weaving', email: 'ravi@t.co' });
    expect(JSON.stringify(res.body)).not.toMatch(/hourlyRate|aadhar|1234/);
  });
});

describe('around the employee view', () => {
  it('refuses plant-wide dashboard figures to an employee login, not to a supervisor', async () => {
    expect((await as(worker).get('/api/v2/dashboard/kpis')).status).toBe(403);
    expect((await as(supervisor).get('/api/v2/dashboard/kpis')).status).toBe(200);
  });

  it('limits the Flutter loom route to the caller\'s own record', async () => {
    expect((await as(worker).get(`/api/v2/shift/active-jobs/${workerEmp._id}`)).status).toBe(200);
    expect((await as(worker).get(`/api/v2/shift/active-jobs/${otherEmp._id}`)).status).toBe(403);
    expect((await as(supervisor).get(`/api/v2/shift/active-jobs/${otherEmp._id}`)).status).toBe(403);
    expect((await as(admin).get(`/api/v2/shift/active-jobs/${otherEmp._id}`)).status).toBe(200);
  });

  it('tells the app which logins get the employee view', async () => {
    expect((await as(worker).get('/api/v2/user/me')).body.user.selfService).toBe(true);
    expect((await as(supervisor).get('/api/v2/user/me')).body.user.selfService).toBe(false);
    expect((await as(admin).get('/api/v2/user/me')).body.user.selfService).toBe(false);
  });
});

describe('linking a login to an employee', () => {
  it('creates an employee login with self-service access only', async () => {
    const emp = await M.Employee.create({ name: 'Mani', phoneNumber: '9100000003', department: 'weaving' });
    const res = await as(admin).post('/api/v2/user/manage/create', {
      name: 'Mani', email: 'mani@t.co', password: 'pass1234', department: 'production', employee: String(emp._id), selfService: true,
    });
    expect(res.status).toBe(201);
    expect(res.body.user.selfService).toBe(true);
    const saved = await M.User.findOne({ email: 'mani@t.co' }).lean();
    expect(String(saved.employee)).toBe(String(emp._id));
    expect(saved.features).toEqual(require('../../utils/features').ALWAYS_ON);
  });

  it('allows one login per employee', async () => {
    const res = await as(admin).post('/api/v2/user/manage/create', {
      name: 'Dup', email: 'dup@t.co', password: 'pass1234', department: 'production', employee: String(workerEmp._id),
    });
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/already has a login/);
  });

  it('will not make an employee login without an employee', async () => {
    const res = await as(admin).post('/api/v2/user/manage/create', {
      name: 'X', email: 'x@t.co', password: 'pass1234', department: 'production', selfService: true,
    });
    expect(res.status).toBe(400);
  });

  it('links and unlinks an existing login', async () => {
    const emp = await M.Employee.create({ name: 'Siva', phoneNumber: '9100000004', department: 'weaving' });
    const u = await M.User.create({ name: 'Siva', email: 'siva@t.co', password: 'pass1234', role: 'production', department: 'production' });
    const linked = await as(admin).put(`/api/v2/user/manage/${u._id}`, { employee: String(emp._id), selfService: true });
    expect(linked.status).toBe(200);
    expect(linked.body.user.selfService).toBe(true);
    const unlinked = await as(admin).put(`/api/v2/user/manage/${u._id}`, { employee: null });
    expect(unlinked.status).toBe(200);
    expect((await M.User.findById(u._id).lean()).employee).toBeUndefined();
  });
});
