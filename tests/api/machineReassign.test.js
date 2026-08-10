'use strict';
// ══════════════════════════════════════════════════════════════════
//  REASSIGNING A JOB TO ANOTHER MACHINE
//
//  Reported as: the machine that was already on the job is not freed,
//  so it stays "running" and cannot be given to anything else.
//
//  The link between a job and its machine is held on BOTH documents —
//  `job.machine` and `machine.orderRunning` — and the release path
//  reads only one of them. Anything that sets one without the other
//  leaves a machine that no job will ever release, because the job it
//  claims to be running does not point back at it.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
// /plan-weaving claims the machine inside a transaction.
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, JobOrder, Order, Customer, Elastic, Machine, Warping, Covering, User, admin;

const adminCookie = () => [
  `token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`,
];

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  JobOrder = require('../../models/JobOrder');
  Order    = require('../../models/Order');
  Customer = require('../../models/Customer');
  Elastic  = require('../../models/Elastic');
  Machine  = require('../../models/Machine');
  Warping  = require('../../models/Warping');
  Covering = require('../../models/Covering');
  User     = require('../../models/User');
  admin = await User.create({
    name: 'Owner', email: 'o@t.co', password: 'pass1234', role: 'admin', department: 'admin',
  });
}, 120_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
});

const makeMachine = (heads = 2) =>
  Machine.create({
    ID: `M-${Math.floor(Math.random() * 100000)}`, manufacturer: 'Comez',
    NoOfHead: heads, NoOfHooks: 8, status: 'free', orderRunning: null, elastics: [],
  });

async function seed() {
  const customer = await Customer.create({ name: 'Acme', contactName: 'R', phoneNumber: '9000000001' });
  const elastic = await Elastic.create({
    // Unique per seed: two jobs in this file are two DIFFERENT
    // products. One name would now be one row, which is the rule.
    name: `20mm ${Math.random().toString(36).slice(2, 8)}`, weaveType: '8',
    spandexEnds: 40, yarnEnds: 120, pick: 12, noOfHook: 8, weight: 2.4,
  });
  const order = await Order.create({
    orderNo: Math.floor(Math.random() * 100000),
    customer: customer._id, status: 'InProgress', po: 'PO-1',
    date: new Date(), supplyDate: new Date(),
    elasticOrdered: [{ elastic: elastic._id, quantity: 1000 }],
  });
  const job = await JobOrder.create({
    date: new Date(), order: order._id, customer: customer._id, status: 'preparatory',
    elastics: [{ elastic: elastic._id, quantity: 500 }],
  });
  return { job, elastic, customer, order };
}

const assign = (job, machine, elastic) =>
  request(app).post('/api/v2/job/assign-machine')
    .set('Cookie', adminCookie())
    .send({
      jobId: String(job._id),
      machineId: String(machine._id),
      elastics: Array.from({ length: machine.NoOfHead }, (_, i) => ({
        head: i + 1, elastic: String(elastic._id),
      })),
    });

const reload = (m) => Machine.findById(m._id).lean();

/** What the web actually calls when a machine is picked on a job. */
const planWeaving = (job, machine, elastic) =>
  request(app).post('/api/v2/job/plan-weaving')
    .set('Cookie', adminCookie())
    .send({
      jobId: String(job._id),
      machineId: String(machine._id),
      headElasticMap: Object.fromEntries(
        Array.from({ length: machine.NoOfHead }, (_, i) => [String(i), String(elastic._id)])
      ),
    });

// ── The straightforward case ──────────────────────────────────────────

describe('moving a job from one machine to another', () => {
  it('frees the machine it was on', async () => {
    const { job, elastic } = await seed();
    const first = await makeMachine();
    const second = await makeMachine();

    expect((await assign(job, first, elastic)).status).toBe(200);
    expect((await assign(job, second, elastic)).status).toBe(200);

    const old = await reload(first);
    expect(old.status).toBe('free');
    expect(old.orderRunning).toBeNull();
    expect(old.elastics).toEqual([]);
  });

  it('leaves the new machine running the job', async () => {
    const { job, elastic } = await seed();
    const first = await makeMachine();
    const second = await makeMachine();

    await assign(job, first, elastic);
    await assign(job, second, elastic);

    const now = await reload(second);
    expect(now.status).toBe('running');
    expect(String(now.orderRunning)).toBe(String(job._id));
    expect((await JobOrder.findById(job._id)).machine.toString()).toBe(String(second._id));
  });
});

