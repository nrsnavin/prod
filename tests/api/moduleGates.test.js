'use strict';
// ══════════════════════════════════════════════════════════════════
//  WHAT A FEATURE TICK-BOX OPENS — AND WHAT IT MUST NOT
//
//  Found by calling every route as a worker's login, as two narrowed
//  logins and as one with nothing ticked, and reading what came back:
//
//    • quotations could be READ by an account with nothing ticked;
//    • Job Orders alone opened every machine write, and the whole of QC;
//    • a finance login with Payroll, Attendance, Leave and Bonus all
//      unticked could read every employee's pay, attendance and leave —
//      the "own records" paths were let through for whoever asked;
//    • a note sent anonymously was sent to the office with its author.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, M, ALWAYS_ON, ravi, mani, n = 0;
const cookieFor = (u) => [`token=${jwt.sign({ id: u._id, role: u.role, v: u.tokenVersion ?? 0 }, process.env.JWT_SECRET_KEY)}`];
const as = (u) => ({
  get: (url) => request(app).get(url).set('Cookie', cookieFor(u)),
  post: (url, body = {}) => request(app).post(url).set('Cookie', cookieFor(u)).send(body),
  put: (url, body = {}) => request(app).put(url).set('Cookie', cookieFor(u)).send(body),
});
/** A login with exactly these features (undefined = never configured). */
const login = (role, features, extra = {}) => M.User.create({
  name: `U${++n}`, email: `u${n}@t.co`, password: 'pass1234', role,
  department: role === 'accounts' ? 'finance' : role, ...(features ? { features } : {}), ...extra,
});

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  M = {};
  for (const name of ['User', 'Employee', 'EmployeeFeedback']) M[name] = require(`../../models/${name}.js`);
  ({ ALWAYS_ON } = require('../../utils/features'));
  ravi = await M.Employee.create({ name: 'Ravi', phoneNumber: '9100000001', department: 'weaving', role: 'operator' });
  mani = await M.Employee.create({ name: 'Mani', phoneNumber: '9100000002', department: 'weaving', role: 'operator' });
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

describe('quotations', () => {
  it('cannot be read by an account without Quotations', async () => {
    const nothing = await login('accounts', []);
    const invoices = await login('accounts', [...ALWAYS_ON, '/invoices']);
    for (const u of [nothing, invoices]) {
      for (const url of ['/api/v2/quote/list', '/api/v2/quote/win-loss', `/api/v2/quote/${new mongoose.Types.ObjectId()}/pdf`]) {
        expect((await as(u).get(url)).status).toBe(403);
      }
    }
  });

  it('CONTROL: open with Quotations, and to an account that was never narrowed', async () => {
    expect((await as(await login('accounts', ['/quotes'])).get('/api/v2/quote/list')).status).toBe(200);
    expect((await as(await login('accounts')).get('/api/v2/quote/list')).status).toBe(200);
  });
});

describe('machines', () => {
  it('Job Orders alone reads the machine list and writes no machine', async () => {
    const jobs = await login('production', [...ALWAYS_ON, '/jobs']);
    expect((await as(jobs).get('/api/v2/machine/get-machines')).status).toBe(200);
    expect((await as(jobs).get('/api/v2/machine/free')).status).toBe(200);
    for (const [method, url] of [
      ['post', '/api/v2/machine/create-machine'], ['post', '/api/v2/machine/service-bill'],
      ['post', '/api/v2/machine/service-analytics/dismiss'], ['put', '/api/v2/machine/updateOrder'],
    ]) {
      const res = await as(jobs)[method](url);
      expect(res.status).toBe(403);
      expect(res.body.message).toMatch(/access to this feature/);
    }
  });

  it('CONTROL: Machines writes them', async () => {
    const machines = await login('production', [...ALWAYS_ON, '/machines']);
    // Past the gate: refused for what was (not) sent, not for who asked.
    expect((await as(machines).post('/api/v2/machine/create-machine')).status).toBe(400);
  });

  it('a service log is the office\'s to add — a worker\'s own login adds none', async () => {
    const worker = await login('production', ALWAYS_ON, { employee: ravi._id });
    const res = await as(worker).post('/api/v2/machine/add-service-log');
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/office staff/);
    // A supervisor closing a machine issue logs the service from that screen.
    const supervisor = await login('production', ALWAYS_ON);
    expect((await as(supervisor).post('/api/v2/machine/add-service-log')).status).not.toBe(403);
  });

  it('the repeat-offender roll-up is the office\'s too', async () => {
    const worker = await login('production', ALWAYS_ON, { employee: mani._id });
    expect((await as(worker).get('/api/v2/machine-issue/anomalies')).status).toBe(403);
    expect((await as(await login('production', ALWAYS_ON)).get('/api/v2/machine-issue/anomalies')).status).toBe(200);
  });
});

