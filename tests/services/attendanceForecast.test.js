'use strict';
// ══════════════════════════════════════════════════════════════════
//  STAFFING THE PLAN, NOT RANKING THE PEOPLE
//
//  This is a base rate over the attendance register. The arithmetic is
//  easy; what needs testing is the judgement around it, because a
//  per-person attendance percentage is a league table waiting to
//  happen, and a plan built on optimistic staffing is a plan that fails
//  quietly on a Thursday night.
//
//  Four things have to hold:
//
//    • approved leave is not absence — it is planned, granted time off,
//      and counting it would penalise people for taking what they are
//      owed AND make the forecast worse
//    • the plant forecast carries no names
//    • a thin cell leans on the plant average instead of declaring
//      somebody a 0% Tuesday attender from two observations
//    • expected heads round DOWN, because a plan that assumes the
//      ninth person turns up is a plan that assumes full attendance
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, forecastSvc, I, Attendance, Employee;

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  forecastSvc = require('../../services/attendanceForecast');
  I           = forecastSvc._internals;
  Attendance  = require('../../models/Attendence.js');
  Employee    = require('../../models/Employee');
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) await c.deleteMany({});
});

let seq = 0;
const makeEmployee = () => Employee.create({
  name: `Op ${seq}`, phoneNumber: `95000000${String(seq++).padStart(2, '0')}`,
  department: 'production',
});

// A fixed "now" so weekday arithmetic and decay are deterministic.
// 2026-08-17 is a Monday.
const NOW = new Date(2026, 7, 17, 12, 0, 0);

/** Mark `count` occurrences of one weekday, walking backwards from NOW. */
async function mark(employee, { dow, shift = 'DAY', count, status, startWeeksAgo = 0 }) {
  const rows = [];
  for (let k = 0; k < count; k++) {
    const d = new Date(NOW);
    d.setDate(d.getDate() - (startWeeksAgo + k) * 7);
    // Walk back to the requested weekday.
    while (d.getDay() !== dow) d.setDate(d.getDate() - 1);
    d.setHours(0, 0, 0, 0);
    rows.push({
      employee: employee._id, date: new Date(d), shift,
      status: typeof status === 'function' ? status(k) : status,
    });
  }
  await Attendance.insertMany(rows);
}

const run = (opts = {}) => forecastSvc.forecast({ now: NOW, ...opts });

// ══════════════════════════════════════════════════════════════════
//  1. WHAT COUNTS AS ABSENCE
// ══════════════════════════════════════════════════════════════════
describe('what the register is evidence of', () => {
  test('approved leave is not absence', async () => {
    // It is planned, granted, and already visible to whoever writes the
    // plan. Counting it would penalise somebody for taking leave they
    // were owed and would make the forecast WORSE, not more cautious.
    expect(I.attendanceValue('on_leave')).toBeNull();
    expect(I.attendanceValue('absent')).toBe(0);
    expect(I.attendanceValue('present')).toBe(1);
  });

  test('late is present — they were at the machine', () => {
    // Lateness is a payroll matter, handled there with its own
    // deduction. For "will there be somebody on this loom", they were.
    expect(I.attendanceValue('late')).toBe(1);
  });

  test('half a day is half a person', () => {
    // Not rounded either way. Half the shift was covered.
    expect(I.attendanceValue('half_day')).toBe(0.5);
  });

  test('a person on approved leave every Friday does not drag Friday down', async () => {
    const a = await makeEmployee();
    const b = await makeEmployee();
    await mark(a, { dow: 5, count: 10, status: 'present' });
    await mark(b, { dow: 5, count: 10, status: 'on_leave' });

    const out = await run();
    const fri = out.slots.find((s) => s.day === 'Fri' && s.shift === 'DAY');

    // Only one person has any Friday evidence at all, and they are
    // always there.
    expect(fri.peopleRostered).toBe(1);
    expect(fri.expectedAttendancePct).toBeGreaterThan(90);
  });
});

