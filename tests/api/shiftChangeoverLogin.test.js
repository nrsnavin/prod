'use strict';
// ══════════════════════════════════════════════════════════════════
//  SHIFT CHANGEOVER, THROUGH THE REAL LOGIN ROUTE
//
//  tests/middleware/rateLimits.test.js holds the limiters to their
//  rules on a stand-in app. This drives app.js itself, because the
//  failure that mattered was the WIRING: the login throttle counted
//  successful sign-ins, so the 21st worker on the office Wi-Fi was
//  locked out at 7 a.m. having typed nothing wrong.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, User;

const OFFICE = '198.51.100.20';
const WORKERS = 30; // past the old limit of 20

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  User = require('../../models/User');
  for (let i = 0; i < WORKERS; i++) {
    await User.create({
      name: `Worker ${i}`, email: `w${i}@mill.test`, password: 'pass1234',
      role: 'production', department: 'weaving',
    });
  }
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

const login = (email, password) =>
  request(app)
    .post('/api/v2/user/login-user')
    .set('X-Forwarded-For', OFFICE)
    .send({ email, password });

describe('a whole shift signing in from one office address', () => {
  it('lets every worker in', async () => {
    const statuses = [];
    for (let i = 0; i < WORKERS; i++) statuses.push((await login(`w${i}@mill.test`, 'pass1234')).status);
    expect(statuses.filter((s) => s === 429)).toEqual([]);
    expect(statuses.every((s) => s === 200 || s === 201)).toBe(true);
  }, 120_000);

  it('still stops someone guessing one account\'s password', async () => {
    let last;
    for (let i = 0; i < 21; i++) last = await login('w0@mill.test', `guess-${i}`);
    expect(last.status).toBe(429);
  }, 120_000);

  it('does not lock the rest of the office out because of that guesser', async () => {
    const r = await login('w1@mill.test', 'pass1234');
    expect(r.status).not.toBe(429);
  }, 60_000);
});