// ── The case the release path could not see ───────────────────────────

describe('a machine holding a job that does not point back at it', () => {
  it('is still freed when the job moves', async () => {
    // The link lives on both documents. Release read `job.machine`
    // alone, so a machine whose `orderRunning` was set without the job
    // being pointed back — by an older build, a script, or a partial
    // failure — was held forever: no job would ever release it, because
    // the job it claimed to run did not know about it.
    const { job, elastic } = await seed();
    const stranded = await makeMachine();
    const wanted = await makeMachine();

    await Machine.findByIdAndUpdate(stranded._id, {
      status: 'running', orderRunning: job._id,
      elastics: [{ head: 1, elastic: elastic._id }],
    });
    // The job has no idea — exactly the state that stranded it.
    expect((await JobOrder.findById(job._id)).machine).toBeFalsy();

    expect((await assign(job, wanted, elastic)).status).toBe(200);

    const freed = await reload(stranded);
    expect(freed.status).toBe('free');
    expect(freed.orderRunning).toBeNull();
    expect(freed.elastics).toEqual([]);
  });

  it('frees every machine stranded on the job, not just one', async () => {
    const { job, elastic } = await seed();
    const a = await makeMachine();
    const b = await makeMachine();
    const wanted = await makeMachine();
    for (const m of [a, b]) {
      await Machine.findByIdAndUpdate(m._id, { status: 'running', orderRunning: job._id });
    }

    await assign(job, wanted, elastic);

    for (const m of [a, b]) {
      expect({ id: m.ID, status: (await reload(m)).status }).toEqual({ id: m.ID, status: 'free' });
    }
  });

  it('does not free a machine running a different job', async () => {
    // The release must be scoped to this job. Freeing by machine id
    // alone would take a machine off someone else's running job.
    const { job, elastic } = await seed();
    const other = await seed();
    const theirs = await makeMachine();
    const wanted = await makeMachine();

    await Machine.findByIdAndUpdate(theirs._id, {
      status: 'running', orderRunning: other.job._id,
    });

    await assign(job, wanted, elastic);

    const untouched = await reload(theirs);
    expect(untouched.status).toBe('running');
    expect(String(untouched.orderRunning)).toBe(String(other.job._id));
  });

  it('leaves a machine under maintenance alone', async () => {
    // Maintenance is not a job holding the machine, and "free" would
    // put a machine back in the picker that is in pieces on the floor.
    const { job, elastic } = await seed();
    const down = await makeMachine();
    const wanted = await makeMachine();
    await Machine.findByIdAndUpdate(down._id, { status: 'maintenance', orderRunning: null });

    await assign(job, wanted, elastic);

    expect((await reload(down)).status).toBe('maintenance');
  });
});

// ── Re-assigning the same machine ─────────────────────────────────────

describe('assigning the machine it is already on', () => {
  it('leaves it running rather than freeing it', async () => {
    // The head plan is being edited, not the machine changed. Freeing
    // and re-claiming would blink the machine out of production.
    const { job, elastic } = await seed();
    const machine = await makeMachine();

    await assign(job, machine, elastic);
    expect((await assign(job, machine, elastic)).status).toBe(200);

    const still = await reload(machine);
    expect(still.status).toBe('running');
    expect(String(still.orderRunning)).toBe(String(job._id));
  });
});

// ── The route the web actually uses ───────────────────────────────────

