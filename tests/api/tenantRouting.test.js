'use strict';
// ══════════════════════════════════════════════════════════════════
//  PER-USER DATABASE ROUTING
//
//  Named users work in a sandbox database; everyone else works in the
//  live one. The failure this suite exists to catch is the one that
//  cannot be seen from the outside: a request served from the WRONG
//  database. Nothing errors, the screen looks right, and a sandbox
//  experiment quietly becomes a production row — or a real order
//  disappears into a database nobody looks at.
//
//  So every case asserts which database the bytes actually landed in,
//  by reading both with the driver rather than through the app.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';
// Set before app.js is required — install() reads nothing at load time,
// but the model files must be registered through the patched
// mongoose.model, and app.js is what installs it.
process.env.SANDBOX_DB = 'sandbox_db';
process.env.SANDBOX_USERS = 'rsnavin02@gmail.com';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongo, app, M = {}, tenants;
let admin, sandboxUser;

const cookie = (u) => [`token=${jwt.sign({ id: u._id, role: u.role }, process.env.JWT_SECRET_KEY)}`];

/** Read a collection straight from a named database, bypassing the app. */
const raw = (dbName, coll) =>
  mongoose.connection.useDb(dbName, { useCache: true }).db.collection(coll);

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(`${mongo.getUri()}primary_db`);
  app = require('../../app.js');
  tenants = require('../../db/tenants.js');
  for (const n of ['User', 'Customer', 'SampleRequest', 'Counter']) {
    M[n] = require(`../../models/${n}.js`);
  }

  admin = await M.User.create({
    name: 'Owner', email: 'owner@t.co', password: 'pass1234',
    role: 'admin', department: 'admin',
  });
  sandboxUser = await M.User.create({
    name: 'Sandbox', email: 'rsnavin02@gmail.com', password: 'pass1234',
    role: 'admin', department: 'admin',
  });
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  for (const db of ['primary_db', 'sandbox_db']) {
    for (const coll of ['samplerequests', 'customers', 'doc_counters',
                         'machines', 'machineservicebills']) {
      await raw(db, coll).deleteMany({});
    }
  }
});

const raiseSample = (as, title) =>
  request(app).post('/api/v2/sample').set('Cookie', cookie(as)).send({
    title, details: 'Spec as given by the customer.',
  });

// ── The whole point ──────────────────────────────────────────────
describe('which database a request lands in', () => {
  it('writes an ordinary user\'s data to the primary and not the sandbox', async () => {
    const res = await raiseSample(admin, 'Live sample');
    expect(res.status).toBe(201);

    expect(await raw('primary_db', 'samplerequests').countDocuments()).toBe(1);
    expect(await raw('sandbox_db', 'samplerequests').countDocuments()).toBe(0);
  });

  it('writes a sandbox user\'s data to the sandbox and not the primary', async () => {
    const res = await raiseSample(sandboxUser, 'Sandbox sample');
    expect(res.status).toBe(201);

    expect(await raw('sandbox_db', 'samplerequests').countDocuments()).toBe(1);
    expect(await raw('primary_db', 'samplerequests').countDocuments()).toBe(0);
  });

  it('keeps the two invisible to each other', async () => {
    await raiseSample(admin, 'Live sample');
    await raiseSample(sandboxUser, 'Sandbox sample');

    const live = await request(app).get('/api/v2/sample').set('Cookie', cookie(admin));
    const sand = await request(app).get('/api/v2/sample').set('Cookie', cookie(sandboxUser));

    expect(live.body.samples.map((s) => s.title)).toEqual(['Live sample']);
    expect(sand.body.samples.map((s) => s.title)).toEqual(['Sandbox sample']);
  });

  it('does not leak a sandbox row into the live totals', async () => {
    await raiseSample(sandboxUser, 'Sandbox sample');
    const live = await request(app).get('/api/v2/sample').set('Cookie', cookie(admin));
    expect(live.body.total).toBe(0);
    expect(live.body.counts).toMatchObject({ open: 0 });
  });

  // Both databases number from their own counter, so a sandbox trial does
  // not consume a PO or DC number the live ledger was going to use.
  it('gives each database its own document numbering', async () => {
    const a = await raiseSample(admin, 'Live one');
    const b = await raiseSample(admin, 'Live two');
    const c = await raiseSample(sandboxUser, 'Sandbox one');

    expect([a.body.sample.sampleNo, b.body.sample.sampleNo]).toEqual([1, 2]);
    expect(c.body.sample.sampleNo).toBe(1);
  });
});

