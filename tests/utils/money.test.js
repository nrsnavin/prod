'use strict';
// utils/money.js — the two roundings, and why there are two.

const { r2, round2, parseMoney, MAX_RATE } = require('../../utils/money');

describe('r2: for adding up a column', () => {
  it('rounds to the paisa', () => {
    expect(r2(12.345)).toBe(12.35);
    expect(r2('12.344')).toBe(12.34);
    expect(r2(-0.005)).toBe(-0);
    expect(r2(1e9 + 0.004)).toBe(1e9);
  });
  it('counts an empty or missing cell as nothing, so the total is still a total', () => {
    for (const v of [undefined, null, '', 'abc', NaN, {}]) expect(r2(v)).toBe(0);
    expect([100, undefined, 50.555].reduce((s, v) => r2(s + r2(v)), 0)).toBe(150.56);
  });
});

describe('round2: for a figure that must not look right when it is not', () => {
  it('rounds a real number, and says null for anything else', () => {
    expect(round2(12.345)).toBe(12.35);
    expect(round2('7')).toBe(7);
    for (const v of [undefined, 'abc', NaN, Infinity, -Infinity]) expect(round2(v)).toBeNull();
  });
});

describe('parseMoney', () => {
  it('takes a number or text that is one, and nothing else', () => {
    expect(parseMoney(12.5)).toEqual({ ok: true, value: 12.5 });
    expect(parseMoney('12.5')).toEqual({ ok: true, value: 12.5 });
    for (const v of [null, '', true, [], {}, 'abc', NaN]) expect(parseMoney(v).ok).toBe(false);
    expect(parseMoney(-1).reason).toMatch(/cannot be negative/);
    expect(parseMoney(MAX_RATE + 1, { max: MAX_RATE, label: 'rate' }).reason).toMatch(/rate looks wrong/);
    expect(parseMoney(null, { allowNull: true })).toEqual({ ok: true, value: null });
  });
});