describe('picking a machine through /plan-weaving', () => {
  it('frees the machine the job was already on', async () => {
    // The reported bug. The web modal calls this route, not
    // /assign-machine, and it claimed the new machine without ever
    // releasing the old one — so every reassignment left a machine
    // stuck on "running" for a job it was no longer part of.
    const { job, elastic } = await seed();
    const first = await makeMachine();
    const second = await makeMachine();

    expect((await planWeaving(job, first, elastic)).status).toBe(200);
    expect((await planWeaving(job, second, elastic)).status).toBe(200);

    const old = await reload(first);
    expect(old.status).toBe('free');
    expect(old.orderRunning).toBeNull();
    expect(old.elastics).toEqual([]);
  });

  it('leaves the new machine claimed', async () => {
    const { job, elastic } = await seed();
    const first = await makeMachine();
    const second = await makeMachine();

    await planWeaving(job, first, elastic);
    await planWeaving(job, second, elastic);

    const now = await reload(second);
    expect(now.status).toBe('running');
    expect(String(now.orderRunning)).toBe(String(job._id));
    expect(String((await JobOrder.findById(job._id)).machine)).toBe(String(second._id));
  });

  it('does not free a machine running someone else\'s job', async () => {
    const { job, elastic } = await seed();
    const other = await seed();
    const theirs = await makeMachine();
    const wanted = await makeMachine();
    await Machine.findByIdAndUpdate(theirs._id, {
      status: 'running', orderRunning: other.job._id,
    });

    await planWeaving(job, wanted, elastic);

    expect((await reload(theirs)).status).toBe('running');
  });

  it('releases nothing when the claim itself fails', async () => {
    // The release happens inside the same transaction as the claim, so
    // a machine that turns out not to be free must leave the job on
    // exactly the machine it was already running.
    const { job, elastic } = await seed();
    const held = await makeMachine();
    const busy = await makeMachine();
    await planWeaving(job, held, elastic);
    await Machine.findByIdAndUpdate(busy._id, {
      status: 'maintenance', orderRunning: null,
    });

    const res = await planWeaving(job, busy, elastic);
    expect(res.status).toBeGreaterThanOrEqual(400);

    const still = await reload(held);
    expect(still.status).toBe('running');
    expect(String(still.orderRunning)).toBe(String(job._id));
  });
});

// ── Giving the machine back ───────────────────────────────────────────

describe('a job letting its machine go', () => {
  /** Move a job to weaving by satisfying the readiness gate. */
  async function toWeaving(job, elastic) {
    const warping = await Warping.create({
      date: new Date(), job: job._id, status: 'completed',
      elasticOrdered: [{ elastic: elastic._id, quantity: 500 }],
    });
    const covering = await Covering.create({
      date: new Date(), job: job._id, status: 'completed',
    });
    await JobOrder.findByIdAndUpdate(job._id, {
      warping: warping._id, covering: covering._id,
    });
    return request(app).post('/api/v2/job/update-status')
      .set('Cookie', adminCookie())
      .send({ jobId: String(job._id), nextStatus: 'weaving' });
  }

  it('frees it when weaving finishes', async () => {
    const { job, elastic } = await seed();
    const machine = await makeMachine();
    await planWeaving(job, machine, elastic);
    await toWeaving(job, elastic);

    const res = await request(app).post('/api/v2/job/update-status')
      .set('Cookie', adminCookie())
      .send({ jobId: String(job._id), nextStatus: 'finishing' });
    expect(res.status).toBeLessThan(400);

    const freed = await reload(machine);
    expect(freed.status).toBe('free');
    expect(freed.orderRunning).toBeNull();
    // The head plan goes too: leaving it makes the next job's picker
    // show heads already mapped to another job's products.
    expect(freed.elastics).toEqual([]);
  });

  it('frees it when the job is cancelled while still preparatory', async () => {
    // A machine can be claimed while the job is preparatory — the
    // system offers that deliberately, to reserve capacity. The release
    // on cancel only ran for jobs in weaving, so cancelling one of
    // these left its machine running forever on a job that no longer
    // existed to release it.
    const { job, elastic } = await seed();
    const machine = await makeMachine();
    await planWeaving(job, machine, elastic);
    expect((await JobOrder.findById(job._id)).status).toBe('preparatory');

    const res = await request(app).post('/api/v2/job/cancel')
      .set('Cookie', adminCookie())
      .send({ jobId: String(job._id), reason: 'customer pulled the order' });
    expect(res.status).toBeLessThan(400);

    const freed = await reload(machine);
    expect(freed.status).toBe('free');
    expect(freed.orderRunning).toBeNull();
  });

  it('frees a stranded machine on cancel too', async () => {
    const { job, elastic } = await seed();
    const stranded = await makeMachine();
    await Machine.findByIdAndUpdate(stranded._id, {
      status: 'running', orderRunning: job._id,
    });

    await request(app).post('/api/v2/job/cancel')
      .set('Cookie', adminCookie())
      .send({ jobId: String(job._id), reason: 'no longer needed' });

    expect((await reload(stranded)).status).toBe('free');
  });

  it('leaves a machine under maintenance alone on cancel', async () => {
    const { job, elastic } = await seed();
    const machine = await makeMachine();
    await planWeaving(job, machine, elastic);
    await Machine.findByIdAndUpdate(machine._id, { status: 'maintenance' });

    await request(app).post('/api/v2/job/cancel')
      .set('Cookie', adminCookie())
      .send({ jobId: String(job._id), reason: 'stopped' });

    expect((await reload(machine)).status).toBe('maintenance');
  });
});

