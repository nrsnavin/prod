'use strict';
// ══════════════════════════════════════════════════════════════════
//  A LOOM BEING LOADED FOR ITS JOB
//
//  Assigned with "loading", the machine is the job's but weaves nothing:
//  its shifts are marked loading — no production can be entered, none is
//  verified, and they are left out of production and efficiency. Marking
//  it running puts the current shift and later back to open.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, M, admin;
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
const post = (url, body) => request(app).post(`/api/v2${url}`).set('Cookie', cookie()).send(body);
const patch = (url, body) => request(app).patch(`/api/v2${url}`).set('Cookie', cookie()).send(body);

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  M = {};
  for (const n of ['User', 'Employee', 'Machine', 'JobOrder', 'ShiftPlan', 'ShiftDetail', 'Customer', 'Order', 'Elastic']) {
    M[n] = require(`../../models/${n}.js`);
  }
  admin = await M.User.create({ name: 'Owner', email: 'o@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
}, 120_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (!['users', 'counters'].includes(c.collectionName)) await c.deleteMany({});
  }
});

async function seed() {
  const customer = await M.Customer.create({ name: 'Acme', contactName: 'R', phoneNumber: '9000000001' });
  const elastic = await M.Elastic.create({
    name: `20mm ${Math.random().toString(36).slice(2, 7)}`, weaveType: '8',
    spandexEnds: 40, yarnEnds: 120, pick: 12, noOfHook: 8, weight: 2.4,
  });
  const order = await M.Order.create({
    orderNo: Math.floor(Math.random() * 100000), customer: customer._id, status: 'InProgress', po: 'PO-1',
    date: new Date(), supplyDate: new Date(), elasticOrdered: [{ elastic: elastic._id, quantity: 100000 }],
  });
  const job = await M.JobOrder.create({
    date: new Date(), order: order._id, customer: customer._id, status: 'weaving',
    elastics: [{ elastic: elastic._id, quantity: 100000 }],
  });
  const machine = await M.Machine.create({
    ID: `M-${Math.floor(Math.random() * 100000)}`, manufacturer: 'Comez',
    NoOfHead: 2, NoOfHooks: 8, status: 'free', orderRunning: null, elastics: [],
  });
  const operator = await M.Employee.create({ name: 'Ravi', department: 'weaving' });
  return { job, elastic, machine, operator };
}

const assign = (s, extra = {}) => post('/job/plan-weaving', {
  jobId: String(s.job._id), machineId: String(s.machine._id),
  headElasticMap: { 0: String(s.elastic._id), 1: String(s.elastic._id) }, ...extra,
});

/** A plan for the shift running now, so "from the current shift on" covers it. */
async function shiftNow(s) {
  const { currentShift } = require('../../services/machineLoading');
  const cur = currentShift();
  const { createShiftPlan } = require('../../services/shiftPlanCreate');
  const { shiftPlan } = await createShiftPlan({
    date: cur.dateKey, shiftType: cur.shift, machines: [{ machine: s.machine._id, operator: s.operator._id }],
  });
  return M.ShiftDetail.findOne({ shiftPlan: shiftPlan._id });
}

describe('assigning a machine as loading', () => {
  it('the machine is the job\'s, marked loading; a shift planned on it is a loading shift', async () => {
    const s = await seed();
    expect((await assign(s, { loading: true })).status).toBe(200);
    const m = await M.Machine.findById(s.machine._id).lean();
    expect(m).toMatchObject({ status: 'running', loading: true });
    expect(m.loadingSince).toBeTruthy();

    const shift = await shiftNow(s);
    expect(shift.status).toBe('loading');

    const detail = await request(app).get(`/api/v2/job/${s.job._id}`).set('Cookie', cookie());
    expect(detail.body.data.machine.loading).toBe(true);
  });

  it('a shift planned before the assignment turns loading too', async () => {
    const s = await seed();
    await assign(s); // weaving
    const shift = await shiftNow(s);
    expect(shift.status).toBe('open');
    await assign(s, { loading: true }); // re-planned as loading
    expect((await M.ShiftDetail.findById(shift._id).lean()).status).toBe('loading');
  });

  it('without the option a new machine starts weaving, as before', async () => {
    const s = await seed();
    await assign(s);
    expect((await M.Machine.findById(s.machine._id).lean()).loading).toBe(false);
    expect((await shiftNow(s)).status).toBe('open');
  });
});

