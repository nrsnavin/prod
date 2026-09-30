'use strict';
// ══════════════════════════════════════════════════════════════════
//  TWO PEOPLE EDITING ONE RECORD
//
//  Customer, raw material, machine details, a loom's head map and an
//  elastic's recipe were all last-write-wins: two people open the same
//  record, both save, and the second silently erases the first with no
//  trace. Each now takes the version its form loaded and refuses a save
//  made from a stale screen with a 409 that says to reload.
//
//  Held for every route:
//    • the right version saves, and moves the version on;
//    • the scenario itself — both load v0, A saves, B saves v0 → 409,
//      and A's edit is still there;
//    • a client that sends NO version still saves (old app builds), and
//      still moves the version on, so a newer client holding the old
//      one cannot overwrite it unchallenged.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, M, admin;
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  M = {};
  for (const n of ['Customer', 'RawMaterial', 'Machine', 'Elastic', 'User']) M[n] = require(`../../models/${n}`);
  admin = await M.User.create({ name: 'Owner', email: 'ol@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
});

const version = async (Model, id) => Number((await Model.findById(id).select('__v').lean()).__v ?? 0);

// Each route as: how to make a record, how to save an edit, how to read
// the edited field back.
let seq = 0;
const ROUTES = {
  customer: {
    Model: () => M.Customer,
    make: () => M.Customer.create({ name: `Acme ${++seq}`, contactName: 'R', phoneNumber: '9000000001' }),
    save: (doc, value, v) => request(app).put('/api/v2/customer/update').set('Cookie', cookie())
      .send({ _id: String(doc._id), contactName: value, ...(v === undefined ? {} : { expectedVersion: v }) }),
    read: async (doc) => (await M.Customer.findById(doc._id).lean()).contactName,
  },
  material: {
    Model: () => M.RawMaterial,
    make: () => M.RawMaterial.create({ name: `Nylon ${++seq}`, category: 'warp', price: 100, stock: 10, minStock: 1 }),
    save: (doc, value, v) => request(app).put('/api/v2/materials/edit-raw-material').set('Cookie', cookie())
      .send({ _id: String(doc._id), minStock: value, ...(v === undefined ? {} : { expectedVersion: v }) }),
    read: async (doc) => (await M.RawMaterial.findById(doc._id).lean()).minStock,
    values: [5, 9],
  },
  machineDetails: {
    Model: () => M.Machine,
    make: () => M.Machine.create({ ID: `M-${++seq}`, manufacturer: 'Comez', NoOfHead: 2, NoOfHooks: 8 }),
    save: (doc, value, v) => request(app).patch('/api/v2/machine/update-details').set('Cookie', cookie())
      .send({ machineId: String(doc._id), manufacturer: value, ...(v === undefined ? {} : { expectedVersion: v }) }),
    read: async (doc) => (await M.Machine.findById(doc._id).lean()).manufacturer,
  },
  headMap: {
    Model: () => M.Machine,
    make: async () => {
      const a = await M.Elastic.create({ name: `E-a-${++seq}`, weaveType: '8', spandexEnds: 40, yarnEnds: 120, pick: 12, noOfHook: 8, weight: 2 });
      const b = await M.Elastic.create({ name: `E-b-${seq}`, weaveType: '8', spandexEnds: 40, yarnEnds: 120, pick: 12, noOfHook: 8, weight: 2 });
      const m = await M.Machine.create({ ID: `HM-${seq}`, manufacturer: 'Comez', NoOfHead: 1, NoOfHooks: 8 });
      m._elastics = { A: String(a._id), B: String(b._id) };
      return m;
    },
    save: (doc, value, v) => request(app).put('/api/v2/machine/updateOrder').set('Cookie', cookie())
      .send({ id: String(doc._id), elastics: [{ head: 1, elastic: doc._elastics[value] }], ...(v === undefined ? {} : { expectedVersion: v }) }),
    read: async (doc) => {
      const e = (await M.Machine.findById(doc._id).lean()).elastics?.[0]?.elastic;
      return Object.entries(doc._elastics).find(([, id]) => id === String(e))?.[0];
    },
    values: ['A', 'B'],
  },
  elastic: {
    Model: () => M.Elastic,
    make: () => M.Elastic.create({ name: `El ${++seq}`, weaveType: '8', spandexEnds: 40, yarnEnds: 120, pick: 12, noOfHook: 8, weight: 2 }),
    save: (doc, value, v) => request(app).put('/api/v2/elastic/update-elastic').set('Cookie', cookie())
      .send({ _id: String(doc._id), pick: value, ...(v === undefined ? {} : { expectedVersion: v }) }),
    read: async (doc) => (await M.Elastic.findById(doc._id).lean()).pick,
    values: [14, 16],
  },
};

describe.each(Object.keys(ROUTES))('%s', (name) => {
  const r = ROUTES[name];
  const [A, B] = r.values || ['first', 'second'];

  it('saves with the version it loaded, and moves the version on', async () => {
    const doc = await r.make();
    const v0 = await version(r.Model(), doc._id);
    const res = await r.save(doc, A, v0);
    expect(res.status).toBe(200);
    expect(await r.read(doc)).toBe(A);
    expect(await version(r.Model(), doc._id)).toBeGreaterThan(v0);
  });

  it('refuses the second of two people editing from the same screen', async () => {
    const doc = await r.make();
    const v0 = await version(r.Model(), doc._id);
    expect((await r.save(doc, A, v0)).status).toBe(200);   // first person
    const stale = await r.save(doc, B, v0);                 // second, same screen
    expect(stale.status).toBe(409);
    expect(stale.body.message).toMatch(/changed by someone else/i);
    // Its own code, so a client can tell it from this API's other 409s.
    expect(stale.body.code).toBe('VERSION_CONFLICT');
    expect(await r.read(doc)).toBe(A);                      // first edit survives
  });

  it('still saves for a client that sends no version, and moves the version on', async () => {
    // Old app builds. Without the bump, a newer client that loaded before
    // this save would overwrite it unchallenged.
    const doc = await r.make();
    const v0 = await version(r.Model(), doc._id);
    expect((await r.save(doc, A)).status).toBe(200);
    expect(await version(r.Model(), doc._id)).toBeGreaterThan(v0);
    expect((await r.save(doc, B, v0)).status).toBe(409);
  });

  it('refuses a version that is not a number', async () => {
    const doc = await r.make();
    expect((await r.save(doc, A, 'abc')).status).toBe(400);
  });
});