// ── Moving a job that is already running ──────────────────────────────

describe('a machine breaking down mid-run', () => {
  async function runningOnMachine(elastic) {
    const { job } = await seed();
    const machine = await makeMachine();
    await planWeaving(job, machine, elastic);

    const warping = await Warping.create({
      date: new Date(), job: job._id, status: 'completed',
      elasticOrdered: [{ elastic: elastic._id, quantity: 500 }],
    });
    const covering = await Covering.create({
      date: new Date(), job: job._id, status: 'completed',
    });
    await JobOrder.findByIdAndUpdate(job._id, {
      warping: warping._id, covering: covering._id,
    });
    const res = await request(app).post('/api/v2/job/update-status')
      .set('Cookie', adminCookie())
      .send({ jobId: String(job._id), nextStatus: 'weaving' });
    expect(res.status).toBeLessThan(400);
    return { job, machine };
  }

  it('can be swapped for another machine', async () => {
    // Refused outright before, so a breakdown had no answer inside the
    // system: the job had to be walked back a stage first.
    const { elastic } = await seed();
    const { job, machine } = await runningOnMachine(elastic);
    expect((await JobOrder.findById(job._id)).status).toBe('weaving');
    const replacement = await makeMachine();

    const res = await planWeaving(job, replacement, elastic);
    expect(res.status).toBe(200);

    expect(String((await JobOrder.findById(job._id)).machine)).toBe(String(replacement._id));
    expect((await reload(replacement)).status).toBe('running');
  });

  it('frees the machine that broke down', async () => {
    const { elastic } = await seed();
    const { job, machine } = await runningOnMachine(elastic);
    const replacement = await makeMachine();

    await planWeaving(job, replacement, elastic);

    const broken = await reload(machine);
    expect(broken.status).toBe('free');
    expect(broken.orderRunning).toBeNull();
    expect(broken.elastics).toEqual([]);
  });

  it('leaves the job in weaving — it never stopped running', async () => {
    const { elastic } = await seed();
    const { job } = await runningOnMachine(elastic);
    const replacement = await makeMachine();

    await planWeaving(job, replacement, elastic);
    expect((await JobOrder.findById(job._id)).status).toBe('weaving');
  });

  it('records the move, naming both machines', async () => {
    // No stage moved, so nothing else would have recorded it — and
    // "which machine was it on before" is the question asked afterwards.
    const { elastic } = await seed();
    const { job, machine } = await runningOnMachine(elastic);
    const replacement = await makeMachine();

    await planWeaving(job, replacement, elastic);

    const fresh = await JobOrder.findById(job._id);
    const fp = (fresh.fingerprints || []).find((f) => f.code === 'JOB_MACHINE_CHANGED');
    expect(fp).toBeTruthy();
    expect(fp.meta.fromMachineId).toBe(String(machine._id));
    expect(fp.meta.toMachineId).toBe(String(replacement._id));
  });

  it('accepts the same machine again, as a head-plan edit', async () => {
    // Re-picking the machine the job is already on must not fail with
    // "machine is not free" — that is the system objecting to its own
    // state.
    const { elastic } = await seed();
    const { job, machine } = await runningOnMachine(elastic);

    const res = await planWeaving(job, machine, elastic);
    expect(res.status).toBe(200);

    const still = await reload(machine);
    expect(still.status).toBe('running');
    expect(String(still.orderRunning)).toBe(String(job._id));
  });

  it('still refuses a machine running somebody else', async () => {
    const { elastic } = await seed();
    const { job } = await runningOnMachine(elastic);
    const other = await seed();
    const theirs = await makeMachine();
    await Machine.findByIdAndUpdate(theirs._id, {
      status: 'running', orderRunning: other.job._id,
    });

    const res = await planWeaving(job, theirs, elastic);
    expect(res.status).toBeGreaterThanOrEqual(400);
    // And nothing moved on either side.
    expect(String((await reload(theirs)).orderRunning)).toBe(String(other.job._id));
  });
});

