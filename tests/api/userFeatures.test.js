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

// /sign-up used to pass req.body straight into User.create, so a request
// could set any schema path — arbitrary feature strings, or a role that
// contradicts the department — producing accounts the Users page and the
// feature gates then reason about incorrectly.
describe('sign-up cannot set privileged fields directly', () => {
  test('role is derived from department, not taken from the body', async () => {
    const res = await request(app)
      .post('/api/v2/user/sign-up')
      .set('Cookie', adminCookie())
      .send({
        name: 'Sneaky', email: 'sneaky@t.co', password: 'pass1234',
        department: 'production', role: 'admin',
      });
    expect(res.status).toBe(200);
    const doc = await User.findById(res.body.user._id ?? res.body.user.id).lean();
    expect(doc.role).toBe('production');
  });

  test('unknown feature keys are dropped rather than stored verbatim', async () => {
    const res = await request(app)
      .post('/api/v2/user/sign-up')
      .set('Cookie', adminCookie())
      .send({
        name: 'Sneaky2', email: 'sneaky2@t.co', password: 'pass1234',
        department: 'production', features: ['/jobs', '/not-a-real-feature'],
      });
    expect(res.status).toBe(200);
    const doc = await User.findById(res.body.user._id ?? res.body.user.id).lean();
    expect(doc.features).toEqual(['/jobs']);
  });
});

// Now that [] means "granted nothing" rather than "defer to the role
// gate", a request whose features all fall outside the department's scope
// must NOT be quietly stored as [] — that would lock the account out of
// every module. The likely trigger is changing the department without
// re-picking features (both shipped clients re-seed, but the API is
// callable directly).
describe('an out-of-scope feature list is a mismatch, not a revocation', () => {
  test('create rejects a list that scopes down to nothing', async () => {
    const res = await createUser({
      name: 'Mismatch', email: 'mismatch@t.co', password: 'pass1234',
      department: 'finance',
      features: ['/warping', '/covering'], // production keys, not finance
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/none of the selected features/i);
    expect(await User.findOne({ email: 'mismatch@t.co' })).toBeNull();
  });

  test('update rejects a list that scopes down to nothing', async () => {
    const created = await createUser({
      name: 'DeptSwap', email: 'deptswap@t.co', password: 'pass1234',
      department: 'production', features: ['/warping'],
    });
    const id = created.body.user.id;

    // Move them to finance while still sending the production keys.
    const put = await request(app)
      .put(`/api/v2/user/manage/${id}`)
      .set('Cookie', adminCookie())
      .send({ department: 'finance', features: ['/warping'] });

    expect(put.status).toBe(400);
    // And the stored list is untouched — not silently emptied.
    const doc = await User.findById(id).lean();
    expect(doc.features).toEqual(['/warping']);
  });

  test('but an explicit empty list is still honoured as "grant nothing"', async () => {
    const created = await createUser({
      name: 'DeliberateNone', email: 'deliberatenone@t.co', password: 'pass1234',
      department: 'production', features: ['/warping'],
    });
    const put = await request(app)
      .put(`/api/v2/user/manage/${created.body.user.id}`)
      .set('Cookie', adminCookie())
      .send({ features: [] });

    expect(put.status).toBe(200);
    const doc = await User.findById(created.body.user.id).lean();
    // Persisted as a real empty array — if it came back undefined it would
    // read as "never configured" and grant everything the role allows.
    expect(Array.isArray(doc.features)).toBe(true);
    expect(doc.features).toEqual([]);
  });

  test('a partially out-of-scope list keeps the in-scope keys', async () => {
    const res = await createUser({
      name: 'Partial', email: 'partial@t.co', password: 'pass1234',
      department: 'production', features: ['/warping', '/orders'], // /orders is finance
    });
    expect(res.status).toBe(201);
    expect(res.body.user.features).toEqual(['/warping']);
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

  // Closing the read gap: a GET is now blocked exactly like a write when
  // the user's explicit feature list omits the module. See
  // tests/api/featureReadGate.test.js for full coverage of this behavior.
  test('READS are feature-gated the same as writes (GET blocked without the feature)', async () => {
    const c = await createUser({
      name: 'Reader', email: 'reader@t.co', password: 'pass1234',
      department: 'production', features: ['/jobs'],   // no /wastage
    });
    const res = await request(app)
      .get('/api/v2/wastage/jobs-for-wastage')
      .set('Cookie', cookie(c.body.user.id, 'production'));
    expect(res.status).toBe(403);
  });

  // An EMPTY list is a decision — the admin ticked nothing — and is
  // denied. An ABSENT list is an account that predates the feature system
  // (the create-admin owner, the WhatsApp bot, legacy logins) and defers
  // to the role gate. The two used to be the same value, so the guards
  // could only honour the permissive reading.
  test('an explicitly empty feature list grants nothing (write blocked)', async () => {
    const c = await createUser({
      name: 'Empty', email: 'empty@t.co', password: 'pass1234',
      department: 'production', features: [],
    });
    expect(c.body.user.features).toEqual([]);
    // Stored as a real empty array, not dropped back to undefined —
    // otherwise it would read as "never configured" and grant everything.
    const doc = await User.findById(c.body.user.id).lean();
    expect(Array.isArray(doc.features)).toBe(true);
    expect(doc.features).toEqual([]);

    const res = await request(app)
      .post('/api/v2/wastage/anything')
      .set('Cookie', cookie(c.body.user.id, 'production'))
      .send({});
    expect(res.status).toBe(403);
  });

  test('an account with NO feature list still defers to the role gate', async () => {
    // Created straight through the model, the way scripts/create-admin.js
    // and the WhatsApp bot do — no features key at all.
    const legacy = await User.create({
      name: 'NoList', email: 'nolist@t.co', password: 'pass1234',
      role: 'production', department: 'production',
    });
    expect(legacy.features).toBeUndefined();

    const res = await request(app)
      .post('/api/v2/wastage/anything')
      .set('Cookie', cookie(legacy._id, 'production'))
      .send({});
    expect(res.status).not.toBe(403);
  });

  // The lockout this fix had to avoid: the owner login is created with no
  // features, so it must keep reaching the Users screen.
  test('the create-admin style owner keeps full access', async () => {
    const owner = await User.create({
      name: 'Owner2', email: 'owner2@t.co', password: 'pass1234',
      role: 'admin', department: 'admin',
    });
    const res = await request(app)
      .get('/api/v2/user/manage/list')
      .set('Cookie', cookie(owner._id, 'admin'));
    expect(res.status).toBe(200);
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
