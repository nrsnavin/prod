'use strict';
// Email-OTP login flow (/user/request-otp + /user/verify-otp).
//
// SMTP is STUBBED here rather than left unconfigured.
//
// This file used to run with no SMTP settings at all, on the basis that
// "the mailer no-ops" — which it did, returning { skipped: true }
// instead of throwing. That no-op was the bug behind "the OTP never
// arrives": /request-otp treated a skip as a send and told the caller a
// code was on its way, on a server that had never been given a mail
// host. The route now refuses with 503 when it has no mailer, so a
// suite that leans on the no-op would be asserting the defect.
//
// The mechanics below — hashing, expiry, the attempt counter, the
// session shape — are what this file is actually about, and they are
// unchanged. It just needs a mail server that accepts the message, so
// it gets a fake one. See tests/api/otpDelivery.test.js for the
// delivery behaviour itself.
//
// The code is read straight off the User document (the raw code isn't
// stored — we re-stamp a known code's hash where a test needs to verify).

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';
process.env.SMTP_HOST = 'smtp.test.local';
process.env.SMTP_USER = 'no-reply@test.local';
process.env.SMTP_PASS = 'stub';

const request = require('supertest');
const mongoose = require('mongoose');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { MongoMemoryServer } = require('mongodb-memory-server');

// Accepts everything and sends nothing.
jest.spyOn(nodemailer, 'createTransport').mockReturnValue({
  sendMail: async () => ({ messageId: '<stub@test.local>' }),
});

let mongo, app, User;

const hash = (raw) => crypto.createHash('sha256').update(String(raw)).digest('hex');

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  User = require('../../models/User.js');
  require('../../utils/mailer.js').resetTransport();
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  await User.deleteMany({});
});

async function seedUser(email = 'otp@t.co') {
  return User.create({ name: 'Otp User', email, password: 'pass1234', role: 'admin', department: 'admin' });
}

// Stamp a known code so verify tests don't need the emailed raw value.
async function stampOtp(user, code = '123456', { expireMs = 10 * 60_000, attempts = 0 } = {}) {
  user.otpCode = hash(code);
  user.otpExpire = new Date(Date.now() + expireMs);
  user.otpAttempts = attempts;
  await user.save({ validateBeforeSave: false });
  return code;
}

describe('POST /user/request-otp', () => {
  test('generic 200 for unknown email (no enumeration)', async () => {
    const res = await request(app).post('/api/v2/user/request-otp').send({ email: 'ghost@t.co' });
    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/if an account exists/i);
  });

  test('stamps a hashed 6-digit code + expiry + zeroed attempts for a real user', async () => {
    const u = await seedUser();
    const res = await request(app).post('/api/v2/user/request-otp').send({ email: 'OTP@t.co' });
    expect(res.status).toBe(200);
    const fresh = await User.findById(u._id).select('+otpCode +otpExpire +otpAttempts');
    expect(fresh.otpCode).toMatch(/^[a-f0-9]{64}$/); // hash, never the raw code
    expect(fresh.otpExpire.getTime()).toBeGreaterThan(Date.now());
    expect(fresh.otpAttempts).toBe(0);
  });

  test('matches a mixed-case stored email', async () => {
    const u = await User.create({ name: 'Mixed', email: 'Navin@T.co', password: 'pass1234', role: 'admin', department: 'admin' });
    await request(app).post('/api/v2/user/request-otp').send({ email: 'navin@t.co' });
    const fresh = await User.findById(u._id).select('+otpCode');
    expect(fresh.otpCode).toBeTruthy();
  });
});