// ── What the machines list says a machine is doing ────────────────────
//
// Reported as: the Running Job column is empty on every row, including
// machines that are plainly running.
//
// The field was never the problem — it is set on assignment and cleared
// on release, and the detail route reads it correctly. The list route's
// projection simply did not include it, so it never left the server, and
// the column had nothing to render.

describe('the machines list', () => {
  const list = () =>
    request(app).get('/api/v2/machine/get-machines').set('Cookie', adminCookie());

  const rowFor = (body, machine) =>
    body.machines.find((m) => String(m._id) === String(machine._id));

  it('carries the running job, with its number', async () => {
    const { job, elastic } = await seed();
    const machine = await makeMachine(2);
    await assign(job, machine, elastic);

    const res = await list();
    expect(res.status).toBe(200);

    const row = rowFor(res.body, machine);
    expect(row.status).toBe('running');
    // Populated, not a bare id: the column wants the NUMBER, and the
    // machine document only stores a reference.
    expect(row.orderRunning).toBeTruthy();
    expect(row.orderRunning.jobOrderNo).toBe(job.jobOrderNo);
  });

  it('carries the job id too, so the number can be a link', async () => {
    const { job, elastic } = await seed();
    const machine = await makeMachine(2);
    await assign(job, machine, elastic);

    const row = rowFor((await list()).body, machine);
    expect(String(row.orderRunning._id)).toBe(String(job._id));
  });

  it('says nothing for a machine that is free', async () => {
    // Not zero, not an empty object — null, so the screen can tell
    // "no job" apart from "job with no number".
    const machine = await makeMachine(2);

    const row = rowFor((await list()).body, machine);
    expect(row.status).toBe('free');
    expect(row.orderRunning).toBeNull();
  });

  it('clears the job when the machine is released', async () => {
    // The column has to follow the machine back to free, or it reports
    // a job that finished — which is worse than reporting nothing.
    const { job, elastic } = await seed();
    const first = await makeMachine(2);
    const second = await makeMachine(2);
    await assign(job, first, elastic);
    await assign(job, second, elastic);

    const body = (await list()).body;
    expect(rowFor(body, first).orderRunning).toBeNull();
    expect(rowFor(body, second).orderRunning.jobOrderNo).toBe(job.jobOrderNo);
  });
});

// ── Will the product fit on the machine? ──────────────────────────────
//
// A weaving head has a fixed number of hooks and an elastic's recipe
// says how many it needs. Nothing checked the two against each other:
// the head map validated head NUMBERS — no gaps, no duplicates, the
// right count, every elastic on the job — and never asked whether the
// machine could run what was being put on it. A 24-hook product went
// onto a 12-hook machine silently, and was found out at the machine
// with the beam already up.
//
// Refused with a confirmation rather than outright, because the floor
// sometimes runs a product on a smaller machine deliberately, and a
// hard block just gets worked around by assigning something else and
// swapping it back.

