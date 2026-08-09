'use strict';
// ══════════════════════════════════════════════════════════════════
//  ONE ELASTIC PER NAME
//
//  Two rows for one product split every figure that touches it — stock
//  on hand, the order book, the P&L, the forecast — and each half looks
//  plausible on its own screen. That is what makes it worth refusing at
//  the door rather than reconciling later.
//
//  The interesting cases are all about what "the same name" means. An
//  exact-match check catches almost none of the duplicates that
//  actually happen: the second copy is typed by a different person on a
//  different day, and the shift key is the first thing to differ.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryServer } = require('mongodb-memory-server');

const { elasticNameKey } = require('../../utils/elasticName.js');

let mongo, app, Elastic, User, admin;

const adminCookie = () => [
  `token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`,
];

beforeAll(async () => {
  mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 60_000 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  Elastic = require('../../models/Elastic');
  User = require('../../models/User');
  admin = await User.create({
    name: 'Owner', email: 'o@t.co', password: 'pass1234', role: 'admin', department: 'admin',
  });
}, 120_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
});

// Shaped like what the web and mobile forms actually post. The three
// material slots are always sent as objects even when nothing is picked
// — create-elastic's costing step dereferences them unconditionally, so
// a leaner fixture would be testing a shape no real caller sends.
const spec = (name) => ({
  name, weaveType: '8', spandexEnds: 40, yarnEnds: 120,
  pick: 12, noOfHook: 8, weight: 2.4,
  warpSpandex:     { id: null, ends: 40, weight: 0.4 },
  spandexCovering: { id: null, weight: 0.3 },
  weftYarn:        { id: null, weight: 0.5 },
  warpYarn:        [],
});

const create = (name) =>
  request(app).post('/api/v2/elastic/create-elastic')
    .set('Cookie', adminCookie()).send(spec(name));

const update = (id, body) =>
  request(app).put('/api/v2/elastic/update-elastic')
    .set('Cookie', adminCookie()).send({ _id: String(id), ...body });

// ── The key ───────────────────────────────────────────────────────

describe('what counts as the same name', () => {
  it('folds case, ends and internal runs of whitespace', () => {
    const same = [
      'NEWDAY ROMEO BLACK',
      'newday romeo black',
      'Newday Romeo Black',
      '  NEWDAY ROMEO BLACK  ',
      'NEWDAY  ROMEO   BLACK',
      'NEWDAY\tROMEO BLACK',
    ].map(elasticNameKey);
    expect(new Set(same).size).toBe(1);
  });

  it('leaves punctuation alone — a hyphen is sometimes load-bearing', () => {
    // Guessing here costs more than it saves: "ROMEO-BLACK" may well be
    // a different product from "ROMEO BLACK", and merging them by rule
    // would be a silent, unrecoverable decision.
    expect(elasticNameKey('ROMEO-BLACK')).not.toBe(elasticNameKey('ROMEO BLACK'));
  });

  it('has no key for an empty or missing name', () => {
    for (const v of ['', '   ', null, undefined]) {
      expect(elasticNameKey(v)).toBe('');
    }
  });
});

// ── Creating ──────────────────────────────────────────────────────

describe('POST /elastic/create-elastic', () => {
  it('takes the first one', async () => {
    const res = await create('NEWDAY ROMEO BLACK');
    expect(res.status).toBe(201);
    expect(res.body.elastic.name).toBe('NEWDAY ROMEO BLACK');
  });

  it('refuses the same name again', async () => {
    await create('NEWDAY ROMEO BLACK');
    const again = await create('NEWDAY ROMEO BLACK');

    expect(again.status).toBe(409);
    // The message names the one in the way, because "duplicate key" tells
    // somebody entering a product nothing about what to do next.
    expect(again.body.message).toMatch(/NEWDAY ROMEO BLACK/);
    expect(await Elastic.countDocuments()).toBe(1);
  });

  it('refuses it in different case and spacing', async () => {
    await create('NEWDAY ROMEO BLACK');
    for (const variant of [
      'newday romeo black',
      'Newday Romeo Black',
      'NEWDAY  ROMEO  BLACK',
      '  NEWDAY ROMEO BLACK ',
    ]) {
      const res = await create(variant);
      expect({ variant, status: res.status }).toEqual({ variant, status: 409 });
    }
    expect(await Elastic.countDocuments()).toBe(1);
  });

  it('trims the stored name, so a trailing space cannot smuggle a copy in', async () => {
    const res = await create('  BLUE 20MM  ');
    expect(res.status).toBe(201);
    expect(res.body.elastic.name).toBe('BLUE 20MM');
    expect((await create('BLUE 20MM')).status).toBe(409);
  });

  it('writes nothing at all when it refuses', async () => {
    // The refusal has to land before the Costing row is made, or every
    // rejected attempt leaves an orphan behind it.
    await create('NEWDAY ROMEO BLACK');
    const before = await mongoose.connection.collection('costings').countDocuments();

    await create('newday romeo black');

    expect(await mongoose.connection.collection('costings').countDocuments()).toBe(before);
    expect(await Elastic.countDocuments()).toBe(1);
  });

  it('says so when the clash is an archived elastic', async () => {
    // Otherwise the name looks free on the list and is refused anyway,
    // which is a mystery rather than a message.
    const first = await create('OLD STOCK 25MM');
    await Elastic.findByIdAndUpdate(first.body.elastic._id, { archived: true });

    const again = await create('OLD STOCK 25MM');
    expect(again.status).toBe(409);
    expect(again.body.message).toMatch(/archived/i);
  });

  it('ignores a nameKey supplied in the body', async () => {
    // Accepting it would let a caller point a new elastic's key at some
    // other name and walk straight past the check.
    await create('NEWDAY ROMEO BLACK');
    const res = await request(app).post('/api/v2/elastic/create-elastic')
      .set('Cookie', adminCookie())
      .send({ ...spec('NEWDAY ROMEO BLACK'), nameKey: 'something-else' });

    expect(res.status).toBe(409);
    expect(await Elastic.countDocuments()).toBe(1);
  });

  it('lets two genuinely different products through', async () => {
    expect((await create('NEWDAY ROMEO BLACK')).status).toBe(201);
    expect((await create('NEWDAY ROMEO WHITE')).status).toBe(201);
    expect(await Elastic.countDocuments()).toBe(2);
  });
});

