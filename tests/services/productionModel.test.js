'use strict';
// ══════════════════════════════════════════════════════════════════
//  PREDICTING A LOOM'S METRES
//
//  The model is: metres per head = rate(machine) × minutes ÷ pick, with
//  each machine's rate learned from its own past shifts and pulled
//  toward the plant's when it has few. These tests pin each part of
//  that sentence, the things that are left out and why, and the honest
//  scoring against simpler guesses.
// ══════════════════════════════════════════════════════════════════

const pm = require('../../services/productionModel');
const { buildRows, fit, evaluate } = pm._internals;

const DAY = 86_400_000;
const NOW = new Date('2026-10-01T00:00:00Z');

// A small deterministic random source, so the simulated plant is the
// same on every run.
function rng(seed) {
  let s = seed;
  const u = () => (s = (s * 16807) % 2147483647) / 2147483647;
  return { u, gauss: () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u()) };
}

/** Rows as buildRows makes them, for a machine of a known speed. */
function shifts(machine, speed, n, { from = 200, noise = 0.06, seed = 1, picks = [10, 12, 14, 16, 20] } = {}) {
  const r = rng(seed);
  return Array.from({ length: n }, (_, i) => {
    const pick = picks[Math.floor(r.u() * picks.length)];
    const minutes = 300 + r.u() * 400;
    const perHead = (speed * minutes) / pick * Math.exp(noise * r.gauss());
    return { shift: `${machine}-${i}`, machine, date: new Date(NOW - (from - (i * from) / n) * DAY), minutes, pick, perHead, lr: Math.log((perHead * pick) / minutes) };
  });
}

describe('reading the inputs', () => {
  it('reads a run time with or without seconds', () => {
    expect(pm.runMinutes('7:45')).toBe(465);
    expect(pm.runMinutes('07:45:30')).toBe(465.5);
    expect(pm.runMinutes('00:00:00')).toBe(0);
    expect(pm.runMinutes('7.45')).toBe(0);
    expect(pm.runMinutes(null)).toBe(0);
  });

  it('takes one pick for mixed heads that gives the same total length', () => {
    // A head at 10 and a head at 20 make as much as two at 13.33, not 15.
    expect(pm.effectivePick([10, 20])).toBeCloseTo(13.333, 3);
    expect(pm.effectivePick([14, 14, 14])).toBe(14);
    expect(pm.effectivePick([14, 0])).toBeNull();
    expect(pm.effectivePick([14, undefined])).toBeNull();
    expect(pm.effectivePick([])).toBeNull();
  });
});

describe('which shifts are learned from', () => {
  const heads = new Map([['m1', 4]]);
  const picks = new Map([['e14', 14], ['e10', 10], ['eNone', 0]]);
  const shift = (over) => ({ _id: Math.random(), date: NOW, timer: '8:00:00', productionMeters: 4 * 480, machine: 'm1', elastics: [{ elastic: 'e14' }], ...over });

  it('uses metres per head: the stored figure is per head times heads', () => {
    const { rows } = buildRows(Array.from({ length: 5 }, () => shift()), heads, picks);
    expect(rows[0]).toMatchObject({ perHead: 480, minutes: 480, pick: 14 });
  });

  it('counts every reason a shift was left out', () => {
    const good = Array.from({ length: 6 }, () => shift());
    const { rows, skipped } = buildRows([
      ...good,
      shift({ timer: '00:00:00' }),
      shift({ timer: '0:20' }),
      shift({ productionMeters: 0 }),
      shift({ elastics: [{ elastic: 'eNone' }] }),
      shift({ elastics: [] }),
      shift({ machine: 'gone' }),
      shift({ productionMeters: 4 * 480 * 10 }), // an extra zero
    ], heads, picks);
    expect(rows).toHaveLength(6);
    expect(skipped).toEqual({ noRunTime: 1, shortRun: 1, noMetres: 1, noPick: 2, noHeads: 1, outlier: 1 });
  });
});

