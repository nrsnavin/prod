'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE ACCEPT PATH, WHICH IS NOW THE ONLY PLACE THE PLANNER LEARNS
//
//  Two things happen when an admin accepts a plan, and until now neither
//  of them did.
//
//  1. If they MOVED a line first, the plan they accepted is not the plan
//     they were shown. The rows the client posts still carry the finish
//     dates the optimiser computed for the machine the line used to be
//     on — so storing them unchanged puts a plan of record on the wall
//     with dates for a schedule nobody is running. Every accepted plan
//     is re-scored here on the assignment that was actually accepted.
//
//  2. That difference is the only signal in this system that can correct
//     the objective's weights. No amount of production data reveals
//     whether this plant would rather take a late day or a changeover;
//     only somebody choosing does.
//
//  The tests below are mostly about the ways this could go quietly
//  wrong: learning from a difference nobody made, learning from a
//  rubber stamp, or letting a weight update stop a plan being accepted
//  at all.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const C = require('../../utils/etaConfig');

let mongo, app;
let Order, Machine, Elastic, Customer, ProductionPlan, PlannerWeights, User;
let admin, customer;

const cookie = () => [
  `token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`,
];

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app            = require('../../app.js');
  Order          = require('../../models/Order');
  Machine        = require('../../models/Machine');
  Elastic        = require('../../models/Elastic');
  Customer       = require('../../models/Customer');
  ProductionPlan = require('../../models/ProductionPlan');
  PlannerWeights = require('../../models/PlannerWeights');
  User           = require('../../models/User');
  admin = await User.create({
    name: 'Planner', email: 'plan-learn@t.co', password: 'pass1234',
    role: 'admin', department: 'admin',
  });
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

let seq = 0;
beforeEach(async () => {
  customer = await Customer.create({
    name: `Acme ${seq++}`, contactName: 'R', phoneNumber: `9${String(seq).padStart(9, '0')}`,
  });
});
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
});

const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };

const makeElastic = (hooks = 8) => Elastic.create({
  name: `20mm-${seq++}`, weaveType: '8', spandexEnds: 40,
  yarnEnds: 120, pick: 12, noOfHook: hooks, weight: 2.4,
});

const makeMachine = (heads = 4, hooks = 12) => Machine.create({
  ID: `LOOM-${seq++}`, manufacturer: 'Comez', DateOfPurchase: new Date(),
  NoOfHead: heads, NoOfHooks: hooks, status: 'free',
});

async function makeOrder(elastic, qty, dueInWorkingDays) {
  const due = C.addWorkingDays(startOfDay(new Date()), dueInWorkingDays);
  return Order.create({
    customer: customer._id, po: `PO-${seq++}`,
    date: new Date(), supplyDate: due, status: 'Approved',
    elasticOrdered:  [{ elastic: elastic._id, quantity: qty, rate: 10 }],
    pendingElastic:  [{ elastic: elastic._id, quantity: qty }],
    producedElastic: [{ elastic: elastic._id, quantity: 0 }],
  });
}

const suggest = (qs = '') =>
  request(app).get(`/api/v2/planner/suggest-plan${qs}`).set('Cookie', cookie());

const accept = (body) =>
  request(app).post('/api/v2/planner/accept').set('Cookie', cookie()).send(body);

/**
 * A plant with two looms and two lines the planner will spread across
 * them, so there is somewhere to move a line TO.
 */
async function twoLinePlant() {
  const [e1, e2] = [await makeElastic(), await makeElastic()];
  await makeMachine();
  await makeMachine();
  await makeOrder(e1, 600, 10);
  await makeOrder(e2, 600, 10);
  const res = await suggest('?horizonDays=30');
  expect(res.status).toBe(200);
  return res.body;
}

/** Everything onto the first machine — the strongest edit available. */
function collapseOntoOneMachine(plan) {
  const first = plan.machines[0];
  const rows = plan.machines.flatMap((m) => m.rows);
  return [{ ...first, rows }];
}

// ══════════════════════════════════════════════════════════════════
describe('the proposal carries what an edit needs', () => {
  test('every row is identified, so a moved line can be matched back', async () => {
    const plan = await twoLinePlant();
    const rows = plan.machines.flatMap((m) => m.rows);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(typeof r.lineId).toBe('string');
  });

  test('the objective and its weights are on the response', async () => {
    const plan = await twoLinePlant();
    expect(plan.weights).toMatchObject({ late: 10, learned: false });
    expect(plan.objectiveTerms).toHaveProperty('late');
    expect(plan.objectiveTerms).toHaveProperty('changeover');
    expect(plan.objectiveTerms).toHaveProperty('balance');
  });
});

