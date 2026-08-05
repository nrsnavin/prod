'use strict';
// Once a job moves to `finishing` its machine is released — the cloth is
// off the loom. From there nothing can legitimately be produced against
// it, so every production write path and the outsource toggle must
// refuse, on every client, which means the rule lives on the server.
//
// The pipeline is preparatory → weaving → finishing → checking → packing
// → completed, so the lock covers finishing and everything after it.

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, M = {}, admin, refs;
const cookie = (id, role) => [`token=${jwt.sign({ id, role }, process.env.JWT_SECRET_KEY)}`];
const adminCookie = () => cookie(admin._id, 'admin');

beforeAll(async () => {
  // verify-production and the correction routes run in transactions.
  mongo = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
    instanceOpts: [{ launchTimeout: 60000 }],
  });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  for (const n of ['User', 'Employee', 'Machine', 'JobOrder', 'ShiftPlan', 'ShiftDetail', 'Customer', 'Order'])
    M[n] = require(`../../models/${n}.js`);

  admin = await M.User.create({
    name: 'Owner', email: 'plock-owner@t.co', password: 'pass1234',
    role: 'admin', department: 'admin',
  });
  const cust = await M.Customer.create({ name: 'Acme', contactName: 'Ms Rao', phoneNumber: '9000000009' });
  const ord = await M.Order.create({
    customer: cust._id, orderNo: 9100, po: 'PO-9100',
    date: new Date('2026-03-01'), supplyDate: new Date('2026-06-30'),
  });
  refs = { customer: cust._id, order: ord._id, date: new Date('2026-03-01') };
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

// shiftplans carries a unique (date, shift) index, so every seeded plan
// needs its own day.
let seedDay = 0;

// A shift on a job in the given status, ready to be written to.
async function seed(status, { shiftStatus = 'open', linkJob = true } = {}) {
  const job = await M.JobOrder.create({ status, ...refs });
  const machine = await M.Machine.create({
    ID: `M-${Math.random().toString(36).slice(2, 7)}`, manufacturer: 'Comez',
    DateOfPurchase: new Date('2020-01-01'), NoOfHead: 1, NoOfHooks: 8,
    status: 'running', orderRunning: job._id,
  });
  const emp = await M.Employee.create({ name: 'Ravi', department: 'production', hourlyRate: 50 });
  const date = new Date('2026-05-01'); date.setDate(date.getDate() + (seedDay += 1));
  date.setHours(0, 0, 0, 0);
  const plan = await M.ShiftPlan.create({ date, shift: 'DAY', plan: [], totalProduction: 0 });
  const shift = await M.ShiftDetail.create({
    date, shift: 'DAY', shiftPlan: plan._id, machine: machine._id, employee: emp._id,
    ...(linkJob ? { job: job._id } : {}),
    timer: '08:00:00', productionMeters: shiftStatus === 'closed' ? 100 : 0,
    status: shiftStatus,
    ...(shiftStatus !== 'open' ? { submittedProductionMeters: 100, submittedAt: new Date() } : {}),
  });
  plan.plan = [shift._id]; await plan.save();
  return { job, machine, shift, plan, emp };
}

describe('production entry closes once the job reaches finishing', () => {
  test.each(['finishing', 'checking', 'packing', 'completed', 'cancelled'])(
    'a worker cannot enter production on a %s job', async (status) => {
      const { shift } = await seed(status);
      const res = await request(app)
        .post('/api/v2/shift/enter-shift-production')
        .set('Cookie', adminCookie())
        .send({ id: String(shift._id), production: 50 });

      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/production closes once a job leaves the loom/i);
    });

  test.each(['preparatory', 'weaving'])('but it still works while the job is %s', async (status) => {
    const { shift } = await seed(status);
    const res = await request(app)
      .post('/api/v2/shift/enter-shift-production')
      .set('Cookie', adminCookie())
      .send({ id: String(shift._id), production: 50 });

    expect(res.status).toBe(200);
    expect(res.body.shift.submittedProductionMeters).toBe(50);
  });

  test('the worker update path is closed too', async () => {
    const { shift } = await seed('finishing');
    const res = await request(app)
      .post('/api/v2/shift/update')
      .set('Cookie', adminCookie())
      .send({ shiftId: String(shift._id), production: 50 });
    expect(res.status).toBe(409);
  });

  test('an admin cannot verify production on a finished job', async () => {
    const { shift } = await seed('finishing', { shiftStatus: 'pending_verification' });
    const res = await request(app)
      .post('/api/v2/shift/verify-production')
      .set('Cookie', adminCookie())
      .send({ shiftId: String(shift._id), productionMeters: 100 });
    expect(res.status).toBe(409);
  });

  test('an admin cannot correct a closed entry on a finished job', async () => {
    const { shift } = await seed('finishing', { shiftStatus: 'closed' });
    const res = await request(app)
      .put(`/api/v2/shift/production-entry/${shift._id}`)
      .set('Cookie', adminCookie())
      .send({ productionMeters: 80, auditReason: 'miscount' });
    expect(res.status).toBe(409);
  });

  test('an admin cannot delete a closed entry on a finished job', async () => {
    const { shift } = await seed('finishing', { shiftStatus: 'closed' });
    const res = await request(app)
      .delete(`/api/v2/shift/production-entry/${shift._id}`)
      .set('Cookie', adminCookie())
      .send({ auditReason: 'entered twice' });
    expect(res.status).toBe(409);
  });

  // ShiftDetail.job is nullable, so the guard falls back to the machine's
  // running order — the same fallback the Shifts screens use to label the
  // row. Without it, an unlinked shift would slip past the lock.
  test('a shift with no job ref is still locked via the machine it ran', async () => {
    const { shift } = await seed('finishing', { linkJob: false });
    const res = await request(app)
      .post('/api/v2/shift/enter-shift-production')
      .set('Cookie', adminCookie())
      .send({ id: String(shift._id), production: 50 });
    expect(res.status).toBe(409);
  });
});

describe('outsource entry closes at the same point', () => {
  test('the production mode cannot be changed once the job is finishing', async () => {
    const job = await M.JobOrder.create({ status: 'finishing', ...refs });
    const res = await request(app)
      .patch(`/api/v2/job/${job._id}/production-mode`)
      .set('Cookie', adminCookie())
      .send({ productionMode: 'outsource', outsourceVendor: 'Sunrise' });

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/production closes once a job leaves the loom/i);

    // And the refusal must be a REFUSAL — the status is read before the
    // write, so nothing is persisted and then complained about.
    const after = await M.JobOrder.findById(job._id).lean();
    expect(after.productionMode).not.toBe('outsource');
    expect(after.outsourceVendor || '').toBe('');
  });

  test('it still works while the job is on the loom', async () => {
    const job = await M.JobOrder.create({ status: 'weaving', ...refs });
    const res = await request(app)
      .patch(`/api/v2/job/${job._id}/production-mode`)
      .set('Cookie', adminCookie())
      .send({ productionMode: 'outsource', outsourceVendor: 'Sunrise' });

    expect(res.status).toBe(200);
    expect(res.body.data.productionMode).toBe('outsource');
    expect(res.body.data.outsourceVendor).toBe('Sunrise');
  });

  test('switching back to in-house is equally closed after finishing', async () => {
    const job = await M.JobOrder.create({
      status: 'checking', productionMode: 'outsource', outsourceVendor: 'Sunrise', ...refs,
    });
    const res = await request(app)
      .patch(`/api/v2/job/${job._id}/production-mode`)
      .set('Cookie', adminCookie())
      .send({ productionMode: 'in_house' });
    expect(res.status).toBe(409);
  });
});
