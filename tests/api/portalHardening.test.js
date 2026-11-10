'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE CUSTOMER PORTAL'S SIGN-IN
//
//  Mounted on /api/v3, which had no limiter of any kind (they were all
//  on /api/v2), so a customer's password could be guessed without limit.
//  And "log out" did not clear the cookie the way it was set, which a
//  browser on another site ignores. Held here:
//
//    • wrong passwords for one account are cut off, like a staff login;
//    • signing out clears the cookie with the attributes it was set
//      with (and never a maxAge, which Express turns back into a future
//      expiry);
//    • a new portal password is held to the staff rule.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongo, app, Customer, CustomerUser, User, adminCookie, acme;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  Customer = require('../../models/Customer.js');
  CustomerUser = require('../../models/CustomerUser.js');
  User = require('../../models/User.js');
  const admin = await User.create({ name: 'Owner', email: 'own@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  adminCookie = [`token=${jwt.sign({ id: admin._id, role: 'admin', v: 0 }, process.env.JWT_SECRET_KEY)}`];
  acme = await Customer.create({ name: 'Acme Garments', gstin: '33AAAAA0000A1Z5', contactName: 'Buyer', phoneNumber: '9000000001' });
  await CustomerUser.create({ customer: acme._id, name: 'Buyer', email: 'buyer@acme.test', password: 'cotton-reel-7' });
}, 120_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

const login = (email, password) => request(app).post('/api/v3/portal/auth/login').send({ email, password });

describe('guessing a portal password', () => {
  it('is cut off, per account, and the right password then waits too', async () => {
    let last;
    for (let i = 0; i < 25; i++) {
      last = await login('buyer@acme.test', `wrong-${i}`);
      if (last.status === 429) break;
      expect(last.status).toBe(401);
    }
    expect(last.status).toBe(429);
    expect(last.body.message).toMatch(/too many login attempts/i);
    expect((await login('buyer@acme.test', 'cotton-reel-7')).status).toBe(429);
  }, 120_000);

  it('CONTROL: another account at the same address is not held up by it', async () => {
    await CustomerUser.create({ customer: acme._id, name: 'Accounts', email: 'accounts@acme.test', password: 'cotton-reel-8' });
    expect((await login('accounts@acme.test', 'cotton-reel-8')).status).toBe(200);
  });
});

describe('signing out of the portal', () => {
  it('clears the cookie the way it was set', async () => {
    await CustomerUser.create({ customer: acme._id, name: 'Viewer', email: 'viewer@acme.test', password: 'cotton-reel-9' });
    const inRes = await login('viewer@acme.test', 'cotton-reel-9');
    expect(inRes.status).toBe(200);
    const set = String(inRes.headers['set-cookie']);
    const attrs = (cookie) => ({
      httpOnly: /HttpOnly/i.test(cookie),
      sameSite: (/SameSite=(\w+)/i.exec(cookie) || [])[1],
      path: (/Path=([^;]+)/i.exec(cookie) || [])[1],
    });

    const out = await request(app).post('/api/v3/portal/auth/logout');
    expect(out.status).toBe(200);
    const cleared = String(out.headers['set-cookie']);
    expect(cleared).toMatch(/portalToken=;/);
    expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970/);
    expect(cleared).not.toMatch(/Max-Age/i);
    expect(attrs(cleared)).toEqual(attrs(set));
  });

  it('in production that means SameSite=None and Secure, or a browser on another site ignores it', async () => {
    const was = process.env.NODE_ENV;
    process.env.NODE_ENV = 'PRODUCTION';
    try {
      const out = await request(app).post('/api/v3/portal/auth/logout');
      const cleared = String(out.headers['set-cookie']);
      expect(cleared).toMatch(/SameSite=None/);
      expect(cleared).toMatch(/Secure/);
    } finally {
      process.env.NODE_ENV = was;
    }
  });
});

describe('a portal token', () => {
  it('signed with any algorithm but ours is refused', async () => {
    const u = await CustomerUser.findOne({ email: 'buyer@acme.test' });
    const hs512 = jwt.sign({ id: u._id, role: 'customer' }, process.env.JWT_SECRET_KEY, { audience: 'portal', algorithm: 'HS512' });
    const res = await request(app).get('/api/v3/portal/auth/me').set('Cookie', [`portalToken=${hs512}`]);
    expect(res.status).toBe(401);
    // CONTROL: its own token works.
    const ok = await request(app).get('/api/v3/portal/auth/me').set('Cookie', [`portalToken=${u.getJwtToken()}`]);
    expect(ok.status).toBe(200);
  });
});

describe('a new portal login', () => {
  const create = (body) => request(app).post(`/api/v2/customer/${acme._id}/portal-users`).set('Cookie', adminCookie).send(body);

  it('needs a password that would do for a staff login', async () => {
    for (const [password, why] of [['short', /at least 8/], ['password', /easy to guess/], ['newbuyer@acme.test', /your email/]]) {
      const res = await create({ name: 'New Buyer', email: 'newbuyer@acme.test', password });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(why);
    }
    expect(await CustomerUser.countDocuments({ email: 'newbuyer@acme.test' })).toBe(0);
    expect((await create({ name: 'New Buyer', email: 'NewBuyer@Acme.test', password: 'cotton-reel-10' })).status).toBe(201);
    expect(await CustomerUser.countDocuments({ email: 'newbuyer@acme.test' })).toBe(1);
  });

  it('needs an email address, and plain text for a name', async () => {
    expect((await create({ name: 'X', email: 'not-an-address', password: 'cotton-reel-11' })).status).toBe(400);
    expect((await create({ name: { $ne: null }, email: 'a@acme.test', password: 'cotton-reel-11' })).status).toBe(400);
  });
});