describe('quality control', () => {
  it('Job Orders records a result and reads a job\'s results — not the module', async () => {
    const jobs = await login('production', [...ALWAYS_ON, '/jobs']);
    // The three the Jobs screen uses reach their handlers…
    expect((await as(jobs).post('/api/v2/qc/create')).status).not.toBe(403);
    expect((await as(jobs).get('/api/v2/qc/by-job')).status).not.toBe(403);
    expect((await as(jobs).get('/api/v2/qc/coa')).status).not.toBe(403);
    // …and nothing else does.
    for (const url of ['/api/v2/qc/recent', '/api/v2/qc/jobs-for-qc', '/api/v2/qc/export-dataset', '/api/v2/qc/training-readiness', '/api/v2/qc/root-cause']) {
      expect((await as(jobs).get(url)).status).toBe(403);
    }
    expect((await as(jobs).post('/api/v2/qc/vision-draft')).status).toBe(403);
  });

  it('CONTROL: Quality Control opens all of it', async () => {
    const qc = await login('production', [...ALWAYS_ON, '/qc']);
    expect((await as(qc).get('/api/v2/qc/recent')).status).toBe(200);
    expect((await as(qc).get('/api/v2/qc/export-dataset')).status).toBe(200);
  });
});

describe('someone else\'s pay, attendance, leave and bonus', () => {
  const others = (emp) => [
    `/api/v2/payroll/ledger/${emp._id}`, `/api/v2/payroll/history/${emp._id}`, `/api/v2/payroll/range/${emp._id}`,
    `/api/v2/attendance/monthly/${emp._id}`, `/api/v2/leave/employee/${emp._id}`, `/api/v2/bonus/employee/${emp._id}`,
  ];

  it('are closed to a finance login without those modules', async () => {
    for (const features of [[], [...ALWAYS_ON, '/invoices', '/accounts']]) {
      const clerk = await login('accounts', features);
      for (const url of others(ravi)) {
        const res = await as(clerk).get(url);
        expect(res.status).toBe(403);
        expect(res.body.message).toMatch(/access to this feature/);
      }
    }
  });

  it('each module opens its own, and no other', async () => {
    const payroll = await login('accounts', [...ALWAYS_ON, '/payroll']);
    expect((await as(payroll).get(`/api/v2/payroll/ledger/${ravi._id}`)).status).toBe(200);
    // Payroll's screens show a person's bonus beside their pay.
    expect((await as(payroll).get(`/api/v2/bonus/employee/${ravi._id}`)).status).toBe(200);
    expect((await as(payroll).get(`/api/v2/attendance/monthly/${ravi._id}`)).status).toBe(403);
    expect((await as(payroll).get(`/api/v2/leave/employee/${ravi._id}`)).status).toBe(403);
  });

  it('Employees opens them: its page shows a person\'s pay, leave and attendance', async () => {
    const hr = await login('accounts', [...ALWAYS_ON, '/employees']);
    for (const url of others(ravi)) expect((await as(hr).get(url)).status).toBe(200);
    // …but not the modules themselves.
    expect((await as(hr).get('/api/v2/payroll/advance')).status).toBe(403);
    expect((await as(hr).get('/api/v2/leave/pending')).status).toBe(403);
  });

  it('CONTROL: an account that was never narrowed reads them as before', async () => {
    const legacy = await login('accounts');
    for (const url of others(ravi)) expect((await as(legacy).get(url)).status).toBe(200);
  });
});

