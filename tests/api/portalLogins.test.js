'use strict';
// ══════════════════════════════════════════════════════════════════
//  A CUSTOMER'S PORTAL LOGIN, AFTER IT HAS BEEN MADE
//
//  A login could be created and listed, and that was all. One given to a
//  buyer who has since left the customer could not be switched off; a
//  password that had got out could not be changed; one made by mistake
//  could not be removed. Held here:
//
//    • switched off, it stops working at once — the session already open
//      included — and switched on again it works;
//    • given a new password, the old one and every session opened with
//      it are refused (a portal session otherwise lasts a week);
//    • removed, it is gone;
//    • only through the customer it belongs to.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongo, app, Customer, CustomerUser, User, adminCookie, acme, other;
const PASSWORD = 'cotton-reel-7';

const office = {
  post:  (url, body) => request(app).post(`/api/v2${url}`).set('Cookie', adminCookie).send(body),
  patch: (url, body) => request(app).patch(`/api/v2${url}`).set('Cookie', adminCookie).send(body),
  del:   (url) => request(app).delete(`/api/v2${url}`).set('Cookie', adminCookie),
  get:   (url) => request(app).get(`/api/v2${url}`).set('Cookie', adminCookie),
};
const login = (email, password = PASSWORD) => request(app).post('/api/v3/portal/auth/login').send({ email, password });
const me = (cookie) => request(app).get('/api/v3/portal/auth/me').set('Cookie', cookie);
/** The portal cookie a sign-in set, to send back. */
const sessionOf = (res) => [String(res.headers['set-cookie']).split(';')[0]];

let n = 0;
/** A login for `customer`, made the way the office makes one. */
async function makeLogin(customer = acme, over = {}) {
  const email = `buyer${++n}@acme.test`;
  const res = await office.post(`/customer/${customer._id}/portal-users`, { name: 'Ravi Buyer', email, password: PASSWORD, ...over });
  expect(res.status).toBe(201);
  return { id: String(res.body.user._id), email };
}
const change = (id, body, customer = acme) => office.patch(`/customer/${customer._id}/portal-users/${id}`, body);

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  Customer = require('../../models/Customer.js');
  CustomerUser = require('../../models/CustomerUser.js');
  User = require('../../models/User.js');
  const admin = await User.create({ name: 'Owner', email: 'own@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  adminCookie = [`token=${jwt.sign({ id: admin._id, role: 'admin', v: 0 }, process.env.JWT_SECRET_KEY)}`];
  acme = await Customer.create({ name: 'Acme Garments', contactName: 'Buyer', phoneNumber: '9000000001' });
  other = await Customer.create({ name: 'Other Mills', contactName: 'Buyer', phoneNumber: '9000000002' });
}, 120_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => { await CustomerUser.deleteMany({}); });

describe('a login switched off', () => {
  it('stops working at once — the session already open as well — and works again when switched on', async () => {
    const { id, email } = await makeLogin();
    const session = sessionOf(await login(email));
    expect((await me(session)).status).toBe(200);

    const off = await change(id, { status: 'disabled' });
    expect(off.status).toBe(200);
    expect(off.body).toMatchObject({ sessionsEnded: true, user: { status: 'disabled', email } });
    expect((await me(session)).status).toBe(401);
    expect((await login(email)).status).toBe(401);

    const on = await change(id, { status: 'active' });
    expect(on.body).toMatchObject({ sessionsEnded: false, user: { status: 'active' } });
    // The session from before stays ended; signing in again is what works.
    expect((await me(session)).status).toBe(401);
    const again = await login(email);
    expect(again.status).toBe(200);
    expect((await me(sessionOf(again))).status).toBe(200);
  });

  it('shows as switched off in the customer\'s list of logins', async () => {
    const { id } = await makeLogin();
    await change(id, { status: 'disabled' });
    const list = await office.get(`/customer/${acme._id}/portal-users`);
    expect(list.body.users.map((u) => u.status)).toEqual(['disabled']);
  });
});