// ══════════════════════════════════════════════════════════════════
//  The OTP response is the WEB APP'S ONLY LOGIN. Its shape is not a
//  detail — the client builds the session from it, and the sidebar,
//  the route guard and every per-feature button read the session's
//  `features` list. When that field was missing the client fell back
//  to the DEPARTMENT defaults, so per-user access simply did not exist
//  in the UI: revoked modules stayed in the nav, their pages opened,
//  and the API's 403 was the first anyone heard of it.
//
//  The old assertion here was `toMatchObject({ username, role,
//  department })` under a title claiming "same JSON shape as login" —
//  which passes just as happily with the field gone. These compare the
//  two responses against each other instead.
// ══════════════════════════════════════════════════════════════════
describe("the OTP response carries everything /login-user does", () => {
  const otpLogin = async (user, code = '424242') => {
    await stampOtp(user, code);
    return request(app).post('/api/v2/user/verify-otp').send({ email: user.email, otp: code });
  };

  test('sends the user\'s explicit feature list', async () => {
    const u = await User.create({
      name: 'Restricted', email: 'restricted@t.co', password: 'pass1234',
      role: 'accounts', department: 'finance', features: ['/orders', '/customers'],
    });

    const res = await otpLogin(u);
    expect(res.status).toBe(201);
    expect(res.body.features).toEqual(['/orders', '/customers']);
    // Specifically NOT the department default, which is far wider.
    expect(res.body.features).not.toContain('/order-pnl');
  });

  test('falls back to the department default for a user with no list', async () => {
    const u = await User.create({
      name: 'Legacy', email: 'legacy@t.co', password: 'pass1234',
      role: 'accounts', department: 'finance',
    });

    const res = await otpLogin(u);
    expect(Array.isArray(res.body.features)).toBe(true);
    expect(res.body.features).toContain('/orders');
  });

  test('key-for-key, the OTP body matches the password login body', async () => {
    const u = await User.create({
      name: 'Both Paths', email: 'bothpaths@t.co', password: 'pass1234',
      role: 'accounts', department: 'finance', features: ['/orders'],
    });

    const pwd = await request(app)
      .post('/api/v2/user/login-user')
      .send({ email: 'bothpaths@t.co', password: 'pass1234' });
    const otp = await otpLogin(u);

    expect(pwd.status).toBe(201);
    expect(otp.status).toBe(201);
    // The token differs by design (fresh signature); everything the
    // client builds a session from must not.
    const shape = (b) => { const { token, ...rest } = b; return rest; };
    expect(shape(otp.body)).toEqual(shape(pwd.body));
  });
});

describe('POST /user/verify-otp', () => {
  test('correct code signs in: 201, token cookie, same JSON shape as login', async () => {
    const u = await seedUser();
    const code = await stampOtp(u);
    const res = await request(app).post('/api/v2/user/verify-otp').send({ email: 'otp@t.co', otp: code });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ username: 'Otp User', role: 'admin', department: 'admin' });
    expect(res.body.token).toBeTruthy();
    expect(res.headers['set-cookie'].join(';')).toMatch(/token=/);
    // single-use: cleared on success
    const fresh = await User.findById(u._id).select('+otpCode');
    expect(fresh.otpCode).toBeFalsy();
  });

  test('the code cannot be replayed after success', async () => {
    const u = await seedUser();
    const code = await stampOtp(u);
    await request(app).post('/api/v2/user/verify-otp').send({ email: 'otp@t.co', otp: code });
    const replay = await request(app).post('/api/v2/user/verify-otp').send({ email: 'otp@t.co', otp: code });
    expect(replay.status).toBe(401);
  });

  test('wrong code is rejected and attempts increment', async () => {
    const u = await seedUser();
    await stampOtp(u, '123456');
    const res = await request(app).post('/api/v2/user/verify-otp').send({ email: 'otp@t.co', otp: '000000' });
    expect(res.status).toBe(401);
    const fresh = await User.findById(u._id).select('+otpAttempts +otpCode');
    expect(fresh.otpAttempts).toBe(1);
    expect(fresh.otpCode).toBeTruthy(); // still live for a retry
  });

  test('the code dies after 5 wrong guesses — even the right code then fails', async () => {
    const u = await seedUser();
    const code = await stampOtp(u, '123456', { attempts: 5 });
    const res = await request(app).post('/api/v2/user/verify-otp').send({ email: 'otp@t.co', otp: code });
    expect(res.status).toBe(401);
    const fresh = await User.findById(u._id).select('+otpCode');
    expect(fresh.otpCode).toBeFalsy(); // burned
  });

  test('an expired code is rejected and cleared', async () => {
    const u = await seedUser();
    const code = await stampOtp(u, '123456', { expireMs: -60_000 });
    const res = await request(app).post('/api/v2/user/verify-otp').send({ email: 'otp@t.co', otp: code });
    expect(res.status).toBe(401);
    const fresh = await User.findById(u._id).select('+otpCode');
    expect(fresh.otpCode).toBeFalsy();
  });

  test('unknown email gets the same generic 401 as a bad code', async () => {
    const res = await request(app).post('/api/v2/user/verify-otp').send({ email: 'ghost@t.co', otp: '123456' });
    expect(res.status).toBe(401);
    expect(res.body.message).toMatch(/invalid or expired/i);
  });

  test('a numeric otp in the JSON body is accepted', async () => {
    const u = await seedUser();
    await stampOtp(u, '123456');
    const res = await request(app).post('/api/v2/user/verify-otp').send({ email: 'otp@t.co', otp: 123456 });
    expect(res.status).toBe(201);
  });

  test('password login still works as the emergency fallback', async () => {
    await seedUser();
    const res = await request(app).post('/api/v2/user/login-user').send({ email: 'otp@t.co', password: 'pass1234' });
    expect(res.status).toBe(201);
  });
});
