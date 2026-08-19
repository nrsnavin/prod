'use strict';
// ══════════════════════════════════════════════════════════════════
//  AN OBJECTIVE THAT MOVES ON ITS OWN
//
//  This changes what the planner proposes to the whole plant, without
//  anybody asking it to. That makes the tests here less about "does the
//  arithmetic work" and more about "can it be made to do something
//  stupid", because the failure mode is not a wrong number on a screen —
//  it is a schedule that quietly stops making sense and nobody knowing
//  why.
//
//  Four properties carry the safety, and each has tests that fail if it
//  is removed:
//
//    1. THE SIGN. Getting it backwards is the single most damaging bug
//       available here: the planner would learn the opposite of what the
//       admin wants and get more wrong every week, confidently.
//    2. THE ANCHOR. The scale is unidentifiable — doubling all three
//       weights picks the same plan — so without pinning lateness the
//       vector drifts forever while changing no decision, and the
//       numbers on the screen become meaningless.
//    3. THE CLAMPS. One person dragging every line onto one loom must
//       not be able to delete a term from the objective.
//    4. THE WARM-UP. Two corrections are a coincidence. Acting on a
//       coincidence would reshape every plan in the plant.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, learn, PlannerWeights, DEFAULTS, BOUNDS;

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  learn          = require('../../services/plannerLearning');
  PlannerWeights = require('../../models/PlannerWeights');
  DEFAULTS       = PlannerWeights.DEFAULT_WEIGHTS;
  BOUNDS         = PlannerWeights.BOUNDS;
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => { await PlannerWeights.deleteMany({}); });

/** One correction. `lines` scales the step, as in production. */
const observe = (proposed, accepted, lines = 10) =>
  learn.observe({ proposed, accepted, lines, actor: 'tester' });

const terms = (totalLate, changeovers, imbalance) => ({ totalLate, changeovers, imbalance });

// ══════════════════════════════════════════════════════════════════
//  1. The sign
// ══════════════════════════════════════════════════════════════════
describe('the direction of the update', () => {
  test('accepting MORE changeovers makes changeovers cheaper', async () => {
    // The admin took a plan with three extra changeovers. They care less
    // about them than the objective claimed, so the cost must come down.
    // Backwards, the planner would fight the admin harder every week.
    const r = await observe(terms(0, 2, 0), terms(0, 5, 0));
    expect(r.updated).toBe(true);
    expect(r.after.changeover).toBeLessThan(r.before.changeover);
  });

  test('accepting FEWER changeovers makes changeovers dearer', async () => {
    const r = await observe(terms(0, 5, 0), terms(0, 2, 0));
    expect(r.after.changeover).toBeGreaterThan(r.before.changeover);
  });

  test('trading a late day away to cut changeovers raises the changeover cost', async () => {
    // The realistic case: the admin swallowed a late day to batch a
    // colour. That says changeovers are worth more than one tenth of a
    // late day, which is what the defaults assert.
    const r = await observe(terms(1, 6, 0), terms(2, 2, 0));
    expect(r.after.changeover).toBeGreaterThan(r.before.changeover);
  });

  test('the same logic applies to load balance', async () => {
    const dearer = await observe(terms(0, 0, 4), terms(0, 0, 1));
    expect(dearer.after.balance).toBeGreaterThan(dearer.before.balance);
  });
});

// ══════════════════════════════════════════════════════════════════
//  2. The anchor
// ══════════════════════════════════════════════════════════════════
describe('the lateness anchor', () => {
  test('lateness never moves, however many corrections land', async () => {
    for (let i = 0; i < 12; i++) await observe(terms(0, 2, 0), terms(0, 5, 1));
    const doc = await PlannerWeights.findOne({ key: 'default' });
    expect(doc.late).toBe(DEFAULTS.late);
  });

  test('an update that only changes lateness still renormalises to a real ratio', async () => {
    // Without the anchor this is where the whole vector would shrink
    // toward zero while selecting exactly the same plans.
    const r = await observe(terms(5, 3, 1), terms(2, 3, 1));
    expect(r.after.late).toBe(DEFAULTS.late);
    // Accepting fewer late days says lateness matters MORE, which after
    // anchoring shows up as the other terms getting relatively cheaper.
    expect(r.after.changeover).toBeLessThan(r.before.changeover);
  });
});

// ══════════════════════════════════════════════════════════════════
//  3. The clamps
// ══════════════════════════════════════════════════════════════════
describe('bounds', () => {
  test('a run of extreme corrections cannot drive a term to zero', async () => {
    // Somebody dragging every line onto one loom, twenty times over. The
    // term has to survive: a weight of zero silently deletes it from the
    // objective and nothing on any screen would say so.
    for (let i = 0; i < 20; i++) await observe(terms(0, 0, 0), terms(0, 40, 40));
    const doc = await PlannerWeights.findOne({ key: 'default' });
    expect(doc.changeover).toBeGreaterThanOrEqual(BOUNDS.changeover.min);
    expect(doc.balance).toBeGreaterThanOrEqual(BOUNDS.balance.min);
  });

  test('nor above the ceiling', async () => {
    for (let i = 0; i < 20; i++) await observe(terms(0, 40, 40), terms(0, 0, 0));
    const doc = await PlannerWeights.findOne({ key: 'default' });
    expect(doc.changeover).toBeLessThanOrEqual(BOUNDS.changeover.max);
    expect(doc.balance).toBeLessThanOrEqual(BOUNDS.balance.max);
  });
});

