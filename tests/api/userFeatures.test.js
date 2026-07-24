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
      department: 'weaving', features: ['/jobs', '/wastage'],
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
      department: 'weaving', features: ['/jobs', '/not-a-real-feature', 42],
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
      department: 'weaving', features: ['/jobs'],
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
});

describe('feature config drives API enforcement', () => {
  test('a user WITHOUT the feature is blocked from that route (403)', async () => {
    const c = await createUser({
      name: 'NoWaste', email: 'nowaste@t.co', password: 'pass1234',
      department: 'weaving', features: ['/jobs'],   // explicit, no /wastage
    });
    const res = await request(app)
      .get('/api/v2/wastage/jobs-for-wastage')
      .set('Cookie', cookie(c.body.user.id, 'production'));
    expect(res.status).toBe(403);
  });

  test('a user WITH the feature is not blocked', async () => {
    const c = await createUser({
      name: 'YesWaste', email: 'yeswaste@t.co', password: 'pass1234',
      department: 'weaving', features: ['/jobs', '/wastage'],
    });
    const res = await request(app)
      .get('/api/v2/wastage/jobs-for-wastage')
      .set('Cookie', cookie(c.body.user.id, 'production'));
    expect(res.status).not.toBe(403);
  });

  test('a user with an empty feature list defers to the role gate (not blocked)', async () => {
    const c = await createUser({
      name: 'Empty', email: 'empty@t.co', password: 'pass1234',
      department: 'weaving', features: [],
    });
    expect(c.body.user.features).toEqual([]);
    const res = await request(app)
      .get('/api/v2/wastage/jobs-for-wastage')
      .set('Cookie', cookie(c.body.user.id, 'production'));
    expect(res.status).not.toBe(403);
  });
});
