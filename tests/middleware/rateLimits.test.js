'use strict';
// ══════════════════════════════════════════════════════════════════
//  RATE LIMITS FOR AN OFFICE, NOT FOR AN IP ADDRESS
//
//  Two failures these tests exist for, both from the same fact — a
//  mill office reaches the internet through one address:
//
//    1. The API ceiling was one bucket per IP, so the whole office was
//       throttled together at roughly fifteen users.
//    2. The login throttle counted SUCCESSFUL logins, so the 21st
//       worker signing in at shift changeover was locked out.
//
//  And one property they exist to hold for later: the counters are in
//  the database, so two worker processes see one count, not two.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo;
let MongoRateLimitStore, buildLimiters, COLLECTION;

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  ({ MongoRateLimitStore, COLLECTION } = require('../../utils/rateLimitStore'));
  ({ buildLimiters } = require('../../middleware/rateLimits'));
}, 180_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

afterEach(async () => {
  await mongoose.connection.collection(COLLECTION).deleteMany({});
});

describe('the shared counter', () => {
  const store = (prefix = 't:', windowMs = 60_000) => {
    const s = new MongoRateLimitStore({ prefix });
    s.init({ windowMs });
    return s;
  };

  it('counts up', async () => {
    const s = store();
    await s.increment('k');
    await s.increment('k');
    const r = await s.increment('k');
    expect(r.totalHits).toBe(3);
    expect(r.resetTime).toBeInstanceOf(Date);
  });

  it('loses no hits when fifty arrive at once', async () => {
    // A read-then-write counter drops hits under exactly this load. The
    // increment is one atomic pipeline update, so the database decides.
    const s = store();
    await Promise.all(Array.from({ length: 50 }, () => s.increment('burst')));
    const doc = await mongoose.connection.collection(COLLECTION).findOne({ _id: 't:burst' });
    expect(doc.hits).toBe(50);
  });

  it('is one count across two processes, not two', async () => {
    // Two store instances stand in for two cluster workers. With the
    // old in-memory store each would have said 2.
    const workerA = store();
    const workerB = store();
    await workerA.increment('shared');
    await workerB.increment('shared');
    await workerA.increment('shared');
    const r = await workerB.increment('shared');
    expect(r.totalHits).toBe(4);
  });

  it('starts a fresh window once the old one has run out', async () => {
    // The TTL monitor only sweeps about once a minute, so a finished
    // window can still be sitting there. The update must notice.
    const s = store('t:', 60_000);
    await s.increment('old');
    await mongoose.connection.collection(COLLECTION).updateOne(
      { _id: 't:old' },
      { $set: { resetAt: new Date(Date.now() - 1000), hits: 999 } }
    );
    const r = await s.increment('old');
    expect(r.totalHits).toBe(1);
    expect(r.resetTime.getTime()).toBeGreaterThan(Date.now());
  });

  it('keeps separate limiters apart by prefix', async () => {
    await store('a:').increment('same');
    const r = await store('b:').increment('same');
    expect(r.totalHits).toBe(1);
  });

  it('lets the request through when the database is not connected', async () => {
    // Fail open. A limiter that turns a database blip into a 500 on
    // every request has made the outage worse.
    const s = new MongoRateLimitStore({ connection: () => ({ readyState: 0 }) });
    s.init({ windowMs: 60_000 });
    const r = await s.increment('k');
    expect(r.totalHits).toBe(1);
  });

  it('lets the request through when the write itself fails', async () => {
    const broken = {
      readyState: 1,
      collection: () => ({
        createIndex: () => Promise.resolve(),
        findOneAndUpdate: () => Promise.reject(new Error('not primary')),
      }),
    };
    const s = new MongoRateLimitStore({ connection: () => broken });
    s.init({ windowMs: 60_000 });
    const r = await s.increment('k');
    expect(r.totalHits).toBe(1);
  });

  it('creates the TTL index that clears finished windows', async () => {
    const s = store();
    await s.increment('k');
    await s._indexed;
    const idx = await mongoose.connection.collection(COLLECTION).indexes();
    const ttl = idx.find((i) => i.key && i.key.resetAt === 1);
    expect(ttl).toBeDefined();
    expect(ttl.expireAfterSeconds).toBe(0);
  });
});

