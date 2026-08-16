'use strict';
// ══════════════════════════════════════════════════════════════════
//  A PLANNER THAT WAS WRONG ABOUT THE CLOCK AND THE CALENDAR
//
//  The optimiser is deterministic and its objective is dominated by
//  lateness: W_LATE is 10 against a changeover's 1 and an imbalance's
//  0.1. So an error in "is this line late?" does not merely misreport —
//  it changes which machine the work goes on, and the plan the floor
//  then follows.
//
//  Three faults, in the order they bite:
//
//    • planDate was `new Date()`, carrying the time of day, while
//      supplyDate is stored at midnight. A line finishing exactly ON
//      its due date compared as finish > due and was booked a day late.
//      Every plan drawn after midnight — i.e. every plan — paid ten
//      points per line for a day that did not exist.
//
//    • horizonDays was read from the query, echoed in the response and
//      written onto the accepted plan, and never used for anything.
//      _gatherLines' own comment said "within the horizon". Every
//      horizon returned an identical plan.
//
//    • every machine's cursor started at zero, so the plan assumed a
//      plant standing idle. The looms are running when the plan is
//      drawn; their remaining metres have to come off first.
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

const cookie = () => [
  `token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`,
];

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
  admin = await User.create({
    name: 'Planner', email: 'plan@t.co', password: 'pass1234',
    role: 'admin', department: 'admin',
  });
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

let seq = 0;
beforeEach(async () => {
  customer = await Customer.create({
    name: `Acme ${seq}`, contactName: 'R', phoneNumber: '9000000001',
  });
});

afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
});

const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };

const makeElastic = (hooks = 8) =>
  Elastic.create({
    name: `20mm-${seq++}`, weaveType: '8', spandexEnds: 40,
    yarnEnds: 120, pick: 12, noOfHook: hooks, weight: 2.4,
  });

const makeMachine = (heads = 4, hooks = 12) =>
  Machine.create({
    ID: `LOOM-${seq++}`, manufacturer: 'Comez', DateOfPurchase: new Date(),
    NoOfHead: heads, NoOfHooks: hooks, status: 'free',
  });

/** An approved order with one pending line, due `dueInDays` working days out. */
async function makeOrder(elastic, qty, dueInWorkingDays) {
  const due = dueInWorkingDays === null
    ? null
    : C.addWorkingDays(startOfDay(new Date()), dueInWorkingDays);
  return Order.create({
    customer: customer._id, po: `PO-${seq++}`,
    date: new Date(), supplyDate: due || new Date(), status: 'Approved',
    elasticOrdered:  [{ elastic: elastic._id, quantity: qty, rate: 10 }],
    pendingElastic:  [{ elastic: elastic._id, quantity: qty }],
    producedElastic: [{ elastic: elastic._id, quantity: 0 }],
  });
}

const suggest = (qs = '') =>
  request(app).get(`/api/v2/planner/suggest-plan${qs}`).set('Cookie', cookie());

// ══════════════════════════════════════════════════════════════════
describe('a line that finishes exactly on its due date', () => {
  // Read at call time: `planner` is only assigned in beforeAll, and a
  // describe body runs before that.
  const _evaluate = (...args) => planner._planner._evaluate(...args);

  /** One line, one machine, weaving time chosen to land on the date. */
  const scenario = (planDate) => {
    const due = C.addWorkingDays(startOfDay(planDate), 3);
    const line = { id: 'L1', elasticId: 'E1', qtyMeters: 300, dueDate: due };
    return {
      map: new Map([['L1', 'M1']]),
      ctx: {
        linesById: new Map([['L1', line]]),
        machinesById: new Map([['M1', { id: 'M1', heads: 4, currentElasticId: null }]]),
        rate: new Map([['E1|M1', { mpd: 100, source: 'posterior' }]]),  // 3 days
        planDate,
      },
    };
  };

  it('is on time', () => {
    const at2pm = new Date(); at2pm.setHours(14, 30, 0, 0);
    const { map, ctx } = scenario(at2pm);
    const out = _evaluate(map, ctx);

    expect(out.results[0].late).toBe(false);
    expect(out.results[0].lateWorkingDays).toBe(0);
  });

  it('costs the objective nothing', () => {
    // The reason it matters: lateness is weighted 10, so a phantom day
    // is not a cosmetic slip — it outweighs ten changeovers and steers
    // the assignment somewhere worse.
    const at2pm = new Date(); at2pm.setHours(14, 30, 0, 0);
    const { map, ctx } = scenario(at2pm);
    expect(_evaluate(map, ctx).score).toBe(0);
  });

  it('gives the same answer whatever time of day the plan is drawn', () => {
    // The bug was entirely a function of the wall clock, which is the
    // one input a production plan must not depend on.
    const scores = [0, 9, 14, 23].map((h) => {
      const at = new Date(); at.setHours(h, 30, 0, 0);
      const { map, ctx } = scenario(at);
      return _evaluate(map, ctx).score;
    });
    expect(new Set(scores).size).toBe(1);
  });

  it('still books a genuinely late line', () => {
    const at2pm = new Date(); at2pm.setHours(14, 30, 0, 0);
    const { map, ctx } = scenario(at2pm);
    // Same 3-day run, but due a day earlier than it can finish.
    ctx.linesById.get('L1').dueDate = C.addWorkingDays(startOfDay(at2pm), 2);

    const out = _evaluate(map, ctx);
    expect(out.results[0].late).toBe(true);
    expect(out.results[0].lateWorkingDays).toBe(1);
  });
});

