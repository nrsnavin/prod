'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE SHIFT TIMER ACROSS MIDNIGHT, AND TWO THINGS ON THE SAME ROUTES
//
//  Found reading api/attendence.js line by line.
//
//  1. A NIGHT SHIFT COULD NOT BE CLOCKED OUT. A night shift keeps the
//     date it started on, so somebody clocked in at 20:00 on the 18th has
//     a row dated the 18th. Both apps show the timers for "today" only,
//     and send today's date with every clock-in and clock-out. After
//     midnight the running night shift was gone from the list ("No one is
//     currently clocked in"), and a clock-out for it answered "Not
//     clocked in for this shift" — it was looked for under the 19th. The
//     shift then stayed open, and was paid as a full twelve hours whenever
//     the person had left. A clock-in after midnight (somebody late, or
//     back from a break) started a row for TONIGHT's shift instead.
//
//  2. THE SUMMARY NEVER COUNTED LEAVE. Each person's days are tallied by
//     status, and "on_leave" was added to a field the tally does not
//     have: every employee's leave came out as 0.
//
//  3. THE DAY'S LIST was sorted by a field of the employee record, which
//     the database does not have on an attendance row: it came back in no
//     order.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const factoryDay = require('../../utils/factoryDay');
const marks = require('../../services/attendanceMarks');

let mongo, app, Employee, Attendance, User, admin;
const DAY = 86_400_000;
const HOUR = 3_600_000;
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
const post = (url, body) => request(app).post(`/api/v2${url}`).set('Cookie', cookie()).send(body);
const get  = (url) => request(app).get(`/api/v2${url}`).set('Cookie', cookie());

const today     = () => factoryDay.calendarDay();
const yesterday = () => new Date(today().getTime() - DAY);
const ymd = (d) => factoryDay.ymd(d);
let n = 0;
const makeEmp = (over = {}) => { n += 1; return Employee.create({ name: `Ravi ${n}`, hourlyRate: 100, ...over }); };
/** A shift the timer was started on, `hoursAgo` hours back. */
const running = (emp, date, shift, hoursAgo, over = {}) => Attendance.create({
  employee: emp._id, date, shift, status: 'present', clockInAt: new Date(Date.now() - hoursAgo * HOUR), clockOutAt: null, ...over,
});

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  Employee = require('../../models/Employee');
  Attendance = require('../../models/Attendence.js');
  User = require('../../models/User');
  await Attendance.init();
  admin = await User.create({ name: 'Asha', email: 'night@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
});

