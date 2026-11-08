'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE FACTORY'S DAY
//
//  The server keeps UTC; the factory keeps India's clock. Between
//  midnight and 05:30 in India the two disagree about what day it is,
//  and every "today" in the app used to take the server's side.
// ══════════════════════════════════════════════════════════════════

const f = require('../../utils/factoryDay');
const iso = (d) => d && d.toISOString();

describe('the factory day', () => {
  // 01:30 on 8 November in India — still the 7th on the server's clock.
  const smallHours = new Date('2026-11-07T20:00:00.000Z');

  it('is India\'s date in the small hours, not the server\'s', () => {
    expect(f.ymd(smallHours)).toBe('2026-11-08');
    expect(iso(f.calendarDay(smallHours))).toBe('2026-11-08T00:00:00.000Z');
  });

  it('starts and ends at midnight in India for moments', () => {
    expect(iso(f.dayStart(smallHours))).toBe('2026-11-07T18:30:00.000Z');
    expect(iso(f.dayEnd(smallHours))).toBe('2026-11-08T18:29:59.999Z');
  });

  it('keeps a calendar date on its own day however it was stored', () => {
    expect(f.ymd('2026-03-01')).toBe('2026-03-01');
    expect(f.ymd(new Date('2026-03-01T00:00:00.000Z'))).toBe('2026-03-01'); // UTC midnight
    expect(f.ymd(new Date('2026-02-28T18:30:00.000Z'))).toBe('2026-03-01'); // India midnight
  });

  it('reads a time with no zone as the factory\'s wall clock', () => {
    // The phone app sends DateTime.toIso8601String(): local, no zone.
    expect(f.ymd('2026-11-08T20:00:00.000')).toBe('2026-11-08');
    expect(f.ymd('2026-11-08T23:00:00+05:30')).toBe('2026-11-08');
  });

  it('reads its own bounds back as the same day', () => {
    for (const day of ['2026-01-31', '2026-03-31', '2026-12-31']) {
      for (const fn of ['calendarDay', 'calendarDayEnd', 'dayStart', 'dayEnd']) {
        expect([fn, f.ymd(f[fn](day))]).toEqual([fn, day]);
      }
    }
    // A month's last day built as 23:59:59.999 stays in that month.
    expect(f.ymd(new Date(Date.UTC(2026, 2, 31, 23, 59, 59, 999)))).toBe('2026-03-31');
  });

  it('means today only when called with nothing', () => {
    expect(f.calendarDay()).toBeInstanceOf(Date);
    expect(f.calendarDay(undefined)).toBeNull();
    expect(f.calendarDay(null)).toBeNull();
    expect(f.dayStart('not a date')).toBeNull();
  });
});

describe('the shift day', () => {
  it('stays on the night shift\'s date until the day shift starts at 08:00', () => {
    expect(f.ymd(f.shiftDay(new Date('2026-11-07T20:00:00Z')))).toBe('2026-11-07'); // 01:30 on the 8th
    expect(f.ymd(f.shiftDay(new Date('2026-11-08T02:29:00Z')))).toBe('2026-11-07'); // 07:59
    expect(f.ymd(f.shiftDay(new Date('2026-11-08T02:30:00Z')))).toBe('2026-11-08'); // 08:00
    expect(f.ymd(f.shiftDay(new Date('2026-11-08T17:00:00Z')))).toBe('2026-11-08'); // 22:30, night shift of the 8th
  });

  it('takes a written date as that date', () => {
    expect(f.ymd(f.shiftDay('2026-11-08'))).toBe('2026-11-08');
  });
});
