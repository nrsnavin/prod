'use strict';
// ══════════════════════════════════════════════════════════════════
//  "CHECK YOUR EMAIL" ON A SERVER THAT CANNOT SEND EMAIL
//
//  Email OTP is the primary sign-in for the web and mobile apps, and
//  the UI links to nothing else — /login-user is kept mounted as an
//  unlisted fallback. So when a code does not arrive, nobody can get
//  in.
//
//  /request-otp answered 200 "a sign-in code has been sent" in three
//  quite different situations:
//
//    1. the address has no account        — deliberate, and correct
//    2. the mail went out                 — correct
//    3. this server has no SMTP at all    — a lie
//
//  Three is a lie because `sendMail` returns `{ skipped: true }`
//  instead of throwing when SMTP is unset — a deliberate kindness so a
//  half-provisioned box does not 500 the password-reset route. The OTP
//  route's `catch` therefore never fired: the code was generated,
//  saved, and left sitting in the database, and the caller was told to
//  go and look in an inbox.
//
//  The reason 1 and 2 must be indistinguishable is anti-enumeration:
//  a different answer for a real address tells an attacker which
//  addresses are real. Three carries no such information — a server
//  with no mailer cannot send to ANY address — so it can be reported
//  honestly, as long as it is reported before the account is looked up
//  and identically for every address.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryServer } = require('mongodb-memory-server');
const nodemailer = require('nodemailer');

let mongo, app, User, mailer, admin;

/** Put the process into "SMTP configured" state, with a stub transport. */
function withSmtp({ fails = false } = {}) {
  process.env.SMTP_HOST = 'smtp.example.com';
  process.env.SMTP_PORT = '465';
  process.env.SMTP_USER = 'no-reply@example.com';
  process.env.SMTP_PASS = 'secret';
  mailer.resetTransport();
  return jest.spyOn(nodemailer, 'createTransport').mockReturnValue({
    sendMail: async () => {
      if (fails) throw new Error('535 5.7.8 authentication failed');
      return { messageId: '<probe@example.com>' };
    },
  });
}

function withoutSmtp() {
  delete process.env.SMTP_HOST;
  delete process.env.SMTP_PORT;
  delete process.env.SMTP_USER;
  delete process.env.SMTP_PASS;
  delete process.env.SMTP_FROM;
  mailer.resetTransport();
}

const adminCookie = () => [
  `token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`,
];

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  app    = require('../../app.js');
  User   = require('../../models/User');
  mailer = require('../../utils/mailer');
  admin = await User.create({
    name: 'Navin', email: 'otp-admin@t.co', password: 'pass1234',
    role: 'admin', department: 'admin',
  });
}, 120_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

afterEach(() => {
  jest.restoreAllMocks();
  withoutSmtp();
});

const ask = (email) =>
  request(app).post('/api/v2/user/request-otp').send({ email });

const otpOf = (email) =>
  User.findOne({ email }).select('+otpCode +otpExpire').lean();

// ══════════════════════════════════════════════════════════════════
describe('asking for a sign-in code with no mailer on the server', () => {
  it('says so instead of claiming a code was sent', async () => {
    withoutSmtp();
    const res = await ask('otp-admin@t.co');

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('MAILER_NOT_CONFIGURED');
    expect(res.body.message).toMatch(/no email configured/i);
  });

  it('never tells anyone to check an inbox for a code it did not send', async () => {
    // The invariant, rather than a status check: the phrase only
    // belongs in a reply where a send was actually attempted.
    withoutSmtp();
    const res = await ask('otp-admin@t.co');
    expect(JSON.stringify(res.body)).not.toMatch(/has been sent/i);
  });

  it('leaves no unusable code behind on the account', async () => {
    // It used to generate and save one, then skip the send — a live
    // 10-minute code nobody could receive.
    withoutSmtp();
    await ask('otp-admin@t.co');

    const u = await otpOf('otp-admin@t.co');
    expect(u.otpCode).toBeFalsy();
  });

  it('answers the same for an address with no account', async () => {
    // The whole basis for reporting this honestly: the reply must
    // depend on the SERVER's configuration and never on whether the
    // account exists, or it becomes an enumeration oracle.
    withoutSmtp();
    const real    = await ask('otp-admin@t.co');
    const madeUp  = await ask('nobody-at-all@t.co');

    expect(real.status).toBe(madeUp.status);
    expect(real.body.message).toBe(madeUp.body.message);
  });
});