// ── Logins ───────────────────────────────────────────────────────
describe('logins', () => {
  // Pinned to the primary: one set of credentials, and no way for a
  // sandbox account to become a production one.
  it('reads users from the primary even inside a sandbox request', async () => {
    expect(await raw('primary_db', 'users').countDocuments()).toBeGreaterThan(0);
    expect(await raw('sandbox_db', 'users').countDocuments()).toBe(0);

    // A sandbox request that reads the user list still resolves it there.
    const res = await request(app).get('/api/v2/sample').set('Cookie', cookie(sandboxUser));
    expect(res.status).toBe(200);
    expect(await raw('sandbox_db', 'users').countDocuments()).toBe(0);
  });

  it('routes on the email, not the role', () => {
    expect(tenants.dbForUser({ email: 'rsnavin02@gmail.com' })).toBe('sandbox_db');
    expect(tenants.dbForUser({ email: 'RSNavin02@Gmail.com' })).toBe('sandbox_db');
    expect(tenants.dbForUser({ email: 'owner@t.co' })).toBeNull();
    expect(tenants.dbForUser({})).toBeNull();
    expect(tenants.dbForUser(null)).toBeNull();
  });
});

// ── The default path ─────────────────────────────────────────────
describe('when no sandbox is configured', () => {
  const saved = process.env.SANDBOX_DB;
  afterEach(() => { process.env.SANDBOX_DB = saved; });

  // Every deployment today runs with SANDBOX_DB unset. Routing has to be
  // completely inert there, or this change breaks all of them.
  it('sends everyone, including the named user, to the connected database', async () => {
    process.env.SANDBOX_DB = '';
    expect(tenants.dbForUser({ email: 'rsnavin02@gmail.com' })).toBeNull();

    const res = await raiseSample(sandboxUser, 'Nowhere to go but home');
    expect(res.status).toBe(201);
    expect(await raw('primary_db', 'samplerequests').countDocuments()).toBe(1);
    expect(await raw('sandbox_db', 'samplerequests').countDocuments()).toBe(0);
  });

  it('sends an unauthenticated request to the primary', async () => {
    // No cookie: there is no user, so there is nothing to route on.
    const res = await request(app).get('/api/v2/health');
    expect(res.status).toBe(200);
    expect(tenants.currentDb()).toBeNull();
  });
});

// ── Reads that cross documents ───────────────────────────────────
describe('joins inside a sandbox request', () => {
  // populate() resolves a ref through the CONNECTION's model registry and
  // throws MissingSchemaError if the schema was never registered there —
  // which would only show on whichever route happened to join first.
  it('populates a reference without a missing-schema error', async () => {
    const customer = await raw('sandbox_db', 'customers').insertOne({
      name: 'Sandbox Customer', contactName: 'A', phoneNumber: '9000000000',
    });

    const created = await request(app)
      .post('/api/v2/sample')
      .set('Cookie', cookie(sandboxUser))
      .send({
        title: 'With a customer',
        details: 'Spec.',
        customerId: String(customer.insertedId),
      });

    expect(created.status).toBe(201);
    expect(created.body.sample.customerName).toBe('Sandbox Customer');

    const detail = await request(app)
      .get(`/api/v2/sample/${created.body.sample._id}`)
      .set('Cookie', cookie(sandboxUser));
    expect(detail.status).toBe(200);
    expect(detail.body.sample.customer).toMatchObject({ name: 'Sandbox Customer' });
  });

  it('does not find a primary customer from a sandbox request', async () => {
    const customer = await raw('primary_db', 'customers').insertOne({
      name: 'Live Customer', contactName: 'B', phoneNumber: '9000000001',
    });

    const res = await request(app)
      .post('/api/v2/sample')
      .set('Cookie', cookie(sandboxUser))
      .send({ title: 'x', details: 'y', customerId: String(customer.insertedId) });

    expect(res.status).toBe(404);
  });
});

