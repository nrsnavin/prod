'use strict';
// ══════════════════════════════════════════════════════════════════
//  DOES THIS ELASTIC FIT ON THIS MACHINE?
//
//  A weaving head has a fixed number of hooks; an elastic's recipe
//  says how many it needs. The rule is a CONFIRMATION rather than a
//  refusal — the floor sometimes runs a product on a smaller machine
//  deliberately — so what matters is that it asks the question in
//  every case where the answer could be no.
//
//  Which makes the interesting cases the ones where it CANNOT answer:
//  a machine with no hook count recorded, an elastic that no longer
//  exists, a recipe with no hook count. All three currently return
//  "fits" and say nothing about how much they actually checked.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongo, Elastic, checkHookFit, hookFitError;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  Elastic = require('../../models/Elastic');
  ({ checkHookFit, hookFitError } = require('../../utils/machineFit'));
}, 120_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => { await Elastic.deleteMany({}); });

let seq = 0;
const elastic = (name, noOfHook) =>
  Elastic.create({
    name: `${name}-${seq++}`, weaveType: '8',
    spandexEnds: 40, yarnEnds: 120, pick: 12,
    noOfHook, weight: 2.4,
  });

const machine = (NoOfHooks, ID = 'M-1') => ({ _id: new mongoose.Types.ObjectId(), ID, NoOfHooks });

