'use strict';
// ══════════════════════════════════════════════════════════════════
//  WHEN A MACHINE'S SERVICE IS DUE, AND WHAT ITS HEALTH PAGE SAYS
//
//  Three things, found reading api/machine.js line by line.
//
//  1. A service date is a day; "now" is a moment. Comparing the two
//     called a service due TODAY overdue from 05:30 in the morning:
//     "0d overdue" on the maintenance list and 20 points off the
//     machine's health score, on the day the service was booked for.
//
//  2. The health list scores output against what each machine's own
//     product normally makes (tests/api/predictiveHealthDrift.test.js).
//     The advice opened from a row of that list still compared raw
//     metres, so a loom moved to a slower product read "healthy" on the
//     list and "output is down 50%, urgency high" in the advice.
//
//  3. A service log sent with resolved: "false" was stored as resolved
//     — any non-empty string is true — though the same handler takes
//     setMaintenance: "true".
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';
// The advice falls back to its own wording with no key: that is the
// path under test, and no call must leave the test machine.
delete process.env.ANTHROPIC_API_KEY;

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app;
let Machine, ShiftDetail, ShiftPlan, EtaRatePosterior, Elastic, Employee, User, factoryDay;
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
  factoryDay       = require('../../utils/factoryDay');
  admin = await User.create({ name: 'Admin', email: 'msd-admin@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

let seq = 0;
beforeEach(async () => {
  operator = await Employee.create({ name: 'Op', phoneNumber: `9700000${String(seq++).padStart(2, '0')}`, department: 'production' });
});
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
});

const DAY = 86_400_000;
/** The factory's calendar day, `n` days from today, as it is stored. */
const dayFromToday = (n) => new Date(factoryDay.calendarDay().getTime() + n * DAY);

/** A machine whose latest service log names its next service `n` days from today. */
const machineDue = (n) => Machine.create({
  ID: `LOOM-${String(seq++).padStart(2, '0')}`, manufacturer: 'Comez', NoOfHead: 4, NoOfHooks: 12,
  serviceLogs: [{ date: new Date(Date.now() - 30 * DAY), type: 'Preventive', description: 'Oiled', nextServiceDate: dayFromToday(n) }],
});

const get = (url) => request(app).get(`/api/v2/machine${url}`).set('Cookie', cookie());

// ══════════════════════════════════════════════════════════════════
describe('the maintenance list', () => {
  it('lists a service due today as due, not overdue', async () => {
    const m = await machineDue(0);
    const res = await get('/maintenance-due');
    expect(res.status).toBe(200);
    const row = res.body.data.find((d) => d.ID === m.ID);
    expect(row).toMatchObject({ overdue: false, daysUntil: 0 });
    expect(res.body.overdueCount).toBe(0);
  });

  it('counts whole days either side of today', async () => {
    const [late, soon, far] = [await machineDue(-3), await machineDue(5), await machineDue(40)];
    const res = await get('/maintenance-due?days=14');
    const by = Object.fromEntries(res.body.data.map((d) => [d.ID, d]));
    expect(by[late.ID]).toMatchObject({ overdue: true, daysUntil: -3 });
    expect(by[soon.ID]).toMatchObject({ overdue: false, daysUntil: 5 });
    // Past the window asked for.
    expect(by[far.ID]).toBeUndefined();
    // Most urgent first.
    expect(res.body.data.map((d) => d.ID)).toEqual([late.ID, soon.ID]);
  });

  it('includes the last day of the window', async () => {
    const edge = await machineDue(14);
    const res = await get('/maintenance-due?days=14');
    expect(res.body.data.find((d) => d.ID === edge.ID)).toMatchObject({ daysUntil: 14, overdue: false });
  });
});

