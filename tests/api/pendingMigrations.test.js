'use strict';
// ══════════════════════════════════════════════════════════════════
//  "WHY IS THE NEW PAGE MISSING?" — NOW A QUESTION WITH AN ANSWER
//
//  package.json has a `prestart` that runs migrate-mongo. The systemd
//  unit starts the app with `ExecStart=/usr/bin/node index.js`, so npm
//  is never involved and prestart never fires. Migrations therefore run
//  only when somebody remembers, and until now nothing reported that
//  they had not.
//
//  That silence has a specific cost, paid four times in this codebase:
//  every feature-grant migration that goes unrun leaves a finished page
//  invisible to every configured account, with no error anywhere. From
//  the outside "the migration hasn't run" is indistinguishable from "the
//  feature was never built", and only one of those is a code problem.
//
//  /health/build already answers "did the deploy land?". This is the
//  same question one layer down: did the DATABASE land too.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const fs       = require('fs');
const path     = require('path');
const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, User, admin, operator;

const cookieFor = (u) => [
  `token=${jwt.sign({ id: u._id, role: u.role }, process.env.JWT_SECRET_KEY)}`,
];

const migrationFiles = () =>
  fs.readdirSync(path.join(__dirname, '..', '..', 'migrations'))
    .filter((f) => f.endsWith('.js')).sort();

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app  = require('../../app.js');
  User = require('../../models/User');

  admin = await User.create({
    name: 'Admin', email: 'mig-admin@t.co', password: 'pass1234',
    role: 'admin', department: 'admin',
  });
  operator = await User.create({
    name: 'Op', email: 'mig-op@t.co', password: 'pass1234',
    role: 'production', department: 'production',
  });
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => { await mongoose.connection.collection('changelog').deleteMany({}); });

const build = (u) =>
  request(app).get('/api/v2/health/build').set('Cookie', cookieFor(u));

describe('GET /health/build — pending migrations', () => {
  test('an empty changelog reports every migration as pending', async () => {
    const res = await build(admin);
    expect(res.status).toBe(200);
    expect(res.body.migrations.pending).toEqual(migrationFiles());
    expect(res.body.migrations.pendingCount).toBe(migrationFiles().length);
  });

  test('a fully migrated database reports none', async () => {
    await mongoose.connection.collection('changelog').insertMany(
      migrationFiles().map((fileName) => ({ fileName, appliedAt: new Date() }))
    );

    const res = await build(admin);
    expect(res.body.migrations.pending).toEqual([]);
    expect(res.body.migrations.pendingCount).toBe(0);
  });

  test('it names the ones actually missing, not just a count', async () => {
    // A count says "something is wrong". A name says which command to
    // run and what it will do — and these filenames say what they grant.
    const all = migrationFiles();
    const held = all.slice(0, -2);
    await mongoose.connection.collection('changelog').insertMany(
      held.map((fileName) => ({ fileName, appliedAt: new Date() }))
    );

    const res = await build(admin);
    expect(res.body.migrations.pending).toEqual(all.slice(-2));
  });

  test('the three migrations behind the new pages are listed by name', async () => {
    // The concrete case this exists for. Each of these grants a feature
    // key or moves a field the new screens read.
    const res = await build(admin);
    expect(res.body.migrations.pending).toEqual(
      expect.arrayContaining([
        '20260818000001-grant-ai-health-feature.js',
        '20260818000002-complaint-order-to-job.js',
        '20260818000003-grant-complaints-feature.js',
      ])
    );
  });

  test('it stays admin-gated — this is deploy detail', async () => {
    const res = await build(operator);
    expect([401, 403]).toContain(res.status);
  });

  test('the rest of the probe still answers', async () => {
    // The migration read must not become a way for this endpoint to
    // stop reporting the commit SHA, which is what it is mostly for.
    const res = await build(admin);
    expect(res.body.status).toBe('ok');
    expect(res.body).toHaveProperty('commitSha');
    expect(res.body).toHaveProperty('node');
    expect(res.body.routes).toHaveProperty('/api/v2/order/estimate-completion');
  });
});