// ── The real middleware, at limits small enough to reach ──────────
function appWith(limits, { asUser } = {}) {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  // Stands in for setUserContext, which runs before the limiter in app.js.
  app.use((req, _res, next) => {
    const who = req.get('x-test-user');
    if (who || asUser) req.user = { _id: who || asUser };
    next();
  });
  const l = buildLimiters(limits);
  app.use('/api', l.apiLimiter);
  app.get('/api/ping', (_req, res) => res.json({ ok: true }));
  app.post('/login', l.loginAddressLimiter, l.loginAccountLimiter, (req, res) =>
    req.body.password === 'right' ? res.json({ ok: true }) : res.status(401).json({ ok: false })
  );
  return app;
}

// Every request below arrives from one address, as an office does.
const OFFICE = '203.0.113.7';

describe('the API ceiling', () => {
  it('gives each signed-in user their own allowance behind one office address', async () => {
    const app = appWith({ apiLimit: 3 });
    for (let i = 0; i < 3; i++) {
      const r = await request(app).get('/api/ping').set('X-Forwarded-For', OFFICE).set('x-test-user', 'alice');
      expect(r.status).toBe(200);
    }
    // Alice has spent hers.
    const aliceAgain = await request(app).get('/api/ping').set('X-Forwarded-For', OFFICE).set('x-test-user', 'alice');
    expect(aliceAgain.status).toBe(429);
    // Bob, same building, same address, is untouched. Before this he
    // was throttled along with her.
    const bob = await request(app).get('/api/ping').set('X-Forwarded-For', OFFICE).set('x-test-user', 'bob');
    expect(bob.status).toBe(200);
  });

  it('still limits anonymous traffic by address', async () => {
    const app = appWith({ apiLimit: 2 });
    await request(app).get('/api/ping').set('X-Forwarded-For', OFFICE);
    await request(app).get('/api/ping').set('X-Forwarded-For', OFFICE);
    const third = await request(app).get('/api/ping').set('X-Forwarded-For', OFFICE);
    expect(third.status).toBe(429);
  });

  it('does not let a signed-in user and an anonymous caller share a bucket', async () => {
    const app = appWith({ apiLimit: 1 });
    await request(app).get('/api/ping').set('X-Forwarded-For', OFFICE);
    const signedIn = await request(app).get('/api/ping').set('X-Forwarded-For', OFFICE).set('x-test-user', 'alice');
    expect(signedIn.status).toBe(200);
  });
});

describe('the login throttle', () => {
  const login = (app, email, password) =>
    request(app).post('/login').set('X-Forwarded-For', OFFICE).send({ email, password });

  it('does not count a successful login as an attempt', async () => {
    // Shift changeover: many correct logins from one office address.
    // With a limit of 3, the fourth used to be refused.
    const app = appWith({ loginPerAccount: 3, loginPerAddress: 3 });
    for (let i = 0; i < 10; i++) {
      const r = await login(app, `worker${i}@mill.test`, 'right');
      expect(r.status).toBe(200);
    }
  });

  it('refuses an account after too many wrong passwords', async () => {
    const app = appWith({ loginPerAccount: 3, loginPerAddress: 100 });
    for (let i = 0; i < 3; i++) expect((await login(app, 'a@mill.test', 'wrong')).status).toBe(401);
    expect((await login(app, 'a@mill.test', 'wrong')).status).toBe(429);
  });

  it('does not lock one person out because a colleague mistyped', async () => {
    const app = appWith({ loginPerAccount: 3, loginPerAddress: 100 });
    for (let i = 0; i < 4; i++) await login(app, 'a@mill.test', 'wrong');
    expect((await login(app, 'b@mill.test', 'right')).status).toBe(200);
  });

  it('treats the same address in different case as one account', async () => {
    const app = appWith({ loginPerAccount: 2, loginPerAddress: 100 });
    await login(app, 'A@Mill.test', 'wrong');
    await login(app, 'a@mill.test', 'wrong');
    expect((await login(app, 'a@MILL.test', 'wrong')).status).toBe(429);
  });

  it('caps failures from one address across many accounts', async () => {
    // Without this, one address could try twenty passwords on every
    // account in the company.
    const app = appWith({ loginPerAccount: 100, loginPerAddress: 3 });
    for (let i = 0; i < 3; i++) await login(app, `u${i}@mill.test`, 'wrong');
    expect((await login(app, 'u99@mill.test', 'wrong')).status).toBe(429);
  });
});