// ══════════════════════════════════════════════════════════════════
describe('the ordinary case', () => {
  it('passes an elastic that needs fewer hooks than the head has', async () => {
    const e = await elastic('narrow', 8);
    const fit = await checkHookFit(machine(12), [e._id]);
    expect(fit.fits).toBe(true);
    expect(fit.overs).toEqual([]);
  });

  it('passes one that needs exactly as many', async () => {
    // "less than or equal to" — a 12-hook product on a 12-hook head is
    // the machine being used as designed, not a risk.
    const e = await elastic('exact', 12);
    const fit = await checkHookFit(machine(12), [e._id]);
    expect(fit.fits).toBe(true);
  });

  it('catches one that needs more', async () => {
    const e = await elastic('wide', 24);
    const fit = await checkHookFit(machine(12), [e._id]);
    expect(fit.fits).toBe(false);
    expect(fit.overs[0].excess).toBe(12);
  });

  it('names the worst fit first, because it decides the answer', async () => {
    const a = await elastic('over-by-2', 14);
    const b = await elastic('over-by-20', 32);
    const fit = await checkHookFit(machine(12), [a._id, b._id]);
    expect(fit.overs.map((o) => o.excess)).toEqual([20, 2]);
  });

  it('counts one elastic across eight heads once', async () => {
    // Listing it eight times would bury every other problem.
    const e = await elastic('repeated', 24);
    const fit = await checkHookFit(machine(12), Array(8).fill(e._id));
    expect(fit.overs).toHaveLength(1);
  });

  it('ignores empty head slots rather than tripping on them', async () => {
    const e = await elastic('narrow', 8);
    const fit = await checkHookFit(machine(12), [e._id, null, undefined, '']);
    expect(fit.fits).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════
//  WHERE IT CANNOT ANSWER
//
//  Each of these lets the assignment through, which is the right
//  policy — refusing on missing information would invent a fact. What
//  is wrong is that the caller cannot tell "checked, and it fits" from
//  "could not check anything". Silence reads as approval.
// ══════════════════════════════════════════════════════════════════
describe('when the machine has no hook count recorded', () => {
  it('lets everything through', async () => {
    const e = await elastic('wide', 24);
    const fit = await checkHookFit(machine(0), [e._id]);
    expect(fit.fits).toBe(true);
  });

  it('says nothing to distinguish that from a genuine pass', async () => {
    const e = await elastic('wide', 24);
    const checked = await checkHookFit(machine(99), [e._id]);
    const unknown = await checkHookFit(machine(0), [e._id]);
    // Byte for byte the same answer, from a real check and from no
    // check at all.
    expect(unknown.fits).toBe(checked.fits);
    expect(unknown.summary).toBe(checked.summary);
  });
});

describe('when an elastic cannot be looked up', () => {
  it('lets a deleted one through', async () => {
    const gone = new mongoose.Types.ObjectId();
    const fit = await checkHookFit(machine(12), [gone]);
    expect(fit.fits).toBe(true);
  });

  it('checks the others and never mentions the one it could not', async () => {
    const e = await elastic('wide', 24);
    const gone = new mongoose.Types.ObjectId();
    const fit = await checkHookFit(machine(12), [e._id, gone]);
    expect(fit.overs).toHaveLength(1);      // the one it could read
    expect(fit.fits).toBe(false);
  });
});

describe('a recipe with no hook count', () => {
  it('cannot exist — the schema requires one', async () => {
    // Worth pinning rather than assuming. `Number(undefined) > 12` is
    // false, so an elastic with no hook count would sail through every
    // check silently. It is the schema, not machineFit, that stops
    // that — and if `required` were ever relaxed the hole opens with
    // nothing here to notice.
    await expect(
      Elastic.create({
        name: `unspecified-${seq++}`, weaveType: '8',
        spandexEnds: 40, yarnEnds: 120, pick: 12, weight: 2.4,
      })
    ).rejects.toThrow(/noOfHook/);
  });

  it('but a recorded ZERO does pass, and zero hooks is not a product', async () => {
    // `required` means present, not sensible. 0 > 12 is false.
    const e = await elastic('zero-hooks', 0);
    const fit = await checkHookFit(machine(12), [e._id]);
    expect(fit.fits).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('the refusal a route hands back', () => {
  class FakeError extends Error {
    constructor(message, status) { super(message); this.statusCode = status; }
  }

  it('carries the code a client branches on', async () => {
    const e = await elastic('wide', 24);
    const m = machine(12, 'M-7');
    const fit = await checkHookFit(m, [e._id]);
    const err = hookFitError(m, fit, FakeError);

    expect(err.statusCode).toBe(409);
    expect(err.code).toBe('HOOKS_EXCEED_MACHINE');
  });

  it('names the field that goes ahead anyway, rather than leaving it to the docs', async () => {
    const e = await elastic('wide', 24);
    const m = machine(12);
    const err = hookFitError(m, await checkHookFit(m, [e._id]), FakeError);
    expect(err.details.confirmField).toBe('confirmHooks');
  });

  it('says what does not fit, in the sentence', async () => {
    const e = await elastic('wide', 24);
    const m = machine(12, 'M-7');
    const err = hookFitError(m, await checkHookFit(m, [e._id]), FakeError);

    expect(err.message).toMatch(/M-7/);
    expect(err.message).toMatch(/12 hooks per head/);
    expect(err.message).toMatch(/needs 24/);
  });

  it('reads as one elastic or several, correctly', async () => {
    const m = machine(12);
    const one = await elastic('wide', 24);
    const single = hookFitError(m, await checkHookFit(m, [one._id]), FakeError);
    expect(single.message).toMatch(/this elastic needs/);

    const two = await elastic('wider', 30);
    const plural = hookFitError(m, await checkHookFit(m, [one._id, two._id]), FakeError);
    expect(plural.message).toMatch(/these elastics need/);
  });
});

// ══════════════════════════════════════════════════════════════════
//  HOW MUCH DID IT ACTUALLY CHECK?
//
//  `fits: true` alone made a check that could not run look exactly
//  like one that passed. Both are "go ahead" — but only one of them
//  is a statement about the machine.
// ══════════════════════════════════════════════════════════════════
describe('what the answer says about its own coverage', () => {
  it('reports everything checked on an ordinary pass', async () => {
    const a = await elastic('a', 8);
    const b = await elastic('b', 10);
    const fit = await checkHookFit(machine(12), [a._id, b._id]);
    expect(fit.checked).toBe(2);
    expect(fit.unchecked).toBe(0);
    expect(fit.reason).toBe('');
  });

  it('says WHY it let everything through when the machine has no hooks', async () => {
    const e = await elastic('wide', 24);
    const fit = await checkHookFit(machine(0), [e._id]);
    expect(fit.fits).toBe(true);
    expect(fit.checked).toBe(0);
    expect(fit.reason).toBe('no-machine-hooks');
  });

  it('counts an elastic it could not look up', async () => {
    const e = await elastic('narrow', 8);
    const fit = await checkHookFit(machine(12), [e._id, new mongoose.Types.ObjectId()]);
    expect(fit.checked).toBe(1);
    expect(fit.unchecked).toBe(1);
    expect(fit.reason).toBe('elastics-not-found');
  });

  it('is now distinguishable from a genuine pass, which was the whole problem', async () => {
    const e = await elastic('wide', 24);
    const checked = await checkHookFit(machine(99), [e._id]);
    const unknown = await checkHookFit(machine(0), [e._id]);

    expect(checked.fits).toBe(unknown.fits);        // both say go ahead
    expect(checked.reason).not.toBe(unknown.reason); // but not for the same reason
  });
});
