'use strict';
// Coverage for the READ side of per-user feature enforcement
// (requireFeatureRead in middleware/auth.js). Before this, a module NOT in
// a user's admin-granted feature list was fully hidden by the frontend
// nav/route guard, but its API never blocked GETs — only writes. Anyone
// who called the read routes directly (devtools, Postman, a crafted
// request) could still browse the whole module. This file proves the gap
// is closed while three carve-outs keep working: worker self-service
// reads (own payslip/leave/bonus/attendance), legitimate cross-feature
// reads on shared master-data routers, and elastic.js's deliberately open
// shop-floor stock lookups.

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongo, app, User, Employee, admin;

const cookie = (id, role) => [`token=${jwt.sign({ id, role }, process.env.JWT_SECRET_KEY)}`];
const adminCookie = () => cookie(admin._id, 'admin');

const createUser = async (body) => {
  const res = await request(app)
    .post('/api/v2/user/manage/create')
    .set('Cookie', adminCookie())
    .send(body);
  return res;
};

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  User = require('../../models/User.js');
  Employee = require('../../models/Employee.js');
  admin = await User.create({ name: 'Owner', email: 'rg-owner@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

describe('leaf-feature reads are blocked without the feature', () => {
  test('GET is 403 when the explicit feature list omits the module', async () => {
    const c = await createUser({
      name: 'NoWaste2', email: 'nowaste2@t.co', password: 'pass1234',
      department: 'production', features: ['/jobs'], // no /wastage
    });
    const res = await request(app)
      .get('/api/v2/wastage/jobs-for-wastage')
      .set('Cookie', cookie(c.body.user.id, 'production'));
    expect(res.status).toBe(403);
  });

  test('GET is allowed when the feature is present', async () => {
    const c = await createUser({
      name: 'YesWaste2', email: 'yeswaste2@t.co', password: 'pass1234',
      department: 'production', features: ['/jobs', '/wastage'],
    });
    const res = await request(app)
      .get('/api/v2/wastage/jobs-for-wastage')
      .set('Cookie', cookie(c.body.user.id, 'production'));
    expect(res.status).not.toBe(403);
  });

  test('an empty feature list defers to the role gate (read not blocked)', async () => {
    const c = await createUser({
      name: 'EmptyReader', email: 'emptyreader@t.co', password: 'pass1234',
      department: 'production', features: [],
    });
    const res = await request(app)
      .get('/api/v2/wastage/jobs-for-wastage')
      .set('Cookie', cookie(c.body.user.id, 'production'));
    expect(res.status).not.toBe(403);
  });
});

describe('shared master-data reads', () => {
  test('a broader read-side key is honored (machine reads accepted via /jobs)', async () => {
    // machine's read-key list is ('/machines','/jobs','/machine-issues','/analytics') —
    // a user with only /jobs must still be able to read machine data.
    const c = await createUser({
      name: 'JobReader', email: 'jobreader@t.co', password: 'pass1234',
      department: 'production', features: ['/jobs'],
    });
    const res = await request(app)
      .get('/api/v2/machine/get-machines')
      .set('Cookie', cookie(c.body.user.id, 'production'));
    expect(res.status).not.toBe(403);
  });

  test('machine reads are blocked for a feature list with neither key', async () => {
    const c = await createUser({
      name: 'NoMachine', email: 'nomachine@t.co', password: 'pass1234',
      department: 'production', features: ['/wastage'],
    });
    const res = await request(app)
      .get('/api/v2/machine/get-machines')
      .set('Cookie', cookie(c.body.user.id, 'production'));
    expect(res.status).toBe(403);
  });

  test('customer reads are blocked for a finance user without /customers, /orders or /elastic-groups', async () => {
    const c = await createUser({
      name: 'FinanceNoCust', email: 'financenocust@t.co', password: 'pass1234',
      department: 'finance', features: ['/suppliers'],
    });
    const res = await request(app)
      .get('/api/v2/customer/all-customers')
      .set('Cookie', cookie(c.body.user.id, 'accounts'));
    expect(res.status).toBe(403);
  });

  test('customer reads are allowed via the broader /orders read-key', async () => {
    const c = await createUser({
      name: 'FinanceOrders', email: 'financeorders@t.co', password: 'pass1234',
      department: 'finance', features: ['/orders'],
    });
    const res = await request(app)
      .get('/api/v2/customer/all-customers')
      .set('Cookie', cookie(c.body.user.id, 'accounts'));
    expect(res.status).not.toBe(403);
  });
});

describe('worker self-service reads stay open regardless of the feature list', () => {
  let worker, empDoc;

  beforeAll(async () => {
    empDoc = await Employee.create({ name: 'Self Worker', department: 'production', hourlyRate: 50 });
    const created = await createUser({
      name: 'SelfWorker', email: 'selfworker@t.co', password: 'pass1234',
      department: 'production', features: ['/jobs'], // no payroll/leave/bonus/attendance
    });
    worker = await User.findByIdAndUpdate(created.body.user.id, { employee: empDoc._id }, { new: true });
  });

  test('own payslip read (payroll) is not feature-gated', async () => {
    const res = await request(app)
      .get(`/api/v2/payroll/slip/${empDoc._id}`)
      .set('Cookie', cookie(worker._id, 'production'));
    expect(res.status).not.toBe(403);
  });

  test('own leave history read is not feature-gated', async () => {
    const res = await request(app)
      .get(`/api/v2/leave/employee/${empDoc._id}`)
      .set('Cookie', cookie(worker._id, 'production'));
    expect(res.status).not.toBe(403);
  });

  test('own bonus record read is not feature-gated', async () => {
    const res = await request(app)
      .get(`/api/v2/bonus/employee/${empDoc._id}`)
      .set('Cookie', cookie(worker._id, 'production'));
    expect(res.status).not.toBe(403);
  });

  test('own attendance history read is not feature-gated', async () => {
    const res = await request(app)
      .get(`/api/v2/attendance/employee/${empDoc._id}`)
      .query({ startDate: '2024-01-01', endDate: '2024-01-31' })
      .set('Cookie', cookie(worker._id, 'production'));
    expect(res.status).not.toBe(403);
  });

  test('but an admin-only read on the same router is still feature-gated for that worker', async () => {
    // /date is the admin view on attendance — must stay blocked without
    // /attendance even though the worker's own read above is exempt.
    const res = await request(app)
      .get('/api/v2/attendance/date')
      .query({ date: '2024-01-01' })
      .set('Cookie', cookie(worker._id, 'production'));
    expect(res.status).toBe(403);
  });
});

describe('elastic.js reads stay open by design (shop-floor stock lookup)', () => {
  test('GET /elastic/get-elastics is not feature-gated even without /elastics', async () => {
    const c = await createUser({
      name: 'ProdNoElastics', email: 'prodnoelastics@t.co', password: 'pass1234',
      department: 'production', features: ['/jobs'], // /elastics isn't even in production's default set
    });
    const res = await request(app)
      .get('/api/v2/elastic/get-elastics')
      .set('Cookie', cookie(c.body.user.id, 'production'));
    expect(res.status).not.toBe(403);
  });
});
