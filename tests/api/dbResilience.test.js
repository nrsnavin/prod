'use strict';
// ══════════════════════════════════════════════════════════════════
//  Surviving a database failover.
//
//  An Atlas replica-set election takes ~10–30s, during which connections
//  fail. The old connectDatabase called process.exit(1) on the FIRST
//  failure, so systemd restarted, failed again, and burned through its
//  StartLimitBurst — turning a transient election into an outage that
//  needed a human to clear.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const { connectDatabase, databaseHealth } = require('../../db/Database');

let mongo, app;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URL = mongo.getUri();
  app = require('../../app.js');
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

afterEach(async () => {
  jest.restoreAllMocks();
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
});

// No real waiting — the schedule is injected.
const NO_WAIT = [0, 0, 0];

describe('connectDatabase', () => {
  test('connects on the first try when the database is reachable', async () => {
    const spy = jest.spyOn(mongoose, 'connect');
    await connectDatabase({ retryDelays: NO_WAIT });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(databaseHealth().ok).toBe(true);
  });

  test('rides out a failover instead of exiting on the first failure', async () => {
    const real = mongoose.connect.bind(mongoose);
    let calls = 0;
    jest.spyOn(mongoose, 'connect').mockImplementation((...args) => {
      calls += 1;
      // Two elections' worth of refusals, then the new primary accepts.
      if (calls <= 2) return Promise.reject(new Error('no primary available'));
      return real(...args);
    });

    const onGiveUp = jest.fn();
    await connectDatabase({ retryDelays: NO_WAIT, onGiveUp });

    expect(calls).toBe(3);
    // The critical assertion: it recovered rather than killing the process.
    expect(onGiveUp).not.toHaveBeenCalled();
    expect(databaseHealth().ok).toBe(true);
  });

  test('gives up only after exhausting the schedule, and says so', async () => {
    jest.spyOn(mongoose, 'connect')
      .mockRejectedValue(new Error('getaddrinfo ENOTFOUND cluster'));
    const onGiveUp = jest.fn();

    await connectDatabase({ retryDelays: NO_WAIT, onGiveUp });

    // One attempt per delay, plus the initial one.
    expect(mongoose.connect).toHaveBeenCalledTimes(NO_WAIT.length + 1);
    expect(onGiveUp).toHaveBeenCalledTimes(1);
  });

  test('backs off between attempts rather than hot-looping', async () => {
    jest.spyOn(mongoose, 'connect').mockRejectedValue(new Error('down'));
    const started = Date.now();

    await connectDatabase({ retryDelays: [30, 30], onGiveUp: () => {} });

    // Two waits of 30ms; assert it actually waited rather than spinning.
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
  });
});

describe('readiness probe', () => {
  test('reports ready while the database is connected', async () => {
    await connectDatabase({ retryDelays: NO_WAIT });

    const res = await request(app).get('/api/v2/health/ready');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ready', db: 'connected' });
  });

  test('503s when the database is gone, so a balancer can pull the box out', async () => {
    await connectDatabase({ retryDelays: NO_WAIT });
    await mongoose.disconnect();

    const res = await request(app).get('/api/v2/health/ready');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('not-ready');
    expect(res.body.db).toBe('disconnected');
  });

  test('liveness stays up even with no database, so the box is not killed', async () => {
    await mongoose.disconnect().catch(() => {});

    // Liveness answers "is the process alive", readiness answers "can it
    // serve". Conflating them makes a supervisor restart a healthy process
    // during a database blip.
    const res = await request(app).get('/api/v2/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});
