'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE PLANNER: THE ORDER YOU PUT IT IN, AND A LOOM THAT IS SPOKEN FOR
//
//  Found reading api/planner.js line by line.
//
//  1. A MANUAL REORDER WAS THROWN AWAY. The plan screen lets the planner
//     move a line up or down within a loom's queue, and says accepting
//     keeps what was arranged. The server re-scored the accepted plan
//     with the optimiser's own evaluator — which SORTS each loom's lines
//     by due date before walking them. So the plan of record went on
//     the wall in due-date order, with finish dates for a sequence
//     nobody chose, and the planner "learned" nothing from the reorder
//     because, as it scored it, nothing had been reordered. (The comment
//     beside it said insertion order was the sequence. It was not.)
//
//  2. A LOOM RESERVED FOR A JOB STILL IN PREPARATION WAS FREE. A job can
//     claim its loom before weaving starts — the app offers that, to
//     hold capacity. The planner counted a loom's commitments from jobs
//     already weaving only, so a reserved loom had nothing on it and
//     new work was proposed there from day zero.
//
//  3. THE FIRST PASS IGNORED WHAT THE PLANNER HAD LEARNED. The weights
//     are learned from the plans people accept; the greedy pass that
//     places every line used the built-in ones, and the learned ones
//     only steered the handful of moves made afterwards.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const C = require('../../utils/etaConfig');

let mongo, app, planner;
let Order, Machine, Elastic, Customer, JobOrder, ProductionPlan, User, admin;
let customer;
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app     = require('../../app.js');
  planner = require('../../api/planner.js');
  Order          = require('../../models/Order');
  Machine        = require('../../models/Machine');
  Elastic        = require('../../models/Elastic');
  Customer       = require('../../models/Customer');
  JobOrder       = require('../../models/JobOrder');
  ProductionPlan = require('../../models/ProductionPlan');
  User           = require('../../models/User');
  admin = await User.create({ name: 'Owner', email: 'planner-order@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

let seq = 0;
beforeEach(async () => {
  customer = await Customer.create({ name: `Acme ${seq}`, contactName: 'R', phoneNumber: '9000000001' });
});
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
});

const startOfDay = (d) => require('../../utils/factoryDay').calendarDay(d);
const makeElastic = (hooks = 8) => Elastic.create({ name: `20mm-${seq++}`, weaveType: '8', spandexEnds: 40, yarnEnds: 120, pick: 12, noOfHook: hooks, weight: 2.4 });
const makeMachine = (heads = 4, hooks = 12) => Machine.create({ ID: `LOOM-${seq++}`, manufacturer: 'Comez', DateOfPurchase: new Date(), NoOfHead: heads, NoOfHooks: hooks, status: 'free' });
async function makeOrder(elastic, qty, dueInWorkingDays) {
  const due = C.addWorkingDays(startOfDay(new Date()), dueInWorkingDays);
  return Order.create({
    customer: customer._id, po: `PO-${seq++}`, date: new Date(), supplyDate: due, status: 'Approved',
    elasticOrdered:  [{ elastic: elastic._id, quantity: qty, rate: 10 }],
    pendingElastic:  [{ elastic: elastic._id, quantity: qty }],
    producedElastic: [{ elastic: elastic._id, quantity: 0 }],
  });
}
const suggest = (qs = '?horizonDays=60') => request(app).get(`/api/v2/planner/suggest-plan${qs}`).set('Cookie', cookie());
const accept = (body) => request(app).post('/api/v2/planner/accept').set('Cookie', cookie()).send(body);

