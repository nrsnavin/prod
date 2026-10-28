'use strict';
// ══════════════════════════════════════════════════════════════════
//  CHANGING THE ELASTIC ON A RUNNING JOB — the exceptional case
//
//  A beam comes up short, and the loom goes on to another elastic of
//  the same order mid-run. The line that leaves is frozen at what was
//  woven, and the shortfall goes back to the order; the line that comes
//  in is on the order and within what it still has unplanned, takes the
//  frozen elastic's heads, and production counts for it from then.
//  Always with a reason; nothing is erased.
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
const get = (url) => request(app).get(`/api/v2${url}`).set('Cookie', cookie());

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

const elasticNamed = (name) => M.Elastic.create({
  name: `${name} ${Math.random().toString(36).slice(2, 6)}`, weaveType: '8',
  spandexEnds: 40, yarnEnds: 120, pick: 12, noOfHook: 8, weight: 2.4,
});

/** An order of two elastics; a job weaving the first on a 2-head loom. */
async function seed({ jobQty = 5000, orderedB = 3000 } = {}) {
  const customer = await M.Customer.create({ name: 'Acme', contactName: 'R', phoneNumber: '9000000001' });
  const a = await elasticNamed('20mm White');
  const b = await elasticNamed('25mm Black');
  const c = await elasticNamed('30mm Navy'); // not on the order
  const order = await M.Order.create({
    orderNo: Math.floor(Math.random() * 100000), customer: customer._id, status: 'InProgress', po: 'PO-1',
    date: new Date(), supplyDate: new Date(),
    elasticOrdered: [{ elastic: a._id, quantity: 5000 }, { elastic: b._id, quantity: orderedB }],
  });
  const zero = (e) => [{ elastic: e._id, quantity: 0 }];
  const job = await M.JobOrder.create({
    date: new Date(), order: order._id, customer: customer._id, status: 'weaving',
    elastics: [{ elastic: a._id, quantity: jobQty }],
    producedElastic: zero(a), packedElastic: zero(a), wastageElastic: zero(a),
  });
  const machine = await M.Machine.create({
    ID: `M-${Math.floor(Math.random() * 100000)}`, manufacturer: 'Comez', NoOfHead: 2, NoOfHooks: 8,
    status: 'running', orderRunning: job._id, elastics: [{ head: 1, elastic: a._id }, { head: 2, elastic: a._id }],
  });
  await M.JobOrder.updateOne({ _id: job._id }, { $set: { machine: machine._id } });
  const operator = await M.Employee.create({ name: 'Ravi', department: 'weaving' });
  return { order, job, a, b, c, machine, operator };
}

// Each shift on its own day: a random day collided with the one before
// it about once in fifteen runs ("a shift plan already exists").
let shiftDay = 0;
async function shiftOn(s) {
  const { createShiftPlan } = require('../../services/shiftPlanCreate');
  shiftDay += 1;
  const { shiftPlan } = await createShiftPlan({
    date: `2026-${String(1 + Math.floor((shiftDay - 1) / 28)).padStart(2, '0')}-${String(1 + ((shiftDay - 1) % 28)).padStart(2, '0')}`, shiftType: 'DAY',
    machines: [{ machine: s.machine._id, operator: s.operator._id }],
  });
  return M.ShiftDetail.findOne({ shiftPlan: shiftPlan._id });
}

const verify = (shift, perHead) => post('/shift/verify-production', { shiftId: String(shift._id), productionMeters: perHead });
const change = (s, body) => post(`/job/${s.job._id}/change-elastic`, {
  elastic: String(s.b._id), quantity: 3000, auditReason: 'Beam came up 1,800 m short of the programme',
  freeze: [String(s.a._id)], ...body,
});

describe('the candidates', () => {
  it("lists the order's elastics with what is still unplanned, and which are on the job", async () => {
    const s = await seed();
    const res = await get(`/job/${s.job._id}/order-elastics`);
    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.elastics.map((e) => [e.elasticId, e]));
    expect(byId[String(s.a._id)]).toMatchObject({ ordered: 5000, planned: 5000, pending: 0, onJob: true, frozen: false });
    expect(byId[String(s.b._id)]).toMatchObject({ ordered: 3000, planned: 0, pending: 3000, onJob: false });
    expect(byId[String(s.c._id)]).toBeUndefined();
  });
});