// ══════════════════════════════════════════════════════════════════
//  4. The warm-up
// ══════════════════════════════════════════════════════════════════
describe('warm-up before the learned weights are used', () => {
  test('the defaults are served until enough corrections have landed', async () => {
    for (let i = 0; i < learn.MIN_OBSERVATIONS - 1; i++) {
      await observe(terms(0, 2, 0), terms(0, 5, 0));
    }
    const w = await learn.currentWeights();
    expect(w.learned).toBe(false);
    expect(w.changeover).toBe(DEFAULTS.changeover);
    expect(w.observations).toBe(learn.MIN_OBSERVATIONS - 1);
  });

  test('and the learned ones only after', async () => {
    for (let i = 0; i < learn.MIN_OBSERVATIONS; i++) {
      await observe(terms(0, 2, 0), terms(0, 5, 0));
    }
    const w = await learn.currentWeights();
    expect(w.learned).toBe(true);
    expect(w.changeover).not.toBe(DEFAULTS.changeover);
  });

  test('weights are still being learned while below the threshold', async () => {
    // Stored but not used. Otherwise the first five corrections would be
    // thrown away and the warm-up would delay learning rather than
    // delaying its EFFECT.
    await observe(terms(0, 2, 0), terms(0, 5, 0));
    const doc = await PlannerWeights.findOne({ key: 'default' });
    expect(doc.changeover).not.toBe(DEFAULTS.changeover);
    expect(doc.observations).toBe(1);
  });

  test('with no document at all the defaults are served, not a crash', async () => {
    const w = await learn.currentWeights();
    expect(w.learned).toBe(false);
    expect(w.late).toBe(DEFAULTS.late);
  });
});

// ══════════════════════════════════════════════════════════════════
//  Rubber stamps teach nothing
// ══════════════════════════════════════════════════════════════════
describe('accepting unchanged', () => {
  test('an identical plan is not an observation', async () => {
    const r = await observe(terms(3, 4, 2), terms(3, 4, 2));
    expect(r.updated).toBe(false);
    expect(r.reason).toBe('unchanged');
  });

  test('a hundred rubber stamps do not satisfy the warm-up', async () => {
    // The trap this guards: if accepting unchanged counted, a plant that
    // never edits anything would cross the threshold and start running
    // on "learned" weights identical to the defaults but labelled as
    // learned — a claim of evidence that does not exist.
    for (let i = 0; i < 100; i++) await observe(terms(1, 1, 1), terms(1, 1, 1));
    const w = await learn.currentWeights();
    expect(w.observations).toBe(0);
    expect(w.learned).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════
//  Plan size must not decide how much is learned
// ══════════════════════════════════════════════════════════════════
describe('normalisation by plan size', () => {
  test('the same proportional correction moves the weights the same way', async () => {
    // A busy week and a quiet one that disagree in the same proportion
    // should teach the same lesson. Without dividing by lines, the busy
    // week would shout.
    const small = await observe(terms(0, 1, 0), terms(0, 3, 0), 10);
    await PlannerWeights.deleteMany({});
    const large = await observe(terms(0, 10, 0), terms(0, 30, 0), 100);
    expect(large.after.changeover).toBeCloseTo(small.after.changeover, 6);
  });

  test('a bigger disagreement at the same size moves further', async () => {
    const mild = await observe(terms(0, 2, 0), terms(0, 3, 0), 10);
    await PlannerWeights.deleteMany({});
    const sharp = await observe(terms(0, 2, 0), terms(0, 8, 0), 10);
    expect(sharp.after.changeover).toBeLessThan(mild.after.changeover);
  });
});

// ══════════════════════════════════════════════════════════════════
//  Inspectable and reversible
// ══════════════════════════════════════════════════════════════════
describe('being able to see and undo what it learned', () => {
  test('every update is recorded with both plans and a readable note', async () => {
    await observe(terms(0, 2, 0), terms(0, 5, 0));
    const doc = await PlannerWeights.findOne({ key: 'default' });
    expect(doc.history).toHaveLength(1);
    const h = doc.history[0];
    expect(h.proposed.changeover).toBe(2);
    expect(h.accepted.changeover).toBe(5);
    expect(h.actor).toBe('tester');
    expect(h.note).toMatch(/changeover cost down/i);
  });

  test('history is bounded', async () => {
    for (let i = 0; i < learn.HISTORY_LIMIT + 10; i++) {
      await observe(terms(0, 2, 0), terms(0, 3 + (i % 3), 0));
    }
    const doc = await PlannerWeights.findOne({ key: 'default' });
    expect(doc.history.length).toBeLessThanOrEqual(learn.HISTORY_LIMIT);
  });

  test('reset returns the constants and clears the evidence', async () => {
    for (let i = 0; i < 8; i++) await observe(terms(0, 2, 0), terms(0, 6, 0));
    expect((await learn.currentWeights()).learned).toBe(true);

    await learn.reset('somebody');

    const w = await learn.currentWeights();
    expect(w.learned).toBe(false);
    expect(w.changeover).toBe(DEFAULTS.changeover);
    const doc = await PlannerWeights.findOne({ key: 'default' });
    expect(doc.observations).toBe(0);
    expect(doc.history).toHaveLength(0);
    expect(doc.lastResetBy).toBe('somebody');
  });

  test('the report distinguishes what is stored from what is in use', async () => {
    await observe(terms(0, 2, 0), terms(0, 5, 0));
    const r = await learn.report();
    // Below the threshold: stored has moved, active has not.
    expect(r.stored.changeover).not.toBe(DEFAULTS.changeover);
    expect(r.active.changeover).toBe(DEFAULTS.changeover);
    expect(r.learned).toBe(false);
    expect(r.needed).toBe(learn.MIN_OBSERVATIONS);
  });
});