describe('a login given a new password', () => {
  it('refuses the old password and the sessions opened with it', async () => {
    const { id, email } = await makeLogin();
    const session = sessionOf(await login(email));

    const res = await change(id, { password: 'bobbin-lace-42' });
    expect(res.status).toBe(200);
    expect(res.body.sessionsEnded).toBe(true);
    expect(res.body.user.password).toBeUndefined();

    expect((await me(session)).status).toBe(401);
    expect((await login(email, PASSWORD)).status).toBe(401);
    const fresh = await login(email, 'bobbin-lace-42');
    expect(fresh.status).toBe(200);
    expect((await me(sessionOf(fresh))).status).toBe(200);
    // Stored as a hash, never as typed.
    const stored = await CustomerUser.findById(id).select('+password').lean();
    expect(stored.password).not.toContain('bobbin-lace-42');
  });

  it('is held to the rule a new login is held to', async () => {
    const { id, email } = await makeLogin();
    for (const weak of ['short', 'password', 12345678]) {
      const res = await change(id, { password: weak });
      expect([String(weak), res.status]).toEqual([String(weak), 400]);
    }
    expect((await login(email)).status).toBe(200); // and nothing was changed
  });

  it('CONTROL: a name, phone or role changed leaves the session as it is', async () => {
    const { id, email } = await makeLogin();
    const session = sessionOf(await login(email));
    const res = await change(id, { name: ' Ravi K ', phone: '98765 43210', role: 'accountant' });
    expect(res.body).toMatchObject({ sessionsEnded: false, user: { name: 'Ravi K', phone: '98765 43210', role: 'accountant' } });
    expect((await me(session)).status).toBe(200);
  });
});

describe('a login removed', () => {
  it('is gone: no sign-in, no session, not on the list', async () => {
    const { id, email } = await makeLogin();
    const session = sessionOf(await login(email));

    const res = await office.del(`/customer/${acme._id}/portal-users/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.removed.email).toBe(email);
    expect((await me(session)).status).toBe(401);
    expect((await login(email)).status).toBe(401);
    expect((await office.get(`/customer/${acme._id}/portal-users`)).body.users).toEqual([]);
    expect((await office.del(`/customer/${acme._id}/portal-users/${id}`)).status).toBe(404);
  });
});

describe('whose login it is', () => {
  it('is changed only through the customer it belongs to', async () => {
    const { id, email } = await makeLogin(acme);
    expect((await change(id, { status: 'disabled' }, other)).status).toBe(404);
    expect((await office.del(`/customer/${other._id}/portal-users/${id}`)).status).toBe(404);
    expect((await login(email)).status).toBe(200);
  });

  it('refuses what is not a status, a role, a name or an id', async () => {
    const { id } = await makeLogin();
    expect((await change(id, { status: 'paused' })).body.message).toBe('status must be active or disabled');
    expect((await change(id, { role: 'owner' })).body.message).toBe('role must be buyer, viewer or accountant');
    expect((await change(id, { name: ' ' })).status).toBe(400);
    expect((await change('not-an-id', { status: 'disabled' })).status).toBe(404);
    expect((await change(String(new mongoose.Types.ObjectId()), { status: 'disabled' })).status).toBe(404);
  });

  it('is the office\'s to do: nobody signed out, and no customer, can', async () => {
    const { id, email } = await makeLogin();
    const url = `/api/v2/customer/${acme._id}/portal-users/${id}`;
    expect((await request(app).patch(url).send({ status: 'disabled' })).status).toBe(401);
    // A customer's own portal session is not a staff session.
    const session = sessionOf(await login(email));
    expect((await request(app).patch(url).set('Cookie', session).send({ role: 'accountant' })).status).toBe(401);
    expect((await request(app).delete(url).set('Cookie', session)).status).toBe(401);
    expect((await CustomerUser.findById(id).lean()).role).toBe('buyer');
  });
});

describe('a session from before sessions carried a version', () => {
  it('is good until the password changes', async () => {
    const { id } = await makeLogin();
    const user = await CustomerUser.findById(id);
    // As a token was signed before: the same claims, no version.
    const old = jwt.sign({ id: user._id, role: 'customer', customer: user.customer },
      process.env.JWT_SECRET_KEY, { audience: 'portal', expiresIn: '7d', algorithm: 'HS256' });
    expect((await me([`portalToken=${old}`])).status).toBe(200);
    await change(id, { password: 'bobbin-lace-42' });
    expect((await me([`portalToken=${old}`])).status).toBe(401);
  });
});
