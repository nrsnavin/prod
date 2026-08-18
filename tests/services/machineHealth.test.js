'use strict';
// ══════════════════════════════════════════════════════════════════
//  TELLING A SICK LOOM FROM A BUSY ONE
//
//  The output of this report is "go and strip that machine" — an
//  expensive instruction. It is wrong in two directions and they cost
//  differently:
//
//    • a machine flagged that is fine wastes a fitter's day, and after
//      two of those nobody reads the report again
//    • a machine NOT flagged that is failing takes a run down mid-order
//
//  The first is what kills a report like this, so most of these tests
//  are about not crying wolf. The single biggest source of false alarms
//  in a textile plant is product mix: a loom moved onto a slower
//  elastic makes fewer metres and is perfectly healthy. Normalising per
//  (elastic, machine) pair against the posterior is the whole design,
//  and the test for it is the one that matters most here.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, health, I;
let Machine, ShiftDetail, ShiftPlan, EtaRatePosterior, MachineIssue, Elastic, Employee;

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  health           = require('../../services/machineHealth');
  I                = health._internals;
  Machine          = require('../../models/Machine');
  ShiftDetail      = require('../../models/ShiftDetail');
  ShiftPlan        = require('../../models/ShiftPlan');
  EtaRatePosterior = require('../../models/EtaRatePosterior');
  MachineIssue     = require('../../models/MachineIssue');
  Elastic          = require('../../models/Elastic');
  Employee         = require('../../models/Employee');
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) await c.deleteMany({});
});

let seq = 0;

const makeMachine = (over = {}) => Machine.create({
  ID: `LOOM-${String(seq++).padStart(2, '0')}`, manufacturer: 'Comez',
  DateOfPurchase: new Date(), NoOfHead: 4, NoOfHooks: 12, ...over,
});

const makeElastic = () => Elastic.create({
  name: `E-${seq++}`, weaveType: '8', spandexEnds: 40, yarnEnds: 120,
  pick: 12, noOfHook: 8, weight: 2.4,
});

/**
 * Give a (machine, elastic) pair an expected rate.
 *
 * shape/rate is the posterior mean — metres per head per shift — and
 * `observations` has to clear the floor the loader applies, because two
 * observations is not an expectation.
 */
const givePosterior = (machine, elastic, meanPerHead, observations = 50) =>
  EtaRatePosterior.create({
    machine: machine._id, elastic: elastic._id,
    shape: meanPerHead * observations, rate: observations, observations,
  });

/**
 * A run of closed shifts on one machine and elastic.
 *
 * `perHead` may be a number or a function of the index, which is how a
 * decaying machine is written.
 */
let dayCursor = 0;
let fixtureOperator = null;
async function runShifts(machine, elastic, count, perHead) {
  const heads = machine.NoOfHead;
  // ShiftDetail requires an operator. Irrelevant to this report — it
  // asks about the machine — but the document will not save without one.
  fixtureOperator ??= await Employee.create({
    name: 'Fixture Op', phoneNumber: `9100000${String(seq++).padStart(3, '0')}`,
    department: 'production',
  });
  // Batched. One-at-a-time creation of 960 documents takes long enough
  // to trip jest's default timeout, which reads as a failing assertion
  // and sends whoever hits it looking for a bug that is not there.
  const plans = [];
  const details = [];
  for (let i = 0; i < count; i++) {
    const date = new Date(2026, 0, 1);
    date.setDate(date.getDate() + dayCursor++);
    const planId = new mongoose.Types.ObjectId();
    const value = typeof perHead === 'function' ? perHead(i) : perHead;

    plans.push({ _id: planId, date, shift: 'DAY' });
    details.push({
      machine: machine._id, date, shift: 'DAY', status: 'closed',
      shiftPlan: planId, employee: fixtureOperator._id,
      productionMeters: value * heads,
      elastics: Array.from({ length: heads }, (_, h) => ({ head: h + 1, elastic: elastic._id })),
    });
  }
  await ShiftPlan.insertMany(plans);
  await ShiftDetail.insertMany(details);
}

beforeEach(() => { dayCursor = 0; fixtureOperator = null; });