describe('switching the loom to another elastic of the order', () => {
  it('freezes the old line at what was woven, adds the new one, and gives the shortfall back to the order', async () => {
    const s = await seed();
    // 3,200 m woven of the 5,000 planned before the beam ran out.
    const shift = await shiftOn(s);
    expect((await verify(shift, 1600)).status).toBe(200);

    const res = await change(s, {});
    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/added to J-\d+ for 3000 m; 1 line of J-\d+ frozen at what was woven; put on 2 heads/);

    const job = await M.JobOrder.findById(s.job._id).lean();
    const old = job.elastics.find((e) => String(e.elastic) === String(s.a._id));
    expect(old).toMatchObject({ quantity: 3200, frozen: true, plannedBeforeFreeze: 5000, frozenReason: expect.stringMatching(/short/) });
    const added = job.elastics.find((e) => String(e.elastic) === String(s.b._id));
    expect(added).toMatchObject({ quantity: 3000, addedMidRun: true, frozen: false });
    // A row each, so wastage and packing have somewhere to land.
    for (const key of ['producedElastic', 'packedElastic', 'wastageElastic']) {
      expect(job[key].some((e) => String(e.elastic) === String(s.b._id))).toBe(true);
    }
    const fp = job.fingerprints.find((f) => f.code === 'JOB_ELASTIC_CHANGED');
    expect(fp.meta.frozen[0]).toMatchObject({ plannedBefore: 5000, frozenAt: 3200 });

    // The 1,800 m the beam never reached is back on the order's pending.
    const order = await M.Order.findById(s.order._id).lean();
    const pendingOf = (id) => order.pendingElastic.find((p) => String(p.elastic) === String(id)).quantity;
    expect(pendingOf(s.a._id)).toBe(1800);
    expect(pendingOf(s.b._id)).toBe(0);

    // The loom runs the new elastic on both heads now.
    const m = await M.Machine.findById(s.machine._id).lean();
    expect(m.elastics.map((h) => String(h.elastic))).toEqual([String(s.b._id), String(s.b._id)]);
  });

  it('production from then on counts for the new elastic; the frozen one takes no more', async () => {
    const s = await seed();
    const before = await shiftOn(s);
    await verify(before, 1600);
    await change(s, {});

    const after = await shiftOn(s);
    expect((await M.ShiftDetail.findById(after._id).lean()).elastics.every((h) => String(h.elastic) === String(s.b._id))).toBe(true);
    expect((await verify(after, 500)).status).toBe(200);

    const job = await M.JobOrder.findById(s.job._id).lean();
    const produced = (id) => job.producedElastic.find((p) => String(p.elastic) === String(id)).quantity;
    expect(produced(s.a._id)).toBe(3200);
    expect(produced(s.b._id)).toBe(1000);

    const summary = await get(`/job/summary?jobId=${s.job._id}`);
    const rows = Object.fromEntries(summary.body.summary.map((r) => [String(r.elasticId), r]));
    expect(rows[String(s.a._id)]).toMatchObject({ planned: 3200, produced: 3200, remaining: 0, frozen: true });
    expect(rows[String(s.b._id)]).toMatchObject({ planned: 3000, produced: 1000, remaining: 2000, addedMidRun: true });
  });

  it('what was packed of the frozen elastic stays, and the rest of it can still be packed', async () => {
    const s = await seed();
    await verify(await shiftOn(s), 1600);
    await M.JobOrder.updateOne({ _id: s.job._id, 'packedElastic.elastic': s.a._id }, { $set: { 'packedElastic.$.quantity': 2800 } });
    await change(s, {});
    const job = await M.JobOrder.findById(s.job._id).lean();
    expect(job.packedElastic.find((p) => String(p.elastic) === String(s.a._id)).quantity).toBe(2800);
    expect(job.elastics.find((e) => String(e.elastic) === String(s.a._id)).quantity).toBe(3200);
  });

  it('the job detail shows the change', async () => {
    const s = await seed();
    await change(s, {});
    const res = await get(`/job/${s.job._id}`);
    const lines = res.body.data.plannedElastics;
    expect(lines.find((l) => l.elasticId === String(s.a._id))).toMatchObject({ frozen: true, plannedBeforeFreeze: 5000 });
    expect(lines.find((l) => l.elasticId === String(s.b._id))).toMatchObject({ addedMidRun: true, quantity: 3000 });
    expect(res.body.data.orderId).toBe(String(s.order._id));
  });
});