// ── Editing ───────────────────────────────────────────────────────

describe('PUT /elastic/update-elastic', () => {
  it('refuses a rename onto another elastic', async () => {
    const a = await create('NEWDAY ROMEO BLACK');
    const b = await create('NEWDAY ROMEO WHITE');

    const res = await update(b.body.elastic._id, { name: 'newday romeo black' });
    expect(res.status).toBe(409);

    const unchanged = await Elastic.findById(b.body.elastic._id);
    expect(unchanged.name).toBe('NEWDAY ROMEO WHITE');
  });

  it('lets an elastic keep its own name through an unrelated edit', async () => {
    // The check has to exclude the row being edited, or every edit that
    // resends the name is refused by the elastic itself.
    const a = await create('NEWDAY ROMEO BLACK');
    const res = await update(a.body.elastic._id, {
      name: 'NEWDAY ROMEO BLACK', pick: 14,
    });
    expect(res.status).toBe(200);
    expect(res.body.elastic.pick).toBe(14);
  });

  it('allows a change of capitalisation on its own name', async () => {
    const a = await create('newday romeo black');
    const res = await update(a.body.elastic._id, { name: 'NEWDAY ROMEO BLACK' });
    expect(res.status).toBe(200);
    expect(res.body.elastic.name).toBe('NEWDAY ROMEO BLACK');
  });

  it('edits that do not touch the name are never blocked', async () => {
    const a = await create('NEWDAY ROMEO BLACK');
    const res = await update(a.body.elastic._id, { weight: 3.1 });
    expect(res.status).toBe(200);
  });

  it('keeps the key in step after a rename', async () => {
    // A stale key would leave the old name still reserved and the new
    // one still free — the constraint quietly inverted.
    const a = await create('NEWDAY ROMEO BLACK');
    await update(a.body.elastic._id, { name: 'NEWDAY ROMEO RED' });

    const doc = await Elastic.findById(a.body.elastic._id);
    expect(doc.nameKey).toBe('newday romeo red');

    expect((await create('NEWDAY ROMEO BLACK')).status).toBe(201); // freed
    expect((await create('newday romeo red')).status).toBe(409);   // taken
  });
});

// ── The key is derived, whoever writes ────────────────────────────

describe('nameKey is maintained by the model, not the route', () => {
  it('is set on a direct create that never goes near the API', async () => {
    // The seeder and anything added later write through save() too.
    const doc = await Elastic.create(spec('  Direct  Write  '));
    expect(doc.name).toBe('Direct  Write');
    expect(doc.nameKey).toBe('direct write');
  });

  it('follows the name on a direct save', async () => {
    const doc = await Elastic.create(spec('First Name'));
    doc.name = 'Second Name';
    await doc.save();
    expect(doc.nameKey).toBe('second name');
  });

  it('follows the name through the update pipeline too', async () => {
    // findOneAndUpdate does not run document hooks. Nothing renames an
    // elastic this way today, but a stale key is worse than no key: it
    // holds the OLD name reserved while leaving the new one free.
    const doc = await Elastic.create(spec('Pipeline Before'));
    await Elastic.findByIdAndUpdate(doc._id, { $set: { name: 'Pipeline After' } });

    const fresh = await Elastic.findById(doc._id);
    expect(fresh.nameKey).toBe('pipeline after');
    expect((await create('pipeline after')).status).toBe(409);
    expect((await create('Pipeline Before')).status).toBe(201);
  });

  it('backfills a key onto a legacy row the first time it is saved', async () => {
    // A row written before any of this existed. The first save derives
    // its key without waiting for the migration.
    const doc = await Elastic.create(spec('Legacy Row'));
    await mongoose.connection.collection('elastics')
      .updateOne({ _id: doc._id }, { $unset: { nameKey: '' } });

    const loaded = await Elastic.findById(doc._id);
    expect(loaded.nameKey).toBeUndefined();
    loaded.weight = 3.3;
    await loaded.save();
    expect(loaded.nameKey).toBe('legacy row');
  });
});