// ══════════════════════════════════════════════════════════════════
describe('accepting unchanged', () => {
  test('is not treated as a correction', async () => {
    const plan = await twoLinePlant();
    const res = await accept({
      generatedAt: plan.generatedAt, horizonDays: 30,
      objective: plan.objective, machines: plan.machines,
      proposedMachines: plan.machines,
      assumptions: plan.assumptions,
    });

    expect(res.status).toBe(200);
    expect(res.body.learning.updated).toBe(false);
    expect(res.body.learning.reason).toBe('unchanged');
    expect(await PlannerWeights.countDocuments({ observations: { $gt: 0 } })).toBe(0);
  });

  test('and still records the plan', async () => {
    const plan = await twoLinePlant();
    await accept({
      horizonDays: 30, objective: plan.objective,
      machines: plan.machines, proposedMachines: plan.machines,
    });
    const stored = await ProductionPlan.findOne({ status: 'accepted' }).lean();
    expect(stored).toBeTruthy();
    expect(stored.edited).toBe(false);
    expect(stored.assignments.length).toBe(plan.machines.flatMap((m) => m.rows).length);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('accepting an edited plan', () => {
  test('learns from it, and says what it learned', async () => {
    const plan = await twoLinePlant();
    const edited = collapseOntoOneMachine(plan);

    const res = await accept({
      horizonDays: 30, objective: plan.objective,
      machines: edited, proposedMachines: plan.machines,
    });

    expect(res.status).toBe(200);
    expect(res.body.learning.updated).toBe(true);
    expect(res.body.learning.note).toEqual(expect.any(String));
    expect(res.body.learning.observations).toBe(1);
    // Stored, but not yet in use — five corrections are needed first.
    expect(res.body.learning.inUse).toBe(false);
  });

  test('the plan of record is re-scored on what was accepted, not what was shown', async () => {
    // The bug this exists for: the client's rows describe the machine the
    // line was originally on. Piling both lines onto one loom must push
    // the second line's start day out; keeping the client's figure would
    // record two lines both starting on day zero of the same machine.
    const plan = await twoLinePlant();
    const edited = collapseOntoOneMachine(plan);

    await accept({
      horizonDays: 30, objective: plan.objective,
      machines: edited, proposedMachines: plan.machines,
    });

    const stored = await ProductionPlan.findOne({ status: 'accepted' }).lean();
    expect(stored.edited).toBe(true);
    const onOneMachine = stored.assignments;
    expect(onOneMachine.length).toBe(2);
    const starts = onOneMachine.map((a) => a.startWorkingDay).sort((a, b) => a - b);
    expect(starts[1]).toBeGreaterThan(starts[0]);
  });

  test('both plans\' objective terms are stored on the plan', async () => {
    const plan = await twoLinePlant();
    const edited = collapseOntoOneMachine(plan);
    await accept({
      horizonDays: 30, objective: plan.objective,
      machines: edited, proposedMachines: plan.machines,
    });

    const stored = await ProductionPlan.findOne({ status: 'accepted' }).lean();
    expect(stored.proposedTerms).toHaveProperty('changeover');
    expect(stored.objectiveTerms).toHaveProperty('changeover');
    // Two elastics on one loom is a changeover the spread plan did not
    // have. That is the term this particular edit actually moves.
    expect(stored.objectiveTerms.changeover)
      .toBeGreaterThan(stored.proposedTerms.changeover);
  });

  test('piling both lines onto one loom is scored as MORE imbalanced', async () => {
    // Found by probing what an edit actually changes, and it was
    // backwards. The imbalance term averaged over machines that HAD
    // work, so collapsing two looms into one left a single cursor —
    // max equal to average, imbalance zero. The most concentrated plan
    // available scored as perfectly balanced, and the term rewarded the
    // exact arrangement it exists to discourage. Idle looms are counted
    // now, so the gap is real.
    const plan = await twoLinePlant();
    const edited = collapseOntoOneMachine(plan);
    await accept({
      horizonDays: 30, objective: plan.objective,
      machines: edited, proposedMachines: plan.machines,
    });

    const stored = await ProductionPlan.findOne({ status: 'accepted' }).lean();
    expect(stored.objectiveTerms.balance).toBeGreaterThan(stored.proposedTerms.balance);
  });

  test('the weights move in the direction the edit implies', async () => {
    const plan = await twoLinePlant();
    const edited = collapseOntoOneMachine(plan);
    await accept({
      horizonDays: 30, objective: plan.objective,
      machines: edited, proposedMachines: plan.machines,
    });

    const doc = await PlannerWeights.findOne({ key: 'default' });
    // The admin accepted a plan with a changeover the proposal avoided,
    // so changeovers are costing less than the objective claimed.
    expect(doc.changeover).toBeLessThan(PlannerWeights.DEFAULT_WEIGHTS.changeover);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('what must not happen', () => {
  test('an older client that sends no proposal learns nothing, and still accepts', async () => {
    // Backwards compatibility as a safety property: a client that has
    // not been updated must not be able to teach the planner a
    // difference it never measured.
    const plan = await twoLinePlant();
    const res = await accept({
      horizonDays: 30, objective: plan.objective, machines: plan.machines,
    });

    expect(res.status).toBe(200);
    expect(res.body.learning.updated).toBe(false);
    expect(res.body.learning.reason).toBe('no-proposal');
    expect(await ProductionPlan.countDocuments({ status: 'accepted' })).toBe(1);
  });

  test('rows naming an unknown line are ignored rather than trusted', async () => {
    const plan = await twoLinePlant();
    const junk = [{
      ...plan.machines[0],
      rows: [...plan.machines[0].rows, { lineId: 'not-a-line', orderNo: 999 }],
    }];

    const res = await accept({
      horizonDays: 30, objective: plan.objective,
      machines: junk, proposedMachines: plan.machines,
    });
    expect(res.status).toBe(200);
  });

  test('a plan is still accepted when the weight update cannot run', async () => {
    // Learning is a refinement. A plan of record that could not be
    // accepted because a weights write failed would be a far worse
    // failure than an objective that stays where it is.
    const plan = await twoLinePlant();
    const spy = jest
      .spyOn(require('../../services/plannerLearning'), 'observe')
      .mockRejectedValue(new Error('boom'));

    const res = await accept({
      horizonDays: 30, objective: plan.objective,
      machines: collapseOntoOneMachine(plan), proposedMachines: plan.machines,
    });

    expect(res.status).toBe(200);
    expect(res.body.learning.updated).toBe(false);
    expect(res.body.learning.reason).toBe('error');
    expect(await ProductionPlan.countDocuments({ status: 'accepted' })).toBe(1);
    spy.mockRestore();
  });
});

// ══════════════════════════════════════════════════════════════════
describe('GET /planner/weights', () => {
  test('reports the defaults before anything is learned', async () => {
    const res = await request(app)
      .get('/api/v2/planner/weights').set('Cookie', cookie());

    expect(res.status).toBe(200);
    expect(res.body.data.learned).toBe(false);
    expect(res.body.data.active).toEqual(PlannerWeights.DEFAULT_WEIGHTS);
    expect(res.body.data.observations).toBe(0);
  });

  test('reset puts the constants back', async () => {
    const plan = await twoLinePlant();
    await accept({
      horizonDays: 30, objective: plan.objective,
      machines: collapseOntoOneMachine(plan), proposedMachines: plan.machines,
    });

    const reset = await request(app)
      .post('/api/v2/planner/weights/reset').set('Cookie', cookie());
    expect(reset.status).toBe(200);

    const after = await request(app)
      .get('/api/v2/planner/weights').set('Cookie', cookie());
    expect(after.body.data.observations).toBe(0);
    expect(after.body.data.stored).toEqual(PlannerWeights.DEFAULT_WEIGHTS);
    expect(after.body.data.lastResetBy).toBe('Planner');
  });

  test('is admin-only — it reports and changes plant-wide behaviour', async () => {
    const worker = await User.create({
      name: 'Op', email: `op-${seq++}@t.co`, password: 'pass1234',
      role: 'production', department: 'production',
    });
    const c = [`token=${jwt.sign({ id: worker._id, role: 'production' }, process.env.JWT_SECRET_KEY)}`];

    const read = await request(app).get('/api/v2/planner/weights').set('Cookie', c);
    const write = await request(app).post('/api/v2/planner/weights/reset').set('Cookie', c);
    expect([401, 403]).toContain(read.status);
    expect([401, 403]).toContain(write.status);
    await User.deleteOne({ _id: worker._id });
  });
});