describe('putting an elastic on a machine that has too few hooks', () => {
  /** A job whose elastic needs `hooks`, and a machine with `machineHooks`. */
  async function seedFit({ hooks, machineHooks, heads = 2 }) {
    const customer = await Customer.create({
      name: 'Acme', contactName: 'R', phoneNumber: '9000000009',
    });
    const elastic = await Elastic.create({
      name: `20mm ${Math.random().toString(36).slice(2, 8)}`, weaveType: '8',
      spandexEnds: 40, yarnEnds: 120, pick: 12, noOfHook: hooks, weight: 2.4,
    });
    const order = await Order.create({
      orderNo: Math.floor(Math.random() * 100000),
      customer: customer._id, status: 'InProgress', po: 'PO-F',
      date: new Date(), supplyDate: new Date(),
      elasticOrdered: [{ elastic: elastic._id, quantity: 1000 }],
    });
    const job = await JobOrder.create({
      date: new Date(), order: order._id, customer: customer._id,
      status: 'preparatory', elastics: [{ elastic: elastic._id, quantity: 500 }],
    });
    const machine = await Machine.create({
      ID: `M-${Math.floor(Math.random() * 100000)}`, manufacturer: 'Comez',
      NoOfHead: heads, NoOfHooks: machineHooks, status: 'free',
      orderRunning: null, elastics: [],
    });
    return { job, elastic, machine };
  }

  const assignWith = (job, machine, elastic, extra = {}) =>
    request(app).post('/api/v2/job/assign-machine')
      .set('Cookie', adminCookie())
      .send({
        jobId: String(job._id),
        machineId: String(machine._id),
        elastics: Array.from({ length: machine.NoOfHead }, (_, i) => ({
          head: i + 1, elastic: String(elastic._id),
        })),
        ...extra,
      });

  const planWith = (job, machine, elastic, extra = {}) =>
    request(app).post('/api/v2/job/plan-weaving')
      .set('Cookie', adminCookie())
      .send({
        jobId: String(job._id),
        machineId: String(machine._id),
        headElasticMap: Object.fromEntries(
          Array.from({ length: machine.NoOfHead }, (_, i) => [String(i), String(elastic._id)])
        ),
        ...extra,
      });

  it('stops the assignment and says what does not fit', async () => {
    const { job, elastic, machine } = await seedFit({ hooks: 24, machineHooks: 12 });

    const res = await assignWith(job, machine, elastic);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('HOOKS_EXCEED_MACHINE');
    expect(res.body.message).toMatch(/12 hooks/);
    expect(res.body.message).toMatch(/needs 24/);
    // And nothing was claimed on the way to refusing.
    expect((await reload(machine)).status).toBe('free');
  });

  it('names the elastic, so somebody can act on it', async () => {
    const { job, elastic, machine } = await seedFit({ hooks: 24, machineHooks: 12 });
    const res = await assignWith(job, machine, elastic);

    expect(res.body.details).toMatchObject({ machineHooks: 12 });
    expect(res.body.details.elastics[0]).toMatchObject({
      name: elastic.name, noOfHook: 24, excess: 12,
    });
  });

  it('goes ahead once it is confirmed', async () => {
    const { job, elastic, machine } = await seedFit({ hooks: 24, machineHooks: 12 });

    const res = await assignWith(job, machine, elastic, { confirmHooks: true });

    expect(res.status).toBeLessThan(400);
    expect((await reload(machine)).status).toBe('running');
  });

  it('says nothing when the product fits', async () => {
    // Equal counts fit — the rule is "more hooks than the machine has",
    // and an elastic needing exactly what the machine offers is normal.
    const { job, elastic, machine } = await seedFit({ hooks: 12, machineHooks: 12 });

    const res = await assignWith(job, machine, elastic);
    expect(res.status).toBeLessThan(400);
    expect((await reload(machine)).status).toBe('running');
  });

  it('guards /plan-weaving too, which is what the picker calls', async () => {
    // A rule enforced on one of two routes to the same head map is not
    // a rule.
    const { job, elastic, machine } = await seedFit({ hooks: 24, machineHooks: 12 });

    const res = await planWith(job, machine, elastic);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('HOOKS_EXCEED_MACHINE');
    expect((await reload(machine)).status).toBe('free');
  });

  it('lets /plan-weaving through on confirmation', async () => {
    const { job, elastic, machine } = await seedFit({ hooks: 24, machineHooks: 12 });

    const res = await planWith(job, machine, elastic, { confirmHooks: true });

    expect(res.status).toBeLessThan(400);
    expect((await reload(machine)).status).toBe('running');
  });

  it('counts one elastic once, however many heads it is on', async () => {
    const { job, elastic, machine } = await seedFit({
      hooks: 24, machineHooks: 12, heads: 8,
    });
    const res = await assignWith(job, machine, elastic);

    expect(res.body.details.elastics).toHaveLength(1);
  });
});

