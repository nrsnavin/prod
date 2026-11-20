'use strict';
// A delivery estimate is a DAY, and so is the day that was promised.
//
// The estimate was "now plus N working days" with the time of day still
// on it — 24 November 14:10 — and the promise is a calendar date, 24
// November 00:00. So an order expected on the very day it was promised
// was later than its promise by fourteen hours: flagged late, by one
// working day. And "now" was the server's clock: between midnight and
// 05:30 in India the server is still on yesterday, so Sunday's first
// hours were a working Saturday and Monday's were a Sunday off.
//
// Working days are now counted on the calendar in India, from the day
// it is there, and land on a day.

const C = require('../../utils/etaConfig');
const { estimateOrderEta } = require('../../utils/orderEta');
const { estimateRunningOrderEta } = require('../../utils/runningOrderEta');

const agg = { elasticRate: { ela1: 1000 }, plantRate: 900, consistencyScore: 80, attendanceMomentum: 1, machineHealth: 1, freeMachines: 3, machineNoOfHeadAvg: 4 };
/** Monday 15 June 2026, ten past two in the afternoon in India. */
const MONDAY_AFTERNOON = new Date('2026-06-15T08:40:00Z');
const day = (d) => d.toISOString().slice(0, 10);

describe('an estimate is a day', () => {
  it('counts from the day it is in India and lands on a day, whatever the time', () => {
    expect(C.addWorkingDays(MONDAY_AFTERNOON, 7).toISOString()).toBe('2026-06-23T00:00:00.000Z');
    expect(C.addWorkingDays(new Date('2026-06-15T00:00:00Z'), 7).toISOString()).toBe('2026-06-23T00:00:00.000Z');
    // It does not change what it was given.
    const from = new Date(MONDAY_AFTERNOON);
    C.addWorkingDays(from, 3);
    expect(from.getTime()).toBe(MONDAY_AFTERNOON.getTime());
  });

  it('an order expected on the day it was promised is not late', () => {
    const order = (supplyDate) => estimateOrderEta({ lines: [{ elastic: 'ela1', quantity: 6000 }], machines: 2, supplyDate, today: MONDAY_AFTERNOON, aggregates: agg });
    const onTime = order('2026-06-23');
    expect(day(onTime.expectedDate)).toBe('2026-06-23');
    expect(onTime.risk).toMatchObject({ late: false, lateWorkingDays: 0 });
    // One promised a day sooner is one working day late; a week later, in hand.
    expect(order('2026-06-22').risk).toMatchObject({ late: true, lateWorkingDays: 1 });
    expect(order('2026-06-30').risk).toMatchObject({ late: false, lateWorkingDays: 0 });
  });

  it('the same for an order already on the looms', () => {
    const running = (supplyDate) => estimateRunningOrderEta({
      jobs: [{ job: 'J1', machineId: 'M1', noOfHead: 2, elastics: [{ elastic: 'A', remainingMeters: 800, headsAssigned: 2, metersPerHeadPerShift: 100 }] }],
      today: MONDAY_AFTERNOON, supplyDate,
    });
    expect(day(running(new Date('2026-06-19')).expectedDate)).toBe('2026-06-19');
    expect(running(new Date('2026-06-19')).risk).toMatchObject({ late: false, lateWorkingDays: 0 });
    expect(running(new Date('2026-06-18')).risk).toMatchObject({ late: true, lateWorkingDays: 1 });
  });
});

describe('the factory’s week, not the server’s', () => {
  it('Sunday begins at midnight in India', () => {
    const sunday0130 = new Date('2026-06-13T20:00:00Z');   // still Saturday evening in UTC
    expect(C.isWorkingDay(sunday0130)).toBe(false);
    expect(day(C.addWorkingDays(sunday0130, 1))).toBe('2026-06-15');   // Monday
    const monday0130 = new Date('2026-06-14T20:00:00Z');   // still Sunday in UTC
    expect(C.isWorkingDay(monday0130)).toBe(true);
    expect(day(C.addWorkingDays(monday0130, 1))).toBe('2026-06-16');   // Tuesday
  });

  it('a holiday is the day it is written as', () => {
    expect(C.isWorkingDay(new Date('2026-06-16T20:00:00Z'), [0], ['2026-06-17'])).toBe(false);   // 17 June, 01:30
    expect(C.isWorkingDay(new Date('2026-06-17T00:00:00Z'), [0], ['2026-06-17'])).toBe(false);
    expect(C.isWorkingDay(new Date('2026-06-17T20:00:00Z'), [0], ['2026-06-17'])).toBe(true);    // 18 June, 01:30
    expect(day(C.addWorkingDays(MONDAY_AFTERNOON, 2, [0], ['2026-06-16']))).toBe('2026-06-18');
  });

  it('counts the working days after one day up to another', () => {
    const d = (s) => new Date(`${s}T00:00:00Z`);
    expect(C.workingDaysBetween(d('2026-06-15'), new Date('2026-06-15T09:00:00Z'))).toBe(0);   // the same day
    expect(C.workingDaysBetween(d('2026-06-15'), d('2026-06-16'))).toBe(1);
    expect(C.workingDaysBetween(d('2026-06-15'), d('2026-06-22'))).toBe(6);   // Sunday the 21st is not one
    expect(C.workingDaysBetween(d('2026-06-22'), d('2026-06-15'))).toBe(0);
    expect(C.workingDaysBetween(null, d('2026-06-15'))).toBe(0);
  });
});
