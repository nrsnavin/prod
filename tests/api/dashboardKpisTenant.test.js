'use strict';
// ══════════════════════════════════════════════════════════════════
//  A SHARED DASHBOARD ANSWER MUST NOT CROSS DATABASES
//
//  /dashboard/kpis now hands one computed answer to everyone asking
//  within a few seconds. Sandbox users (db/tenants.js) work in a
//  different database from everyone else, so the one way this cache
//  could leak is a live user being served the sandbox's numbers, or the
//  other way round. The cache key carries the request's database; this
//  proves it through the real route, with both users asking inside the
//  same TTL window.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';
process.env.SANDBOX_DB = 'kpi_sandbox_db';
process.env.SANDBOX_USERS = 'sandbox-kpi@t.co';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, User, live, sandbox;

const cookie = (u) => [`token=${jwt.sign({ id: u._id, role: u.role }, process.env.JWT_SECRET_KEY)}`];
const rawIn = (dbName) => mongoose.connection.useDb(dbName, { useCache: true }).db.collection('rawmaterials');

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(`${mongo.getUri()}`.replace(/\/\?/, '/kpi_live_db?'));
  app = require('../../app.js');
  User = require('../../models/User');
  live = await User.create({ name: 'Live', email: 'live-kpi@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  sandbox = await User.create({ name: 'Sand', email: 'sandbox-kpi@t.co', password: 'pass1234', role: 'admin', department: 'admin' });

  // Live has three low materials; the sandbox has one.
  const low = (name) => ({ name, category: 'warp', stock: 1, minStock: 10, price: 1 });
  await rawIn(mongoose.connection.name).insertMany([low('L1'), low('L2'), low('L3')]);
  await rawIn('kpi_sandbox_db').insertMany([low('S1')]);
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

it('gives the live user and the sandbox user each their own numbers, even back to back', async () => {
  const a = await request(app).get('/api/v2/dashboard/kpis').set('Cookie', cookie(live));
  const b = await request(app).get('/api/v2/dashboard/kpis').set('Cookie', cookie(sandbox));
  const c = await request(app).get('/api/v2/dashboard/kpis').set('Cookie', cookie(live));

  expect(a.body.data.lowStock.count).toBe(3);
  expect(b.body.data.lowStock.count).toBe(1);
  expect(b.body.data.lowStock.items.map((m) => m.name)).toEqual(['S1']);
  expect(c.body.data.lowStock.count).toBe(3);
});