// ══════════════════════════════════════════════════════════════════
describe('a night shift that began before midnight', () => {
  it('is still on the list of running timers the next morning', async () => {
    const emp = await makeEmp();
    await running(emp, yesterday(), 'NIGHT', 10);

    const res = await get(`/attendance/active?date=${ymd(today())}`);
    expect(res.status).toBe(200);
    // Before: [] — "No one is currently clocked in".
    expect(res.body.data.map((r) => String(r.employeeId))).toEqual([String(emp._id)]);
    expect(res.body.data[0]).toMatchObject({ shift: 'NIGHT', date: ymd(yesterday()) });
  });

  it('is clocked out by a clock-out sent with today\'s date, as both apps send it', async () => {
    const emp = await makeEmp();
    const row = await running(emp, yesterday(), 'NIGHT', 10);

    const res = await post('/attendance/clock-out', { employeeId: String(emp._id), shift: 'NIGHT', date: ymd(today()) });
    // Before: 400 "Not clocked in for this shift."
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: String(row._id), date: ymd(yesterday()), shift: 'NIGHT' });

    const after = await Attendance.findById(row._id).lean();
    expect(after.clockOutAt).toBeInstanceOf(Date);
    // Ten hours, to the minute.
    expect(after.workedMinutes).toBeGreaterThanOrEqual(599);
    expect(after.workedMinutes).toBeLessThanOrEqual(601);
    // And nothing was started under today's date.
    expect(await Attendance.countDocuments({ employee: emp._id })).toBe(1);
  });

  it('with no date sent at all, the same', async () => {
    const emp = await makeEmp();
    await running(emp, yesterday(), 'NIGHT', 9);
    const res = await post('/attendance/clock-out', { employeeId: String(emp._id), shift: 'NIGHT' });
    expect(res.status).toBe(200);
  });

  it('a shift running under the day asked for is the one closed, when there is one', async () => {
    const emp = await makeEmp();
    const forgotten = await running(emp, yesterday(), 'DAY', 26);
    const todays = await running(emp, today(), 'DAY', 3);

    const res = await post('/attendance/clock-out', { employeeId: String(emp._id), shift: 'DAY', date: ymd(today()) });
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(String(todays._id));
    expect((await Attendance.findById(forgotten._id).lean()).clockOutAt).toBeNull();
  });

  it('nobody running is still "not clocked in", and a finished shift still "already clocked out"', async () => {
    const emp = await makeEmp();
    const none = await post('/attendance/clock-out', { employeeId: String(emp._id), shift: 'NIGHT', date: ymd(today()) });
    expect([none.status, none.body.message]).toEqual([400, 'Not clocked in for this shift.']);

    await running(emp, today(), 'DAY', 5, { clockOutAt: new Date(Date.now() - HOUR), workedMinutes: 240 });
    const done = await post('/attendance/clock-out', { employeeId: String(emp._id), shift: 'DAY', date: ymd(today()) });
    expect([done.status, done.body.message]).toEqual([409, 'Already clocked out for this shift.']);
  });

  it('a shift from the day before that was clocked out is not reopened or closed again', async () => {
    const emp = await makeEmp();
    await running(emp, yesterday(), 'NIGHT', 14, { clockOutAt: new Date(Date.now() - 2 * HOUR), workedMinutes: 720 });
    const res = await post('/attendance/clock-out', { employeeId: String(emp._id), shift: 'NIGHT', date: ymd(today()) });
    expect(res.status).toBe(400);
    expect((await get(`/attendance/active?date=${ymd(today())}`)).body.data).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('the day a timer started for the night shift is kept under', () => {
  // 2026-11-19 in India: midnight there is 18:30 UTC on the 18th.
  const at = (hhmm) => new Date(`2026-11-19T${hhmm}:00+05:30`);
  const the19th = new Date('2026-11-19T00:00:00.000Z');
  const the18th = new Date('2026-11-18T00:00:00.000Z');

  it('is the evening it began: half past midnight belongs to last night', () => {
    expect(marks.timerDayFor(the19th, 'NIGHT', at('00:30'))).toEqual(the18th);
    expect(marks.timerDayFor(the19th, 'NIGHT', at('07:45'))).toEqual(the18th);
  });

  it('from the evening on, it is tonight', () => {
    expect(marks.timerDayFor(the19th, 'NIGHT', at('19:40'))).toEqual(the19th);
    expect(marks.timerDayFor(the19th, 'NIGHT', at('23:55'))).toEqual(the19th);
  });

  it('a day shift is the day it is, however early somebody arrives', () => {
    expect(marks.timerDayFor(the19th, 'DAY', at('07:45'))).toEqual(the19th);
    expect(marks.timerDayFor(the19th, 'DAY', at('00:30'))).toEqual(the19th);
  });

  it('a day named on purpose is left alone', () => {
    const the15th = new Date('2026-11-15T00:00:00.000Z');
    expect(marks.timerDayFor(the15th, 'NIGHT', at('00:30'))).toEqual(the15th);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('clocking in', () => {
  it('is for somebody who is an employee', async () => {
    const res = await post('/attendance/clock-in', { employeeId: String(new mongoose.Types.ObjectId()), shift: 'DAY', date: ymd(today()) });
    // Before: 200, and a timer running for nobody.
    expect(res.status).toBe(404);
    expect(await Attendance.countDocuments({})).toBe(0);
  });

  it('still starts the timer for one who is', async () => {
    const emp = await makeEmp();
    const res = await post('/attendance/clock-in', { employeeId: String(emp._id), shift: 'DAY', date: ymd(today()) });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ shift: 'DAY', date: ymd(today()), status: 'present' });
  });
});

// ══════════════════════════════════════════════════════════════════
describe('the attendance summary', () => {
  it('counts each person\'s leave', async () => {
    const emp = await makeEmp();
    const day = (back) => new Date(today().getTime() - back * DAY);
    await Attendance.create([
      { employee: emp._id, date: day(3), shift: 'DAY', status: 'present' },
      { employee: emp._id, date: day(2), shift: 'DAY', status: 'on_leave' },
      { employee: emp._id, date: day(1), shift: 'DAY', status: 'on_leave' },
      { employee: emp._id, date: day(0), shift: 'DAY', status: 'half_day' },
    ]);

    const res = await get(`/attendance/summary?startDate=${ymd(day(3))}&endDate=${ymd(day(0))}`);
    expect(res.status).toBe(200);
    const mine = res.body.employees[0];
    // Before: onLeave 0, and a stray "on_leave": null beside it.
    expect(mine).toMatchObject({ total: 4, present: 1, onLeave: 2, halfDay: 1, absent: 0, late: 0 });
    expect(mine).not.toHaveProperty('on_leave');
    expect(res.body.factory.onLeaveCount).toBe(2);
  });
});

describe('the day\'s attendance list', () => {
  it('is in order of name', async () => {
    const [zed, abe, mani] = await Promise.all(['Zubair', 'Abhi', 'Mani'].map((name) => makeEmp({ name })));
    for (const e of [zed, abe, mani]) await Attendance.create({ employee: e._id, date: today(), shift: 'DAY', status: 'present' });
    const res = await get(`/attendance/date?date=${ymd(today())}&shift=DAY`);
    expect(res.body.data.records.map((r) => r.name)).toEqual(['Abhi', 'Mani', 'Zubair']);
  });
});