// ══════════════════════════════════════════════════════════════════
describe('accepting a plan after moving a line up the queue', () => {
  /** One loom, two lines of the same elastic: the first due sooner. */
  async function proposal() {
    const elastic = await makeElastic();
    await makeMachine();
    const soon  = await makeOrder(elastic, 500, 5);
    const later = await makeOrder(elastic, 500, 30);
    const res = await suggest();
    expect(res.status).toBe(200);
    const [loom] = res.body.machines;
    // As proposed: the one due sooner runs first.
    expect(loom.rows.map((r) => r.orderNo)).toEqual([soon.orderNo, later.orderNo]);
    return { plan: res.body, loom, soon, later };
  }

  it('keeps the order it was put in', async () => {
    const { plan, loom, soon, later } = await proposal();
    const moved = [{ ...loom, rows: [loom.rows[1], loom.rows[0]] }];     // the later order first

    const res = await accept({ ...plan, machines: moved, proposedMachines: plan.machines });
    expect(res.status).toBe(200);

    const saved = await ProductionPlan.findById(res.body.planId).lean();
    const bySequence = [...saved.assignments].sort((a, b) => a.sequence - b.sequence);
    // Before: [soon, later] — the due-date order, whatever was arranged.
    expect(bySequence.map((a) => a.orderNo)).toEqual([later.orderNo, soon.orderNo]);
    expect(bySequence.map((a) => a.sequence)).toEqual([0, 1]);
    // And the dates are for THAT order: the one moved up finishes first.
    expect(new Date(bySequence[0].projectedFinish).getTime()).toBeLessThan(new Date(bySequence[1].projectedFinish).getTime());
    expect(bySequence[0].startWorkingDay).toBe(0);
    expect(bySequence[1].startWorkingDay).toBeGreaterThan(0);
  });

  it('accepting it as proposed keeps the proposal\'s order (unchanged)', async () => {
    const { plan, soon, later } = await proposal();
    const res = await accept({ ...plan, proposedMachines: plan.machines });
    const saved = await ProductionPlan.findById(res.body.planId).lean();
    expect([...saved.assignments].sort((a, b) => a.sequence - b.sequence).map((a) => a.orderNo)).toEqual([soon.orderNo, later.orderNo]);
    expect(saved.edited).toBe(false);
  });

  it('a reorder that makes a line late is scored as late', async () => {
    const elastic = await makeElastic();
    await makeMachine();
    // Each line is a few days of weaving at the cold-start rate; the
    // first is due tomorrow.
    const urgent = await makeOrder(elastic, 6000, 1);
    await makeOrder(elastic, 6000, 60);
    const plan = (await suggest()).body;
    const [loom] = plan.machines;
    expect(loom.rows[0].orderNo).toBe(urgent.orderNo);
    const wasLate = loom.rows[0].lateWorkingDays;

    const res = await accept({ ...plan, machines: [{ ...loom, rows: [loom.rows[1], loom.rows[0]] }], proposedMachines: plan.machines });
    const saved = await ProductionPlan.findById(res.body.planId).lean();
    const row = saved.assignments.find((a) => a.orderNo === urgent.orderNo);
    // Pushed behind the other line, it is later than it was. Before: the
    // same figure as proposed — the server had put it back in front.
    expect(row.sequence).toBe(1);
    expect(row.late).toBe(true);
    expect(row.lateWorkingDays).toBeGreaterThan(wasLate);
    // The plan cost more than the proposal, and that is what was kept.
    expect(saved.objectiveTerms.late).toBeGreaterThan(saved.proposedTerms.late);
  });
});

