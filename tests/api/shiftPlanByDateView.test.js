'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE SHIFT PLAN THE PAGE COULD NOT SEE
//
//  Reported as: the shift-plans page shows "not created" even for a
//  date that has a plan. The page decides a shift exists by reading
//  `id` off the summary, and /shift/today answered with a lean
//  document — `_id`, no virtuals — so the field it looked for was
//  never there. The plan was found, counted and returned; only its
//  identity was missing, which is enough for the card to say there is
//  nothing to show.
//
//  Driven through the real app so the response is the one the browser
//  actually receives.
// ══════════════════════════════════════════════════════════════════

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
}, 90_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
});

/** A DAY plan on `dateIso` with one machine, one operator, some metres. */
async function makePlan(dateIso, { shift = 'DAY', meters = 1200 } = {}) {
  const machine = await Machine.create({
    ID: `M-${Math.random().toString(36).slice(2, 7)}`,
    manufacturer: 'Acme', NoOfHead: 4, NoOfHooks: 8, status: 'running',
  });
  const employee = await Employee.create({
    name: 'Ravi', phoneNumber: '9000000001', role: 'operator', salary: 500,
  });
  const plan = await ShiftPlan.create({ date: new Date(dateIso), shift });
  const detail = await ShiftDetail.create({
    shiftPlan: plan._id, machine: machine._id, employee: employee._id,
    job: new mongoose.Types.ObjectId(),
    date: new Date(dateIso), shift, productionMeters: meters,
  });
  await ShiftPlan.findByIdAndUpdate(plan._id, { $push: { plan: detail._id } });
  return plan;
}

const dayView = (dateIso) =>
  request(app).get('/api/v2/shift/today').query({ date: dateIso }).set('Cookie', adminCookie());

describe('browsing a date that has a plan', () => {
  it('identifies the plan, so the page can open it', async () => {
    const plan = await makePlan('2026-07-15');

    const res = await dayView('2026-07-15');
    expect(res.status).toBe(200);

    // The page reads `id` to decide the shift exists at all, and to
    // navigate to it. `_id` alone leaves the card saying "not created".
    expect(res.body.data.dayShift.id).toBe(String(plan._id));
    expect(res.body.data.dayShift.status).not.toBe('not_created');
  });

  it('reports the figures for that date', async () => {
    await makePlan('2026-07-15', { meters: 1200 });

    const { body } = await dayView('2026-07-15');
    expect(body.data.dayShift.production).toBe(1200);
    expect(body.data.dayShift.machinesRunning).toBe(1);
    expect(body.data.dayShift.operatorCount).toBe(1);
  });

  it('keeps the two shifts apart', async () => {
    const night = await makePlan('2026-07-15', { shift: 'NIGHT', meters: 800 });

    const { body } = await dayView('2026-07-15');
    expect(body.data.nightShift.id).toBe(String(night._id));
    expect(body.data.dayShift.status).toBe('not_created');
    expect(body.data.dayShift.id).toBeNull();
  });

  it('does not leak a neighbouring date into the answer', async () => {
    await makePlan('2026-07-14');
    await makePlan('2026-07-16');

    const { body } = await dayView('2026-07-15');
    expect(body.data.dayShift.status).toBe('not_created');
  });

  it('finds a plan stored with a time of day, not just at midnight', async () => {
    // A plan created from a datetime input lands mid-day; the browse
    // window has to cover the whole date, not the midnight instant.
    const plan = await makePlan('2026-07-15T14:30:00');

    const { body } = await dayView('2026-07-15');
    expect(body.data.dayShift.id).toBe(String(plan._id));
  });
});