// ── The third way into a head map ─────────────────────────────────────
//
// The machine page has its own head-map editor, which writes through
// PUT /machine/updateOrder. Guarding only the two job-side routes would
// leave this as a way straight past the rule — and a rule with a door
// next to it is not a rule.

describe('editing the head map from the machine page', () => {
  async function seedMachineWithElastic({ hooks, machineHooks }) {
    const elastic = await Elastic.create({
      name: `20mm ${Math.random().toString(36).slice(2, 8)}`, weaveType: '8',
      spandexEnds: 40, yarnEnds: 120, pick: 12, noOfHook: hooks, weight: 2.4,
    });
    const machine = await Machine.create({
      ID: `M-${Math.floor(Math.random() * 100000)}`, manufacturer: 'Comez',
      NoOfHead: 2, NoOfHooks: machineHooks, status: 'free',
      orderRunning: null, elastics: [],
    });
    return { elastic, machine };
  }

  const saveMap = (machine, elastic, extra = {}) =>
    request(app).put('/api/v2/machine/updateOrder')
      .set('Cookie', adminCookie())
      .send({
        id: String(machine._id),
        elastics: [
          { head: 1, elastic: String(elastic._id) },
          { head: 2, elastic: String(elastic._id) },
        ],
        ...extra,
      });

  it('refuses a product the machine has too few hooks for', async () => {
    const { elastic, machine } = await seedMachineWithElastic({ hooks: 24, machineHooks: 12 });

    const res = await saveMap(machine, elastic);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('HOOKS_EXCEED_MACHINE');
    // Nothing was written on the way to refusing.
    expect((await reload(machine)).elastics).toHaveLength(0);
  });

  it('saves it once confirmed', async () => {
    const { elastic, machine } = await seedMachineWithElastic({ hooks: 24, machineHooks: 12 });

    const res = await saveMap(machine, elastic, { confirmHooks: true });

    expect(res.status).toBe(200);
    expect((await reload(machine)).elastics).toHaveLength(2);
  });

  it('says nothing when the product fits', async () => {
    const { elastic, machine } = await seedMachineWithElastic({ hooks: 8, machineHooks: 12 });

    const res = await saveMap(machine, elastic);

    expect(res.status).toBe(200);
    expect((await reload(machine)).elastics).toHaveLength(2);
  });

  it('ignores empty heads rather than tripping over them', async () => {
    // A head with no elastic is a normal thing to save — a partial map.
    const { machine } = await seedMachineWithElastic({ hooks: 8, machineHooks: 12 });

    const res = await request(app).put('/api/v2/machine/updateOrder')
      .set('Cookie', adminCookie())
      .send({
        id: String(machine._id),
        elastics: [{ head: 1, elastic: null }, { head: 2, elastic: null }],
      });

    expect(res.status).toBe(200);
  });
});