// ══════════════════════════════════════════════════════════════════
//  2. THE LINE THIS SERVICE DOES NOT CROSS
// ══════════════════════════════════════════════════════════════════
describe('the plant forecast carries no names', () => {
  test('nothing in the forecast identifies a person', async () => {
    // A per-person attendance percentage on a shared screen becomes a
    // league table within a week, and then a reason somebody was let go
    // — from a figure that cannot tell an unreliable worker from one who
    // had a sick child in April.
    const a = await makeEmployee();
    const b = await makeEmployee();
    await mark(a, { dow: 1, count: 12, status: 'present' });
    await mark(b, { dow: 1, count: 12, status: (k) => (k % 2 ? 'absent' : 'present') });

    const out = await run();
    const json = JSON.stringify(out);

    expect(json).not.toContain(String(a._id));
    expect(json).not.toContain(String(b._id));
    expect(json).not.toContain(a.name);
    // The slot still reflects both of them.
    const mon = out.slots.find((s) => s.day === 'Mon' && s.shift === 'DAY');
    expect(mon.peopleRostered).toBe(2);
  });

  test("a person's own record is reachable, separately, and says what it excludes", async () => {
    // Exists so a supervisor can check a number WITH somebody, the way
    // a payslip is theirs to see. Gated separately at the route.
    const a = await makeEmployee();
    await mark(a, { dow: 2, count: 8, status: 'present' });

    const mine = await forecastSvc.forEmployee(a._id, { now: NOW });
    expect(mine.employeeId).toBe(String(a._id));
    expect(mine.slots[0]).toMatchObject({ day: 'Tue', shift: 'DAY' });
    expect(mine.note).toMatch(/approved leave is excluded/i);
  });

  test('an employee with no history is null, not a zero', async () => {
    const a = await makeEmployee();
    expect(await forecastSvc.forEmployee(a._id, { now: NOW })).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════
//  3. NOT OVER-READING THIN DATA
// ══════════════════════════════════════════════════════════════════
describe('a thin cell leans on the plant average', () => {
  test('two missed Tuesdays does not make somebody a 0% Tuesday attender', async () => {
    // Without shrinkage this person is recorded as never turning up on
    // a Tuesday, for ever, on the strength of two rows.
    const steady = [];
    for (let i = 0; i < 6; i++) {
      const e = await makeEmployee();
      steady.push(e);
      await mark(e, { dow: 2, count: 12, status: 'present' });
    }
    const unlucky = await makeEmployee();
    await mark(unlucky, { dow: 2, count: 2, status: 'absent' });

    const mine = await forecastSvc.forEmployee(unlucky._id, { now: NOW });
    const tue = mine.slots.find((s) => s.day === 'Tue');

    expect(tue.rawRate).toBe(0);              // what the register says
    expect(tue.expectedRate).toBeGreaterThan(30);  // what it is worth believing
    expect(tue.confident).toBe(false);
  });

  test('a slot where most people are thinly observed is flagged', async () => {
    const a = await makeEmployee();
    const b = await makeEmployee();
    await mark(a, { dow: 3, count: 2, status: 'present' });
    await mark(b, { dow: 3, count: 2, status: 'present' });

    const out = await run();
    expect(out.slots.find((s) => s.day === 'Wed').thin).toBe(true);
  });

  test('an empty register forecasts nothing rather than zero heads', async () => {
    // "Nobody will be here" and "we have no records" are different
    // claims, and only one of them would be true.
    const out = await run();
    expect(out.slots).toEqual([]);
    expect(out.plantAttendancePct).toBeNull();
    expect(out.note).toMatch(/nothing to forecast/i);
  });
});

// ══════════════════════════════════════════════════════════════════
//  4. RECENCY
// ══════════════════════════════════════════════════════════════════
describe('the recent past counts for more', () => {
  test('an observation decays with the half-life', () => {
    expect(I.decay(0)).toBeCloseTo(1, 6);
    expect(I.decay(I.HALF_LIFE_DAYS)).toBeCloseTo(0.5, 6);
    expect(I.decay(I.HALF_LIFE_DAYS * 2)).toBeCloseTo(0.25, 6);
  });

  test('somebody steady lately outranks their bad winter', async () => {
    // Missing a fortnight last winter and missing one now are not the
    // same fact about next Thursday.
    const reformed = await makeEmployee();
    // Older weeks absent, recent weeks present.
    await mark(reformed, { dow: 4, count: 8, status: 'absent', startWeeksAgo: 16 });
    await mark(reformed, { dow: 4, count: 8, status: 'present' });

    const mine = await forecastSvc.forEmployee(reformed._id, { now: NOW });
    const thu = mine.slots.find((s) => s.day === 'Thu');

    // Raw says half. Weighted says considerably better, because the
    // good half is the recent half.
    expect(thu.rawRate).toBeCloseTo(50, 0);
    expect(thu.weightedRate).toBeGreaterThan(65);
    // Both are reported, so the difference is visible rather than
    // silently baked in.
    expect(thu.rawRate).not.toBe(thu.weightedRate);
  });
});

// ══════════════════════════════════════════════════════════════════
//  5. THE NUMBER THE PLAN IS BUILT ON
// ══════════════════════════════════════════════════════════════════
describe('expected heads', () => {
  test('are rounded DOWN for planning', async () => {
    // A plan built on 8.7 people needs eight of them to work. The ninth
    // turning up is a good day, not a requirement — and rounding up is
    // how a plan quietly goes back to assuming full attendance.
    for (let i = 0; i < 9; i++) {
      const e = await makeEmployee();
      // Roughly 90% attendance each.
      await mark(e, { dow: 1, count: 10, status: (k) => (k === 0 ? 'absent' : 'present') });
    }

    const out = await run();
    const mon = out.slots.find((s) => s.day === 'Mon' && s.shift === 'DAY');

    expect(mon.peopleRostered).toBe(9);
    expect(mon.expectedHeads).toBeGreaterThan(7.5);
    expect(mon.expectedHeads).toBeLessThan(9);
    expect(mon.planningHeads).toBe(Math.floor(mon.expectedHeads));
    expect(mon.planningHeads).toBeLessThan(mon.peopleRostered);
  });

  test('day and night are forecast apart', async () => {
    // A Monday night is not a Monday day, and one number for both would
    // smooth away exactly the pattern the plan needs.
    const a = await makeEmployee();
    const b = await makeEmployee();
    await mark(a, { dow: 1, shift: 'DAY',   count: 12, status: 'present' });
    await mark(b, { dow: 1, shift: 'NIGHT', count: 12, status: (k) => (k % 2 ? 'absent' : 'present') });

    const out = await run();
    const day   = out.slots.find((s) => s.day === 'Mon' && s.shift === 'DAY');
    const night = out.slots.find((s) => s.day === 'Mon' && s.shift === 'NIGHT');

    expect(day.expectedAttendancePct).toBeGreaterThan(night.expectedAttendancePct);
  });

  test('the weakest slot is named, so the plan can be built around it', async () => {
    const a = await makeEmployee();
    const b = await makeEmployee();
    await mark(a, { dow: 1, count: 12, status: 'present' });
    await mark(b, { dow: 6, count: 12, status: (k) => (k < 9 ? 'absent' : 'present') });

    const out = await run();
    expect(out.weakestSlot.day).toBe('Sat');
  });

  test('the method is on the response', async () => {
    const a = await makeEmployee();
    await mark(a, { dow: 1, count: 8, status: 'present' });
    const out = await run();
    expect(out.method).toMatch(/half-life/i);
    expect(out.method).toMatch(/approved leave is excluded/i);
    expect(out.method).toMatch(/rounded DOWN/i);
  });
});
