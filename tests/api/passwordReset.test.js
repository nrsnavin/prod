'use strict';
// Forgot / reset password flow. Exercises the real Express app:
//  - /forgot-password never reveals whether an email has an account
//  - it stamps a hashed (not raw) reset token with an expiry
//  - /reset-password consumes a valid token, rotates the password,
//    and invalidates the token so it can't be replayed
//  - expired / wrong / already-used tokens are rejected
//
// SMTP is STUBBED, not left unconfigured.
//
// This file used to run with no SMTP settings, on the basis that "the
// mailer degrades to a no-op". It did — returning { skipped: true }
// rather than throwing — and that no-op was the bug behind "the email
// never arrives": /forgot-password treated a skip as a send, promised a
// reset link it had not sent, and left a live reset token on the
// account for its whole lifetime. The route now refuses with 503 when
// it has no mailer, so a suite that leans on the no-op would be
// asserting the defect.
//
// Everything below — the hashed token, the expiry, single use, replay
// rejection — is unchanged. It just needs a mail server that accepts
// the message, so it gets a fake one that sends nothing. See
// tests/api/otpDelivery.test.js for the delivery behaviour itself.

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

// Accepts everything and sends nothing — no real message can escape CI.
jest.spyOn(nodemailer, 'createTransport').mockReturnValue({
  sendMail: async () => ({ messageId: '<stub@test.local>' }),
});

let mongo, app, User;

const hash = (raw) => crypto.createHash('sha256').update(raw).digest('hex');

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

describe('POST /user/forgot-password', () => {
  test('returns a generic success for an unknown email (no enumeration)', async () => {
    const res = await request(app)
      .post('/api/v2/user/forgot-password')
      .send({ email: 'ghost@nowhere.co' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.message).toMatch(/if an account exists/i);
  });

  test('requires an email', async () => {
    const res = await request(app).post('/api/v2/user/forgot-password').send({});
    expect(res.status).toBe(400);
  });

  test('finds an account stored with a MIXED-case email (legacy /sign-up data)', async () => {
    const u = await User.create({ name: 'Legacy', email: 'Navin@Baluelastics.com', password: 'pass1234', role: 'admin', department: 'admin' });
    const res = await request(app)
      .post('/api/v2/user/forgot-password')
      .send({ email: 'navin@baluelastics.com' });
    expect(res.status).toBe(200);
    const fresh = await User.findById(u._id).select('+resetPasswordToken');
    expect(fresh.resetPasswordToken).toBeTruthy(); // matched despite case difference
  });

  test('regex metacharacters in the email cannot break the lookup', async () => {
    const res = await request(app)
      .post('/api/v2/user/forgot-password')
      .send({ email: 'a+b.*@t.co' });
    expect(res.status).toBe(200); // generic success, no 500
  });

  test('stamps a hashed token + expiry for a real user, and returns the same generic message', async () => {
    const u = await User.create({ name: 'Reset Me', email: 'reset@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
    const res = await request(app)
      .post('/api/v2/user/forgot-password')
      .send({ email: 'RESET@t.co' }); // case-insensitive
    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/if an account exists/i);

    const fresh = await User.findById(u._id).select('+resetPasswordToken +resetPasswordExpire');
    expect(fresh.resetPasswordToken).toBeTruthy();
    // Stored value must be a 64-char sha256 hex — NEVER a raw token.
    expect(fresh.resetPasswordToken).toMatch(/^[a-f0-9]{64}$/);
    expect(fresh.resetPasswordExpire.getTime()).toBeGreaterThan(Date.now());
  });
});

describe('POST /user/reset-password', () => {
  async function seedWithToken() {
    const u = await User.create({ name: 'Reset Me', email: 'reset@t.co', password: 'oldpass12', role: 'admin', department: 'admin' });
    const raw = crypto.randomBytes(32).toString('hex');
    u.resetPasswordToken = hash(raw);
    u.resetPasswordExpire = new Date(Date.now() + 30 * 60 * 1000);
    await u.save({ validateBeforeSave: false });
    return { u, raw };
  }

  test('a valid token rotates the password and can then log in', async () => {
    const { u, raw } = await seedWithToken();
    const res = await request(app)
      .post('/api/v2/user/reset-password')
      .send({ token: raw, password: 'brandnew1' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // Old password no longer works; new one does.
    const fresh = await User.findById(u._id).select('+password +resetPasswordToken');
    expect(await fresh.comparePassword('oldpass12')).toBe(false);
    expect(await fresh.comparePassword('brandnew1')).toBe(true);
    // Token was cleared → single-use.
    expect(fresh.resetPasswordToken).toBeFalsy();

    const login = await request(app)
      .post('/api/v2/user/login-user')
      .send({ email: 'reset@t.co', password: 'brandnew1' });
    expect(login.status).toBe(201);
  });

  test('the same token cannot be replayed', async () => {
    const { raw } = await seedWithToken();
    await request(app).post('/api/v2/user/reset-password').send({ token: raw, password: 'brandnew1' });
    const replay = await request(app)
      .post('/api/v2/user/reset-password')
      .send({ token: raw, password: 'another11' });
    expect(replay.status).toBe(400);
    expect(replay.body.message).toMatch(/invalid or has expired/i);
  });

  test('an expired token is rejected', async () => {
    const u = await User.create({ name: 'Reset Me', email: 'reset@t.co', password: 'oldpass12', role: 'admin', department: 'admin' });
    const raw = crypto.randomBytes(32).toString('hex');
    u.resetPasswordToken = hash(raw);
    u.resetPasswordExpire = new Date(Date.now() - 60 * 1000); // already expired
    await u.save({ validateBeforeSave: false });

    const res = await request(app)
      .post('/api/v2/user/reset-password')
      .send({ token: raw, password: 'brandnew1' });
    expect(res.status).toBe(400);
  });

  test('a wrong token is rejected', async () => {
    await seedWithToken();
    const res = await request(app)
      .post('/api/v2/user/reset-password')
      .send({ token: 'deadbeef'.repeat(8), password: 'brandnew1' });
    expect(res.status).toBe(400);
  });

  test('a too-short password is rejected', async () => {
    const { raw } = await seedWithToken();
    const res = await request(app)
      .post('/api/v2/user/reset-password')
      .send({ token: raw, password: 'ab' });
    expect(res.status).toBe(400);
  });
});