describe('freezing with nothing coming in', () => {
  it('closes the line at what was woven, frees its heads, and the job carries on', async () => {
    const s = await seed();
    await verify(await shiftOn(s), 1600);
    const res = await post(`/job/${s.job._id}/change-elastic`, {
      freeze: [String(s.a._id)], auditReason: 'Beam ran out; nothing else to put on this loom',
    });
    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/1 line of J-\d+ frozen at what was woven; 2 heads freed/);
    const job = await M.JobOrder.findById(s.job._id).lean();
    expect(job.elastics).toHaveLength(1);
    expect(job.elastics[0]).toMatchObject({ quantity: 3200, frozen: true });
    const m = await M.Machine.findById(s.machine._id).lean();
    expect(m.elastics.map((h) => h.elastic)).toEqual([null, null]);
    expect((await M.Order.findById(s.order._id).lean()).pendingElastic.find((p) => String(p.elastic) === String(s.a._id)).quantity).toBe(1800);
    const after = await shiftOn(s);
    expect((await M.ShiftDetail.findById(after._id).lean()).elastics).toHaveLength(0);
  });

  it('needs something to do', async () => {
    const s = await seed();
    const res = await post(`/job/${s.job._id}/change-elastic`, { freeze: [], auditReason: 'Beam ran out, nothing else to put on' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Choose an elastic to put on, or at least one line to freeze/);
  });

  it('works on a job in finishing or checking too', async () => {
    const s = await seed();
    await M.JobOrder.updateOne({ _id: s.job._id }, { $set: { status: 'checking', producedElastic: [{ elastic: s.a._id, quantity: 4100 }] } });
    const res = await change(s, { heads: 'none' });
    expect(res.status).toBe(200);
    const job = await M.JobOrder.findById(s.job._id).lean();
    expect(job.elastics.find((e) => String(e.elastic) === String(s.a._id))).toMatchObject({ quantity: 4100, frozen: true });
    expect(job.elastics.find((e) => String(e.elastic) === String(s.b._id))).toMatchObject({ quantity: 3000, addedMidRun: true });
  });
});

describe('what it refuses', () => {
  it('needs a proper reason', async () => {
    const s = await seed();
    const res = await change(s, { auditReason: 'short' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/exceptional change: give the reason/);
    expect((await M.JobOrder.findById(s.job._id).lean()).elastics).toHaveLength(1);
  });

  it('an elastic that is not on the order', async () => {
    const s = await seed();
    const res = await change(s, { elastic: String(s.c._id) });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/is not on order #/);
  });

  it('more than the order still has unplanned, naming the figure', async () => {
    const s = await seed({ orderedB: 2000 });
    const res = await change(s, { quantity: 2500 });
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/only 2000 m of .* not yet planned/);
    expect((await M.JobOrder.findById(s.job._id).lean()).elastics).toHaveLength(1);
    expect((await M.Machine.findById(s.machine._id).lean()).elastics.every((h) => String(h.elastic) === String(s.a._id))).toBe(true);
  });

  it('a job in packing, and an elastic already on the job', async () => {
    const s = await seed();
    expect((await change(s, { elastic: String(s.a._id) })).body.message).toMatch(/already on this job/);
    await M.JobOrder.updateOne({ _id: s.job._id }, { $set: { status: 'packing' } });
    expect((await change(s, {})).body.message).toMatch(/until the job reaches packing/);
  });

  it('a stale screen', async () => {
    const s = await seed();
    const res = await change(s, { expectedVersion: 99 });
    expect(res.status).toBe(409);
  });
});

describe('the heads', () => {
  it("'none' leaves the loom alone; 'all' takes every running head", async () => {
    const s = await seed();
    await change(s, { heads: 'none' });
    expect((await M.Machine.findById(s.machine._id).lean()).elastics.every((h) => String(h.elastic) === String(s.a._id))).toBe(true);

    const t = await seed();
    await M.Machine.updateOne({ _id: t.machine._id }, { $set: { elastics: [{ head: 1, elastic: t.a._id }, { head: 2, elastic: null }] } });
    const res = await change(t, { heads: 'all', freeze: [] });
    expect(res.body.headsChanged).toBe(1); // the free head stays free
    const m = await M.Machine.findById(t.machine._id).lean();
    expect(m.elastics.map((h) => (h.elastic ? String(h.elastic) : null))).toEqual([String(t.b._id), null]);
  });

  it('asks before putting an elastic on a loom with too few hooks', async () => {
    const s = await seed();
    await M.Elastic.updateOne({ _id: s.b._id }, { $set: { noOfHook: 24 } });
    const first = await change(s, {});
    expect(first.status).toBe(409);
    expect(first.body.code).toBe('HOOKS_EXCEED_MACHINE');
    expect((await M.JobOrder.findById(s.job._id).lean()).elastics).toHaveLength(1); // nothing written
    const second = await change(s, { confirmHooks: true });
    expect(second.status).toBe(200);
    expect(second.body.message).toMatch(/needs 24/);
  });
});
