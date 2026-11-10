'use strict';
// ══════════════════════════════════════════════════════════════════
//  ENDING A SESSION
//
//  A token used to be good until it expired, whatever happened to the
//  account meanwhile. Held here:
//
//    • signing out ends THAT session on the server — the token is
//      refused afterwards, and the account's other sessions carry on;
//    • a password reset, and an admin setting a new password, end every
//      session open under the old one;
//    • a token that has expired, or is not one of ours, is a 401 that
//      says so (it was a 400 about a "url", which no app acted on);
//    • a sign-in code allows five tries however the guesses arrive, and
//      works once.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongo, app, User, AccessEvent;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  User = require('../../models/User.js');
  AccessEvent = require('../../models/AccessEvent.js');
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  await User.deleteMany({});
  await AccessEvent.deleteMany({});
  await User.create({ name: 'Owner', email: 'own@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  await User.create({ name: 'Floor Lead', email: 'floor@t.co', password: 'pass1234', role: 'production', department: 'production' });
});

const signIn = async (email = 'floor@t.co', password = 'pass1234') => {
  const res = await request(app).post('/api/v2/user/login-user').send({ email, password });
  expect(res.status).toBe(201);
  return res.body.token;
};
const me = (token) => request(app).get('/api/v2/user/me').set('Cookie', [`token=${token}`]);

describe('signing out', () => {
  it('ends that session on the server, and only that one', async () => {
    const desk = await signIn();
    const phone = await signIn();
    expect((await me(desk)).status).toBe(200);

    const out = await request(app).post('/api/v2/user/logout').set('Cookie', [`token=${desk}`]);
    expect(out.status).toBe(200);
    // The browser is told to drop the cookie…
    expect(String(out.headers['set-cookie'])).toMatch(/token=;.*Expires=Thu, 01 Jan 1970/);

    // …and the token itself no longer works anywhere.
    const after = await me(desk);
    expect(after.status).toBe(401);
    expect(after.body.message).toMatch(/signed out/i);
    // The same person's other session is untouched.
    expect((await me(phone)).status).toBe(200);
  });

  it('answers the same with no session, an expired one, or one already ended', async () => {
    expect((await request(app).post('/api/v2/user/logout')).status).toBe(200);
    const token = await signIn();
    for (let i = 0; i < 2; i++) {
      expect((await request(app).post('/api/v2/user/logout').set('Cookie', [`token=${token}`])).status).toBe(200);
    }
    expect((await request(app).post('/api/v2/user/logout').set('Cookie', ['token=not.a.token'])).status).toBe(200);
  });

  it('forgets a sign-out once its token would have expired anyway', async () => {
    const session = require('../../utils/session');
    const u = await User.findOne({ email: 'floor@t.co' });
    await User.updateOne({ _id: u._id }, {
      $set: { revokedSessions: [{ sid: 'long-gone', exp: new Date(Date.now() - 60_000) }, { sid: 'still-live', exp: new Date(Date.now() + 60_000) }] },
    });
    const token = await signIn();
    await session.end(u, jwt.decode(token));
    const kept = (await User.findById(u._id).select('+revokedSessions').lean()).revokedSessions.map((s) => s.sid);
    expect(kept).not.toContain('long-gone');
    expect(kept).toEqual(expect.arrayContaining(['still-live', jwt.decode(token).sid]));
  });

  it('CONTROL: a token from before sessions had ids is still honoured', async () => {
    // A deploy must not sign the mill out: older tokens carry no `sid`
    // (and the oldest no `v`), and run until they expire.
    const u = await User.findOne({ email: 'floor@t.co' });
    const legacy = jwt.sign({ id: u._id, role: u.role }, process.env.JWT_SECRET_KEY, { expiresIn: '1h' });
    expect((await me(legacy)).status).toBe(200);
  });
});

