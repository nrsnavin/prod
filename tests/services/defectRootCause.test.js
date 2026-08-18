'use strict';
// ══════════════════════════════════════════════════════════════════
//  A REPORT THAT NAMES SOMEBODY
//
//  This service's output is an accusation. It says a yarn lot is bad, a
//  machine is drifting, a shift is producing more scrap — and one of the
//  four factors it tests is a person. That changes what "correct" means
//  here: the expensive failure is not a crash, it is confidently naming
//  something innocent, which costs a supplier relationship or somebody's
//  standing with their supervisor.
//
//  So the tests below are mostly about the ways a statistically naive
//  version of this would lie:
//
//    • test forty lots at p<0.05 and two look guilty by chance
//    • one check that failed is a 100% defect rate
//    • a bad lot and a weak operator ride on the same jobs, so both
//      light up and one of them did nothing
//    • a planned batch drew no yarn and cannot have caused anything
//
//  Every one of those has a test, and the arithmetic is checked against
//  hand-computed values rather than against itself.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, rootCause, I;
let QcRecord, WarpingBatch, ShiftDetail, ShiftPlan, Machine, Employee, Elastic, Customer, Order, JobOrder;

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  rootCause    = require('../../services/defectRootCause');
  I            = rootCause._internals;
  QcRecord     = require('../../models/QcRecord');
  WarpingBatch = require('../../models/WarpingBatch');
  ShiftDetail  = require('../../models/ShiftDetail');
  ShiftPlan    = require('../../models/ShiftPlan');
  Machine      = require('../../models/Machine');
  Employee     = require('../../models/Employee');
  Elastic      = require('../../models/Elastic');
  Customer     = require('../../models/Customer');
  Order        = require('../../models/Order');
  JobOrder     = require('../../models/JobOrder');
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) await c.deleteMany({});
});

// ══════════════════════════════════════════════════════════════════
//  1. THE STATISTICS, AGAINST HAND-COMPUTED VALUES
// ══════════════════════════════════════════════════════════════════
describe('chi-square with Yates', () => {
  test('matches a worked example', () => {
    // 2x2: [10, 90 | 20, 880]. n=1000.
    //   |ad − bc| = |10×880 − 90×20| = 7000
    //   Yates: 7000 − 500 = 6500
    //   chi2 = 1000 × 6500² / (100 × 900 × 30 × 970) = 42250000000/2619000000
    const { chi2 } = I.chiSquare2x2(10, 90, 20, 880);
    expect(chi2).toBeCloseTo((1000 * 6500 * 6500) / (100 * 900 * 30 * 970), 6);
  });

  test('Yates pulls a weak association back to zero rather than reporting it', () => {
    // The correction is not ceremony. These tables routinely carry cells
    // in single figures, where the uncorrected statistic is optimistic
    // and hands out significance the data does not support.
    const { chi2, p } = I.chiSquare2x2(2, 3, 3, 2);
    expect(chi2).toBe(0);
    // erfc(0) is 1 to within its approximation error, which is ~3e-8 —
    // several orders more precision than a decision about a yarn lot.
    expect(p).toBeCloseTo(1, 6);
  });

  test('an empty margin is not significant', () => {
    // Nothing failed anywhere: there is no association to find.
    expect(I.chiSquare2x2(0, 10, 0, 90)).toEqual({ chi2: 0, p: 1 });
  });

  test('the p-value tracks the statistic', () => {
    const strong = I.chiSquare2x2(30, 10, 10, 100);
    const weak   = I.chiSquare2x2(12, 28, 20, 90);
    expect(strong.p).toBeLessThan(weak.p);
    expect(strong.p).toBeLessThan(0.01);
  });

  test('erfc is accurate enough to trust the p-values', () => {
    expect(I.erfc(0)).toBeCloseTo(1, 6);
    expect(I.erfc(1)).toBeCloseTo(0.157299, 5);
    expect(I.erfc(2)).toBeCloseTo(0.004678, 5);
  });
});