describe('asking for a sign-in code on a working server', () => {
  it('sends one and says so', async () => {
    withSmtp();
    const res = await ask('otp-admin@t.co');

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/has been sent/i);
    const u = await otpOf('otp-admin@t.co');
    expect(u.otpCode).toBeTruthy();
  });

  it('still gives nothing away about an address with no account', async () => {
    withSmtp();
    const real   = await ask('otp-admin@t.co');
    const madeUp = await ask('nobody-at-all@t.co');

    expect(real.status).toBe(madeUp.status);
    expect(real.body.message).toBe(madeUp.body.message);
  });
});

describe('when the mail server rejects the message', () => {
  it('keeps the reply generic — a failure only for real addresses would name them', async () => {
    withSmtp({ fails: true });
    const real   = await ask('otp-admin@t.co');
    const madeUp = await ask('nobody-at-all@t.co');

    expect(real.status).toBe(200);
    expect(real.body.message).toBe(madeUp.body.message);
  });

  it('clears the code, because nobody can receive it', async () => {
    withSmtp({ fails: true });
    await ask('otp-admin@t.co');

    const u = await otpOf('otp-admin@t.co');
    expect(u.otpCode).toBeFalsy();
  });

  it('records the reason where an administrator can read it', async () => {
    // The caller is told nothing, on purpose. That silence is what made
    // a broken mailer invisible, so the reason has to survive somewhere.
    withSmtp({ fails: true });
    await ask('otp-admin@t.co');

    const res = await request(app).get('/api/v2/health/mailer')
      .set('Cookie', adminCookie());
    expect(res.status).toBe(200);
    expect(res.body.mailer.lastError.reason).toMatch(/authentication failed/i);
  });
});

// ══════════════════════════════════════════════════════════════════
//  THE DIAGNOSTIC
// ══════════════════════════════════════════════════════════════════
describe('GET /health/mailer', () => {
  it('separates "no settings" from "settings that do not work"', async () => {
    withoutSmtp();
    const off = await request(app).get('/api/v2/health/mailer')
      .set('Cookie', adminCookie());
    expect(off.body.mailer.configured).toBe(false);

    withSmtp();
    const on = await request(app).get('/api/v2/health/mailer')
      .set('Cookie', adminCookie());
    expect(on.body.mailer.configured).toBe(true);
    expect(on.body.mailer.host).toBe('smtp.example.com');
  });

  it('never returns the password', async () => {
    withSmtp();
    const res = await request(app).get('/api/v2/health/mailer')
      .set('Cookie', adminCookie());
    expect(JSON.stringify(res.body)).not.toContain('secret');
  });

  it('masks the mailbox login', async () => {
    withSmtp();
    const res = await request(app).get('/api/v2/health/mailer')
      .set('Cookie', adminCookie());
    expect(res.body.mailer.user).toBe('no***@example.com');
  });

  it('sends a real test message on request', async () => {
    withSmtp();
    const res = await request(app)
      .get('/api/v2/health/mailer?test=someone@example.com')
      .set('Cookie', adminCookie());

    expect(res.body.test.sent).toBe(true);
  });

  it('reports why a test message failed', async () => {
    withSmtp({ fails: true });
    const res = await request(app)
      .get('/api/v2/health/mailer?test=someone@example.com')
      .set('Cookie', adminCookie());

    expect(res.body.test.sent).toBe(false);
    expect(res.body.test.reason).toMatch(/authentication failed/i);
  });

  it('says a test cannot be sent at all with no settings', async () => {
    withoutSmtp();
    const res = await request(app)
      .get('/api/v2/health/mailer?test=someone@example.com')
      .set('Cookie', adminCookie());

    expect(res.body.test.sent).toBe(false);
    expect(res.body.test.reason).toMatch(/not configured/i);
  });

  it('is not readable without an admin session', async () => {
    const res = await request(app).get('/api/v2/health/mailer');
    expect([401, 403]).toContain(res.status);
  });
});

// ══════════════════════════════════════════════════════════════════
//  A ONE-TIME CODE IS NOT LOG MATERIAL
//
//  The skip warning printed the subject line, and the subject of an OTP
//  email begins with the code itself. So on exactly the deployments
//  where nobody was receiving codes — and where somebody would
//  therefore go reading the log — live codes were sitting in it in
//  plaintext.
// ══════════════════════════════════════════════════════════════════
describe('what reaches the server log', () => {
  it('does not print the code when a send is skipped', async () => {
    withoutSmtp();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    await mailer.sendLoginOtpEmail({
      to: 'x@y.co', name: 'Navin', code: '135790', ttlMinutes: 10,
    });

    const printed = warn.mock.calls.flat().join(' ');
    expect(printed).toContain('x@y.co');
    expect(printed).not.toContain('135790');
  });
});
