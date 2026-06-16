'use strict';

const {
  posteriorMean,
  posteriorVariance,
  toMetersPerMachineDay,
  INFORMATIVE_THRESHOLD,
} = require('../../utils/etaPosterior.js');

describe('etaPosterior.posteriorMean', () => {
  test('returns 0 with no observations (avoids divide-by-zero)', () => {
    expect(posteriorMean(0, 0)).toBe(0);
  });

  test('matches the conjugate posterior mean α/β', () => {
    // 5 shifts, average 400 m/head/shift → shape 2000, rate 5.
    expect(posteriorMean(2000, 5)).toBe(400);
  });

  test('converges toward observed mean as observations accumulate', () => {
    // Sequence of identical 350 m/head/shift observations.
    let shape = 0, rate = 0;
    for (let i = 0; i < 10; i++) { shape += 350; rate += 1; }
    expect(posteriorMean(shape, rate)).toBe(350);
  });
});

describe('etaPosterior.posteriorVariance', () => {
  test('returns 0 with no observations', () => {
    expect(posteriorVariance(0, 0)).toBe(0);
  });

  test('matches the conjugate posterior variance α/β^2', () => {
    expect(posteriorVariance(2000, 5)).toBe(2000 / 25);
  });

  test('variance shrinks as observations accumulate at the same mean', () => {
    const v3  = posteriorVariance(1200,  3);
    const v30 = posteriorVariance(12000, 30);
    expect(v30).toBeLessThan(v3);
  });
});

describe('etaPosterior.toMetersPerMachineDay', () => {
  test('scales by heads and shifts (the unit the heuristic expects)', () => {
    // 400 m/head/shift, 4-head machine, 2 shifts/day = 3200 m/machine-day.
    expect(toMetersPerMachineDay(400, 4, 2)).toBe(3200);
  });

  test('clamps invalid heads/shifts to 1 instead of returning NaN', () => {
    expect(toMetersPerMachineDay(400, 0, 2)).toBe(800);
    expect(toMetersPerMachineDay(400, 4, 0)).toBe(1600);
    expect(toMetersPerMachineDay(400, null, undefined)).toBe(400);
  });
});

describe('etaPosterior.INFORMATIVE_THRESHOLD', () => {
  test('is a small positive integer (sanity gate)', () => {
    expect(Number.isInteger(INFORMATIVE_THRESHOLD)).toBe(true);
    expect(INFORMATIVE_THRESHOLD).toBeGreaterThan(0);
    expect(INFORMATIVE_THRESHOLD).toBeLessThan(30);
  });
});