describe('Benjamini-Hochberg', () => {
  test('a lone strong result survives', () => {
    expect(I.benjaminiHochberg([0.001, 0.9, 0.8, 0.7], 0.1)).toEqual([true, false, false, false]);
  });

  test('forty mediocre p-values yield nothing, which is the whole point', () => {
    // Test forty lots against a raw 5% threshold and two look guilty by
    // chance alone — then get named, and believed, because the report
    // came with a number. Uniform noise must produce no findings.
    const noise = Array.from({ length: 40 }, (_, i) => (i + 1) / 41);
    expect(I.benjaminiHochberg(noise, 0.1).some(Boolean)).toBe(false);
  });

  test('a raw p under 0.05 is NOT automatically a finding', () => {
    // One candidate at 0.04 among forty is exactly what noise looks
    // like. This is the assertion that separates this service from the
    // naive version of it.
    const many = [0.04, ...Array.from({ length: 39 }, (_, i) => 0.2 + i * 0.02)];
    expect(I.benjaminiHochberg(many, 0.1)[0]).toBe(false);
  });

  test('it is less brutal than Bonferroni, so real findings still surface', () => {
    // Bonferroni over 20 candidates needs p < 0.005. BH lets a genuine
    // 0.004 through alongside a second real one — a report that never
    // names anything gets switched off, which helps nobody.
    const ps = [0.001, 0.004, ...Array.from({ length: 18 }, () => 0.6)];
    const pass = I.benjaminiHochberg(ps, 0.1);
    expect(pass[0]).toBe(true);
    expect(pass[1]).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════
//  2. THE TABULATION
// ══════════════════════════════════════════════════════════════════
describe('tabulate', () => {
  const check = (id, failed, lots) => ({
    id, failed, lots: lots.map((l) => ({ key: l, label: l })),
    machines: [], operators: [], shifts: [],
  });

  test('lift is the ratio to everyone else, not the difference', () => {
    // Two points of difference means something very different at a 1%
    // base rate than at a 30% one, and the reader is comparing across
    // factors where the base rates differ.
    const checks = [
      ...Array.from({ length: 10 }, (_, i) => check(`a${i}`, i < 5, ['BAD'])),   // 50%
      ...Array.from({ length: 20 }, (_, i) => check(`b${i}`, i < 2, ['OK'])),    // 10%
    ];
    const rows = I.tabulate(checks, I.FACTORS[0]);
    const bad = rows.find((r) => r.label === 'BAD');
    expect(bad).toMatchObject({ checks: 10, fails: 5, failRatePct: 50, restFailRatePct: 10, lift: 5 });
  });

  test('lift is null, not Infinity, when nothing else ever failed', () => {
    // "Infinitely worse than a perfect record" is not a usable number
    // and would sort to the top of every report for ever.
    const checks = [
      ...Array.from({ length: 5 }, (_, i) => check(`a${i}`, true, ['BAD'])),
      ...Array.from({ length: 5 }, (_, i) => check(`b${i}`, false, ['OK'])),
    ];
    expect(I.tabulate(checks, I.FACTORS[0]).find((r) => r.label === 'BAD').lift).toBeNull();
  });

  test('a check touching two lots counts against both', () => {
    // One check maps to several values of each factor, because a job
    // draws from several lots. Pretending each check had exactly one
    // cause would be tidier and wrong — and it is what creates the
    // confounding this service has to report.
    const rows = I.tabulate([check('x', true, ['L1', 'L2'])], I.FACTORS[0]);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.fails === 1)).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════
//  3. THE FULL PICTURE, OVER REAL DOCUMENTS
// ══════════════════════════════════════════════════════════════════

let seq = 0;
async function fixture() {
  const customer = await Customer.create({ name: `C${seq++}`, contactName: 'r', phoneNumber: `900000${seq}` });
  const elastic  = await Elastic.create({
    name: `E-${seq++}`, weaveType: '8', spandexEnds: 40, yarnEnds: 120,
    pick: 12, noOfHook: 8, weight: 2.4,
  });
  const order = await Order.create({
    customer: customer._id, po: `PO-${seq++}`, date: new Date(), supplyDate: new Date(),
    status: 'Approved', elasticOrdered: [{ elastic: elastic._id, quantity: 100, rate: 10 }],
  });
  return { customer, elastic, order };
}

const makeJob = (order, customer) =>
  JobOrder.create({ order: order._id, customer: customer._id, date: new Date(), status: 'weaving' });

/**
 * A job with a QC outcome, a lot behind it and a machine/operator on it.
 * Everything the attribution joins, written the way the app writes it.
 */
async function jobWithCheck({ ctx, failed, lotId, lotNo, machine, employee, shift = 'DAY', batchStatus = 'issued' }) {
  const job = await makeJob(ctx.order, ctx.customer);

  if (lotId) {
    await WarpingBatch.create({
      job: job._id, elastics: [ctx.elastic._id], status: batchStatus,
      batchNo: `WB-${seq++}`,
      warping: new mongoose.Types.ObjectId(),
      allocations: [{
        yarnLot: lotId, lotNo, quantity: 10,
        rawMaterial: new mongoose.Types.ObjectId(),
      }],
    });
  }
  if (machine) {
    // ShiftDetail requires its plan. (date, shift) is unique on
    // ShiftPlan, so each fixture shift gets its own day.
    const date = new Date(2026, 0, 1); date.setDate(date.getDate() + seq++);
    const plan = await ShiftPlan.create({ date, shift });
    await ShiftDetail.create({
      job: job._id, machine: machine._id, employee: employee?._id,
      shift, date, status: 'closed', shiftPlan: plan._id,
    });
  }
  await QcRecord.create({
    job: job._id, elastic: ctx.elastic._id,
    results: [{ parameter: 'Width (mm)', expected: '20', measured: failed ? '17' : '20', pass: !failed }],
    overallResult: failed ? 'fail' : 'pass',
    defectCode: failed ? 'weave-fault' : '',
    rejectedMeters: failed ? 40 : 0,
  });
  return job;
}

describe('the attribution end to end', () => {
  test('a genuinely bad lot is named, with the numbers behind it', async () => {
    const ctx = await fixture();
    const bad  = new mongoose.Types.ObjectId();
    const good = new mongoose.Types.ObjectId();

    // 12 checks on the bad lot, 9 failed. 30 on the good lot, 2 failed.
    for (let i = 0; i < 12; i++) {
      await jobWithCheck({ ctx, failed: i < 9, lotId: bad, lotNo: 'D-4471' });
    }
    for (let i = 0; i < 30; i++) {
      await jobWithCheck({ ctx, failed: i < 2, lotId: good, lotNo: 'D-5000' });
    }

    const out = await rootCause.analyse({ days: 30 });

    expect(out.totals).toMatchObject({ checks: 42, fails: 11 });
    const finding = out.findings.find((f) => f.label === 'D-4471');
    expect(finding).toBeDefined();
    expect(finding).toMatchObject({ factor: 'lot', checks: 12, fails: 9, failRatePct: 75 });
    expect(finding.lift).toBeGreaterThan(5);
    expect(finding.headline).toMatch(/yarn lot D-4471 failed 9 of 12 checks/);
  });

  test('a lot with three checks is never a finding, however bad it looks', async () => {
    // One check that failed is a 100% defect rate. Three of three is
    // still three. A caveat beside the number does not survive being
    // read out in a meeting; keeping it out of the findings does.
    const ctx = await fixture();
    const tiny = new mongoose.Types.ObjectId();
    const bulk = new mongoose.Types.ObjectId();

    for (let i = 0; i < 3; i++)  await jobWithCheck({ ctx, failed: true, lotId: tiny, lotNo: 'D-TINY' });
    for (let i = 0; i < 40; i++) await jobWithCheck({ ctx, failed: i < 2, lotId: bulk, lotNo: 'D-BULK' });

    const out = await rootCause.analyse({ days: 30 });

    expect(out.findings.find((f) => f.label === 'D-TINY')).toBeUndefined();
    // It is still visible in the raw table — hidden from the findings,
    // not hidden from somebody looking.
    expect(out.factors.lot.find((r) => r.label === 'D-TINY')).toMatchObject({ checks: 3, fails: 3 });
  });

  test('a quiet month reports as quiet rather than inventing a culprit', async () => {
    const ctx = await fixture();
    const lot = new mongoose.Types.ObjectId();
    for (let i = 0; i < 20; i++) await jobWithCheck({ ctx, failed: false, lotId: lot, lotNo: 'D-1' });

    const out = await rootCause.analyse({ days: 30 });
    expect(out.totals.fails).toBe(0);
    expect(out.findings).toEqual([]);
    expect(out.note).toMatch(/no failures/i);
  });

  test('scattered failures with no pattern produce no finding', async () => {
    // The most important negative case. Four lots, all failing at
    // roughly the same rate — a report that names one of them anyway is
    // worse than no report.
    const ctx = await fixture();
    const lots = [1, 2, 3, 4].map(() => new mongoose.Types.ObjectId());
    for (const [n, lot] of lots.entries()) {
      for (let i = 0; i < 12; i++) {
        await jobWithCheck({ ctx, failed: i < 3, lotId: lot, lotNo: `D-${n}` });
      }
    }

    const out = await rootCause.analyse({ days: 30 });
    expect(out.totals.fails).toBe(12);
    expect(out.findings).toEqual([]);
    expect(out.note).toMatch(/nothing stands out beyond chance/i);
  });

  test('a planned batch drew no yarn and cannot have caused anything', async () => {
    // Planned means lots were chosen and nothing was drawn; cancelled
    // means it was given back. Neither put fibre into the cloth.
    const ctx = await fixture();
    const planned = new mongoose.Types.ObjectId();
    const issued  = new mongoose.Types.ObjectId();

    for (let i = 0; i < 10; i++) {
      await jobWithCheck({ ctx, failed: true, lotId: planned, lotNo: 'D-PLAN', batchStatus: 'planned' });
    }
    for (let i = 0; i < 10; i++) {
      await jobWithCheck({ ctx, failed: false, lotId: issued, lotNo: 'D-ISSUED' });
    }

    const out = await rootCause.analyse({ days: 30 });
    expect(out.factors.lot.find((r) => r.label === 'D-PLAN')).toBeUndefined();
    expect(out.factors.lot.find((r) => r.label === 'D-ISSUED')).toBeDefined();
  });

  test('machine, operator and shift are attributed too', async () => {
    const ctx = await fixture();
    const m1 = await Machine.create({ ID: 'LOOM-07', manufacturer: 'Comez', DateOfPurchase: new Date(), NoOfHead: 4, NoOfHooks: 12 });
    const m2 = await Machine.create({ ID: 'LOOM-08', manufacturer: 'Comez', DateOfPurchase: new Date(), NoOfHead: 4, NoOfHooks: 12 });
    const e1 = await Employee.create({ name: 'Ravi',  phoneNumber: '9000000011', department: 'production' });
    const e2 = await Employee.create({ name: 'Suresh', phoneNumber: '9000000012', department: 'production' });

    for (let i = 0; i < 14; i++) {
      await jobWithCheck({ ctx, failed: i < 10, machine: m1, employee: e1, shift: 'NIGHT' });
    }
    for (let i = 0; i < 30; i++) {
      await jobWithCheck({ ctx, failed: i < 2, machine: m2, employee: e2, shift: 'DAY' });
    }

    const out = await rootCause.analyse({ days: 30 });
    expect(out.factors.machine.find((r) => r.label === 'LOOM-07').failRatePct).toBeCloseTo(71.4, 0);
    expect(out.factors.operator.map((r) => r.label)).toEqual(expect.arrayContaining(['Ravi', 'Suresh']));
    expect(out.factors.shift.map((r) => r.label)).toEqual(expect.arrayContaining(['DAY', 'NIGHT']));
  });
});

// ══════════════════════════════════════════════════════════════════
//  4. THE CONFOUNDING — the finding this service must not make alone
// ══════════════════════════════════════════════════════════════════
describe('confounded findings', () => {
  test('a bad lot and the operator who ran it are reported as inseparable', async () => {
    // The report's own warning, and the reason a naive version of this
    // costs somebody their reputation: the same jobs carried both, so
    // both light up identically and the data contains nothing that can
    // tell them apart. Saying which one is at fault would be invention.
    const ctx = await fixture();
    const machine = await Machine.create({ ID: 'LOOM-01', manufacturer: 'Comez', DateOfPurchase: new Date(), NoOfHead: 4, NoOfHooks: 12 });
    const ravi    = await Employee.create({ name: 'Ravi', phoneNumber: '9000000021', department: 'production' });
    const suresh  = await Employee.create({ name: 'Suresh', phoneNumber: '9000000022', department: 'production' });
    const badLot  = new mongoose.Types.ObjectId();
    const okLot   = new mongoose.Types.ObjectId();

    // Ravi ran every job that used the bad lot, and nothing else.
    for (let i = 0; i < 14; i++) {
      await jobWithCheck({ ctx, failed: i < 11, lotId: badLot, lotNo: 'D-4471', machine, employee: ravi });
    }
    for (let i = 0; i < 30; i++) {
      await jobWithCheck({ ctx, failed: i < 2, lotId: okLot, lotNo: 'D-5000', machine, employee: suresh });
    }

    const out = await rootCause.analyse({ days: 30 });

    const lotFinding = out.findings.find((f) => f.factor === 'lot' && f.label === 'D-4471');
    const opFinding  = out.findings.find((f) => f.factor === 'operator' && f.label === 'Ravi');
    expect(lotFinding).toBeDefined();
    expect(opFinding).toBeDefined();

    const pair = out.confounders.find(
      (c) => [c.a.label, c.b.label].includes('D-4471') && [c.a.label, c.b.label].includes('Ravi')
    );
    expect(pair).toBeDefined();
    expect(pair.overlapPct).toBe(100);
    expect(pair.note).toMatch(/cannot tell which of the two is responsible/i);
  });

  test('two findings on the same factor are not confounded with each other', async () => {
    // Two bad lots are two bad lots. Only a pair from DIFFERENT factors
    // can be the same cause wearing two labels.
    const findings = [
      { factor: 'lot', noun: 'yarn lot', label: 'A', _checkIds: new Set(['1', '2', '3']) },
      { factor: 'lot', noun: 'yarn lot', label: 'B', _checkIds: new Set(['1', '2', '3']) },
    ];
    expect(I.findConfounders(findings)).toEqual([]);
  });

  test('findings that barely overlap are not paired', () => {
    const findings = [
      { factor: 'lot',      noun: 'yarn lot', label: 'A', _checkIds: new Set(['1', '2', '3', '4', '5']) },
      { factor: 'operator', noun: 'operator', label: 'R', _checkIds: new Set(['5', '6', '7', '8', '9']) },
    ];
    expect(I.findConfounders(findings)).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════
//  5. THE METHOD IS REPORTED, BECAUSE THE OUTPUT IS AN ACCUSATION
// ══════════════════════════════════════════════════════════════════
describe('the report explains itself', () => {
  test('it states the test, the correction and the minimum sample', async () => {
    // Somebody is going to be asked "how do you know?" — by a supplier
    // whose lot has been rejected, or by an operator. The answer has to
    // be on the page.
    const ctx = await fixture();
    const lot = new mongoose.Types.ObjectId();
    for (let i = 0; i < 20; i++) await jobWithCheck({ ctx, failed: i < 4, lotId: lot, lotNo: 'D-1' });

    const out = await rootCause.analyse({ days: 30 });
    expect(out.method.test).toMatch(/chi-square/i);
    expect(out.method.correction).toMatch(/Benjamini/i);
    expect(out.method.minSamples).toBe(I.MIN_SAMPLES);
  });

  test('no data reads as no data', async () => {
    const out = await rootCause.analyse({ days: 30 });
    expect(out.totals).toMatchObject({ checks: 0, fails: 0, failRatePct: null });
    expect(out.note).toMatch(/no qc checks/i);
  });

  test('the narrative is additive — with no model configured the numbers still come back', async () => {
    // Claude writes the sentence and computes nothing. If the key is
    // absent the attribution is returned exactly as it would have been.
    const ctx = await fixture();
    const bad = new mongoose.Types.ObjectId();
    for (let i = 0; i < 12; i++) await jobWithCheck({ ctx, failed: i < 9, lotId: bad, lotNo: 'D-4471' });
    for (let i = 0; i < 30; i++) await jobWithCheck({ ctx, failed: i < 2, lotId: new mongoose.Types.ObjectId(), lotNo: 'D-OK' });

    const withText = await rootCause.analyseWithNarrative({ days: 30 });
    const without  = await rootCause.analyse({ days: 30 });

    expect(withText.findings.map((f) => f.label)).toEqual(without.findings.map((f) => f.label));
    expect(withText.aiGenerated).toBe(false);
    expect(withText.narrative).toBeNull();
  });
});
