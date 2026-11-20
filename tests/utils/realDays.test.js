'use strict';
// ══════════════════════════════════════════════════════════════════
//  A DATE THAT IS NOT A DAY IS REFUSED, NOT MOVED TO ANOTHER ONE
//
//  Found checking the loom sensor's date (api/loomSensor.js), then
//  following it into the helpers every request date goes through.
//
//  "2026-02-30" has the shape of a date. JavaScript's own reader takes
//  it as the 2nd of March, and "2026-04-31" as the 1st of May: any day
//  number up to 31 is rolled into the next month without a word. The
//  day reader here went further — "2026-13-01" was January 2027 and
//  "2026-10-51" the 20th of November.
//
//  So an impossible date — mistyped into an import, misread off a
//  photographed bill, sent by another system — was saved as a real day
//  nobody wrote: a bill dated a month it was not, a promise for a day
//  nobody promised. utils/factoryDay.moment already refused "31
//  February 10:00"; the same date on its own went through.
//
//  A date that is not a day is now no date at all, in every reader.
// ══════════════════════════════════════════════════════════════════

const factoryDay = require('../../utils/factoryDay');
const { dateFrom, dayFrom, momentFrom } = require('../../utils/requestDate');
const { readDate } = require('../../services/accountsHelpers');

const NOT_DAYS = ['2026-02-29', '2026-02-30', '2026-02-31', '2026-04-31', '2026-06-31', '2026-09-31', '2026-11-31', '2026-13-01', '2026-00-10', '2026-10-51', '2026-12-32', '2026-10-00'];
const DAYS = ['2028-02-29', '2026-02-28', '2026-04-30', '2026-12-31', '2026-01-01', '2026-10-31'];
const refused = (fn) => { try { fn(); return null; } catch (err) { return [err.statusCode, err.message]; } };

describe('the day reader', () => {
  it.each(NOT_DAYS)('%s is not a day', (s) => {
    // Before: each came back as a day in another month (or year).
    expect(factoryDay.calendarDay(s)).toBeNull();
    expect(factoryDay.ymd(s)).toBeNull();
    expect(factoryDay.dayStart(s)).toBeNull();
    expect(factoryDay.calendarDayEnd(s)).toBeNull();
    expect(factoryDay.daysBetween(s, '2026-03-05')).toBeNull();
    // With a time on it, as the phone sends its clock.
    expect(factoryDay.calendarDay(`${s}T10:15:00.000`)).toBeNull();
  });

  it.each(DAYS)('%s is one (unchanged)', (s) => {
    expect(factoryDay.ymd(s)).toBe(s);
    expect(factoryDay.calendarDay(s).toISOString()).toBe(`${s}T00:00:00.000Z`);
    expect(factoryDay.ymd(`${s}T21:15:30.123`)).toBe(s);
  });

  it('still reads moments, numbers and its own day-ends as before', () => {
    expect(factoryDay.ymd(new Date('2026-11-19T20:00:00Z'))).toBe('2026-11-20');
    expect(factoryDay.ymd('2026-11-19T20:00:00Z')).toBe('2026-11-20');
    expect(factoryDay.ymd(Date.UTC(2026, 10, 20, 3))).toBe('2026-11-20');
    expect(factoryDay.ymd(new Date('2026-11-20T23:59:59.999Z'))).toBe('2026-11-20');
    expect(factoryDay.calendarDay('next week')).toBeNull();
    expect(factoryDay.calendarDay('')).toBeNull();
  });
});

describe('the moment reader', () => {
  it.each(NOT_DAYS)('%s is not a moment, with or without a time or a zone', (s) => {
    // Before: the date on its own, or with a zone, rolled into another day.
    expect(factoryDay.moment(s)).toBeNull();
    expect(factoryDay.moment(`${s}T10:00:00Z`)).toBeNull();
    expect(factoryDay.moment(`${s}T10:00:00.000+05:30`)).toBeNull();
    expect(factoryDay.moment(`${s}T10:00:00`)).toBeNull();
  });

  it.each(DAYS)('%s is one (unchanged)', (s) => {
    expect(factoryDay.moment(s).toISOString()).toBe(`${s}T00:00:00.000Z`);
    expect(factoryDay.moment(`${s}T10:00:00Z`).toISOString()).toBe(`${s}T10:00:00.000Z`);
    expect(factoryDay.moment(`${s}T10:00:00`).toISOString()).toBe(new Date(`${s}T10:00:00+05:30`).toISOString());
  });
});

describe('a date a request sent', () => {
  it.each(NOT_DAYS)('%s is refused by every reader, in the field\'s own name', (s) => {
    for (const read of [dateFrom, dayFrom, momentFrom, readDate]) {
      expect([read.name, refused(() => read(s, 'billDate'))]).toEqual([read.name, [400, 'billDate is not a date']]);
      expect([read.name, refused(() => read(`${s}T18:30:00.000Z`, 'billDate'))]).toEqual([read.name, [400, 'billDate is not a date']]);
    }
  });

  it.each(DAYS)('%s is read as that day by every reader (unchanged)', (s) => {
    for (const read of [dateFrom, dayFrom, momentFrom, readDate]) {
      expect([read.name, read(s, 'billDate').toISOString()]).toEqual([read.name, `${s}T00:00:00.000Z`]);
    }
  });

  it('nothing sent is still the fallback, and a moment still its day', () => {
    expect(dayFrom('', 'date', null)).toBeNull();
    expect(readDate(undefined, 'date', null)).toBeNull();
    expect(dayFrom('2026-11-19T20:00:00.000Z', 'date').toISOString()).toBe('2026-11-20T00:00:00.000Z');
    expect(readDate('2026-11-19T20:00:00.000Z', 'date').toISOString()).toBe('2026-11-20T00:00:00.000Z');
    expect(dateFrom('2026-11-19T20:00:00.000Z', 'date').toISOString()).toBe('2026-11-19T20:00:00.000Z');
    expect(dateFrom(Date.UTC(2026, 10, 20), 'date').toISOString()).toBe('2026-11-20T00:00:00.000Z');
  });
});
