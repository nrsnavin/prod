'use strict';
// ══════════════════════════════════════════════════════════════════
//  WHAT A SANDBOX USER DOES STAYS IN THE SANDBOX
//
//  Named users work in a second database (db/tenants.js). Every model a
//  file `require`s knows which database the request is in. A model
//  fetched by NAME did not: `mongoose.model('YarnLot')` and
//  `mongoose.models.YarnLot` hand back the model as first registered,
//  bound to the live database whoever is asking.
//
//  Four places fetched theirs that way:
//
//    • merging two materials — the materials themselves were merged in
//      the sandbox, and every record that NAMES them (dye lots, supplier
//      rates, purchase orders, recipes …) was re-pointed in the LIVE
//      database. A sandbox is a copy, so the ids are the same there:
//      somebody trying the merge "where it is safe" moved production's
//      records onto a material production had not merged.
//    • "is this master used?" before a delete — counted in live;
//    • the report engine — a sandbox user's reports were live's rows;
//    • the complaint trace's lot numbers.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';
process.env.SANDBOX_DB = 'stays_sandbox_db';
process.env.SANDBOX_USERS = 'sandbox-stays@t.co';

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, live, sandbox, tenants;

const cookie = (u) => [`token=${jwt.sign({ id: u._id, role: u.role }, process.env.JWT_SECRET_KEY)}`];
const oid = () => new mongoose.Types.ObjectId();
const inLive = (coll) => mongoose.connection.db.collection(coll);
const inSandbox = (coll) => mongoose.connection.useDb('stays_sandbox_db', { useCache: true }).db.collection(coll);

const keepId = oid(); const dupId = oid(); const lotId = oid();
const triedId = oid(); const triedLotId = oid();