describe('learning each machine', () => {
  it('needs enough shifts in the plant before it says anything', () => {
    expect(fit(shifts('a', 10, 19), { now: NOW })).toBeNull();
    expect(fit(shifts('a', 10, 20), { now: NOW })).not.toBeNull();
  });

  it('learns each machine\'s speed, so a slow loom is predicted slow', () => {
    const model = fit([...shifts('fast', 12, 60, { seed: 2 }), ...shifts('slow', 9, 60, { seed: 3 })], { now: NOW });
    const fast = pm.predict(model, { machine: 'fast', minutes: 480, pick: 12 });
    const slow = pm.predict(model, { machine: 'slow', minutes: 480, pick: 12 });
    expect(fast.perHead).toBeGreaterThan(470); // 12 × 480 ÷ 12 = 480
    expect(fast.perHead).toBeLessThan(490);
    expect(slow.perHead).toBeGreaterThan(352); // 9 × 480 ÷ 12 = 360
    expect(slow.perHead).toBeLessThan(368);
  });

  it('follows the physics: twice the pick, half the metres; twice the time, twice', () => {
    const model = fit(shifts('a', 10, 60), { now: NOW });
    const base = pm.predict(model, { machine: 'a', minutes: 300, pick: 12 }).perHead;
    expect(pm.predict(model, { machine: 'a', minutes: 300, pick: 24 }).perHead).toBeCloseTo(base / 2, 0);
    expect(pm.predict(model, { machine: 'a', minutes: 600, pick: 12 }).perHead).toBeCloseTo(base * 2, 0);
  });

  it('pulls a machine with few shifts toward the plant, and one with many hardly at all', () => {
    // Shift-to-shift scatter as on a real floor (breaks, stoppages):
    // three shifts then say little about a loom.
    const noise = 0.25;
    const plant = [
      ...shifts('p1', 10, 60, { seed: 4, noise }), ...shifts('p2', 10.4, 60, { seed: 5, noise }),
      ...shifts('p3', 9.6, 60, { seed: 6, noise }), ...shifts('p4', 10.2, 60, { seed: 7, noise }),
    ];
    const few = fit([...plant, ...shifts('new', 14, 3, { seed: 8, from: 10, noise })], { now: NOW });
    const many = fit([...plant, ...shifts('new', 14, 80, { seed: 8, noise })], { now: NOW });
    // How far the rate is pulled from the machine's own average toward
    // the plant's: 0 = not at all, 1 = all the way.
    const pulled = (m) => {
      const own = m.machines.get('new');
      return (own.ownMu - own.mu) / (own.ownMu - m.plant.mu);
    };
    expect(pulled(few)).toBeGreaterThan(0.3);
    expect(pulled(many)).toBeLessThan(0.1);
    expect(Math.exp(many.machines.get('new').mu)).toBeGreaterThan(13);
  });

  it('counts recent shifts more: a loom that slowed is predicted at its new speed', () => {
    // 100 shifts at 12 a while ago, then 30 recent ones at 9.
    const old = shifts('a', 12, 100, { from: 360, seed: 9 }).map((r) => ({ ...r, date: new Date(r.date.getTime() - 60 * DAY) }));
    const recent = shifts('a', 9, 30, { from: 30, seed: 10 });
    const others = shifts('b', 10, 60, { seed: 11 });
    const model = fit([...old, ...recent, ...others], { now: NOW });
    const rate = Math.exp(model.machines.get('a').mu);
    expect(rate).toBeLessThan(10); // an unweighted average would be ~11.2
  });

  it('gives a machine with no history the plant rate and a wider range', () => {
    const model = fit([...shifts('a', 10, 60, { seed: 12 }), ...shifts('b', 11, 60, { seed: 13 })], { now: NOW });
    const known = pm.predict(model, { machine: 'a', minutes: 480, pick: 12 });
    const unknown = pm.predict(model, { machine: 'never-seen', minutes: 480, pick: 12 });
    expect(unknown.basis).toBe('plant');
    expect(known.basis).toBe('machine');
    expect(unknown.high - unknown.low).toBeGreaterThan(known.high - known.low);
  });
});

describe('a prediction', () => {
  const model = fit(shifts('a', 10, 80, { seed: 14 }), { now: NOW });

  it('gives per head and for the machine, with a likely range inside a wider check band', () => {
    const p = pm.predict(model, { machine: 'a', minutes: 480, pick: 12, heads: 6 });
    expect(p.low).toBeLessThan(p.perHead);
    expect(p.high).toBeGreaterThan(p.perHead);
    expect(p.checkLow).toBeLessThan(p.low);
    expect(p.checkHigh).toBeGreaterThan(p.high);
    expect(p.total).toBeCloseTo(p.perHead * 6, 0);
    expect(p).toMatchObject({ heads: 6, minutes: 480, pick: 12, basis: 'machine', shifts: 80 });
  });

  it('is nothing without a run time and a pick', () => {
    expect(pm.predict(model, { machine: 'a', minutes: 0, pick: 12 })).toBeNull();
    expect(pm.predict(model, { machine: 'a', minutes: 480, pick: null })).toBeNull();
    expect(pm.predict(null, { machine: 'a', minutes: 480, pick: 12 })).toBeNull();
  });

  it('describes a machine against the plant in plain terms', () => {
    const two = fit([...shifts('a', 10, 60, { seed: 15 }), ...shifts('b', 12, 60, { seed: 16 })], { now: NOW });
    const a = pm.machineSummary(two, 'a', { pick: 12 });
    const b = pm.machineSummary(two, 'b', { pick: 12 });
    expect(b.speedIndex).toBeGreaterThan(a.speedIndex);
    expect(a.metresPerHeadHour).toBeCloseTo(50, -1); // 10 × 60 ÷ 12
    expect(pm.machineSummary(two, 'a').metresPerHeadHour).toBeNull();
  });
});

describe('scoring it honestly', () => {
  it('beats the simpler guesses when picks and run times vary, and its range holds about 8 in 10', () => {
    const rows = [
      ...shifts('a', 9, 120, { seed: 17 }), ...shifts('b', 10, 120, { seed: 18 }),
      ...shifts('c', 11, 120, { seed: 19 }), ...shifts('d', 12.5, 120, { seed: 20 }),
    ];
    const e = evaluate(rows);
    expect(e.testedOn).toBe(96);
    const err = (m) => e.methods[m].medianErrorPct;
    expect(err('model')).toBeLessThan(err('plantPhysics'));
    expect(err('model')).toBeLessThan(err('machinePerHour'));
    expect(err('model')).toBeLessThan(err('machineAverage'));
    expect(e.methods.model.rangeCoveragePct).toBeGreaterThanOrEqual(65);
    expect(e.methods.model.rangeCoveragePct).toBeLessThanOrEqual(92);
  });

  it('scores only on shifts after everything it trained on', () => {
    const rows = shifts('a', 10, 100, { seed: 21 });
    const e = evaluate(rows);
    expect(e.trainedOn + e.testedOn).toBe(100);
    const sorted = [...rows].sort((x, y) => x.date - y.date);
    expect(new Date(e.testFrom).getTime()).toBe(sorted[80].date.getTime());
  });

  it('says nothing about accuracy with too few shifts to hold back', () => {
    expect(evaluate(shifts('a', 10, 40))).toBeNull();
  });
});