// ══════════════════════════════════════════════════════════════════
//  1. THE FALSE ALARM THIS EXISTS TO AVOID
// ══════════════════════════════════════════════════════════════════
describe('product mix is not a fault', () => {
  test('a machine moved onto a slower elastic is NOT flagged', async () => {
    // The most common thing that happens on a factory floor, and the
    // one that would flag every loom in the plant if the report
    // compared raw metres. Elastic B genuinely takes half the output of
    // elastic A — and the machine is running exactly as expected on
    // both, so there is nothing to report.
    const m = await makeMachine();
    const fast = await makeElastic();
    const slow = await makeElastic();

    await givePosterior(m, fast, 1000);
    await givePosterior(m, slow, 500);

    await runShifts(m, fast, 60, 1000);   // baseline, on the fast product
    await runShifts(m, slow, 20, 500);    // recent, on the slow one

    const out = await health.analyse({});
    const row = out.machines.find((x) => x.machineID === m.ID);

    expect(row.verdict).toBe('ok');
    // Raw metres halved. Normalised, nothing moved.
    expect(Math.abs(row.dropPct)).toBeLessThan(5);
    expect(out.watch).toEqual([]);
  });

  test('a genuinely decaying machine IS flagged, on the same product', async () => {
    // The other side of the same coin: same elastic throughout, output
    // falling. This is the case the report exists for.
    const m = await makeMachine();
    const e = await makeElastic();
    await givePosterior(m, e, 1000);

    await runShifts(m, e, 60, (i) => 1000 + ((i % 5) - 2) * 20);   // steady ~1000
    await runShifts(m, e, 20, (i) => 780 + ((i % 5) - 2) * 20);    // ~22% down

    const out = await health.analyse({});
    const row = out.machines.find((x) => x.machineID === m.ID);

    expect(row.verdict).toBe('watch');
    expect(row.dropPct).toBeGreaterThan(15);
    expect(out.watch[0].machineID).toBe(m.ID);
    expect(row.reasons.join(' ')).toMatch(/below its own .* baseline/);
  });
});

