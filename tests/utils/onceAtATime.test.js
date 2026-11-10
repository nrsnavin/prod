'use strict';
// ══════════════════════════════════════════════════════════════════
//  ONE AT A TIME
//
//  The lease behind "worked out, then created" (utils/onceAtATime.js):
//  the second request waits for the first and then runs against what
//  the first one made.
// ══════════════════════════════════════════════════════════════════

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongo, Lease, onceAtATime, take, release;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  Lease = require('../../models/Lease');
  ({ onceAtATime, take, release } = require('../../utils/onceAtATime'));
  await Lease.init();
}, 120_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(() => Lease.deleteMany({}));

it('runs one at a time: the second starts only when the first has finished', async () => {
  const seen = [];
  const work = (name) => async () => {
    seen.push(`${name} in`);
    await pause(150);
    seen.push(`${name} out`);
    return name;
  };
  const [a, b] = await Promise.all([onceAtATime('k', work('a')), onceAtATime('k', work('b'))]);
  expect([a, b]).toEqual(['a', 'b']);
  // Whoever went first was out before the other was in.
  expect([['a in', 'a out', 'b in', 'b out'], ['b in', 'b out', 'a in', 'a out']]).toContainEqual(seen);
  expect(await Lease.countDocuments({})).toBe(0);
});

it('many at once still run one by one', async () => {
  let running = 0, most = 0, done = 0;
  const work = async () => {
    running += 1; most = Math.max(most, running);
    await pause(20);
    running -= 1; done += 1;
  };
  await Promise.all(Array.from({ length: 8 }, () => onceAtATime('k', work)));
  expect(done).toBe(8);
  expect(most).toBe(1);
});

it('different things do not wait for each other', async () => {
  let together = 0, most = 0;
  const work = async () => { together += 1; most = Math.max(most, together); await pause(100); together -= 1; };
  await Promise.all([onceAtATime('order:1', work), onceAtATime('order:2', work)]);
  expect(most).toBe(2);
});

it('says so, with a 409, when the other is still going after the wait', async () => {
  const slow = onceAtATime('k', () => pause(600));
  await pause(50);
  await expect(onceAtATime('k', async () => 'never', { waitMs: 150, what: 'Purchase orders for this order' }))
    .rejects.toMatchObject({ statusCode: 409, code: 'ALREADY_RUNNING', message: expect.stringMatching(/^Purchase orders for this order is being done by someone else/) });
  await slow;
});

it('lets go when the work fails, and passes the failure on', async () => {
  await expect(onceAtATime('k', async () => { throw new Error('no supplier'); })).rejects.toThrow('no supplier');
  expect(await onceAtATime('k', async () => 'next')).toBe('next');
});

it('a holder that died keeps nobody out once its time is up', async () => {
  const dead = await take('k', 80);          // taken, and never released
  expect(dead).toBeTruthy();
  expect(await take('k', 80)).toBeNull();    // still held
  await pause(120);
  const next = await take('k', 60_000);      // lapsed: taken over
  expect(next).toBeTruthy();
  // The dead holder coming back to life does not release the new holder's lease.
  await release('k', dead);
  expect(await take('k', 60_000)).toBeNull();
});