// ── Saying which database you are in ─────────────────────────────
describe('GET /session/database', () => {
  // Routing is invisible from the outside by design, which makes
  // "is it even switched on?" unanswerable without writing a row and
  // going to look for it.
  it('tells a sandbox user they are in the sandbox', async () => {
    const res = await request(app)
      .get('/api/v2/session/database').set('Cookie', cookie(sandboxUser));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      email: 'rsnavin02@gmail.com',
      database: 'sandbox_db',
      sandbox: true,
      configured: true,
    });
  });

  it('tells an ordinary user which live database they are on', async () => {
    const res = await request(app)
      .get('/api/v2/session/database').set('Cookie', cookie(admin));
    expect(res.body).toMatchObject({
      database: 'primary_db', sandbox: false, configured: true,
    });
  });

  // The two reasons the answer can be "not the sandbox" are different
  // problems with different fixes, so they read differently.
  it('separates "not configured on this box" from "not on the list"', async () => {
    const saved = process.env.SANDBOX_DB;
    process.env.SANDBOX_DB = '';
    try {
      const res = await request(app)
        .get('/api/v2/session/database').set('Cookie', cookie(sandboxUser));
      expect(res.body).toMatchObject({ sandbox: false, configured: false });
    } finally {
      process.env.SANDBOX_DB = saved;
    }
  });

  it('needs a login', async () => {
    const res = await request(app).get('/api/v2/session/database');
    expect([401, 403]).toContain(res.status);
  });
});

// ── The failure that looks like success ──────────────────────────
describe('when SANDBOX_DB is the database already connected to', () => {
  const saved = process.env.SANDBOX_DB;
  afterEach(() => { process.env.SANDBOX_DB = saved; });

  // A MongoDB URI names its database in the PATH. Put it in the query
  // string by mistake — mongodb+srv://host/?appName=X/mydb — and the
  // driver silently connects to `test`; SANDBOX_DB=test then points at
  // the same place. Everything "works": the sandbox user is in
  // production, believing nothing they touch is real.
  it('refuses to route rather than pretending to', async () => {
    process.env.SANDBOX_DB = mongoose.connection.name; // 'primary_db'
    expect(tenants.sandboxIsPrimary()).toBe(true);
    expect(tenants.dbForUser({ email: 'rsnavin02@gmail.com' })).toBeNull();

    const res = await raiseSample(sandboxUser, 'Would have looked sandboxed');
    expect(res.status).toBe(201);
    expect(await raw('primary_db', 'samplerequests').countDocuments()).toBe(1);
  });

  it('says so, instead of reporting a healthy sandbox', async () => {
    process.env.SANDBOX_DB = mongoose.connection.name;
    const res = await request(app)
      .get('/api/v2/session/database').set('Cookie', cookie(sandboxUser));
    expect(res.body.sandbox).toBe(false);
    expect(res.body.warning).toMatch(/names its database in the PATH/);
  });
});

