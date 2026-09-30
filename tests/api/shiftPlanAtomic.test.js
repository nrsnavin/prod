'use strict';
// ══════════════════════════════════════════════════════════════════
//  A SHIFT PLAN IS WRITTEN WHOLE OR NOT AT ALL
//
//  Creating a plan writes four collections: the ShiftPlan, one
//  ShiftDetail per machine, the running job's list of shifts, and each
//  operator's list of shifts. Deleting one undoes all four. Neither ran
//  in a transaction, so a failure half-way left a plan naming some of
//  its machines, operators holding shifts from a plan that no longer
//  existed, and nothing in the data to say it was partial.
//
//  A concrete way that happened: the head-map editor stores an
//  unthreaded head as `elastic: null`, and a ShiftDetail requires an
//  elastic on every head it lists. So any loom with an empty head made
//  the create throw — after the plan and the machines before it had
//  already been written.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, M, admin;

const adminCookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  M = {};
  for (const n of ['Customer', 'Elastic', 'Employee', 'Order', 'JobOrder', 'Machine', 'ShiftPlan', 'ShiftDetail', 'User']) {
    M[n] = require(`../../models/${n}`);
  }
  admin = await M.User.create({ name: 'Owner', email: 'sp@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
});

let seq = 0;
async function loom({ heads = [{ head: 1, threaded: true }], withJob = true } = {}) {
  seq += 1;
  const customer = await M.Customer.create({ name: `Acme ${seq}`, contactName: 'R', phoneNumber: '9000000001' });
  const elastic = await M.Elastic.create({
    name: `20mm ${seq}-${Math.random().toString(36).slice(2, 6)}`, weaveType: '8',
    spandexEnds: 40, yarnEnds: 120, pick: 12, noOfHook: 8, weight: 2.4,
  });
  let job = null;
  if (withJob) {
    const order = await M.Order.create({
      customer: customer._id, status: 'InProgress', po: `PO-${seq}`,
      date: new Date(), supplyDate: new Date(),
      elasticOrdered: [{ elastic: elastic._id, quantity: 5000 }],
    });
    job = await M.JobOrder.create({
      date: new Date(), order: order._id, customer: customer._id, status: 'weaving',
      elastics: [{ elastic: elastic._id, quantity: 3000 }],
    });
  }
  const machine = await M.Machine.create({
    ID: `M-${seq}`, manufacturer: 'Comez', NoOfHead: heads.length, NoOfHooks: 8,
    status: withJob ? 'running' : 'free', orderRunning: job?._id ?? null,
    elastics: heads.map((h) => ({ head: h.head, elastic: h.threaded ? elastic._id : null })),
  });
  const operator = await M.Employee.create({
    name: `Op ${seq}`, phoneNumber: `90000${String(seq).padStart(5, '0')}`, role: 'operator', salary: 600,
  });
  return { machine, operator, job, elastic };
}

const plan = (rows, { date = '2026-06-10', shiftType = 'DAY' } = {}) =>
  request(app).post('/api/v2/shift/create-shift-plan').set('Cookie', adminCookie())
    .send({ date, shiftType, machines: rows.map((r) => ({ machine: String(r.machine._id), operator: String(r.operator._id) })) });

const counts = async () => ({
  plans: await M.ShiftPlan.countDocuments({}),
  details: await M.ShiftDetail.countDocuments({}),
  jobRefs: (await M.JobOrder.find({}).lean()).reduce((t, j) => t + (j.shiftDetails?.length || 0), 0),
  // Shifts attributed to an operator, by the ShiftDetail's own ref.
  empRefs: await M.ShiftDetail.countDocuments({ employee: { $ne: null } }),
});

