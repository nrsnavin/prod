'use strict';
// The month or year a request asks for (utils/periods.js).

const { factoryMonth, yearOf, monthOf, monthBefore, monthRange } = require('../../utils/periods');

describe('the factory\'s month', () => {
  it('is India\'s, not the server\'s: still the old month in UTC, already the new one in the factory', () => {
    // 20:00 UTC on 31 May is 01:30 on 1 June in India.
    expect(factoryMonth(new Date('2026-05-31T20:00:00.000Z'))).toEqual({ year: 2026, month: 6 });
    expect(factoryMonth(new Date('2026-05-31T18:00:00.000Z'))).toEqual({ year: 2026, month: 5 });
    // And the year turns with it.
    expect(factoryMonth(new Date('2026-12-31T19:00:00.000Z'))).toEqual({ year: 2027, month: 1 });
  });
});

describe('monthOf', () => {
  const now = factoryMonth();
  it('takes numbers and text numbers', () => {
    expect(monthOf({ year: 2026, month: 6 })).toEqual([2026, 6]);
    expect(monthOf({ year: '2026', month: '06' })).toEqual([2026, 6]);
  });
  it('fills in the factory\'s current year or month for whichever is not sent', () => {
    expect(monthOf({})).toEqual([now.year, now.month]);
    expect(monthOf(undefined)).toEqual([now.year, now.month]);
    expect(monthOf({ month: 3 })).toEqual([now.year, 3]);
    expect(monthOf({ year: 2025, month: '' })).toEqual([2025, now.month]);
  });
  it.each([
    [{ year: 2026, month: 13 }], [{ year: 2026, month: 0 }], [{ year: 2026, month: 'June' }], [{ year: 2026, month: 6.5 }],
    [{ year: 26, month: 6 }], [{ year: 'next', month: 6 }], [{ year: 99999, month: 6 }], [{ year: ['2026'], month: [1, 2] }],
  ])('%j is not a month', (q) => {
    expect(monthOf(q)).toBeNull();
  });
});

describe('yearOf', () => {
  it('is the year asked for, the factory\'s when none is, null when it is not one', () => {
    expect(yearOf('2026')).toBe(2026);
    expect(yearOf(2027)).toBe(2027);
    expect(yearOf(undefined)).toBe(factoryMonth().year);
    expect(yearOf('')).toBe(factoryMonth().year);
    for (const bad of ['abc', '1', '99999', '2026.5', {}, true]) expect(yearOf(bad)).toBeNull();
  });
});

describe('monthBefore and monthRange', () => {
  it('step back across the year, and bound a month by its calendar dates', () => {
    expect(monthBefore([2026, 6])).toEqual([2026, 5]);
    expect(monthBefore([2026, 1])).toEqual([2025, 12]);
    expect(monthRange([2026, 2])).toEqual({ start: new Date('2026-02-01T00:00:00.000Z'), end: new Date('2026-02-28T23:59:59.999Z') });
    expect(monthRange([2028, 2]).end).toEqual(new Date('2028-02-29T23:59:59.999Z')); // a leap year
    expect(monthRange([2026, 12]).end).toEqual(new Date('2026-12-31T23:59:59.999Z'));
  });
});