describe('one\'s own records', () => {
  it('a worker reads their own, with no module ticked, and nobody else\'s', async () => {
    const worker = await login('production', ALWAYS_ON, { employee: ravi._id });
    for (const url of [
      `/api/v2/payroll/ledger/${ravi._id}`, `/api/v2/payroll/history/${ravi._id}`,
      `/api/v2/attendance/monthly/${ravi._id}`, `/api/v2/leave/employee/${ravi._id}`, `/api/v2/bonus/employee/${ravi._id}`,
    ]) expect((await as(worker).get(url)).status).toBe(200);
    for (const url of [`/api/v2/payroll/ledger/${mani._id}`, `/api/v2/attendance/monthly/${mani._id}`, `/api/v2/leave/employee/${mani._id}`]) {
      expect((await as(worker).get(url)).status).toBe(403);
    }
  });

  it('a finance login without Payroll still reads its OWN payslip history', async () => {
    const clerk = await login('accounts', [...ALWAYS_ON, '/invoices'], { employee: mani._id });
    expect((await as(clerk).get(`/api/v2/payroll/history/${mani._id}`)).status).toBe(200);
    expect((await as(clerk).get(`/api/v2/payroll/history/${ravi._id}`)).status).toBe(403);
  });

  it('asking for an advance and for leave stay a person\'s own business', async () => {
    const worker = await login('production', ALWAYS_ON, { employee: ravi._id });
    // Past the gate: refused for what was (not) sent.
    expect((await as(worker).post('/api/v2/payroll/advance')).status).toBe(400);
    expect((await as(worker).post('/api/v2/leave/request')).status).toBe(400);
  });
});

describe('a note sent anonymously', () => {
  let worker, admin, anon, named;
  beforeAll(async () => {
    await M.EmployeeFeedback.deleteMany({});
    worker = await login('production', ALWAYS_ON, { employee: ravi._id });
    admin = await login('admin');
    const send = (body) => as(worker).post('/api/v2/feedback/', { employeeId: String(ravi._id), type: 'complaint', category: 'management', ...body });
    anon = (await send({ subject: 'Night shift supervisor', body: 'Shouts at the operators.', isAnonymous: true })).body.data;
    named = (await send({ subject: 'Canteen water', body: 'The cooler is broken.' })).body.data;
    expect(anon._id && named._id).toBeTruthy();
  });

  it('reaches the office without its author', async () => {
    const res = await as(admin).get('/api/v2/feedback/');
    expect(res.status).toBe(200);
    const a = res.body.data.find((f) => f._id === anon._id);
    expect(a.subject).toBe('Night shift supervisor');
    expect(a.employee).toBeNull();
    expect(a.createdBy).toBeUndefined();
    expect(a.updatedBy).toBeUndefined();
    expect(JSON.stringify(a)).not.toContain(String(ravi._id));
    expect(JSON.stringify(a)).not.toContain(String(worker._id));
    expect(JSON.stringify(a)).not.toContain('Ravi');
    // A note with a name on it still has one.
    expect(res.body.data.find((f) => f._id === named._id).employee).toMatchObject({ name: 'Ravi' });
  });

  it('is not found by asking for its author\'s notes', async () => {
    const res = await as(admin).get(`/api/v2/feedback/employee/${ravi._id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.map((f) => f._id)).toEqual([named._id]);
  });

  it('is still its author\'s to see and to withdraw', async () => {
    const mine = await as(worker).get(`/api/v2/feedback/employee/${ravi._id}`);
    expect(mine.body.data.map((f) => f._id).sort()).toEqual([anon._id, named._id].sort());
  });

  it('answered by the office, still has no author in the reply', async () => {
    const res = await as(admin).put(`/api/v2/feedback/${anon._id}/respond`, { response: 'Looked into; spoken to.', status: 'in_review' });
    expect(res.status).toBe(200);
    expect(res.body.data.employee).toBeNull();
    expect(JSON.stringify(res.body)).not.toContain('Ravi');
    // The record itself still knows, for its author.
    expect(String((await M.EmployeeFeedback.findById(anon._id).lean()).employee)).toBe(String(ravi._id));
  });

  it('takes text, of a size someone would type', async () => {
    const send = (body) => as(worker).post('/api/v2/feedback/', { employeeId: String(ravi._id), type: 'suggestion', ...body });
    expect((await send({ subject: 12345, body: 'x' })).status).toBe(400);
    expect((await send({ subject: 'ok', body: ['x'] })).status).toBe(400);
    expect((await send({ subject: 'x'.repeat(201), body: 'ok' })).status).toBe(400);
    expect((await send({ subject: 'ok', body: 'x'.repeat(5001) })).status).toBe(400);
  });
});
