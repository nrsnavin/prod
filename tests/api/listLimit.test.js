'use strict';
// ══════════════════════════════════════════════════════════════════
//  LISTS THAT CAN'T GROW WITHOUT END — utils/listLimit.js
//
//  A list that only grows answers its newest rows up to a ceiling, and
//  says when it was cut; a list under the ceiling is untouched; a date
//  range wider than a year is refused with a plain message.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { capped, rangeProblem } = require('../../utils/listLimit');

let mongo, app, admin, MachineIssue, Machine;
const cookie = (u) => [`token=${jwt.sign({ id: u._id, role: u.role }, process.env.JWT_SECRET_KEY)}`];

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  const User = require('../../models/User');
  MachineIssue = require('../../models/MachineIssue');
  Machine = require('../../models/Machine');
  admin = await User.create({ name: 'Owner', email: 'own@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

describe('capped()', () => {
  const Row = () => mongoose.models.LlRow || mongoose.model('LlRow', new mongoose.Schema({ n: Number }));

  beforeAll(async () => {
    await Row().insertMany(Array.from({ length: 12 }, (_, n) => ({ n })));
  });

  it('leaves a list under the ceiling untouched', async () => {
    const res = { set: jest.fn() };
    const out = await capped(Row().find().sort({ n: -1 }).lean(), res, 20);
    expect(out.rows).toHaveLength(12);
    expect(out.capped).toBe(false);
    expect(res.set).not.toHaveBeenCalled();
  });

  it('keeps the first rows of a longer one, and says so', async () => {
    const res = { set: jest.fn() };
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const out = await capped(Row().find().sort({ n: -1 }).lean(), res, 5);
    expect(out.rows.map((r) => r.n)).toEqual([11, 10, 9, 8, 7]);
    expect(out.capped).toBe(true);
    expect(res.set).toHaveBeenCalledWith('X-Result-Capped', '5');
  });
});

describe('a real list route', () => {
  it('answers as before while it is small', async () => {
    const m = await Machine.create({ ID: 'L-1', manufacturer: 'X', NoOfHead: 1, NoOfHooks: 1 });
    await MachineIssue.create({ machine: m._id, title: 'Belt', description: 'slipping' });
    const res = await request(app).get('/api/v2/machine-issue').set('Cookie', cookie(admin));
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body).not.toHaveProperty('capped');
    expect(res.headers['x-result-capped']).toBeUndefined();
  });
});

describe('rangeProblem()', () => {
  it('allows up to about a year', () => {
    expect(rangeProblem('2026-01-01', '2026-12-31')).toBeNull();
  });
  it('refuses wider, in plain words', () => {
    expect(rangeProblem('2024-01-01', '2026-01-01')).toMatch(/at most 370 days/);
  });
  it('leaves unparseable dates to the route', () => {
    expect(rangeProblem('soon', 'later')).toBeNull();
  });

  it('is applied to the production report', async () => {
    const res = await request(app).get('/api/v2/production/date-range?startDate=2023-01-01&endDate=2026-01-01').set('Cookie', cookie(admin));
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/at most 370 days/);
  });
});