describe('nothing is produced on a loading shift', () => {
  it('no entry, no verification, and finalising does not wait for it', async () => {
    const s = await seed();
    await assign(s, { loading: true });
    const shift = await shiftNow(s);

    const enter = await post('/shift/enter-shift-production', { id: String(shift._id), production: 100 });
    expect(enter.status).toBe(409);
    expect(enter.body.message).toMatch(/being loaded/);
    const verify = await post('/shift/verify-production', { shiftId: String(shift._id), productionMeters: 100 });
    expect(verify.status).toBe(409);

    const { submitProduction } = require('../../services/shiftSubmit');
    const out = await submitProduction([{ id: String(shift._id), production: 50 }]);
    expect(out.skipped).toEqual([{ id: String(shift._id), reason: 'Machine was loading' }]);
    expect((await M.JobOrder.findById(s.job._id).lean()).producedElastic || []).toEqual([]);

    const fin = await post(`/shift/finalize-plan/${shift.shiftPlan}`, {});
    expect(fin.status).toBe(200);
  });

  it('is left out of the production analytics', async () => {
    const s = await seed();
    await assign(s, { loading: true });
    const shift = await shiftNow(s);
    const day = new Date(shift.date).toISOString().slice(0, 10);
    const res = await request(app).get(`/api/v2/production/analytics?startDate=${day}&endDate=${day}`).set('Cookie', cookie());
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toMatch(String(shift._id));
  });
});

describe('marking it running', () => {
  it('the current shift opens for production, and it counts from there', async () => {
    const s = await seed();
    await assign(s, { loading: true });
    const shift = await shiftNow(s);

    const res = await patch('/machine/loading', { id: String(s.machine._id), loading: false });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ loading: false, shiftsChanged: 1 });
    expect((await M.ShiftDetail.findById(shift._id).lean()).status).toBe('open');

    const verify = await post('/shift/verify-production', { shiftId: String(shift._id), productionMeters: 100 });
    expect(verify.status).toBe(200);
    expect((await M.JobOrder.findById(s.job._id).lean()).producedElastic[0].quantity).toBe(200);
  });

  it('a loading shift that has already ended stays loading', async () => {
    const s = await seed();
    await assign(s, { loading: true });
    const { createShiftPlan } = require('../../services/shiftPlanCreate');
    const { shiftPlan } = await createShiftPlan({
      date: '2020-01-01', shiftType: 'NIGHT', machines: [{ machine: s.machine._id, operator: s.operator._id }],
    });
    const old = await M.ShiftDetail.findOne({ shiftPlan: shiftPlan._id });
    expect(old.status).toBe('loading');
    await patch('/machine/loading', { id: String(s.machine._id), loading: false });
    expect((await M.ShiftDetail.findById(old._id).lean()).status).toBe('loading');
  });

  it('can be put back to loading; a free machine cannot be loading', async () => {
    const s = await seed();
    const free = await patch('/machine/loading', { id: String(s.machine._id), loading: true });
    expect(free.status).toBe(400);
    expect(free.body.message).toMatch(/only a machine with a job on it/);

    await assign(s);
    const shift = await shiftNow(s);
    expect((await patch('/machine/loading', { id: String(s.machine._id), loading: true })).status).toBe(200);
    expect((await M.ShiftDetail.findById(shift._id).lean()).status).toBe('loading');
    const detail = await request(app).get(`/api/v2/machine/get-machine-detail?id=${s.machine._id}`).set('Cookie', cookie());
    expect(detail.status).toBe(200);
    expect(detail.body.machine.loading).toBe(true);
  });
});

describe('the current shift', () => {
  const { currentShift } = require('../../services/machineLoading');
  it('is told in factory time, whatever the server\'s zone', () => {
    expect(currentShift(new Date('2026-10-21T05:00:00Z'))).toEqual({ dateKey: '2026-10-21', shift: 'DAY' });   // 10:30 IST
    expect(currentShift(new Date('2026-10-21T15:00:00Z'))).toEqual({ dateKey: '2026-10-21', shift: 'NIGHT' }); // 20:30 IST
    expect(currentShift(new Date('2026-10-21T20:00:00Z'))).toEqual({ dateKey: '2026-10-21', shift: 'NIGHT' }); // 01:30 IST next day
  });
});
