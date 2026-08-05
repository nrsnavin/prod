'use strict';
// End-to-end checks for admin-configured per-user feature access
// (/user/manage/* + /user/me) and the API enforcement it drives.
// Runs the real Express app against an in-memory Mongo with JWT cookies.

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { featuresForDepartment } = require('../../utils/features');

let mongo, app, User, admin;

const cookie = (id, role) => [`token=${jwt.sign({ id, role }, process.env.JWT_SECRET_KEY)}`];
const adminCookie = () => cookie(admin._id, 'admin');

// Create a user through the admin endpoint and return the JSON user.
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
  admin = await User.create({ name: 'Owner', email: 'owner@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

describe('admin configures features on create', () => {
  test('an explicit feature list is stored (sanitized) and returned', async () => {
    const res = await createUser({
      name: 'Wilma', email: 'wilma@t.co', password: 'pass1234',
      department: 'production', features: ['/jobs', '/wastage'],
    });
    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe('production');       // derived from dept
    expect(res.body.user.features.sort()).toEqual(['/jobs', '/wastage']);
    const doc = await User.findById(res.body.user.id).lean();
    expect(doc.features.sort()).toEqual(['/jobs', '/wastage']);
  });

  test('unknown feature keys are dropped', async () => {
    const res = await createUser({
      name: 'Fred', email: 'fred@t.co', password: 'pass1234',
      department: 'production', features: ['/jobs', '/not-a-real-feature', 42],
    });
    expect(res.status).toBe(201);
    expect(res.body.user.features).toEqual(['/jobs']);
  });

  test('features outside the role/department scope are dropped', async () => {
    // '/orders' is a valid feature key but NOT in a production user's scope
    // (it's admin/finance) — it must not be stored on a production account.
    const res = await createUser({
      name: 'Scoped', email: 'scoped@t.co', password: 'pass1234',
      department: 'production', features: ['/jobs', '/orders', '/reports'],
    });
    expect(res.status).toBe(201);
    expect(res.body.user.features).toEqual(['/jobs']);
  });

  test('omitting features falls back to the department default', async () => {
    const res = await createUser({
      name: 'Betty', email: 'betty@t.co', password: 'pass1234', department: 'finance',
    });
    expect(res.status).toBe(201);
    expect(res.body.user.features.sort()).toEqual(featuresForDepartment('finance').sort());
  });
});

describe('admin edits features', () => {
  test('PUT replaces the feature list and the change persists', async () => {
    const created = await createUser({
      name: 'Barney', email: 'barney@t.co', password: 'pass1234',
      department: 'production', features: ['/jobs'],
    });
    const id = created.body.user.id;

    const put = await request(app)
      .put(`/api/v2/user/manage/${id}`)
      .set('Cookie', adminCookie())
      .send({ features: ['/jobs', '/machines', '/wastage'] });
    expect(put.status).toBe(200);
    expect(put.body.user.features.sort()).toEqual(['/jobs', '/machines', '/wastage']);

    const list = await request(app).get('/api/v2/user/manage/list').set('Cookie', adminCookie());
    expect(list.status).toBe(200);
    // The list exposes the feature catalog + each user's stored set.
    expect(Array.isArray(list.body.features)).toBe(true);
    const row = list.body.users.find((u) => u._id === id);
    expect(row.features.sort()).toEqual(['/jobs', '/machines', '/wastage']);
  });
});

describe('/user/me effective features', () => {
  test('a user with no stored features is backfilled from department', async () => {
    // Insert directly to simulate a legacy account (empty features).
    const legacy = await User.create({ name: 'Legacy', email: 'legacy@t.co', password: 'pass1234', role: 'production', department: 'packing' });
    const me = await request(app).get('/api/v2/user/me').set('Cookie', cookie(legacy._id, 'production'));
    expect(me.status).toBe(200);
    expect(me.body.user.features.sort()).toEqual(featuresForDepartment('packing').sort());
  });

  // The profile page's "member since" reads this — without it, the only
  // way to answer "when was this account created?" is a database query.
  test('carries the account creation date, for the profile page', async () => {
    const created = await createUser({
      name: 'DateCheck', email: 'datecheck@t.co', password: 'pass1234', department: 'finance',
    });
    const me = await request(app).get('/api/v2/user/me')
      .set('Cookie', cookie(created.body.user.id, 'finance'));
    expect(me.status).toBe(200);
    expect(me.body.user.createdAt).toBeTruthy();
    expect(new Date(me.body.user.createdAt).getTime()).not.toBeNaN();
  });

  test('carries email, department and the linked employee record', async () => {
    const me = await request(app).get('/api/v2/user/me').set('Cookie', adminCookie());
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe('owner@t.co');
    expect(me.body.user.department).toBe('admin');
    // This admin fixture has no linked Employee — must read as null, not
    // undefined or a throw, so the page can render "not linked" cleanly.
    expect(me.body.user.employee).toBeNull();
  });
});

describe('feature config drives API enforcement (writes only)', () => {
  test('a WRITE is blocked (403) when the user lacks the feature', async () => {
    const c = await createUser({
      name: 'NoWaste', email: 'nowaste@t.co', password: 'pass1234',
      department: 'production', features: ['/jobs'],   // explicit, no /wastage
    });
    const res = await request(app)
      .post('/api/v2/wastage/anything')
      .set('Cookie', cookie(c.body.user.id, 'production'))
      .send({});
    expect(res.status).toBe(403);
  });

  test('a WRITE is allowed when the user has the feature', async () => {
    const c = await createUser({
      name: 'YesWaste', email: 'yeswaste@t.co', password: 'pass1234',
      department: 'production', features: ['/jobs', '/wastage'],
    });
    const res = await request(app)
      .post('/api/v2/wastage/anything')
      .set('Cookie', cookie(c.body.user.id, 'production'))
      .send({});
    expect(res.status).not.toBe(403);
  });

  test('READS are never feature-gated (GET passes without the feature)', async () => {
    const c = await createUser({
      name: 'Reader', email: 'reader@t.co', password: 'pass1234',
      department: 'production', features: ['/jobs'],   // no /wastage
    });
    const res = await request(app)
      .get('/api/v2/wastage/jobs-for-wastage')
      .set('Cookie', cookie(c.body.user.id, 'production'));
    expect(res.status).not.toBe(403); // read allowed despite missing feature
  });

  test('an empty feature list defers to the role gate (write not blocked)', async () => {
    const c = await createUser({
      name: 'Empty', email: 'empty@t.co', password: 'pass1234',
      department: 'production', features: [],
    });
    expect(c.body.user.features).toEqual([]);
    const res = await request(app)
      .post('/api/v2/wastage/anything')
      .set('Cookie', cookie(c.body.user.id, 'production'))
      .send({});
    expect(res.status).not.toBe(403);
  });

  // The exact case reported: an ADMIN-role user whose custom features omit
  // /attendance must not be able to write attendance (no admin bypass),
  // but WITH it, they can — and reads are always fine.
  test('an admin without /attendance cannot write attendance; with it, can', async () => {
    const denied = await createUser({
      name: 'AdminNoAtt', email: 'adminnoatt@t.co', password: 'pass1234',
      department: 'admin', features: ['/orders'],   // admin, but no /attendance
    });
    const dRes = await request(app)
      .post('/api/v2/attendance/mark')
      .set('Cookie', cookie(denied.body.user.id, 'admin'))
      .send({});
    expect(dRes.status).toBe(403);

    const allowed = await createUser({
      name: 'AdminAtt', email: 'adminatt@t.co', password: 'pass1234',
      department: 'admin', features: ['/attendance'],
    });
    const aRes = await request(app)
      .post('/api/v2/attendance/mark')
      .set('Cookie', cookie(allowed.body.user.id, 'admin'))
      .send({});
    expect(aRes.status).not.toBe(403);
  });
});