const material = (over) => ({ category: 'weft', unit: 'kg', stock: 0, minStock: 0, price: 100, archived: false, createdAt: new Date(), updatedAt: new Date(), ...over });

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(`${mongo.getUri()}`.replace(/\/\?/, '/stays_live_db?'));
  app = require('../../app.js');
  tenants = require('../../db/tenants.js');
  const User = require('../../models/User');
  live = await User.create({ name: 'Live', email: 'live-stays@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  sandbox = await User.create({ name: 'Sand', email: 'sandbox-stays@t.co', password: 'pass1234', role: 'admin', department: 'admin' });

  // The sandbox is a copy of live: the same records, under the same ids.
  for (const db of [inLive, inSandbox]) {
    await db('rawmaterials').insertMany([
      material({ _id: keepId, name: 'Polyester 150D', stock: 10 }),
      material({ _id: dupId, name: 'Poly 150 D', stock: 5 }),
    ]);
    await db('yarnlots').insertOne({ _id: lotId, rawMaterial: dupId, lotNo: 'L-77', status: 'available', receivedDate: new Date() });
  }
  // And the two then drift: one material each that the other has not got.
  await inLive('rawmaterials').insertOne(material({ name: 'Only in live', stock: 1 }));
  await inSandbox('rawmaterials').insertOne(material({ _id: triedId, name: 'Only in the sandbox', stock: 2 }));
  // Something tried out in the sandbox, on a lot live has never heard of.
  await inSandbox('yarnlots').insertOne({ _id: triedLotId, rawMaterial: triedId, lotNo: 'TRY-1', status: 'available', receivedDate: new Date() });
}, 240_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

describe('a model fetched by name', () => {
  it('is the request\'s database\'s, like one that was required', async () => {
    const YarnLot = require('../../models/YarnLot');
    expect(typeof tenants.modelFor).toBe('function');
    const seen = await tenants.runInDb('stays_sandbox_db', async () => ({
      byName: await tenants.modelFor('YarnLot').countDocuments({}),
      required: await YarnLot.countDocuments({}),
    }));
    expect(seen).toEqual({ byName: 2, required: 2 });
    expect(await tenants.modelFor('YarnLot').countDocuments({})).toBe(1); // no request: live
  });

  it('logins stay where they are, whoever asks', async () => {
    const n = await tenants.runInDb('stays_sandbox_db', () => tenants.modelFor('User').countDocuments({}));
    expect(n).toBe(2);
  });

  it('nothing in the server fetches one the other way', () => {
    const root = path.join(__dirname, '..', '..');
    const allowed = new Set([
      'utils/blankRefs.js', // reads every SCHEMA once; touches no data
    ]);
    const found = [];
    const walk = (dir) => {
      for (const f of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
        const rel = `${dir}/${f.name}`;
        if (f.isDirectory()) { walk(rel); continue; }
        if (!/\.(js|cjs)$/.test(f.name) || allowed.has(rel)) continue;
        const src = fs.readFileSync(path.join(root, rel), 'utf8');
        src.split('\n').forEach((line, i) => {
          if (/^\s*(\/\/|\*)/.test(line)) return;
          // mongoose.model(<one argument>) — a lookup — or the registry itself.
          if (/mongoose\.model\(\s*[^,()]+\s*\)/.test(line) || /mongoose\.(models\b|modelNames\()/.test(line)) found.push(`${rel}:${i + 1}`);
        });
      }
    };
    for (const d of ['api', 'services', 'utils', 'middleware']) walk(d);
    expect(found).toEqual([]);
  });
});

describe('a report asked for from the sandbox', () => {
  const stock = (who) => request(app).post('/api/v2/reports/run').set('Cookie', cookie(who))
    .send({ sql: 'SELECT material, stock FROM stock ORDER BY material' });

  it('is the sandbox\'s rows; live sees live\'s', async () => {
    const s = await stock(sandbox);
    expect(s.status).toBe(200);
    const sNames = JSON.stringify(s.body);
    expect(sNames).toContain('Only in the sandbox');
    expect(sNames).not.toContain('Only in live');

    const l = await stock(live);
    const lNames = JSON.stringify(l.body);
    expect(lNames).toContain('Only in live');
    expect(lNames).not.toContain('Only in the sandbox');
  });
});

describe('"is this material used?", asked from the sandbox', () => {
  it('is answered from the sandbox', async () => {
    const { countUsage } = require('../../utils/masterUsage');
    const there = await tenants.runInDb('stays_sandbox_db', () => countUsage('RawMaterial', triedId));
    expect(there.used).toBe(true);
    expect(there.summary).toMatch(/dye lot/);
    // …and live, which has neither the material nor the lot, says no.
    expect((await countUsage('RawMaterial', triedId)).used).toBe(false);
  });
});

describe('merging two materials in the sandbox', () => {
  it('moves the sandbox\'s records and leaves every live one where it was', async () => {
    const res = await request(app).post('/api/v2/materials/merge').set('Cookie', cookie(sandbox))
      .send({ into: String(keepId), from: [String(dupId)] });
    expect(res.status).toBe(200);

    // Live: untouched. The lot still names the material it was received as,
    // and that material is still there with its stock.
    const liveLot = await inLive('yarnlots').findOne({ _id: lotId });
    expect(String(liveLot.rawMaterial)).toBe(String(dupId));
    const liveDup = await inLive('rawmaterials').findOne({ _id: dupId });
    expect(liveDup.archived).toBe(false);
    expect(liveDup.stock).toBe(5);

    // Sandbox: merged, lot and all.
    const sandLot = await inSandbox('yarnlots').findOne({ _id: lotId });
    expect(String(sandLot.rawMaterial)).toBe(String(keepId));
    const sandDup = await inSandbox('rawmaterials').findOne({ _id: dupId });
    expect(sandDup.archived).toBe(true);
    expect((await inSandbox('rawmaterials').findOne({ _id: keepId })).stock).toBe(15);
    expect(res.body.result?.moved ?? res.body.moved ?? res.body.data?.moved).toMatchObject({ 'YarnLot.rawMaterial': 1 });
  });
});