describe('a new password ends what was signed in under the old one', () => {
  it('a reset by emailed link', async () => {
    const before = await signIn();
    const u = await User.findOne({ email: 'floor@t.co' });
    const raw = u.createPasswordResetToken();
    await u.save();

    const res = await request(app).post('/api/v2/user/reset-password').send({ token: raw, password: 'weaving-shed-9' });
    expect(res.status).toBe(200);

    const stale = await me(before);
    expect(stale.status).toBe(401);
    expect(stale.body.message).toMatch(/signed out/i);
    // The new password works, the old one does not.
    await signIn('floor@t.co', 'weaving-shed-9');
    expect((await request(app).post('/api/v2/user/login-user').send({ email: 'floor@t.co', password: 'pass1234' })).status).toBe(401);
    // It is on the record, without the password.
    const ev = await AccessEvent.findOne({ 'subject.id': String(u._id) }).lean();
    expect(ev).toBeTruthy();
    expect(JSON.stringify(ev)).not.toMatch(/weaving-shed-9/);
  });

  it('a reset is refused for a password that is too easy, and the link stays good', async () => {
    const u = await User.findOne({ email: 'floor@t.co' });
    const raw = u.createPasswordResetToken();
    await u.save();
    for (const [password, why] of [['short', /at least 8/], ['password', /easy to guess/], ['floorlead', /your name/], ['floor@t.co', /your email/], ['11111111', /easy to guess/]]) {
      const res = await request(app).post('/api/v2/user/reset-password').send({ token: raw, password });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(why);
    }
    expect((await request(app).post('/api/v2/user/reset-password').send({ token: raw, password: 'weaving-shed-9' })).status).toBe(200);
  });

  it('a bad link learns nothing about the rule', async () => {
    const res = await request(app).post('/api/v2/user/reset-password').send({ token: 'nope', password: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/invalid or has expired/);
  });

  it('an admin setting one', async () => {
    const before = await signIn();
    const admin = await signIn('own@t.co');
    const u = await User.findOne({ email: 'floor@t.co' });

    const weak = await request(app).put(`/api/v2/user/manage/${u._id}`).set('Cookie', [`token=${admin}`]).send({ password: 'abc' });
    expect(weak.status).toBe(400);
    expect((await me(before)).status).toBe(200); // nothing changed, nobody signed out

    const res = await request(app).put(`/api/v2/user/manage/${u._id}`).set('Cookie', [`token=${admin}`]).send({ password: 'weaving-shed-9' });
    expect(res.status).toBe(200);
    expect((await me(before)).status).toBe(401);
    // The admin's own session is not the one that ended.
    expect((await me(admin)).status).toBe(200);
  });

  it('CONTROL: an admin changing something else signs nobody out', async () => {
    const before = await signIn();
    const admin = await signIn('own@t.co');
    const u = await User.findOne({ email: 'floor@t.co' });
    const res = await request(app).put(`/api/v2/user/manage/${u._id}`).set('Cookie', [`token=${admin}`]).send({ name: 'Floor Leader' });
    expect(res.status).toBe(200);
    expect((await me(before)).status).toBe(200);
  });
});

describe('a token that no longer stands is a 401 that says why', () => {
  it('expired', async () => {
    const u = await User.findOne({ email: 'floor@t.co' });
    const old = jwt.sign({ id: u._id, role: u.role, v: 0 }, process.env.JWT_SECRET_KEY, { expiresIn: -10 });
    const res = await me(old);
    expect(res.status).toBe(401);
    expect(res.body.message).toMatch(/expired/i);
  });

  it('signed with another key, malformed, or naming nobody', async () => {
    const u = await User.findOne({ email: 'floor@t.co' });
    const forged = jwt.sign({ id: u._id, role: 'admin' }, 'some-other-key');
    const nobody = jwt.sign({ id: new mongoose.Types.ObjectId(), role: 'admin' }, process.env.JWT_SECRET_KEY);
    const notAnId = jwt.sign({ id: 'admin', role: 'admin' }, process.env.JWT_SECRET_KEY);
    for (const t of [forged, nobody, notAnId, 'garbage', 'a.b.c']) {
      const res = await me(t);
      expect(res.status).toBe(401);
      expect(res.body.message).toMatch(/login again/i);
    }
  });

  it('signed with no algorithm at all', async () => {
    const u = await User.findOne({ email: 'floor@t.co' });
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ id: String(u._id), role: 'admin' })}.`;
    expect((await me(unsigned)).status).toBe(401);
  });
});

describe('a sign-in code', () => {
  const withCode = async () => {
    const u = await User.findOne({ email: 'floor@t.co' });
    const code = u.createLoginOtp();
    await u.save({ validateBeforeSave: false });
    return code;
  };
  const guess = (otp) => request(app).post('/api/v2/user/verify-otp').send({ email: 'floor@t.co', otp });

  it('works once', async () => {
    const code = await withCode();
    const first = await guess(code);
    expect(first.status).toBe(201);
    expect(first.body.token).toBeTruthy();
    expect((await guess(code)).status).toBe(401);
  });

  it('allows five tries, however the guesses arrive', async () => {
    const code = await withCode();
    const wrong = code === '111111' ? '222222' : '111111';
    // Sent together: they used to all read "no tries used yet".
    const burst = await Promise.all(Array.from({ length: 12 }, () => guess(wrong)));
    expect(burst.every((r) => r.status === 401)).toBe(true);
    // The code is dead: even the right one is refused now.
    expect((await guess(code)).status).toBe(401);
    const u = await User.findOne({ email: 'floor@t.co' }).select('+otpCode +otpAttempts').lean();
    expect(u.otpCode).toBeUndefined();
  });

  it('CONTROL: four wrong tries leave the fifth for the right code', async () => {
    const code = await withCode();
    const wrong = code === '111111' ? '222222' : '111111';
    for (let i = 0; i < 4; i++) expect((await guess(wrong)).status).toBe(401);
    expect((await guess(code)).status).toBe(201);
  });
});
