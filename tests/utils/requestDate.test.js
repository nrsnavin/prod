'use strict';
// A date the request sent: as sent, or refused in the field's own name.
const { dateFrom } = require('../../utils/requestDate');

describe('dateFrom', () => {
  it('is the date that was sent, as text, as milliseconds or as a date', () => {
    expect(dateFrom('2026-11-10', 'date').toISOString()).toBe('2026-11-10T00:00:00.000Z');
    expect(dateFrom(' 2026-11-10T08:30:00+05:30 ', 'date').toISOString()).toBe('2026-11-10T03:00:00.000Z');
    expect(dateFrom(1762732800000, 'date').getTime()).toBe(1762732800000);
    const d = new Date('2026-01-01T00:00:00Z');
    expect(dateFrom(d, 'date')).toBe(d);
    // A repeated query parameter: the first is the one meant.
    expect(dateFrom(['2026-11-10', '2026-11-11'], 'from').toISOString()).toBe('2026-11-10T00:00:00.000Z');
  });

  it('is the fallback when nothing was sent', () => {
    const fallback = new Date();
    for (const nothing of [undefined, null, '']) {
      expect(dateFrom(nothing, 'date')).toBeNull();
      expect(dateFrom(nothing, 'date', fallback)).toBe(fallback);
      expect(dateFrom(nothing, 'date', undefined)).toBeNull(); // undefined asks for the default
    }
  });

  it('refuses what is not a date, naming the field', () => {
    for (const bad of ['next week', '2026-13-45', 'Invalid Date', {}, { $gt: '' }, NaN, new Date('nope')]) {
      let err;
      try { dateFrom(bad, 'billDate'); } catch (e) { err = e; }
      expect(err).toBeDefined();
      expect([err.statusCode, err.message]).toEqual([400, 'billDate is not a date']);
    }
  });
});
