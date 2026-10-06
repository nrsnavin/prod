'use strict';
// ══════════════════════════════════════════════════════════════════
//  ONE LOOM, TWO JOBS, ASSIGNED AT THE SAME MOMENT
//
//  Two supervisors assign the same free loom to two different jobs.
//  Both requests pass the "is it free?" check before either writes.
//  Before the fix both saved: the second took the loom from under the
//  first job, which still pointed at it. Now exactly one wins, and the
//  loom and the winning job point at each other.
//
//  The interleaving is forced, not hoped for: the hook-fit check (which
//  runs after the free check and before the write) waits until both
//  requests have reached it.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

let mockArrived = 0;
let mockRelease;
let mockBarrier = null;
jest.mock('../../utils/machineFit', () => {
  const actual = jest.requireActual('../../utils/machineFit');
  return {
    ...actual,
    checkHookFit: async () => {
      if (mockBarrier) {
        mockArrived += 1;
        if (mockArrived >= 2) mockRelease();
        await mockBarrier;
      }
      return { fits: true, overs: [], machineHooks: 8, summary: '', checked: 0, unchecked: 0, reason: '' };
    },
  };
});

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, JobOrder, Machine, Elastic, admin;
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
const assign = (job, machine, elastic) =>
  request(app).post('/api/v2/job/assign-machine').set('Cookie', cookie()).send({
    jobId: String(job._id), machineId: String(machine._id),
    elastics: [{ head: 1, elastic: String(elastic._id) }, { head: 2, elastic: String(elastic._id) }],
  });

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  JobOrder = require('../../models/JobOrder');
  Machine = require('../../models/Machine');
  Elastic = require('../../models/Elastic');
  const User = require('../../models/User');
  admin = await User.create({ name: 'Owner', email: 'o@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
}, 120_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
beforeEach(() => {
  mockArrived = 0;
  mockBarrier = new Promise((r) => { mockRelease = r; });
});

async function seed() {
  const elastic = await Elastic.create({
    name: `E ${Math.random().toString(36).slice(2, 8)}`, weaveType: '8',
    spandexEnds: 40, yarnEnds: 120, pick: 12, noOfHook: 8, weight: 2.4,
  });
  const job = () => JobOrder.create({
    date: new Date(), order: new mongoose.Types.ObjectId(), customer: new mongoose.Types.ObjectId(),
    status: 'preparatory', elastics: [{ elastic: elastic._id, quantity: 500 }],
  });
  const machine = await Machine.create({
    ID: `M-${Math.floor(Math.random() * 1e6)}`, manufacturer: 'Comez',
    NoOfHead: 2, NoOfHooks: 8, status: 'free', orderRunning: null, elastics: [],
  });
  return { elastic, jobA: await job(), jobB: await job(), machine };
}

describe('two jobs assigned the same free loom at once', () => {
  it('gives the loom to exactly one, and the links agree', async () => {
    const { elastic, jobA, jobB, machine } = await seed();
    const [a, b] = await Promise.all([assign(jobA, machine, elastic), assign(jobB, machine, elastic)]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    expect(loser.body.message).toMatch(/was just taken/);

    const winner = a.status === 200 ? jobA : jobB;
    const other = winner === jobA ? jobB : jobA;
    const m = await Machine.findById(machine._id).lean();
    expect(m.status).toBe('running');
    expect(String(m.orderRunning)).toBe(String(winner._id));
    expect(String((await JobOrder.findById(winner._id).lean()).machine)).toBe(String(machine._id));
    // The loser never claims a loom that isn't running its job.
    expect((await JobOrder.findById(other._id).lean()).machine ?? null).toBeNull();
  });
});

describe('assigning still works as before', () => {
  beforeEach(() => { mockBarrier = null; });

  it('assigns a free loom, and moves a job from its old loom to a new one', async () => {
    const { elastic, jobA, machine } = await seed();
    expect((await assign(jobA, machine, elastic)).status).toBe(200);
    const second = await Machine.create({
      ID: `M-${Math.floor(Math.random() * 1e6)}`, manufacturer: 'Comez',
      NoOfHead: 2, NoOfHooks: 8, status: 'free', orderRunning: null, elastics: [],
    });
    expect((await assign(jobA, second, elastic)).status).toBe(200);
    expect(await Machine.findById(machine._id).lean()).toMatchObject({ status: 'free', orderRunning: null });
    expect(String((await Machine.findById(second._id).lean()).orderRunning)).toBe(String(jobA._id));
    expect(String((await JobOrder.findById(jobA._id).lean()).machine)).toBe(String(second._id));
  });

  it('refuses a loom already running another job', async () => {
    const { elastic, jobA, jobB, machine } = await seed();
    expect((await assign(jobA, machine, elastic)).status).toBe(200);
    const res = await assign(jobB, machine, elastic);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/on another job/);
  });
});
