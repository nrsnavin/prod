'use strict';
// ══════════════════════════════════════════════════════════════════
//  ADVERSARIAL PROBE SUITE
//
//  Not a regression suite — a report generator. Each probe tries to
//  break something and RECORDS what happened rather than asserting a
//  hoped-for answer, so the run prints a findings table instead of
//  stopping at the first surprise.
//
//  Run:  npx jest tests/security/attack.probe --runInBand
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = 'probe-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongo, app, M = {}, actors = {}, fixtures = {};
const findings = [];

const record = (area, probe, outcome, detail) =>
  findings.push({ area, probe, outcome, detail });

const cookieFor = (id, role) => [`token=${jwt.sign({ id, role }, process.env.JWT_SECRET_KEY)}`];
const oid = () => new mongoose.Types.ObjectId();

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  for (const n of ['User', 'Employee', 'Customer', 'Order', 'JobOrder', 'Elastic',
    'RawMaterial', 'ShiftDetail', 'Payroll', 'Attendence']) {
    try { M[n] = require(`../../models/${n}.js`); } catch { /* optional */ }
  }

  const emp = async (name) =>
    M.Employee.create({ name, department: 'weaving', skill: 1, hourlyRate: 50 });
  const empA = await emp('Worker A');
  const empB = await emp('Worker B');

  actors.admin = await M.User.create({
    name: 'Admin', email: 'probe-admin@t.co', password: 'pass1234',
    role: 'admin', department: 'admin',
  });
  actors.worker = await M.User.create({
    name: 'Worker A', email: 'probe-worker@t.co', password: 'pass1234',
    role: 'production', department: 'production', employee: empA._id,
  });
  actors.otherWorker = await M.User.create({
    name: 'Worker B', email: 'probe-worker-b@t.co', password: 'pass1234',
    role: 'production', department: 'production', employee: empB._id,
  });
  // Finance user with a deliberately narrow feature list.
  actors.narrow = await M.User.create({
    name: 'Narrow', email: 'probe-narrow@t.co', password: 'pass1234',
    role: 'accounts', department: 'finance', features: ['/orders'],
  });

  const cust = await M.Customer.create({
    name: 'Probe Customer', contactName: 'X', phoneNumber: '9000000000',
  });
  const el = await M.Elastic.create({
    name: 'Probe Elastic', weaveType: '8', spandexEnds: 40, pick: 30, noOfHook: 12, weight: 5,
  });
  const order = await M.Order.create({
    date: new Date(), po: 'PROBE-1', customer: cust._id, supplyDate: new Date(),
    status: 'InProgress', elasticOrdered: [{ elastic: el._id, quantity: 100, rate: 10 }],
  });
  const job = await M.JobOrder.create({
    date: new Date(), order: order._id, customer: cust._id, status: 'weaving',
  });
  fixtures = { cust, el, order, job, empA, empB };
}, 180_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();

  const pad = (s, n) => String(s).padEnd(n).slice(0, n);
  const bad = findings.filter((f) => f.outcome === 'VULNERABLE' || f.outcome === 'WEAK');
  /* eslint-disable no-console */
  console.log('\n\n════════ PROBE RESULTS ════════');
  for (const f of findings) {
    console.log(`${pad(f.outcome, 11)} ${pad(f.area, 22)} ${pad(f.probe, 46)} ${f.detail}`);
  }
  console.log(`\n${bad.length} of ${findings.length} probes flagged\n`);
});

const admin = () => cookieFor(actors.admin._id, 'admin');
const worker = () => cookieFor(actors.worker._id, 'production');
const narrow = () => cookieFor(actors.narrow._id, 'accounts');