// ══════════════════════════════════════════════════════════════════
//  4. AN EDITED PLAN COULD NOT BE SEEN BEFORE IT WAS ACCEPTED. Moving a
//     line left its dates as they were for where it had been; the
//     "accept" dialog quoted the PROPOSAL's late lines, not those of the
//     plan about to become the plan of record. POST /planner/score
//     re-scores an arrangement as it stands, the way accepting it will.
describe('scoring a plan as it has been rearranged', () => {
  const score = (body) => request(app).post('/api/v2/planner/score').set('Cookie', cookie()).send(body);

  it('gives the dates and the late lines of THAT arrangement', async () => {
    const elastic = await makeElastic();
    await makeMachine();
    const urgent = await makeOrder(elastic, 6000, 1);
    const relaxed = await makeOrder(elastic, 6000, 60);
    const plan = (await suggest()).body;
    const [loom] = plan.machines;

    const res = await score({ horizonDays: 60, machines: [{ ...loom, rows: [loom.rows[1], loom.rows[0]] }] });
    expect(res.status).toBe(200);
    const rows = res.body.machines[0].rows;
    expect(rows.map((r) => r.orderNo)).toEqual([relaxed.orderNo, urgent.orderNo]);
    expect(rows.map((r) => r.sequence)).toEqual([0, 1]);
    expect(rows[0].startWorkingDay).toBe(0);
    // The urgent line, pushed back, is later than the proposal had it.
    expect(rows[1].late).toBe(true);
    expect(rows[1].lateWorkingDays).toBeGreaterThan(loom.rows[0].lateWorkingDays);
    expect(res.body.objective).toMatchObject({ placed: 2, late: rows.filter((r) => r.late).length, machinesUsed: 1 });
    expect(res.body.objective.totalLateDays).toBeGreaterThan(plan.objective.totalLateDays);
    // It is a look, not a decision.
    expect(await ProductionPlan.countDocuments({})).toBe(0);
  });

  it('scored as proposed, agrees with the proposal', async () => {
    const elastic = await makeElastic();
    await makeMachine();
    await makeOrder(elastic, 500, 5);
    await makeOrder(elastic, 500, 30);
    const plan = (await suggest()).body;
    const res = await score({ horizonDays: 60, machines: plan.machines });
    expect(res.body.objective).toMatchObject({ placed: plan.objective.placed, late: plan.objective.late, totalLateDays: plan.objective.totalLateDays, changeovers: plan.objective.changeovers });
    expect(res.body.machines[0].rows.map((r) => [r.lineId, r.projectedFinish, r.late]))
      .toEqual(plan.machines[0].rows.map((r) => [r.lineId, r.projectedFinish, r.late]));
  });

  it('says which lines are no longer there to plan', async () => {
    const elastic = await makeElastic();
    await makeMachine();
    const a = await makeOrder(elastic, 500, 5);
    await makeOrder(elastic, 500, 30);
    const plan = (await suggest()).body;
    // Meanwhile a job is raised for the first order: nothing of it is pending.
    await Order.updateOne({ _id: a._id }, { $set: { 'pendingElastic.0.quantity': 0 } });

    const res = await score({ horizonDays: 60, machines: plan.machines });
    expect(res.body.machines[0].rows).toHaveLength(1);
    expect(res.body.gone).toEqual([expect.objectContaining({ orderNo: a.orderNo })]);
  });

  it('needs a plan to score', async () => {
    expect((await score({ horizonDays: 60 })).status).toBe(400);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('a loom reserved for a job still in preparation', () => {
  it('is not free: new work is proposed behind the job that holds it', async () => {
    const elastic = await makeElastic();
    const machine = await makeMachine();
    const order = await makeOrder(elastic, 500, 20);
    await JobOrder.create({
      order: order._id, customer: customer._id, date: new Date(), status: 'preparatory',
      machine: machine._id,
      elastics:        [{ elastic: elastic._id, quantity: 5000 }],
      producedElastic: [{ elastic: elastic._id, quantity: 0 }],
    });

    const res = await suggest();
    expect(res.status).toBe(200);
    // Before: day 0 — on top of a job that had claimed the loom.
    expect(res.body.machines[0].rows[0].startWorkingDay).toBeGreaterThan(0);
    expect(res.body.committed.map((c) => c.machineID)).toEqual([machine.ID]);
  });

  it('a cancelled or completed job holds nothing (unchanged)', async () => {
    const elastic = await makeElastic();
    const machine = await makeMachine();
    const order = await makeOrder(elastic, 500, 20);
    for (const status of ['cancelled', 'completed']) {
      await JobOrder.create({
        order: order._id, customer: customer._id, date: new Date(), status, machine: machine._id,
        elastics: [{ elastic: elastic._id, quantity: 5000 }], producedElastic: [{ elastic: elastic._id, quantity: 0 }],
      });
    }
    const res = await suggest();
    expect(res.body.machines[0].rows[0].startWorkingDay).toBe(0);
    expect(res.body.committed).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('the first pass and the weights the planner has learned', () => {
  // One line of elastic E1, a day's weaving, due in two working days.
  //   LOOM-A  has E2 on it: a changeover, and on time.
  //   LOOM-B  has E1 on it and three days of work first: no changeover, late.
  const planDate = startOfDay(new Date('2026-11-16T06:00:00Z'));     // a Monday
  const line = { id: 'L1', elasticId: 'E1', qtyMeters: 800, dueDate: C.addWorkingDays(planDate, 2), hooks: 8 };
  const machines = [
    { id: 'A', ID: 'LOOM-A', heads: 4, hooks: 12, currentElasticId: 'E2' },
    { id: 'B', ID: 'LOOM-B', heads: 4, hooks: 12, currentElasticId: 'E1' },
  ];
  const ctx = (weights) => ({
    planDate, weights,
    rate: new Map([['E1|A', { mpd: 800, source: 'posterior' }], ['E1|B', { mpd: 800, source: 'posterior' }]]),
    backlog: new Map([['B', 3]]),
    linesById: new Map([[line.id, line]]),
    machinesById: new Map(machines.map((m) => [m.id, m])),
  });
  const greedy = (weights) => planner._planner._greedy([line], machines, ctx(weights)).assignmentMap.get('L1');

  it('with the built-in weights takes the changeover to be on time (unchanged)', () => {
    expect(greedy(undefined)).toBe('A');
  });

  it('a plant that has taught it changeovers cost more than a late day gets the other loom', () => {
    // Before: 'A' again — the first pass never looked at the learned weights.
    expect(greedy({ late: 0.1, changeover: 5, balance: 1 })).toBe('B');
  });

  it('and one that has taught it lateness matters more still gets the first', () => {
    expect(greedy({ late: 50, changeover: 5, balance: 1 })).toBe('A');
  });
});
