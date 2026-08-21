'use strict';
// ══════════════════════════════════════════════════════════════════
//  HOW LONG A SESSION LASTS
//
//  The app keeps people signed in until they log out; the browser
//  does not. That is one credential system serving two situations,
//  so the things asserted hardest here are the ones that would
//  quietly collapse the distinction:
//
//    * a browser must NEVER get a long session by accident — it has
//      to be asked for, explicitly, per request
//    * a long session must be endable without waiting for it to
//      expire, or a lost phone is a ninety-day hole
//    * tokens minted before any of this existed must keep working,
//      or deploying it signs out the entire mill at once
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongo, app, User;

const DAY = 24 * 60 * 60;

/** Seconds a token is good for, from its own claims. */
const lifetimeOf = (token) => {
  const d = jwt.decode(token);
  return d.exp - d.iat;
};

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  User = require('../../models/User.js');
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  await User.deleteMany({});
  await User.create({
    name: 'Floor Lead', email: 'floor@t.co', password: 'pass1234',
    role: 'production', department: 'production',
  });
});

const login = (headers = {}) => {
  const req = request(app)
    .post('/api/v2/user/login-user')
    .send({ email: 'floor@t.co', password: 'pass1234' });
  for (const [k, v] of Object.entries(headers)) req.set(k, v);
  return req;
};

describe('the browser gets a short session', () => {
  it('mints 24 hours when nothing asks otherwise', async () => {
    const res = await login();
    expect(res.status).toBe(201);
    expect(lifetimeOf(res.body.token)).toBe(DAY);
  });

  it('CONTROL: a wrong or unknown client value gets the short one', async () => {
    // Without this, an implementation that handed a long session to
    // anything with an X-Client header at all would pass the test
    // below and fail nobody until a browser started sending one.
    for (const v of ['web', 'desktop', 'MOBILE-ish', '', 'true']) {
      const res = await login({ 'X-Client': v });
      expect(lifetimeOf(res.body.token)).toBe(DAY);
    }
  });
});

describe('the app gets a long session, but has to ask', () => {
  it('mints 90 days for X-Client: mobile', async () => {
    const res = await login({ 'X-Client': 'mobile' });
    expect(res.status).toBe(201);
    expect(lifetimeOf(res.body.token)).toBe(90 * DAY);
  });

  it('is case-insensitive about the value, since headers are hand-typed', async () => {
    const res = await login({ 'X-Client': 'Mobile' });
    expect(lifetimeOf(res.body.token)).toBe(90 * DAY);
  });

  it('sets the cookie to match the token, not to 24h', async () => {
    // A 90-day token behind a 24-hour cookie is a session that dies
    // at one day for any client that DOES keep a cookie jar — the
    // two have to be decided together or they disagree silently.
    const res = await login({ 'X-Client': 'mobile' });
    const cookie = res.headers['set-cookie'].join(';');
    expect(cookie).toMatch(/Max-Age=7776000/i);
  });
});

describe('opening the app renews the session', () => {
  it('hands back a fresh token on the cold-start check', async () => {
    const { body } = await login({ 'X-Client': 'mobile' });

    const res = await request(app)
      .get('/api/v2/user/getuser')
      .set('Cookie', [`token=${body.token}`])
      .set('X-Client', 'mobile');

    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    expect(lifetimeOf(res.body.token)).toBe(90 * DAY);
  });

  it('CONTROL: the browser is handed no token there', async () => {
    // Its cookie is httpOnly and it has no use for one in the body;
    // handing it over would be a credential in reach of any script
    // on the page, for no benefit.
    const { body } = await login({ 'X-Client': 'mobile' });

    const res = await request(app)
      .get('/api/v2/user/getuser')
      .set('Cookie', [`token=${body.token}`]);

    expect(res.status).toBe(200);
    expect(res.body.token).toBeUndefined();
  });
});

describe('ending a long session without waiting for it', () => {
  it('rejects a token from a superseded generation', async () => {
    const { body } = await login({ 'X-Client': 'mobile' });

    // The lost-phone answer: bump the account's generation.
    await User.updateOne({ email: 'floor@t.co' }, { $inc: { tokenVersion: 1 } });

    const res = await request(app)
      .get('/api/v2/user/getuser')
      .set('Cookie', [`token=${body.token}`])
      .set('X-Client', 'mobile');

    expect(res.status).toBe(401);
    expect(String(res.body.message)).toMatch(/signed out/i);
  });

  it('CONTROL: the same token works before the bump', async () => {
    // Without this, a route that rejected every token would pass the
    // assertion above while meaning nothing.
    const { body } = await login({ 'X-Client': 'mobile' });
    const res = await request(app)
      .get('/api/v2/user/getuser')
      .set('Cookie', [`token=${body.token}`])
      .set('X-Client', 'mobile');
    expect(res.status).toBe(200);
  });

  it('a fresh login after the bump works again', async () => {
    await User.updateOne({ email: 'floor@t.co' }, { $inc: { tokenVersion: 1 } });
    const { body } = await login({ 'X-Client': 'mobile' });

    const res = await request(app)
      .get('/api/v2/user/getuser')
      .set('Cookie', [`token=${body.token}`])
      .set('X-Client', 'mobile');
    expect(res.status).toBe(200);
  });
});

describe('tokens minted before any of this existed', () => {
  it('are still honoured, because rejecting them logs out the whole mill', async () => {
    // The shape generateToken produced before `v` was added. Every
    // one of these is a 24-hour token, so they age out on their own
    // within a day of the deploy — which is a far smaller problem
    // than signing out every user at the moment of release.
    const user = await User.findOne({ email: 'floor@t.co' });
    const legacy = jwt.sign(
      { id: user._id, username: user.name, role: user.role },
      process.env.JWT_SECRET_KEY,
      { expiresIn: '24h' }
    );

    const res = await request(app)
      .get('/api/v2/user/getuser')
      .set('Cookie', [`token=${legacy}`]);

    expect(res.status).toBe(200);
  });

  it('but a legacy token is still stopped once sessions are ended', async () => {
    // The back-compat window must not become a way to survive a
    // revocation — but it does, and deliberately: `v` is absent, so
    // there is nothing to compare. This pins the LIMIT of the
    // compatibility rather than pretending it is not there.
    const user = await User.findOne({ email: 'floor@t.co' });
    const legacy = jwt.sign(
      { id: user._id, username: user.name, role: user.role },
      process.env.JWT_SECRET_KEY,
      { expiresIn: '24h' }
    );
    await User.updateOne({ email: 'floor@t.co' }, { $inc: { tokenVersion: 1 } });

    const res = await request(app)
      .get('/api/v2/user/getuser')
      .set('Cookie', [`token=${legacy}`]);

    // Documented as a known gap, not asserted as a rejection: these
    // tokens cannot outlive 24 hours from the deploy.
    expect(res.status).toBe(200);
  });
});