describe('the health score', () => {
  const rowOf = async (m) => (await get('/predictive-health')).body.machines.find((x) => x.machineID === m.ID);

  it('takes nothing off as overdue on the day the service is due', async () => {
    const row = await rowOf(await machineDue(0));
    expect(row.reasons.map((r) => r.label)).toEqual(['Service due soon']);
    expect(row.score).toBe(92);
  });

  it('still calls yesterday overdue', async () => {
    const row = await rowOf(await machineDue(-1));
    expect(row.reasons.map((r) => r.label)).toEqual(['Service overdue']);
    expect(row.score).toBe(80);
  });

  it('says nothing about a service more than a week away', async () => {
    const row = await rowOf(await machineDue(8));
    expect(row.reasons).toEqual([]);
    expect(row.score).toBe(100);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('the advice agrees with the list it is opened from', () => {
  const makeElastic = () => Elastic.create({ name: `E-${seq++}`, weaveType: '8', spandexEnds: 40, yarnEnds: 120, pick: 12, noOfHook: 8, weight: 2.4 });
  const givePosterior = (machine, elastic, meanPerHead, observations = 50) =>
    EtaRatePosterior.create({ machine: machine._id, elastic: elastic._id, shape: meanPerHead * observations, rate: observations, observations });

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
        machine: machine._id, date, shift: 'DAY', status: 'closed', shiftPlan: planId, employee: operator._id,
        productionMeters: perHead * heads,
        elastics: Array.from({ length: heads }, (_, h) => ({ head: h + 1, elastic: elastic._id })),
      });
    }
    await ShiftPlan.insertMany(plans);
    await ShiftDetail.insertMany(details);
  }

  const plainMachine = () => Machine.create({ ID: `LOOM-${String(seq++).padStart(2, '0')}`, manufacturer: 'Comez', NoOfHead: 4, NoOfHooks: 12 });

  it('does not call a move to a slower product a drop in output', async () => {
    const m = await plainMachine();
    const fast = await makeElastic();
    const slow = await makeElastic();
    await givePosterior(m, fast, 1000);
    await givePosterior(m, slow, 500);
    await runShifts(m, fast, { count: 21, perHead: 1000, endingDaysAgo: 7 });
    await runShifts(m, slow, { count: 7,  perHead: 500,  endingDaysAgo: 0 });

    const list = (await get('/predictive-health')).body.machines.find((x) => x.machineID === m.ID);
    expect(list.dropPct).toBe(0);

    const res = await get(`/health-advice/${m._id}`);
    expect(res.status).toBe(200);
    expect(res.body.aiGenerated).toBe(false);
    // Before: "output is down 50%" and "Urgency: high".
    expect(res.body.advice).not.toMatch(/output is down/);
    expect(res.body.advice).toMatch(/Urgency: low/);
    expect(res.body.facts).toMatch(/100% now, 100% before \(no drop\)/);
  });

  it('does report a real fall on the same product, with the list\'s own figure', async () => {
    const m = await plainMachine();
    const e = await makeElastic();
    await givePosterior(m, e, 1000);
    await runShifts(m, e, { count: 21, perHead: 1000, endingDaysAgo: 7 });
    await runShifts(m, e, { count: 7,  perHead: 620,  endingDaysAgo: 0 });

    const list = (await get('/predictive-health')).body.machines.find((x) => x.machineID === m.ID);
    const res = await get(`/health-advice/${m._id}`);
    expect(list.dropPct).toBeGreaterThan(20);
    expect(res.body.advice).toContain(`output is down ${list.dropPct}%`);
    expect(res.body.facts).toContain(`(${list.dropPct}% drop)`);
  });

  it('says so when there are too few shifts to tell', async () => {
    const m = await plainMachine();
    const e = await makeElastic();
    // No posterior: nothing to say what this product should make.
    await runShifts(m, e, { count: 5, perHead: 800 });
    const res = await get(`/health-advice/${m._id}`);
    expect(res.body.facts).toMatch(/Too few shifts to say/);
    expect(res.body.advice).toMatch(/Urgency: low/);
  });

  it('does not call a service due today overdue either', async () => {
    const m = await machineDue(0);
    const res = await get(`/health-advice/${m._id}`);
    expect(res.body.facts).not.toMatch(/OVERDUE/);
    expect(res.body.advice).not.toMatch(/service is overdue/);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('a service log sent with its flags as text', () => {
  const add = (m, body) => request(app).post('/api/v2/machine/add-service-log').set('Cookie', cookie())
    .send({ machineId: String(m._id), type: 'Corrective', description: 'Belt slipping', ...body });

  it('keeps "false" as not resolved', async () => {
    const m = await Machine.create({ ID: `LOOM-${String(seq++).padStart(2, '0')}`, manufacturer: 'Comez', NoOfHead: 4, NoOfHooks: 12 });
    expect((await add(m, { resolved: 'false' })).body.log.resolved).toBe(false);
    expect((await add(m, { resolved: false })).body.log.resolved).toBe(false);
  });

  it('is resolved unless told otherwise, as before', async () => {
    const m = await Machine.create({ ID: `LOOM-${String(seq++).padStart(2, '0')}`, manufacturer: 'Comez', NoOfHead: 4, NoOfHooks: 12 });
    expect((await add(m, {})).body.log.resolved).toBe(true);
    expect((await add(m, { resolved: 'true' })).body.log.resolved).toBe(true);
    expect((await add(m, { resolved: true })).body.log.resolved).toBe(true);
  });
});