// ══════════════════════════════════════════════════════════════════
describe('A. token and session', () => {
  test('alg:none forged token', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ id: String(actors.admin._id), role: 'admin' })).toString('base64url');
    const res = await request(app).get('/api/v2/order/list')
      .set('Cookie', [`token=${header}.${payload}.`]);
    record('A. token', 'alg:none forgery', res.status === 200 ? 'VULNERABLE' : 'OK', `→ ${res.status}`);
    expect(res.status).not.toBe(200);
  });

  test('token signed with the wrong secret', async () => {
    const forged = jwt.sign({ id: String(actors.admin._id), role: 'admin' }, 'not-the-secret');
    const res = await request(app).get('/api/v2/order/list').set('Cookie', [`token=${forged}`]);
    record('A. token', 'wrong-secret signature', res.status === 200 ? 'VULNERABLE' : 'OK', `→ ${res.status}`);
    expect(res.status).not.toBe(200);
  });

  // The role claim is attacker-controlled. Authorization must read the DB.
  test('valid signature, role claim escalated to admin', async () => {
    const escalated = jwt.sign(
      { id: String(actors.worker._id), role: 'admin' }, process.env.JWT_SECRET_KEY);
    const res = await request(app).get('/api/v2/user/manage/list')
      .set('Cookie', [`token=${escalated}`]);
    record('A. token', 'role claim escalation', res.status === 200 ? 'VULNERABLE' : 'OK',
      `worker claiming admin → ${res.status}`);
  });

  test('expired token', async () => {
    const stale = jwt.sign({ id: String(actors.admin._id), role: 'admin' },
      process.env.JWT_SECRET_KEY, { expiresIn: '-1h' });
    const res = await request(app).get('/api/v2/order/list').set('Cookie', [`token=${stale}`]);
    record('A. token', 'expired token', res.status === 200 ? 'VULNERABLE' : 'OK', `→ ${res.status}`);
  });

  test('token for a user that no longer exists', async () => {
    const ghost = jwt.sign({ id: String(oid()), role: 'admin' }, process.env.JWT_SECRET_KEY);
    const res = await request(app).get('/api/v2/order/list').set('Cookie', [`token=${ghost}`]);
    record('A. token', 'deleted-user token', res.status === 200 ? 'VULNERABLE' : 'OK', `→ ${res.status}`);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('B. feature-gate bypass', () => {
  const gated = '/api/v2/pnl/orders';   // narrow user lacks /order-pnl

  test('baseline: the gate holds', async () => {
    const res = await request(app).get(gated).set('Cookie', narrow());
    record('B. gate', 'baseline direct GET', res.status === 403 ? 'OK' : 'VULNERABLE', `→ ${res.status}`);
  });

  test.each([
    ['trailing slash', '/api/v2/pnl/orders/'],
    ['double slash', '/api/v2//pnl/orders'],
    ['dot segment', '/api/v2/pnl/./orders'],
    ['upper case', '/api/v2/PNL/orders'],
    ['percent-encoded', '/api/v2/pnl/%6frders'],
    ['path traversal', '/api/v2/reports/../pnl/orders'],
    ['null byte', '/api/v2/pnl/orders%00'],
    ['semicolon param', '/api/v2/pnl/orders;x=1'],
  ])('path trick: %s', async (label, path) => {
    const res = await request(app).get(path).set('Cookie', narrow());
    // 200 = bypassed. 403/404 = held.
    record('B. gate', `path trick — ${label}`,
      res.status === 200 ? 'VULNERABLE' : 'OK', `${path} → ${res.status}`);
  });

  test('HEAD instead of GET', async () => {
    const res = await request(app).head(gated).set('Cookie', narrow());
    record('B. gate', 'HEAD verb', res.status === 200 ? 'VULNERABLE' : 'OK', `→ ${res.status}`);
  });

  test('OPTIONS preflight leaks nothing', async () => {
    const res = await request(app).options(gated).set('Cookie', narrow());
    const leaked = typeof res.text === 'string' && /orderValue|profit/.test(res.text);
    record('B. gate', 'OPTIONS verb', leaked ? 'VULNERABLE' : 'OK', `→ ${res.status}`);
  });

  // requireFeatureReadPaths widens by path PREFIX. A widened path must
  // not open a sibling that merely starts with the same characters.
  test('per-path widening does not leak a sibling path', async () => {
    // /all-customers is widened for /orders holders; /all-customers-export
    // (if it existed) must not be.
    const wide = await request(app).get('/api/v2/customer/all-customers').set('Cookie', narrow());
    const detail = await request(app)
      .get(`/api/v2/customer/get-customer?id=${fixtures.cust._id}`).set('Cookie', narrow());
    record('B. gate', 'widened path grants only itself',
      wide.status === 200 && detail.status === 403 ? 'OK' : 'REVIEW',
      `picker → ${wide.status}, detail → ${detail.status}`);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('C. horizontal access (IDOR)', () => {
  // These are the REAL selfOrAdmin routes. The first pass probed two
  // paths that do not exist; a 404 proves nothing about authorization.
  test.each([
    ['payslip', '/api/v2/payroll/slip/EMPB'],
    ['payslip PDF', '/api/v2/payroll/slip/EMPB/pdf'],
    ['pay ledger', '/api/v2/payroll/ledger/EMPB'],
    ['payroll history', '/api/v2/payroll/history/EMPB'],
    ['payroll range', '/api/v2/payroll/range/EMPB'],
    ['attendance', '/api/v2/attendence/employee/EMPB'],
    ['attendance monthly', '/api/v2/attendence/monthly/EMPB'],
  ])('worker reads another worker: %s', async (label, tpl) => {
    const path = tpl.replace('EMPB', String(fixtures.empB._id));
    const res = await request(app).get(path).set('Cookie', worker());
    // 404 would mean the probe missed the route — call that out rather
    // than banking it as a pass.
    const outcome = res.status === 200 ? 'VULNERABLE'
      : res.status === 404 ? 'PROBE-MISSED' : 'OK';
    record('C. IDOR', `another worker's ${label}`, outcome, `${path} → ${res.status}`);
  });

  test('worker reads their OWN payslip (the guard must not over-block)', async () => {
    const res = await request(app)
      .get(`/api/v2/payroll/slip/${fixtures.empA._id}`).set('Cookie', worker());
    record('C. IDOR', 'own payslip still reachable',
      res.status === 403 ? 'VULNERABLE' : 'OK', `→ ${res.status}`);
  });

  test("worker reads another worker's shifts by ?id=", async () => {
    const res = await request(app)
      .get(`/api/v2/shift/employee-closed-shifts?id=${fixtures.empB._id}`)
      .set('Cookie', worker());
    record('C. IDOR', 'shift list by ?id=', res.status === 200 ? 'VULNERABLE' : 'OK', `→ ${res.status}`);
  });

  test('worker cannot read the P&L of any order', async () => {
    const res = await request(app)
      .get(`/api/v2/pnl/order/${fixtures.order._id}`).set('Cookie', worker());
    record('C. IDOR', 'production user reads margin', res.status === 200 ? 'VULNERABLE' : 'OK',
      `→ ${res.status}`);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('D. injection', () => {
  test('NoSQL operator in the login body', async () => {
    const res = await request(app).post('/api/v2/user/login-user')
      .send({ email: { $gt: '' }, password: { $gt: '' } });
    record('D. injection', 'NoSQL operator on login',
      res.status === 201 || res.status === 200 ? 'VULNERABLE' : 'OK', `→ ${res.status}`);
    expect([200, 201]).not.toContain(res.status);
  });

  test('NoSQL operator nested inside an array', async () => {
    const res = await request(app).put(`/api/v2/pnl/order/${fixtures.order._id}/rates`)
      .set('Cookie', admin())
      .send({ rates: [{ elastic: { $ne: null }, rate: 1 }] });
    record('D. injection', 'operator nested in array',
      res.status === 200 ? 'REVIEW' : 'OK', `→ ${res.status}`);
  });

  test('regex metacharacters in an email lookup', async () => {
    const started = Date.now();
    const res = await request(app).post('/api/v2/user/request-otp')
      .send({ email: '.*.*.*.*.*.*.*.*.*.*.*.*@t.co' });
    const ms = Date.now() - started;
    record('D. injection', 'ReDoS via email regex',
      ms > 3000 ? 'VULNERABLE' : 'OK', `${ms}ms → ${res.status}`);
  });

  // `.send({ __proto__: x })` sends NOTHING — in JS that sets the
  // object's prototype rather than creating an own property, so the
  // first version of this probe serialised an empty object and passed
  // vacuously. The payload has to go as a raw JSON string.
  test('prototype pollution through a raw JSON body', async () => {
    const res = await request(app).put('/api/v2/pnl/settings').set('Cookie', admin())
      .set('Content-Type', 'application/json')
      .send('{"finishingRatePerMeter":1,"__proto__":{"polluted":"yes"}}');
    const polluted = ({}).polluted !== undefined;
    record('D. injection', 'prototype pollution (raw __proto__)',
      polluted ? 'VULNERABLE' : 'OK',
      polluted ? 'Object.prototype touched' : `clean (→ ${res.status})`);
    delete Object.prototype.polluted;
    expect(polluted).toBe(false);
  });

  test('constructor.prototype pollution through a raw JSON body', async () => {
    const res = await request(app).put('/api/v2/pnl/settings').set('Cookie', admin())
      .set('Content-Type', 'application/json')
      .send('{"constructor":{"prototype":{"pwned":1}}}');
    const polluted = ({}).pwned !== undefined;
    record('D. injection', 'prototype pollution (constructor)',
      polluted ? 'VULNERABLE' : 'OK', polluted ? 'polluted' : `clean (→ ${res.status})`);
    delete Object.prototype.pwned;
    expect(polluted).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('E. privilege escalation and mass assignment', () => {
  test('a WORKER calls sign-up asking for the admin role', async () => {
    const res = await request(app).post('/api/v2/user/sign-up').set('Cookie', worker()).send({
      name: 'Sneaky2', email: 'sneaky2@t.co', password: 'pass1234',
      role: 'admin', department: 'admin', features: ['/users'],
    });
    let escalated = false;
    if (res.status < 300) {
      const u = await M.User.findOne({ email: 'sneaky2@t.co' }).lean();
      escalated = u?.role === 'admin' || (u?.features || []).includes('/users');
    }
    record('E. privesc', 'authenticated worker signs up an admin',
      escalated ? 'VULNERABLE' : 'OK', `→ ${res.status}`);
    expect(escalated).toBe(false);
  });

  test('unauthenticated sign-up asking for the admin role', async () => {
    const res = await request(app).post('/api/v2/user/sign-up').send({
      name: 'Sneaky', email: 'sneaky@t.co', password: 'pass1234',
      role: 'admin', department: 'admin', features: ['/users'],
    });
    let escalated = false;
    if (res.status < 300) {
      const u = await M.User.findOne({ email: 'sneaky@t.co' }).lean();
      escalated = u?.role === 'admin';
    }
    record('E. privesc', 'sign-up requesting admin',
      escalated ? 'VULNERABLE' : 'OK', `→ ${res.status}`);
    expect(escalated).toBe(false);
  });

  test('worker updates their own profile to admin', async () => {
    await request(app).put('/api/v2/user/me').set('Cookie', worker())
      .send({ name: 'Worker A', role: 'admin', features: ['/users'], department: 'admin' });
    const after = await M.User.findById(actors.worker._id).lean();
    const escalated = after.role === 'admin' || (after.features || []).includes('/users');
    record('E. privesc', 'self-service role/feature edit',
      escalated ? 'VULNERABLE' : 'OK', `role now ${after.role}`);
    expect(escalated).toBe(false);
  });

  test('non-admin creates a user through the admin route', async () => {
    const res = await request(app).post('/api/v2/user/manage/create').set('Cookie', worker())
      .send({ name: 'X', email: 'x-priv@t.co', password: 'pass1234', department: 'admin' });
    record('E. privesc', 'non-admin uses /user/manage/create',
      res.status < 300 ? 'VULNERABLE' : 'OK', `→ ${res.status}`);
  });

  test('non-admin writes the factory-wide cost rate card', async () => {
    const res = await request(app).put('/api/v2/pnl/settings').set('Cookie', worker())
      .send({ overheadRatePerMeter: 0 });
    record('E. privesc', 'worker rewrites the rate card',
      res.status < 300 ? 'VULNERABLE' : 'OK', `→ ${res.status}`);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('F. numeric and data integrity', () => {
  const bad = [
    ['negative', -5],
    ['Infinity', 1e400],
    ['NaN string', 'NaN'],
    ['huge', 1e308],
    ['numeric string', '10'],
    ['array', [1, 2]],
    ['object', { a: 1 }],
  ];

  test.each(bad)('selling rate: %s', async (label, value) => {
    const res = await request(app).put(`/api/v2/pnl/order/${fixtures.order._id}/rates`)
      .set('Cookie', admin())
      .send({ rates: [{ elastic: String(fixtures.el._id), rate: value }] });
    const stored = (await M.Order.findById(fixtures.order._id).lean())
      .elasticOrdered[0].rate;
    const sane = Number.isFinite(stored) && stored >= 0;
    record('F. numeric', `selling rate — ${label}`,
      sane ? 'OK' : 'VULNERABLE', `→ ${res.status}, stored ${stored}`);
    expect(sane).toBe(true);
  });

  test.each(bad)('rate card: %s', async (label, value) => {
    const res = await request(app).put('/api/v2/pnl/settings').set('Cookie', admin())
      .send({ overheadRatePerMeter: value });
    const doc = await require('../../models/CostSettings.js').findOne({ key: 'cost' }).lean();
    const stored = doc?.overheadRatePerMeter;
    const sane = stored === undefined || (Number.isFinite(stored) && stored >= 0);
    record('F. numeric', `rate card — ${label}`,
      sane ? 'OK' : 'VULNERABLE', `→ ${res.status}, stored ${stored}`);
  });

  test('job cost override: negative', async () => {
    const res = await request(app).put(`/api/v2/pnl/job/${fixtures.job._id}/cost-overrides`)
      .set('Cookie', admin()).send({ finishing: -1000 });
    record('F. numeric', 'job override — negative',
      res.status === 400 ? 'OK' : 'VULNERABLE', `→ ${res.status}`);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('G. information disclosure', () => {
  test('no password hash in any user-shaped response', async () => {
    const res = await request(app).get('/api/v2/user/manage/list').set('Cookie', admin());
    const body = JSON.stringify(res.body);
    const leaks = /"password"|\$2[aby]\$/.test(body);
    record('G. disclosure', 'password hash in user list',
      leaks ? 'VULNERABLE' : 'OK', `→ ${res.status}`);
    expect(leaks).toBe(false);
  });

  test('no OTP or reset token in any response', async () => {
    await request(app).post('/api/v2/user/request-otp').send({ email: 'probe-admin@t.co' });
    const me = await request(app).get('/api/v2/user/me').set('Cookie', admin());
    const body = JSON.stringify(me.body);
    const leaks = /otpCode|resetPasswordToken|otpExpire/.test(body);
    record('G. disclosure', 'OTP / reset token in /me',
      leaks ? 'VULNERABLE' : 'OK', `→ ${me.status}`);
    expect(leaks).toBe(false);
  });

  test('login does not reveal whether an account exists', async () => {
    const real = await request(app).post('/api/v2/user/login-user')
      .send({ email: 'probe-admin@t.co', password: 'wrong-password' });
    const fake = await request(app).post('/api/v2/user/login-user')
      .send({ email: 'nobody-here@t.co', password: 'wrong-password' });
    const same = real.status === fake.status && real.body.message === fake.body.message;
    record('G. disclosure', 'user enumeration on login',
      same ? 'OK' : 'REVIEW',
      `real "${real.body.message}" (${real.status}) vs unknown "${fake.body.message}" (${fake.status})`);
  });

  test('server errors do not return a stack trace', async () => {
    const res = await request(app).get('/api/v2/order/get-orderDetail?id=not-an-objectid')
      .set('Cookie', admin());
    const body = JSON.stringify(res.body);
    const leaks = /at .*\(.*\.js:\d+/.test(body) || /node_modules/.test(body);
    record('G. disclosure', 'stack trace in error body',
      leaks ? 'VULNERABLE' : 'OK', `→ ${res.status}`);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('H. availability', () => {
  test('unbounded page size on the P&L list', async () => {
    const res = await request(app).get('/api/v2/pnl/orders?limit=100000').set('Cookie', admin());
    const capped = res.body?.limit != null && res.body.limit <= 50;
    record('H. availability', 'P&L list limit cap',
      capped ? 'OK' : 'VULNERABLE', `limit=100000 → served ${res.body?.limit}`);
  });

  test('unbounded page size on the order list', async () => {
    const res = await request(app).get('/api/v2/order/list?limit=1000000').set('Cookie', admin());
    const served = res.body?.limit ?? res.body?.orders?.length;
    record('H. availability', 'order list limit cap',
      served != null && served <= 500 ? 'OK' : 'REVIEW', `limit=1000000 → ${served}`);
  });

  test('deeply nested JSON body', async () => {
    let deep = { v: 1 };
    for (let i = 0; i < 400; i++) deep = { n: deep };
    const res = await request(app).put('/api/v2/pnl/settings').set('Cookie', admin())
      .send({ finishingRatePerMeter: 1, junk: deep });
    record('H. availability', '400-deep nested body',
      res.status >= 500 ? 'REVIEW' : 'OK', `→ ${res.status}`);
  });

  test('oversized body is rejected, not buffered', async () => {
    const res = await request(app).put('/api/v2/pnl/settings').set('Cookie', admin())
      .send({ notes: 'A'.repeat(3 * 1024 * 1024) });
    record('H. availability', '3 MB body vs the 1 MB cap',
      res.status === 413 ? 'OK' : 'REVIEW', `→ ${res.status}`);
  });

  test('negative and zero page numbers', async () => {
    const res = await request(app).get('/api/v2/pnl/orders?page=-5&limit=0').set('Cookie', admin());
    record('H. availability', 'negative page / zero limit',
      res.status === 200 && res.body.page >= 1 ? 'OK' : 'REVIEW',
      `→ ${res.status}, page ${res.body?.page}, limit ${res.body?.limit}`);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('I. transport and headers', () => {
  test('security headers are present', async () => {
    const res = await request(app).get('/api/v2/order/list').set('Cookie', admin());
    const h = res.headers;
    const missing = ['content-security-policy', 'x-content-type-options',
      'strict-transport-security'].filter((k) => !h[k]);
    record('I. headers', 'helmet headers',
      missing.length ? 'REVIEW' : 'OK', missing.length ? `missing: ${missing.join(', ')}` : 'all present');
  });

  test('the session cookie is httpOnly and SameSite-scoped', async () => {
    const res = await request(app).post('/api/v2/user/login-user')
      .send({ email: 'probe-admin@t.co', password: 'pass1234' });
    const setCookie = (res.headers['set-cookie'] || []).join(';');
    const flags = {
      httpOnly: /HttpOnly/i.test(setCookie),
      secure: /Secure/i.test(setCookie),
      sameSite: (setCookie.match(/SameSite=(\w+)/i) || [])[1],
    };
    record('I. headers', 'session cookie flags',
      flags.httpOnly ? 'OK' : 'VULNERABLE',
      `httpOnly=${flags.httpOnly} secure=${flags.secure} sameSite=${flags.sameSite}`);
  });

  test('an unknown origin is refused by CORS', async () => {
    const res = await request(app).get('/api/v2/order/list')
      .set('Cookie', admin()).set('Origin', 'https://evil.example');
    const allowed = res.headers['access-control-allow-origin'];
    record('I. headers', 'CORS rejects an unknown origin',
      allowed ? 'VULNERABLE' : 'OK', `ACAO: ${allowed ?? 'absent'} → ${res.status}`);
  });
});
