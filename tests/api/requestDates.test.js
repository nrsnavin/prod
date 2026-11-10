'use strict';
// ══════════════════════════════════════════════════════════════════
//  A DATE THAT IS NOT ONE
//
//  Seven handlers took a date from the request and handed it on without
//  looking. Sent "next week", each answered in the database's words —
//  'Cast to date failed for value "Invalid Date" (type Date) at path
//  "billDate"' — or, for a search, went and found nothing. Held here:
//  each says which field is not a date, before anything is written; and
//  a real date, or none, goes through as it always did.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, User, Employee, admin;
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
const post = (url, body) => request(app).post(`/api/v2${url}`).set('Cookie', cookie()).send(body);
const get = (url) => request(app).get(`/api/v2${url}`).set('Cookie', cookie());
const id = () => String(new mongoose.Types.ObjectId());

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  User = require('../../models/User');
  Employee = require('../../models/Employee');
  const emp = await Employee.create({ name: 'Asha', hourlyRate: 100 });
  admin = await User.create({
    name: 'Asha', email: 'o@t.co', password: 'pass1234', role: 'admin', department: 'admin', employee: emp._id,
  });
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

/** What the handlers themselves would have written, had they gone on. */
const RECORDS = ['complaints', 'machines', 'machineservicebills', 'planruns', 'wastages', 'yarnlots', 'rawmaterials'];
const written = async () => {
  const counts = {};
  for (const c of Object.values(mongoose.connection.collections)) {
    const n = await c.countDocuments({});
    if (n && (RECORDS.includes(c.collectionName) || /plan|complaint|wastage|yarn|bill/.test(c.collectionName))) counts[c.collectionName] = n;
  }
  return counts;
};

describe('a date that is not one is refused by name, and nothing is written', () => {
  const cases = [
    ['a complaint\'s date', () => post('/complaint', { customer: id(), job: id(), reason: 'shade varies', date: 'next week' }), 'date'],
    ['a service log\'s next service date', () => post('/machine/add-service-log', { machineId: id(), type: 'Corrective', description: 'belt changed', nextServiceDate: '31/02/2027' }), 'nextServiceDate'],
    ['a service bill\'s date', () => request(app).post('/api/v2/machine/service-bill').set('Cookie', cookie()).field('machineId', id()).field('billDate', 'yesterday'), 'billDate'],
    ['when a plan was generated', () => post('/planner/accept', { machines: [], generatedAt: 'just now' }), 'generatedAt'],
    ['when wastage happened', () => post('/wastage/add-wastage', { job: id(), elastic: id(), reason: 'cut at the selvedge', quantity: 4, incidentDate: 'monday' }), 'incidentDate'],
    ['when a yarn lot was received', () => post('/yarn-lots/create', { rawMaterial: id(), lotNo: 'L-1', quantity: 10, receivedDate: 'last month' }), 'receivedDate'],
    ['the start of a profit search', () => get('/pnl/orders?from=whenever'), 'from'],
    ['the end of a profit search', () => get('/pnl/orders?to=whenever'), 'to'],
  ];

  it.each(cases)('%s', async (_what, send, field) => {
    const before = await written();
    const res = await send();
    expect([res.status, res.body.message]).toEqual([400, `${field} is not a date`]);
    expect(await written()).toEqual(before);
  });
});

describe('CONTROL: a real date, or none, goes through as it always did', () => {
  it('a search between two days answers', async () => {
    const res = await get('/pnl/orders?from=2026-04-01&to=2026-04-30');
    expect(res.status).toBe(200);
    expect((await get('/pnl/orders')).status).toBe(200);
  });

  it('the handlers get past the date to what they check next', async () => {
    // Each of these has a good date (or none) and fails on something
    // further in — which is the point: the date did not stop it.
    const complaint = await post('/complaint', { customer: id(), job: id(), reason: 'shade varies', date: '2026-11-10' });
    expect(complaint.body.message).not.toMatch(/is not a date/);
    const log = await post('/machine/add-service-log', { machineId: id(), type: 'Corrective', description: 'belt changed' });
    expect([log.status, log.body.message]).toEqual([404, 'Machine not found']);
    const lot = await post('/yarn-lots/create', { rawMaterial: id(), lotNo: 'L-1', quantity: 10, receivedDate: '2026-11-01' });
    expect(lot.body.message).not.toMatch(/is not a date/);
  });
});
