'use strict';
// GET /shift/today — the day/night summary, for today or any other date.
//
// The metres figure summed `d.production`, which is not a field on
// ShiftDetail (it is `productionMeters`), so every shift reported 0 metres
// however busy the floor had been.

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongo, app, ShiftPlan, ShiftDetail, Machine, Employee, User, admin;

const adminCookie = () => [
  `token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`,
];

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  ShiftPlan = require('../../models/ShiftPlan');
  ShiftDetail = require('../../models/ShiftDetail');
  Machine = require('../../models/Machine');
  Employee = require('../../models/Employee');
  User = require('../../models/User');
  admin = await User.create({
    name: 'Owner', email: 'o@t.co', password: 'pass1234', role: 'admin', department: 'admin',
  });
}, 60_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
});

const summary = (date) =>
  request(app).get('/api/v2/shift/today')
    .query(date ? { date } : {}).set('Cookie', adminCookie());

/** A plan on `dateIso` with one shift per machine/operator pair. */
async function seedPlan(dateIso, shift, details) {
  const at = new Date(dateIso);
  at.setHours(0, 0, 0, 0);
  const plan = await ShiftPlan.create({ date: at, shift, description: 'x', status: 'confirmed' });

  const ids = [];
  for (const d of details) {
    const machine = await Machine.create({
      ID: d.machineId, manufacturer: 'Comez', NoOfHead: 8, NoOfHooks: 24,
    });
    const emp = await Employee.create({ name: d.operator, hourlyRate: 100 });
    const detail = await ShiftDetail.create({
      date: at, shift, job: new mongoose.Types.ObjectId(),
      machine: machine._id, employee: emp._id, shiftPlan: plan._id,
      elastics: [], status: d.status ?? 'closed', timer: '10:00:00',
      productionMeters: d.meters ?? 0,
      submittedProductionMeters: d.submitted,
    });
    ids.push(detail._id);
  }
  await ShiftPlan.findByIdAndUpdate(plan._id, { $push: { plan: { $each: ids } } });
  return plan;
}

const YESTERDAY = '2026-03-01';
const TODAY_ISO = () => new Date().toISOString().slice(0, 10);

describe('GET /shift/today — metres actually produced', () => {
  test('sums the shifts’ production instead of reporting zero', async () => {
    await seedPlan(TODAY_ISO(), 'DAY', [
      { machineId: 'M-01', operator: 'A', meters: 800 },
      { machineId: 'M-02', operator: 'B', meters: 450 },
    ]);

    const res = await summary();
    expect(res.status).toBe(200);
    expect(res.body.data.dayShift.production).toBe(1250);
    expect(res.body.data.dayShift.machinesRunning).toBe(2);
    expect(res.body.data.dayShift.operatorCount).toBe(2);
  });

  test('counts a submitted-but-unverified shift, so the floor is not shown idle', async () => {
    await seedPlan(TODAY_ISO(), 'DAY', [
      { machineId: 'M-01', operator: 'A', status: 'pending_verification', meters: 0, submitted: 600 },
    ]);

    expect((await summary()).body.data.dayShift.production).toBe(600);
  });

  test('reports a shift with no plan as not created', async () => {
    const res = await summary();
    expect(res.body.data.nightShift.status).toBe('not_created');
    expect(res.body.data.nightShift.production).toBe(0);
    expect(res.body.data.nightShift.id).toBeNull();
  });
});

describe('GET /shift/today?date= — any date', () => {
  test('summarises a past date', async () => {
    await seedPlan(YESTERDAY, 'NIGHT', [
      { machineId: 'M-09', operator: 'C', meters: 1200 },
    ]);

    const res = await summary(YESTERDAY);
    expect(res.status).toBe(200);
    expect(res.body.data.nightShift.production).toBe(1200);
    expect(res.body.data.nightShift.status).not.toBe('not_created');
  });

  test('does not leak a different date’s plan', async () => {
    await seedPlan(YESTERDAY, 'DAY', [{ machineId: 'M-09', operator: 'C', meters: 1200 }]);

    // Asking about today must not pick up yesterday's plan.
    const res = await summary(TODAY_ISO());
    expect(res.body.data.dayShift.status).toBe('not_created');
  });

  test('echoes the date it resolved, so the client can confirm', async () => {
    const res = await summary(YESTERDAY);
    expect(new Date(res.body.data.date).toISOString().slice(0, 10)).toBe(YESTERDAY);
  });

  test('with no date it still means today — every existing caller', async () => {
    await seedPlan(TODAY_ISO(), 'DAY', [{ machineId: 'M-01', operator: 'A', meters: 100 }]);
    expect((await summary()).body.data.dayShift.production).toBe(100);
  });

  test('rejects a date it cannot parse rather than silently using today', async () => {
    const res = await summary('not-a-date');
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/valid date/i);
  });
});