describe('the planning horizon', () => {
  it('leaves out work due beyond it', async () => {
    const elastic = await makeElastic();
    await makeMachine();
    await makeOrder(elastic, 500, 2);    // inside a 7-day horizon
    await makeOrder(elastic, 500, 40);   // well outside it

    const res = await suggest('?horizonDays=7');
    expect(res.status).toBe(200);
    expect(res.body.objective.lines).toBe(1);
    expect(res.body.objective.beyondHorizon).toBe(1);
  });

  it('takes the far line in when the horizon reaches it', async () => {
    // The control: the selector has to actually change the answer.
    const elastic = await makeElastic();
    await makeMachine();
    await makeOrder(elastic, 500, 2);
    await makeOrder(elastic, 500, 40);

    const res = await suggest('?horizonDays=60');
    expect(res.body.objective.lines).toBe(2);
    expect(res.body.objective.beyondHorizon).toBe(0);
  });

  it('changes the plan when it changes — it was a control wired to nothing', async () => {
    const elastic = await makeElastic();
    await makeMachine();
    await makeOrder(elastic, 500, 2);
    await makeOrder(elastic, 500, 40);

    const [tight, wide] = await Promise.all([suggest('?horizonDays=7'), suggest('?horizonDays=60')]);
    expect(tight.body.objective.placed).not.toBe(wide.body.objective.placed);
  });

  it('always includes an overdue line, however tight the horizon', async () => {
    // Overdue work is the most urgent there is; a horizon that dropped
    // it would plan around the problem.
    const elastic = await makeElastic();
    await makeMachine();
    const order = await makeOrder(elastic, 500, 2);
    const past = new Date(); past.setDate(past.getDate() - 30);
    await Order.updateOne({ _id: order._id }, { $set: { supplyDate: past } });

    const res = await suggest('?horizonDays=1');
    expect(res.body.objective.lines).toBe(1);
  });

  it('includes a line with no due date at all', async () => {
    const elastic = await makeElastic();
    await makeMachine();
    const order = await makeOrder(elastic, 500, 2);
    await Order.updateOne({ _id: order._id }, { $unset: { supplyDate: 1 } });

    const res = await suggest('?horizonDays=1');
    expect(res.body.objective.lines).toBe(1);
  });

  it('says where the horizon ends', async () => {
    await makeMachine();
    const res = await suggest('?horizonDays=7');
    expect(res.body.horizonEnd).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('machines that are already busy', () => {
  it('queues proposed work behind the job on the loom', async () => {
    const elastic = await makeElastic();
    const machine = await makeMachine();
    const order = await makeOrder(elastic, 500, 20);

    // A job mid-run on that machine with 5,000 m still to weave.
    await JobOrder.create({
      order: order._id,
      customer: customer._id, date: new Date(), status: 'weaving',
      machine: machine._id,
      elastics:        [{ elastic: elastic._id, quantity: 5000 }],
      producedElastic: [{ elastic: elastic._id, quantity: 0 }],
    });

    const res = await suggest('?horizonDays=60');
    expect(res.status).toBe(200);
    const row = res.body.machines[0].rows[0];
    // It cannot start on day zero — the loom is not free.
    expect(row.startWorkingDay).toBeGreaterThan(0);
  });

  it('reports what each loom still owes, and when it comes free', async () => {
    const elastic = await makeElastic();
    const machine = await makeMachine();
    const order = await makeOrder(elastic, 500, 20);
    await JobOrder.create({
      order: order._id,
      customer: customer._id, date: new Date(), status: 'weaving',
      machine: machine._id,
      elastics:        [{ elastic: elastic._id, quantity: 5000 }],
      producedElastic: [{ elastic: elastic._id, quantity: 0 }],
    });

    const res = await suggest('?horizonDays=60');
    expect(res.body.committed).toHaveLength(1);
    expect(res.body.committed[0].committedWorkingDays).toBeGreaterThan(0);
    expect(res.body.committed[0].freeFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('counts only what is left, not the whole job', async () => {
    // A job four-fifths done owes a fifth of the time.
    const elastic = await makeElastic();
    const machine = await makeMachine();
    const order = await makeOrder(elastic, 500, 20);
    await JobOrder.create({
      order: order._id,
      customer: customer._id, date: new Date(), status: 'weaving',
      machine: machine._id,
      elastics:        [{ elastic: elastic._id, quantity: 5000 }],
      producedElastic: [{ elastic: elastic._id, quantity: 4000 }],
    });

    const res = await suggest('?horizonDays=60');
    const partly = res.body.committed[0].committedWorkingDays;

    await JobOrder.updateMany({}, { $set: { 'producedElastic.0.quantity': 0 } });
    const res2 = await suggest('?horizonDays=60');
    const untouched = res2.body.committed[0].committedWorkingDays;

    expect(partly).toBeLessThan(untouched);
  });

  it('treats a finished job as owing nothing', async () => {
    const elastic = await makeElastic();
    const machine = await makeMachine();
    const order = await makeOrder(elastic, 500, 20);
    await JobOrder.create({
      order: order._id,
      customer: customer._id, date: new Date(), status: 'completed',
      machine: machine._id,
      elastics:        [{ elastic: elastic._id, quantity: 5000 }],
      producedElastic: [{ elastic: elastic._id, quantity: 5000 }],
    });

    const res = await suggest('?horizonDays=60');
    expect(res.body.committed).toHaveLength(0);
    expect(res.body.machines[0].rows[0].startWorkingDay).toBe(0);
  });
});

describe('the rate used when a pair has no history', () => {
  it('gives a bigger loom a bigger throughput', async () => {
    // The plant average is metres per MACHINE-day across the whole
    // plant, so handing it back unscaled gave a 12-head loom and a
    // 4-head loom identical throughput — while the posterior branch
    // gave them 2400 and 800. The fallback is reached exactly when a
    // product is new, so the planner was most wrong about its biggest
    // machines when it had least evidence.
    const elastic = await makeElastic();
    const small = await makeMachine(4, 12);
    const big   = await makeMachine(16, 12);
    await makeOrder(elastic, 20_000, 40);

    const res = await suggest('?horizonDays=60');
    expect(res.status).toBe(200);

    // With no history anywhere, both fall to cold start, which is
    // head-scaled — so the work lands on the bigger loom.
    const used = res.body.machines[0];
    expect(String(used.machineId)).toBe(String(big._id));
    expect(used.heads).toBe(16);
    expect(String(small._id)).not.toBe(String(used.machineId));
  });

  it('never reports an absurd run length as a normal cold start', async () => {
    // The missing-rate fallback was `{ mpd: 1 }` — one metre per
    // machine-day, turning a 5,000 m line into 5,000 working days — and
    // it labelled that "coldstart", a real source with a real formula.
    const elastic = await makeElastic();
    await makeMachine(8, 12);
    await makeOrder(elastic, 5000, 40);

    const res = await suggest('?horizonDays=60');
    const row = res.body.machines[0].rows[0];
    expect(row.weavingDays).toBeLessThan(100);
  });
});

describe('accepting a plan', () => {
  const accept = (body) =>
    request(app).post('/api/v2/planner/accept').set('Cookie', cookie()).send(body);

  const proposal = () => ({
    horizonDays: 7,
    generatedAt: new Date().toISOString(),
    objective: { placed: 1 },
    assumptions: ['a'],
    machines: [{
      machineId: new mongoose.Types.ObjectId().toString(), machineID: 'LOOM-1', heads: 4,
      rows: [{ orderNo: 1, elasticName: '20mm', qtyMeters: 100, sequence: 0, weavingDays: 1 }],
    }],
  });

  it('leaves exactly one accepted plan', async () => {
    await accept(proposal());
    await accept(proposal());

    expect(await ProductionPlan.countDocuments({ status: 'accepted' })).toBe(1);
  });

  it('supersedes the previous one', async () => {
    await accept(proposal());
    await accept(proposal());

    expect(await ProductionPlan.countDocuments({ status: 'superseded' })).toBe(1);
  });

  it('is the one /latest returns', async () => {
    await accept(proposal());
    const second = await accept(proposal());

    const res = await request(app).get('/api/v2/planner/latest').set('Cookie', cookie());
    expect(String(res.body.plan._id)).toBe(String(second.body.planId));
  });

  it('still refuses a body with no machines', async () => {
    expect((await accept({ horizonDays: 7 })).status).toBe(400);
  });
});
