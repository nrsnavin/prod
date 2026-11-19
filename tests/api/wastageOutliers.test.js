'use strict';
// ══════════════════════════════════════════════════════════════════
//  "MACHINES WITH HIGH WASTAGE" — GET /job/wastage-outliers
//
//  Found reading api/jobLookup.js line by line. The phone's advisor
//  shows the count from this route as "N machines with high wastage —
//  last 7 days more than 2σ above their own baseline".
//
//  1. IT WAS NOT A COMPARISON OF LIKE WITH LIKE. The baseline was the
//     average size of ONE wastage entry (and its spread); the figure
//     held up against it was the TOTAL of the last seven days. A loom
//     that wasted a steady 20 m every day had entries averaging 20 m,
//     a seven-day total of 140 m, and was "high" every single day. Any
//     loom with two entries in a week was on the list.
//     Now: the last seven days against what a week normally is on that
//     loom — its own daily totals over the days before, quiet days
//     counted as nothing.
//
//  2. A LOOM DROPPED OFF THE LIST WHEN ITS JOB LEFT IT. The machine was
//     read off the job, and a job stops pointing at a machine when it
//     goes to finishing. The entries know their loom (kept on the
//     record; before that, the shift the operator ran) — the same rule
//     the production pages were put on.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, admin;
const M = {};
const DAY = 86_400_000;
const oid = () => new mongoose.Types.ObjectId();
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
const outliers = (query = '') => request(app).get(`/api/v2/job/wastage-outliers${query}`).set('Cookie', cookie());

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  for (const n of ['JobOrder', 'Machine', 'Wastage', 'ShiftDetail', 'User']) M[n] = require(`../../models/${n}`);
  admin = await M.User.create({ name: 'Owner', email: 'outliers@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
});

let n = 0;
const makeMachine = () => M.Machine.create({
  ID: `M-${(n += 1)}`, manufacturer: 'Comez', DateOfPurchase: new Date('2020-01-01'), NoOfHead: 4, NoOfHooks: 8, status: 'running',
});
const makeJob = (machine) => M.JobOrder.create({
  date: new Date(), order: oid(), customer: oid(), status: machine ? 'weaving' : 'finishing',
  ...(machine ? { machine: machine._id } : {}), elastics: [],
});
/** Noon in India, `daysAgo` days back: well inside its day whenever the test runs. */
const noon = (daysAgo) => {
  const d = new Date(Date.now() + 5.5 * 3_600_000);
  d.setUTCHours(12, 0, 0, 0);
  return new Date(d.getTime() - 5.5 * 3_600_000 - daysAgo * DAY);
};
/** One wastage entry, written with its own date (the driver, so createdAt is kept). */
const entry = (job, daysAgo, quantity, over = {}) => ({
  job: job._id, elastic: oid(), employee: oid(), quantity, penalty: 0, reason: 'Selvedge torn',
  createdAt: noon(daysAgo), updatedAt: noon(daysAgo), ...over,
});
const write = (rows) => M.Wastage.collection.insertMany(rows);
const flagged = (res) => res.body.machines.map((m) => m.machineCode);

// ══════════════════════════════════════════════════════════════════
describe('a loom that wastes about the same every day', () => {
  it('is not "high": this week is like every other week', async () => {
    const machine = await makeMachine();
    const job = await makeJob(machine);
    // 30 days, an entry a day: 18, 20, 22, 18, 20, 22 …
    await write(Array.from({ length: 30 }, (_, d) => entry(job, d, 18 + (d % 3) * 2, { machine: machine._id })));

    const res = await outliers();
    expect(res.status).toBe(200);
    // Before: on the list — a week's total (about 140 m) against the size of one entry (20 m).
    expect(flagged(res)).toEqual([]);
    expect(res.body.count).toBe(0);
  });
});

describe('a loom whose wastage has jumped', () => {
  it('is on the list, with this week against a normal one', async () => {
    const machine = await makeMachine();
    const job = await makeJob(machine);
    await write([
      ...Array.from({ length: 23 }, (_, i) => entry(job, 7 + i, 18 + (i % 3) * 2, { machine: machine._id })),
      ...Array.from({ length: 7 }, (_, d) => entry(job, d, 60, { machine: machine._id })),
    ]);

    const res = await outliers();
    expect(flagged(res)).toEqual([machine.ID]);
    const row = res.body.machines[0];
    expect(row.recentTotal).toBe(420);
    // A normal week on this loom is about 140 m; the line it crossed is not far above that.
    expect(row.expectedTotal).toBeGreaterThan(130);
    expect(row.expectedTotal).toBeLessThan(150);
    expect(row.ceiling).toBeGreaterThan(row.expectedTotal);
    expect(row.ceiling).toBeLessThan(420);
  });

  it('even when its job has since left the loom', async () => {
    const machine = await makeMachine();
    const operator = oid();
    const job = await makeJob(null);   // gone to finishing: no machine on the job any more
    await M.ShiftDetail.create({
      date: noon(20), shift: 'DAY', timer: '08:00:00', elastics: [], status: 'closed', productionMeters: 900,
      employee: operator, job: job._id, shiftPlan: oid(), machine: machine._id,
    });
    await write([
      // Older entries carry no machine of their own: the shift says which loom.
      ...Array.from({ length: 23 }, (_, i) => entry(job, 7 + i, 18 + (i % 3) * 2, { employee: operator })),
      ...Array.from({ length: 7 }, (_, d) => entry(job, d, 60, { employee: operator })),
    ]);

    const res = await outliers();
    // Before: [] — the loom's wastage vanished with the job's machine.
    expect(flagged(res)).toEqual([machine.ID]);
  });
});

describe('a loom with little history', () => {
  it('is not judged on its first bad day', async () => {
    const machine = await makeMachine();
    const job = await makeJob(machine);
    await write([
      entry(job, 20, 10, { machine: machine._id }),
      entry(job, 15, 12, { machine: machine._id }),
      entry(job, 1, 300, { machine: machine._id }),
    ]);
    expect(flagged(await outliers())).toEqual([]);
  });
});

describe('what is asked for', () => {
  it('a stricter line leaves a modest rise off the list', async () => {
    const machine = await makeMachine();
    const job = await makeJob(machine);
    await write([
      ...Array.from({ length: 23 }, (_, i) => entry(job, 7 + i, 10 + (i % 2) * 20, { machine: machine._id })),   // 10, 30, 10, 30 …
      ...Array.from({ length: 7 }, (_, d) => entry(job, d, 34, { machine: machine._id })),
    ]);
    expect(flagged(await outliers('?sigmaThreshold=1'))).toEqual([machine.ID]);
    expect(flagged(await outliers('?sigmaThreshold=4'))).toEqual([]);
  });

  it('nonsense in the query is the usual window, not a server error', async () => {
    const res = await outliers('?lookbackDays=abc&sigmaThreshold=-3');
    expect(res.status).toBe(200);
    expect(res.body.machines).toEqual([]);
  });
});