describe('creating a plan', () => {
  it('writes the plan, a detail per machine, and both sets of refs', async () => {
    const a = await loom();
    const b = await loom();
    const res = await plan([a, b]);
    expect(res.status).toBe(201);
    expect(await counts()).toEqual({ plans: 1, details: 2, jobRefs: 2, empRefs: 2 });
    const sp = await M.ShiftPlan.findById(res.body.shiftPlanId).lean();
    expect(sp.plan).toHaveLength(2);
  });

  it('plans a loom with an empty head, listing only the heads that run', async () => {
    // A partly threaded loom is ordinary. The empty head has nothing to
    // produce, so it is not a line on the shift sheet.
    const a = await loom({ heads: [{ head: 1, threaded: true }, { head: 2, threaded: false }] });
    const res = await plan([a]);
    expect(res.status).toBe(201);
    const d = await M.ShiftDetail.findOne({}).lean();
    expect(d.elastics.map((e) => e.head)).toEqual([1]);
  });

  it('plans a loom that has no job on it', async () => {
    const a = await loom({ withJob: false });
    const res = await plan([a]);
    expect(res.status).toBe(201);
    const d = await M.ShiftDetail.findOne({}).lean();
    expect(d.job).toBeNull();
  });

  it('writes nothing at all when a later row fails inside the write', async () => {
    // The atomicity itself. The first loom is fine; the second has a
    // head map with no head number, which a ShiftDetail refuses. That
    // failure happens AFTER the plan and the first detail have been
    // written — so without the transaction they would still be there.
    const a = await loom();
    const b = await loom();
    await M.Machine.updateOne({ _id: b.machine._id }, { $set: { elastics: [{ head: null, elastic: b.elastic._id }] } });
    const res = await plan([a, b]);
    expect(res.status).toBe(400);
    expect(await counts()).toEqual({ plans: 0, details: 0, jobRefs: 0, empRefs: 0 });
  });

  it('refuses a row that does not name an id, before writing anything', async () => {
    const a = await loom();
    const res = await request(app).post('/api/v2/shift/create-shift-plan').set('Cookie', adminCookie())
      .send({
        date: '2026-06-10', shiftType: 'DAY',
        machines: [
          { machine: String(a.machine._id), operator: String(a.operator._id) },
          { machine: String(a.machine._id), operator: 'not-an-id' },
        ],
      });
    expect(res.status).toBe(400);
    expect(await counts()).toEqual({ plans: 0, details: 0, jobRefs: 0, empRefs: 0 });
  });

  it('refuses a second plan for the same date and shift, and writes nothing for it', async () => {
    const a = await loom();
    expect((await plan([a])).status).toBe(201);
    const b = await loom();
    const dup = await plan([b]);
    expect(dup.status).toBe(409);
    expect(await counts()).toEqual({ plans: 1, details: 1, jobRefs: 1, empRefs: 1 });
  });

  it('gives an operator on two looms both shifts, and nobody else\'s', async () => {
    const a = await loom();
    const b = await loom();
    const res = await request(app).post('/api/v2/shift/create-shift-plan').set('Cookie', adminCookie())
      .send({
        date: '2026-06-10', shiftType: 'DAY',
        machines: [
          { machine: String(a.machine._id), operator: String(a.operator._id) },
          { machine: String(b.machine._id), operator: String(a.operator._id) },
        ],
      });
    expect(res.status).toBe(201);
    expect(await M.ShiftDetail.countDocuments({ employee: a.operator._id })).toBe(2);
    expect(await M.ShiftDetail.countDocuments({ employee: b.operator._id })).toBe(0);
  });

  it('stamps who created each shift line', async () => {
    // The audit plugin fires on save and on updates, not on insertMany —
    // so the details are still created one by one, inside the transaction.
    const a = await loom();
    await plan([a]);
    const d = await M.ShiftDetail.findOne({}).lean();
    expect(String(d.createdBy)).toBe(String(admin._id));
  });
});

describe('deleting a plan', () => {
  const del = (id) => request(app).delete('/api/v2/shift/deletePlan').query({ id: String(id) }).set('Cookie', adminCookie());

  it('removes the plan, its details, and every ref to them', async () => {
    const a = await loom();
    const b = await loom();
    const res = await plan([a, b]);
    expect((await del(res.body.shiftPlanId)).status).toBe(200);
    // jobRefs included: deleting used to leave them pointing at nothing.
    expect(await counts()).toEqual({ plans: 0, details: 0, jobRefs: 0, empRefs: 0 });
  });

  it('leaves the other plan\'s refs alone', async () => {
    const a = await loom();
    const day = await plan([a], { shiftType: 'DAY' });
    await plan([a], { shiftType: 'NIGHT' });
    await del(day.body.shiftPlanId);
    expect(await counts()).toEqual({ plans: 1, details: 1, jobRefs: 1, empRefs: 1 });
  });
});