// ── The proxy itself ─────────────────────────────────────────────
describe('the model proxy', () => {
  it('hands back the real model when there is no sandbox in play', () => {
    const Customer = require('../../models/Customer.js');
    expect(Customer.modelName).toBe('Customer');
    expect(typeof Customer.find).toBe('function');
  });

  it('constructs documents on the routed database', async () => {
    const SampleRequest = require('../../models/SampleRequest.js');
    await tenants.runInDb('sandbox_db', async () => {
      const doc = new SampleRequest({ sampleNo: 99, title: 't', details: 'd' });
      await doc.save();
    });
    expect(await raw('sandbox_db', 'samplerequests').countDocuments()).toBe(1);
    expect(await raw('primary_db', 'samplerequests').countDocuments()).toBe(0);
  });

  it('runs an explicit primary block on the primary, inside a sandbox request', async () => {
    const SampleRequest = require('../../models/SampleRequest.js');
    await tenants.runInDb('sandbox_db', async () => {
      await tenants.runOnPrimary(async () => {
        await SampleRequest.create({ sampleNo: 1, title: 'forced home', details: 'd' });
      });
    });
    expect(await raw('primary_db', 'samplerequests').countDocuments()).toBe(1);
    expect(await raw('sandbox_db', 'samplerequests').countDocuments()).toBe(0);
  });

  it('leaves the pinned models unproxied', () => {
    const User = require('../../models/User.js');
    expect(User.__baseModel).toBeUndefined(); // not wrapped at all
    expect(tenants.PINNED_TO_PRIMARY.has('User')).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════
//  A FILE UPLOAD IS STILL THE SAME REQUEST
//
//  Routing is carried in an AsyncLocalStorage store, set once in
//  setUserContext and read by every model at call time. A JSON route
//  runs its handler synchronously inside that store and is fine.
//
//  A multipart route does not. multer consumes the request stream and
//  calls next() from a STREAM EVENT — and the socket that emits it was
//  created when the connection was accepted, long before any
//  request-scoped context existed. If the store does not survive that
//  hop, every model in the handler silently resolves to the PRIMARY
//  database.
//
//  Which is the worst shape this bug has: a sandbox user's uploads
//  land in production, and the only visible symptom is that the record
//  they are attaching to "does not exist" — because the handler is
//  looking for a sandbox row in the live database.
// ══════════════════════════════════════════════════════════════════
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n', 'utf8');

describe('a multipart upload stays in the requester\'s database', () => {
  const Machine = () => require('../../models/Machine.js');

  /** A machine + service log created BY the given user, so both land
   *  in whichever database that user is routed to. */
  let seq = 0;
  async function machineWithLog(as) {
    // A unique ID per case: Machine.ID is uniquely indexed, and a
    // duplicate makes create-machine fail in a way that reads exactly
    // like a routing failure two calls later.
    const created = await request(app).post('/api/v2/machine/create-machine')
      .set('Cookie', cookie(as))
      .send({ ID: `LOOM-9${seq++}`, manufacturer: 'Comez', NoOfHead: 8, NoOfHooks: 24 });
    const machineId = created.body?.machine?._id || created.body?._id;

    const log = await request(app).post('/api/v2/machine/add-service-log')
      .set('Cookie', cookie(as))
      .send({ machineId: String(machineId), type: 'Corrective', description: 'Belt' });
    return { machineId: String(machineId), logId: String(log.body?.log?._id) };
  }

  it('puts the sandbox user\'s machine and log in the sandbox', async () => {
    // Establishes the premise: the JSON routes DO route correctly, so
    // any failure below is about the upload and nothing else.
    const { machineId } = await machineWithLog(sandboxUser);

    expect(await raw('sandbox_db', 'machines').countDocuments()).toBeGreaterThan(0);
    expect(await raw('primary_db', 'machines').countDocuments()).toBe(0);
    expect(machineId).toBeTruthy();
  });

  it('finds the sandbox log when a bill is attached to it', async () => {
    const { machineId, logId } = await machineWithLog(sandboxUser);

    const res = await request(app).post('/api/v2/machine/service-bill')
      .set('Cookie', cookie(sandboxUser))
      .attach('file', PDF, { filename: 'bill.pdf', contentType: 'application/pdf' })
      .field('machineId', machineId)
      .field('serviceLogId', logId)
      .field('kind', 'service_bill');

    expect(res.status).toBe(201);
  });

  it('writes the bill into the sandbox, never into production', async () => {
    const { machineId, logId } = await machineWithLog(sandboxUser);

    await request(app).post('/api/v2/machine/service-bill')
      .set('Cookie', cookie(sandboxUser))
      .attach('file', PDF, { filename: 'bill.pdf', contentType: 'application/pdf' })
      .field('machineId', machineId)
      .field('serviceLogId', logId)
      .field('kind', 'service_bill');

    expect(await raw('sandbox_db', 'machineservicebills').countDocuments()).toBe(1);
    expect(await raw('primary_db', 'machineservicebills').countDocuments()).toBe(0);
  });
});

// ── The diagnostic has to name the RIGHT database ─────────────────
//  The "cannot find it" error prints which database it looked in.
//  Reading the default connection makes it name the LIVE database for
//  every sandbox user, which is exactly backwards: it sends somebody
//  looking in the one place the answer cannot be. It has to be the
//  database the request itself used.
describe('the not-found message names the request\'s database', () => {
  const missing = (as) =>
    request(app).post('/api/v2/machine/service-bill')
      .set('Cookie', cookie(as))
      .attach('file', PDF, { filename: 'b.pdf', contentType: 'application/pdf' })
      .field('machineId', String(new mongoose.Types.ObjectId()))
      .field('serviceLogId', String(new mongoose.Types.ObjectId()))
      .field('kind', 'service_bill');

  it('says the sandbox to a sandbox user', async () => {
    const res = await missing(sandboxUser);
    expect(res.status).toBe(404);
    expect(res.body.message).toContain('sandbox_db');
    expect(res.body.message).not.toContain('primary_db');
  });

  it('says the live database to everybody else', async () => {
    const res = await missing(admin);
    expect(res.status).toBe(404);
    expect(res.body.message).toContain('primary_db');
    expect(res.body.message).not.toContain('sandbox_db');
  });
});

// ══════════════════════════════════════════════════════════════════
//  "NOT ROUTED" HAS FOUR CAUSES AND ONE SYMPTOM
//
//  A sandbox user reading "this request read database baluElastics"
//  learns half of what they need. The expensive half is WHY: off the
//  list, SANDBOX_DB unset, or SANDBOX_DB colliding with the primary.
//  Three different fixes, and from the outside they are identical.
//
//  The one that costs the most is not in the app at all: the systemd
//  unit sets NODE_ENV=PRODUCTION, and node skips config/.env under
//  that, so systemd's EnvironmentFile is the only source and a change
//  needs `systemctl restart`. Adding SANDBOX_DB and reloading the page
//  changes nothing, because the process never saw the variable.
// ══════════════════════════════════════════════════════════════════
describe('why a request is not in the sandbox', () => {
  const { routingStateFor, describeRouting } = require('../../db/tenants.js');

  const withEnv = (env, fn) => {
    const saved = { SANDBOX_DB: process.env.SANDBOX_DB, SANDBOX_USERS: process.env.SANDBOX_USERS };
    Object.assign(process.env, env);
    try { return fn(); } finally { Object.assign(process.env, saved); }
  };

  it('says a listed user is routed', () => {
    expect(routingStateFor(sandboxUser)).toMatchObject({ routed: true, reason: 'routed' });
  });

  it('says an unlisted user is not on the list, and how many are', () => {
    const state = routingStateFor(admin);
    expect(state).toMatchObject({ routed: false, reason: 'not-listed' });
    expect(state.detail).toContain('owner@t.co');
    expect(state.detail).toMatch(/SANDBOX_USERS/);
  });

  it('points at systemd when SANDBOX_DB never reached the process', () => {
    // The failure mode: added to config/.env, service not restarted.
    withEnv({ SANDBOX_DB: '' }, () => {
      const state = routingStateFor(sandboxUser);
      expect(state).toMatchObject({ routed: false, reason: 'not-configured' });
      expect(state.detail).toMatch(/systemctl restart/);
      expect(state.detail).toMatch(/NODE_ENV=PRODUCTION/);
    });
  });

  it('says so when the sandbox names the live database', () => {
    withEnv({ SANDBOX_DB: mongoose.connection.name }, () => {
      expect(routingStateFor(sandboxUser)).toMatchObject({
        routed: false, reason: 'same-as-primary',
      });
    });
  });

  it('gives one boot line naming the database and who is on it', () => {
    expect(describeRouting()).toContain('sandbox_db');
    expect(describeRouting()).toContain('rsnavin02@gmail.com');
  });

  it('says OFF at boot when nothing is configured', () => {
    withEnv({ SANDBOX_DB: '' }, () => {
      expect(describeRouting()).toMatch(/OFF \(SANDBOX_DB not set\)/);
    });
  });

  it('says nobody is routed when the list is empty', () => {
    // Configured but useless — silently identical to not configured.
    withEnv({ SANDBOX_USERS: '' }, () => {
      expect(describeRouting()).toMatch(/nobody is routed/);
    });
  });

  it('puts the reason in the not-found error a user actually sees', async () => {
    const res = await request(app).post('/api/v2/machine/service-bill')
      .set('Cookie', cookie(admin))
      .attach('file', PDF, { filename: 'b.pdf', contentType: 'application/pdf' })
      .field('machineId', String(new mongoose.Types.ObjectId()))
      .field('serviceLogId', String(new mongoose.Types.ObjectId()))
      .field('kind', 'service_bill');

    expect(res.status).toBe(404);
    expect(res.body.message).toContain('primary_db');
    expect(res.body.message).toMatch(/not in SANDBOX_USERS/);
  });

  it('adds no noise for a correctly routed user', async () => {
    // They are where they should be; the reason would be clutter.
    const res = await request(app).post('/api/v2/machine/service-bill')
      .set('Cookie', cookie(sandboxUser))
      .attach('file', PDF, { filename: 'b.pdf', contentType: 'application/pdf' })
      .field('machineId', String(new mongoose.Types.ObjectId()))
      .field('serviceLogId', String(new mongoose.Types.ObjectId()))
      .field('kind', 'service_bill');

    expect(res.body.message).toContain('sandbox_db');
    expect(res.body.message).not.toMatch(/SANDBOX_USERS|systemctl/);
  });
});