// ══════════════════════════════════════════════════════════════════
//  2. NOT CRYING WOLF
// ══════════════════════════════════════════════════════════════════
describe('what is not worth a fitter\'s morning', () => {
  test('a steady machine is left alone', async () => {
    const m = await makeMachine();
    const e = await makeElastic();
    await givePosterior(m, e, 1000);
    await runShifts(m, e, 80, (i) => 1000 + ((i % 7) - 3) * 15);

    const out = await health.analyse({});
    expect(out.machines.find((x) => x.machineID === m.ID).verdict).toBe('ok');
    expect(out.note).toMatch(/No machine is running materially below/i);
  });

  test('a small but statistically real fall is not reported', async () => {
    // A 4% drop on a very steady machine is significant and is not a
    // maintenance decision. Significance says "not noise"; the material
    // threshold says "worth acting on". Both have to hold, and this is
    // the case that separates them.
    const m = await makeMachine();
    const e = await makeElastic();
    await givePosterior(m, e, 1000);

    await runShifts(m, e, 60, (i) => 1000 + (i % 3) - 1);   // almost no variance
    await runShifts(m, e, 20, (i) => 960 + (i % 3) - 1);    // 4% down, unmistakable

    const out = await health.analyse({});
    const row = out.machines.find((x) => x.machineID === m.ID);

    expect(row.significant).toBe(true);       // the statistics saw it
    expect(row.dropPct).toBeGreaterThan(3);
    expect(row.dropPct).toBeLessThan(I.MATERIAL_DROP_PCT);
    expect(row.verdict).toBe('ok');           // and it is still not worth a call-out
  });

  test('one catastrophic shift does not look like wear', async () => {
    // A snapped beam is one bad shift, not a decaying machine. The
    // report says how much of the recent window is below baseline
    // precisely so the two can be told apart.
    const m = await makeMachine();
    const e = await makeElastic();
    await givePosterior(m, e, 1000);

    await runShifts(m, e, 60, 1000);
    await runShifts(m, e, 19, 1000);
    await runShifts(m, e, 1, 50);        // one disaster

    const out = await health.analyse({});
    const row = out.machines.find((x) => x.machineID === m.ID);

    // The mean moved, but the variance moved with it, so it does not
    // clear significance — and the count makes the shape visible.
    expect(row.shiftsBelowBaseline).toBeLessThanOrEqual(2);
    expect(row.verdict).toBe('ok');
  });

  test('twelve machines of noise produce no findings', async () => {
    // Test twelve machines against a raw threshold and one looks sick
    // by chance. The correction runs across every machine in the run.
    for (let k = 0; k < 12; k++) {
      const m = await makeMachine();
      const e = await makeElastic();
      await givePosterior(m, e, 1000);
      await runShifts(m, e, 80, () => 1000 + (Math.sin(k * 7 + dayCursor) * 90));
    }

    const out = await health.analyse({});
    expect(out.watch).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════
//  3. NOT KNOWING IS A REAL ANSWER
// ══════════════════════════════════════════════════════════════════
describe('machines it cannot judge', () => {
  test('a new machine is "insufficient-data", not "ok"', async () => {
    // Reporting a loom nobody has enough shifts for as healthy is the
    // quiet way this kind of report stops being worth reading.
    const m = await makeMachine();
    const e = await makeElastic();
    await givePosterior(m, e, 1000);
    await runShifts(m, e, 6, 1000);

    const out = await health.analyse({});
    const row = out.machines.find((x) => x.machineID === m.ID);
    expect(row.verdict).toBe('insufficient-data');
    expect(row.shifts).toBe(6);
  });

  test('shifts with no posterior for the pair are skipped, not guessed at', async () => {
    // Without an expectation for the product there is nothing to
    // normalise against, and pooling those shifts under a plant average
    // would reintroduce the exact product-mix error being avoided.
    const m = await makeMachine();
    const known = await makeElastic();
    const unknown = await makeElastic();
    await givePosterior(m, known, 1000);

    await runShifts(m, known, 30, 1000);
    await runShifts(m, unknown, 40, 200);   // no posterior: invisible

    const out = await health.analyse({});
    expect(out.machines.find((x) => x.machineID === m.ID).shifts).toBe(30);
  });

  test('a pair with barely any observations is not an expectation', async () => {
    const m = await makeMachine();
    const e = await makeElastic();
    await givePosterior(m, e, 1000, 2);     // two observations
    await runShifts(m, e, 40, 1000);

    const out = await health.analyse({});
    expect(out.machines.find((x) => x.machineID === m.ID).verdict).toBe('insufficient-data');
  });

  test('a mixed-elastic shift cannot be attributed to one pair', async () => {
    const m = await makeMachine();
    const a = await makeElastic();
    const b = await makeElastic();
    await givePosterior(m, a, 1000);
    await givePosterior(m, b, 1000);

    const date = new Date(2026, 5, 1);
    const plan = await ShiftPlan.create({ date, shift: 'DAY' });
    await ShiftDetail.create({
      machine: m._id, date, shift: 'DAY', status: 'closed', shiftPlan: plan._id,
      employee: (await Employee.create({ name: 'Op', phoneNumber: `9200000${seq++}`, department: 'production' }))._id,
      productionMeters: 4000,
      elastics: [
        { head: 1, elastic: a._id }, { head: 2, elastic: a._id },
        { head: 3, elastic: b._id }, { head: 4, elastic: b._id },
      ],
    });

    const out = await health.analyse({});
    expect(out.machines.find((x) => x.machineID === m.ID).shifts).toBe(0);
  });

  test('an open shift is not an observation', async () => {
    // Only closed shifts carry verified numbers.
    const m = await makeMachine();
    const e = await makeElastic();
    await givePosterior(m, e, 1000);

    const date = new Date(2026, 5, 2);
    const plan = await ShiftPlan.create({ date, shift: 'DAY' });
    await ShiftDetail.create({
      machine: m._id, date, shift: 'DAY', status: 'open', shiftPlan: plan._id,
      employee: (await Employee.create({ name: 'Op', phoneNumber: `9300000${seq++}`, department: 'production' }))._id,
      productionMeters: 100,
      elastics: [{ head: 1, elastic: e._id }],
    });

    const out = await health.analyse({});
    expect(out.machines.find((x) => x.machineID === m.ID).shifts).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════
//  4. WHAT THE REPORT SAYS AROUND THE FINDING
// ══════════════════════════════════════════════════════════════════
describe('the report explains itself', () => {
  test('reported issues corroborate a finding but never create one', async () => {
    // A loom with three reported faults and steady output is being
    // looked after. A loom with none and a falling rate is the one
    // nobody has noticed. Issues change how a finding reads, never
    // whether it is one.
    const noisy = await makeMachine();
    const e1 = await makeElastic();
    await givePosterior(noisy, e1, 1000);
    await runShifts(noisy, e1, 80, 1000);          // perfectly steady
    for (let i = 0; i < 4; i++) {
      await MachineIssue.create({
        machine: noisy._id, title: 'rattle', description: 'noise at head 3',
        severity: 'critical', status: 'open', reporterRole: 'worker',
      });
    }

    const out = await health.analyse({});
    const row = out.machines.find((x) => x.machineID === noisy.ID);
    expect(row.issues.severe).toBe(4);
    expect(row.verdict).toBe('ok');               // output is what decides
  });

  test('a flagged machine already in maintenance says so', async () => {
    const m = await makeMachine({ status: 'maintenance' });
    const e = await makeElastic();
    await givePosterior(m, e, 1000);
    await runShifts(m, e, 60, (i) => 1000 + ((i % 5) - 2) * 20);
    await runShifts(m, e, 20, (i) => 760 + ((i % 5) - 2) * 20);

    const out = await health.analyse({});
    const row = out.machines.find((x) => x.machineID === m.ID);
    expect(row.verdict).toBe('watch');
    // Telling somebody to service a machine that is already stripped is
    // how a report teaches people to ignore it.
    expect(row.reasons.join(' ')).toMatch(/already in maintenance/i);
  });

  test('every threshold is in the response', async () => {
    // A disagreement about this report should be about a number, not
    // about whether the thing works at all.
    const out = await health.analyse({});
    expect(out.thresholds).toMatchObject({
      recentShifts: I.RECENT_SHIFTS,
      baselineShifts: I.BASELINE_SHIFTS,
      materialDropPct: I.MATERIAL_DROP_PCT,
    });
    expect(out.method).toMatch(/posterior/i);
    expect(out.method).toMatch(/false-discovery/i);
  });

  test('the watch list is ordered by how far the machine has fallen', async () => {
    const mild = await makeMachine();
    const bad  = await makeMachine();
    const e1 = await makeElastic();
    const e2 = await makeElastic();
    await givePosterior(mild, e1, 1000);
    await givePosterior(bad, e2, 1000);

    await runShifts(mild, e1, 60, (i) => 1000 + ((i % 5) - 2) * 15);
    await runShifts(mild, e1, 20, (i) => 850 + ((i % 5) - 2) * 15);
    await runShifts(bad, e2, 60, (i) => 1000 + ((i % 5) - 2) * 15);
    await runShifts(bad, e2, 20, (i) => 600 + ((i % 5) - 2) * 15);

    const out = await health.analyse({});
    expect(out.watch.map((w) => w.machineID)).toEqual([bad.ID, mild.ID]);
  });

  test('no machines on file is not an error', async () => {
    const out = await health.analyse({});
    expect(out.machines).toEqual([]);
    expect(out.note).toMatch(/no machines/i);
  });

  test('the drift helper reports percent of expected, and only falls', async () => {
    // The other consumer: GET /machine/predictive-health asks a
    // different question over its own date windows, and must not ask it
    // of raw metres. A machine running ABOVE its baseline reports a
    // drop of zero, not a negative one — the score only ever subtracts.
    const m = await makeMachine();
    const e = await makeElastic();
    await givePosterior(m, e, 1000);
    await runShifts(m, e, 30, 1200);      // comfortably above expectation

    // The fixture lays shifts down from a fixed 1 Jan 2026 while this
    // helper works in windows back from `now`, so `now` is pinned just
    // past the run rather than the fixture being made relative.
    const drift = await health.driftByMachine({
      recentDays: 7, baselineDays: 21, now: new Date(2026, 0, 31),
    });
    const row = drift.get(String(m._id));
    expect(row.dropPct).toBe(0);
    expect(row.recentPctOfExpected).toBeGreaterThan(100);
  });

  test('a machine with nothing in one window reports no drift, not a drop', async () => {
    // No comparison is possible, which is not the same as no fall.
    const m = await makeMachine();
    const drift = await health.driftByMachine({});
    expect(drift.get(String(m._id))).toMatchObject({ dropPct: 0, recentShifts: 0 });
  });
});
