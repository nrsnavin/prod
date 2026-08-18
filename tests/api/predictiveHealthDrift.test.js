'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE HEALTH SCORE WAS READING PRODUCT CHANGES AS FAULTS
//
//  GET /machine/predictive-health has shipped for a while. It scores
//  every loom out of 100 and takes up to 35 points off for "output
//  down N%" — computed from the raw sum of productionMeters over the
//  last 7 days against the 21 before it.
//
//  Raw metres. No normalisation for what the machine was making.
//
//  A loom moved from a 1000 m/shift elastic to a 500 m/shift one has
//  not developed a fault; it has been given different work. The score
//  called that a 50% output drop, took the full penalty, and put the
//  machine in "watch" or "at_risk" — on the single most ordinary event
//  on a factory floor.
//
//  That is how a health report gets ignored: a fitter is sent to a
//  machine that is running perfectly, twice, and then nobody opens the
//  page again.
//
//  The fix routes the drift signal through services/machineHealth.js,
//  which divides every shift by what the (elastic, machine) posterior
//  expects for that pair. The rest of the score — issues, service
//  recency, status — is unchanged, and so is the response shape the
//  web app reads.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app;
let Machine, ShiftDetail, ShiftPlan, EtaRatePosterior, Elastic, Employee, User;
let admin, operator;

const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app              = require('../../app.js');
  Machine          = require('../../models/Machine');
  ShiftDetail      = require('../../models/ShiftDetail');
  ShiftPlan        = require('../../models/ShiftPlan');
  EtaRatePosterior = require('../../models/EtaRatePosterior');
  Elastic          = require('../../models/Elastic');
  Employee         = require('../../models/Employee');
  User             = require('../../models/User');

  admin = await User.create({
    name: 'Admin', email: 'mh-admin@t.co', password: 'pass1234',
    role: 'admin', department: 'admin',
  });
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

let seq = 0;
beforeEach(async () => {
  operator = await Employee.create({
    name: 'Op', phoneNumber: `9600000${String(seq++).padStart(2, '0')}`, department: 'production',
  });
});

afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
});

const makeMachine = () => Machine.create({
  ID: `LOOM-${String(seq++).padStart(2, '0')}`, manufacturer: 'Comez',
  DateOfPurchase: new Date(), NoOfHead: 4, NoOfHooks: 12,
});

const makeElastic = () => Elastic.create({
  name: `E-${seq++}`, weaveType: '8', spandexEnds: 40, yarnEnds: 120,
  pick: 12, noOfHook: 8, weight: 2.4,
});

const givePosterior = (machine, elastic, meanPerHead, observations = 50) =>
  EtaRatePosterior.create({
    machine: machine._id, elastic: elastic._id,
    shape: meanPerHead * observations, rate: observations, observations,
  });

/**
 * Shifts ending `endingDaysAgo` days ago and running backwards.
 *
 * The dates matter: the endpoint's own windows are the last 7 days and
 * the 21 before that, so a fixture has to land inside them.
 */
async function runShifts(machine, elastic, { count, perHead, endingDaysAgo = 0 }) {
  const heads = machine.NoOfHead;
  const plans = [];
  const details = [];

  for (let i = 0; i < count; i++) {
    const date = new Date();
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() - endingDaysAgo - i);
    const planId = new mongoose.Types.ObjectId();

    plans.push({ _id: planId, date, shift: 'DAY' });
    details.push({
      machine: machine._id, date, shift: 'DAY', status: 'closed',
      shiftPlan: planId, employee: operator._id,
      productionMeters: perHead * heads,
      elastics: Array.from({ length: heads }, (_, h) => ({ head: h + 1, elastic: elastic._id })),
    });
  }
  await ShiftPlan.insertMany(plans);
  await ShiftDetail.insertMany(details);
}

const health = () => request(app).get('/api/v2/machine/predictive-health').set('Cookie', cookie());

// ══════════════════════════════════════════════════════════════════
//  THE BUG
// ══════════════════════════════════════════════════════════════════
describe('a product change is not a fault', () => {
  test('a loom moved to a slower elastic keeps its score', async () => {
    // 21 days on a 1000 m/head product, then 7 days on a 500 m/head
    // one. Raw metres halve; the machine is running exactly to
    // expectation on both.
    const m = await makeMachine();
    const fast = await makeElastic();
    const slow = await makeElastic();
    await givePosterior(m, fast, 1000);
    await givePosterior(m, slow, 500);

    await runShifts(m, fast, { count: 21, perHead: 1000, endingDaysAgo: 7 });
    await runShifts(m, slow, { count: 7,  perHead: 500,  endingDaysAgo: 0 });

    const res = await health();
    expect(res.status).toBe(200);
    const row = res.body.machines.find((x) => x.machineID === m.ID);

    // No output penalty, and none of the reasons is about drift.
    expect(row.dropPct).toBe(0);
    expect(row.reasons.map((r) => r.label).join(' ')).not.toMatch(/output down/i);
    expect(row.band).toBe('healthy');
  });

  test('a genuine fall on the same product still scores against it', async () => {
    // The other half. Without this the fix would be "never report a
    // drop", which is not an improvement.
    const m = await makeMachine();
    const e = await makeElastic();
    await givePosterior(m, e, 1000);

    await runShifts(m, e, { count: 21, perHead: 1000, endingDaysAgo: 7 });
    await runShifts(m, e, { count: 7,  perHead: 620,  endingDaysAgo: 0 });

    const res = await health();
    const row = res.body.machines.find((x) => x.machineID === m.ID);

    expect(row.dropPct).toBeGreaterThan(20);
    expect(row.reasons.map((r) => r.label).join(' ')).toMatch(/output down/i);
    expect(row.score).toBeLessThan(100);
  });

  test('the response shape the web app reads is unchanged', async () => {
    // MachineHealth.tsx has been consuming this for a while. The fix is
    // to the SIGNAL, not to the contract.
    const m = await makeMachine();
    const e = await makeElastic();
    await givePosterior(m, e, 1000);
    await runShifts(m, e, { count: 20, perHead: 1000 });

    const res = await health();
    expect(res.body).toMatchObject({
      success: true,
      summary: { total: expect.any(Number), atRisk: expect.any(Number), watch: expect.any(Number) },
    });
    const row = res.body.machines[0];
    for (const k of ['machineId', 'machineID', 'status', 'score', 'band', 'dropPct', 'reasons']) {
      expect(row).toHaveProperty(k);
    }
    expect(res.body.machines.map((x) => x.score)).toEqual(
      [...res.body.machines.map((x) => x.score)].sort((a, b) => a - b)   // worst first
    );
  });

  test('a machine with no attributable history is not penalised for it', async () => {
    // Silence is not a fault. A loom whose shifts carry no posterior
    // simply has no drift signal, and inventing one would put every new
    // machine on the watch list.
    const m = await makeMachine();
    const e = await makeElastic();
    await runShifts(m, e, { count: 10, perHead: 1000 });   // no posterior

    const res = await health();
    const row = res.body.machines.find((x) => x.machineID === m.ID);
    expect(row.dropPct).toBe(0);
    expect(row.band).toBe('healthy');
  });
});
