'use strict';
// ══════════════════════════════════════════════════════════════════
//  LEAVE, AFTER IT HAS BEEN DECIDED
//
//  Four things could not be done once a request had been answered:
//
//    • an approval could not be taken back — the worker comes in after
//      all, or the wrong day was approved, and the shift stayed leave on
//      the sheet and on the payslip;
//    • a request that was refused could never be asked for again: a day
//      and shift takes one request, and the refused one stayed in the way;
//    • the office could not see what it had approved — the admin app's
//      leave tab asks for /leave/all, which did not exist;
//    • leave raised from the admin app (a first and a last day) was
//      refused for want of a `date`, and the note it sends with a
//      refusal was dropped.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, Employee, Attendance, LeaveRequest, Payroll, User, computePayroll, admin;

const YEAR = 2026, MONTH = 6, RATE = 100; // ₹100 an hour: a 12-hour shift is ₹1,200
const dstr = (day) => `${YEAR}-${String(MONTH).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
const dayOf = (day) => new Date(`${dstr(day)}T00:00:00.000Z`);
const signed = (user) => [`token=${jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET_KEY)}`];
const as = (user) => ({
  post: (url, body) => request(app).post(`/api/v2${url}`).set('Cookie', signed(user)).send(body),
  put:  (url, body) => request(app).put(`/api/v2${url}`).set('Cookie', signed(user)).send(body),
  get:  (url) => request(app).get(`/api/v2${url}`).set('Cookie', signed(user)),
});
const office = () => as(admin);
const makeEmp = (over = {}) => Employee.create({ name: 'Ravi', hourlyRate: RATE, ...over });
const mark = (day, records, shift = 'DAY') => office().post('/attendance/mark', { date: dstr(day), shift, records });
const rowOf = (emp, day, shift = 'DAY') => Attendance.findOne({ employee: emp._id, date: dayOf(day), shift }).lean();
const lines = (pay, re) => pay.lineItems.filter((l) => re.test(l.label));
const ask = (emp, day, over = {}) => office().post('/leave/admin-request', {
  employeeId: emp._id, date: dstr(day), shift: 'DAY', leaveType: 'casual', reason: 'family function', ...over,
});
const approved = async (emp, day, over = {}) => {
  const res = await ask(emp, day, { autoApprove: true, ...over });
  expect(res.status).toBe(201);
  return res.body.data.id;
};
const withdraw = (id, body = {}) => office().put(`/leave/${id}/withdraw`, body);

async function makeWorker(name = 'Mani') {
  const emp = await makeEmp({ name });
  const user = await User.create({
    name, email: `${name.toLowerCase()}@t.co`, password: 'pass1234', role: 'production',
    department: 'production', employee: emp._id,
  });
  return { emp, user };
}

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  Employee = require('../../models/Employee');
  Attendance = require('../../models/Attendence.js');
  LeaveRequest = require('../../models/LeaveRequest');
  Payroll = require('../../models/Payroll');
  User = require('../../models/User');
  computePayroll = require('../../services/payrollService').computePayroll;
  await Attendance.init();
  await LeaveRequest.init();
  admin = await User.create({ name: 'Asha', email: 'o@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
  await User.deleteMany({ _id: { $ne: admin._id } });
});

describe('an approval taken back', () => {
  it('takes the leave off the sheet it was written onto: the shift is unmarked again', async () => {
    const emp = await makeEmp();
    await mark(2, [{ employeeId: emp._id, status: 'present' }]);
    const id = await approved(emp, 5);
    expect(await rowOf(emp, 5)).toMatchObject({ status: 'on_leave', isApprovedLeave: true });
    const before = await computePayroll(emp._id, YEAR, MONTH);
    expect(before.approvedLeaveShifts).toBe(1);
    expect(before.grossEarnings).toBe(1200); // the shift worked; approved leave is unpaid

    const res = await withdraw(id, { note: 'coming in after all' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ attendance: { removed: 1, unapproved: 0, kept: 0 }, payslipFinal: false });
    expect(res.body.data).toMatchObject({ status: 'rejected', reviewNotes: 'Approval withdrawn — coming in after all' });

    expect(await rowOf(emp, 5)).toBeNull();
    const sheet = await office().get(`/attendance/date?date=${dstr(5)}&shift=DAY`);
    expect(sheet.body.data.unmarked.map((u) => String(u.id))).toContain(String(emp._id));

    const pay = await computePayroll(emp._id, YEAR, MONTH);
    expect(pay.approvedLeaveShifts).toBe(0);
    expect(pay.grossEarnings).toBe(1200);
  });

  it('a shift somebody marked "on leave" by hand stays as they marked it, and is no longer approved', async () => {
    const emp = await makeEmp();
    await mark(5, [{ employeeId: emp._id, status: 'on_leave', leaveType: 'casual', notes: 'rang in the morning' }]);
    const asked = await ask(emp, 5);
    await office().put(`/leave/${asked.body.data.id}/approve`, {});
    expect(await rowOf(emp, 5)).toMatchObject({ isApprovedLeave: true });

    const res = await withdraw(asked.body.data.id);
    expect(res.body.attendance).toEqual({ removed: 0, unapproved: 1, kept: 0 });
    expect(res.body.data.reviewNotes).toBe('Approval withdrawn');
    const row = await rowOf(emp, 5);
    expect(row).toMatchObject({ status: 'on_leave', isApprovedLeave: false, leaveRequestId: null, notes: 'rang in the morning' });

    const pay = await computePayroll(emp._id, YEAR, MONTH);
    expect(pay.approvedLeaveShifts).toBe(0);
    expect(lines(pay, /Absent — pay lost/)).toHaveLength(1);
  });

  it('leave for the whole day comes off both shifts', async () => {
    const emp = await makeEmp();
    const id = await approved(emp, 6, { shift: 'BOTH' });
    expect(await Attendance.countDocuments({ employee: emp._id })).toBe(2);
    expect((await withdraw(id)).body.attendance).toMatchObject({ removed: 2 });
    expect(await Attendance.countDocuments({ employee: emp._id })).toBe(0);
  });

  it('a shift they worked after all is left as worked', async () => {
    const emp = await makeEmp();
    const id = await approved(emp, 5);
    await mark(5, [{ employeeId: emp._id, status: 'present' }]);

    expect((await withdraw(id)).body.attendance).toEqual({ removed: 0, unapproved: 0, kept: 0 });
    expect(await rowOf(emp, 5)).toMatchObject({ status: 'present', isApprovedLeave: false, leaveRequestId: null, hoursWorked: 12 });
  });

  it('where another approved request still covers the shift, the shift is that leave from here on', async () => {
    const emp = await makeEmp();
    const id = await approved(emp, 5);
    // One for the whole day as well — written straight in, as two could be before.
    const whole = await LeaveRequest.create({
      employee: emp._id, date: dayOf(5), shift: 'BOTH', leaveType: 'sick', reason: 'fever', status: 'approved',
    });

    expect((await withdraw(id)).body.attendance).toEqual({ removed: 0, unapproved: 0, kept: 1 });
    expect(await rowOf(emp, 5)).toMatchObject({
      status: 'on_leave', isApprovedLeave: true, leaveRequestId: whole._id, leaveType: 'sick',
    });
  });

  it('only an approved leave, and only once', async () => {
    const emp = await makeEmp();
    const pending = await ask(emp, 5);
    const refused = await withdraw(pending.body.data.id);
    expect(refused.status).toBe(400);
    expect(refused.body.message).toBe('Only an approved leave can be withdrawn — this one is pending.');

    const id = await approved(emp, 6);
    expect((await withdraw(id)).status).toBe(200);
    const again = await withdraw(id);
    expect(again.status).toBe(400);
    expect(again.body.message).toMatch(/this one is rejected/);

    expect((await withdraw(new mongoose.Types.ObjectId())).status).toBe(404);
    expect((await withdraw('not-an-id')).status).toBe(404);
  });

  it('two people withdrawing it together: one does, and the sheet is undone once', async () => {
    const emp = await makeEmp();
    const id = await approved(emp, 6, { shift: 'BOTH' });
    const both = await Promise.all([withdraw(id), withdraw(id)]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 400]);
    expect(both.find((r) => r.status === 200).body.attendance.removed).toBe(2);
    expect(await Attendance.countDocuments({ employee: emp._id })).toBe(0);
  });

  it('says when the month\'s payslip was already finalised with the leave on it', async () => {
    const emp = await makeEmp();
    const id = await approved(emp, 5);
    await Payroll.create({ employee: emp._id, year: YEAR, month: MONTH, status: 'paid' });
    expect((await withdraw(id)).body.payslipFinal).toBe(true);
  });

  it('is for the office: a worker cannot withdraw anybody\'s, their own included', async () => {
    const { emp, user } = await makeWorker();
    const id = await approved(emp, 5);
    expect((await as(user).put(`/leave/${id}/withdraw`, {})).status).toBe(403);
    expect((await LeaveRequest.findById(id)).status).toBe('approved');
  });
});

describe('asking again', () => {
  it('a request that was refused no longer stands in the way of a new one', async () => {
    const { emp, user } = await makeWorker();
    const first = await as(user).post('/leave/request', { date: dstr(9), shift: 'DAY', leaveType: 'casual', reason: 'work' });
    expect(first.status).toBe(201);
    await office().put(`/leave/${first.body.data.id}/reject`, { note: 'say why' });

    const second = await as(user).post('/leave/request', {
      date: dstr(9), shift: 'DAY', leaveType: 'sick', reason: 'hospital appointment for my mother',
    });
    expect(second.status).toBe(201);
    const all = await LeaveRequest.find({ employee: emp._id }).lean();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ status: 'pending', leaveType: 'sick' });
  });

  it('the office can raise it again after an approval was withdrawn', async () => {
    const emp = await makeEmp();
    await withdraw(await approved(emp, 5));
    const id = await approved(emp, 5, { leaveType: 'unpaid' });
    expect(await LeaveRequest.countDocuments({ employee: emp._id })).toBe(1);
    expect(await rowOf(emp, 5)).toMatchObject({ status: 'on_leave', leaveType: 'unpaid', leaveRequestId: new mongoose.Types.ObjectId(id) });
  });

  it('CONTROL: one still waiting, or approved, does stand in the way', async () => {
    const emp = await makeEmp();
    expect((await ask(emp, 5)).status).toBe(201);
    const dupe = await ask(emp, 5);
    expect(dupe.status).toBe(409);
    expect(dupe.body.message).toBe('A leave request already exists for this date and shift.');
    await approved(emp, 6);
    expect((await ask(emp, 6)).status).toBe(409);
    expect(await LeaveRequest.countDocuments({ employee: emp._id })).toBe(2);
  });

  it('the whole day cannot be asked for beside one of its shifts, nor a shift beside the whole day', async () => {
    const emp = await makeEmp();
    expect((await ask(emp, 5, { shift: 'DAY' })).status).toBe(201);
    expect((await ask(emp, 5, { shift: 'BOTH' })).status).toBe(409);
    expect((await ask(emp, 5, { shift: 'NIGHT' })).status).toBe(201); // the other shift is its own request

    expect((await ask(emp, 6, { shift: 'BOTH' })).status).toBe(201);
    expect((await ask(emp, 6, { shift: 'NIGHT' })).status).toBe(409);
  });
});

describe('leave raised from the admin app: a first and a last day', () => {
  const raise = (emp, body) => office().post('/leave/request', {
    employeeId: String(emp._id), shift: 'DAY', leaveType: 'casual', reason: 'village festival', ...body,
  });

  it('is a request for each day of the span', async () => {
    const emp = await makeEmp();
    const res = await raise(emp, { startDate: dstr(10), endDate: dstr(12) });
    expect(res.status).toBe(201);
    expect(res.body.count).toBe(3);
    expect(res.body.message).toMatch(/^3 leave requests submitted/);
    const days = (await LeaveRequest.find({ employee: emp._id }).sort({ date: 1 }).lean())
      .map((l) => l.date.toISOString().slice(0, 10));
    expect(days).toEqual([dstr(10), dstr(11), dstr(12)]);
  });

  it('one day when only the first is given, or both are the same', async () => {
    const emp = await makeEmp();
    expect((await raise(emp, { startDate: dstr(10) })).body.count).toBe(1);
    expect((await raise(emp, { startDate: dstr(11), endDate: dstr(11) })).body.count).toBe(1);
    expect(await LeaveRequest.countDocuments({ employee: emp._id })).toBe(2);
  });

  it('all of the days or none: one already asked for refuses the span', async () => {
    const emp = await makeEmp();
    await ask(emp, 11);
    const res = await raise(emp, { startDate: dstr(10), endDate: dstr(12) });
    expect(res.status).toBe(409);
    expect(await LeaveRequest.countDocuments({ employee: emp._id })).toBe(1);
  });

  it('a span that is not one is refused in words', async () => {
    const emp = await makeEmp();
    const cases = [
      [{ startDate: dstr(12), endDate: dstr(10) }, 'endDate is before startDate.'],
      [{ startDate: dstr(1), endDate: '2026-08-15' }, 'One request can cover at most 31 days.'],
      [{ startDate: 'soon' }, 'startDate is not a valid date.'],
      [{ startDate: dstr(10), endDate: 'later' }, 'endDate is not a valid date.'],
      [{}, 'date, leaveType, reason are required.'],
    ];
    for (const [body, message] of cases) {
      const res = await raise(emp, body);
      expect([res.status, res.body.message]).toEqual([400, message]);
    }
    expect(await LeaveRequest.countDocuments({})).toBe(0);
  });

  it('CONTROL: a single `date` is one request, as it always was', async () => {
    const emp = await makeEmp();
    const res = await raise(emp, { date: dstr(10), startDate: dstr(1), endDate: dstr(30) });
    expect(res.status).toBe(201);
    expect(res.body.count).toBe(1);
    expect(res.body.data.date).toBe(dstr(10));
  });

  it('the note sent with a refusal is kept, under the name the admin app sends it by', async () => {
    const emp = await makeEmp();
    const asked = await ask(emp, 5);
    const res = await office().put(`/leave/${asked.body.data.id}/reject`, { adminRemarks: 'three people are already off that day' });
    expect(res.body.data.reviewNotes).toBe('three people are already off that day');
  });
});

describe('what the office has decided', () => {
  const list = (query = '') => office().get(`/leave/all${query}`);

  it('lists requests by what became of them, with whose they are', async () => {
    const [a, b] = [await makeEmp({ department: 'weaving' }), await makeEmp({ name: 'Mani' })];
    await approved(a, 5);
    const waiting = await ask(b, 7);
    const refused = await ask(b, 8);
    await office().put(`/leave/${refused.body.data.id}/reject`, {});

    const everything = await list();
    expect(everything.status).toBe(200);
    expect(everything.body.count).toBe(3);
    // Latest day first.
    expect(everything.body.data.map((l) => l.date)).toEqual([dstr(8), dstr(7), dstr(5)]);

    const ok = await list('?status=approved');
    expect(ok.body.data).toHaveLength(1);
    expect(ok.body.data[0]).toMatchObject({
      employeeName: 'Ravi', employeeDept: 'weaving', date: dstr(5), shift: 'DAY', leaveType: 'casual', status: 'approved',
    });
    expect((await list('?status=pending')).body.data.map((l) => String(l.id))).toEqual([String(waiting.body.data.id)]);
    expect((await list('?status=all')).body.count).toBe(3);
  });

  it('by month, as the admin app asks, or between two days', async () => {
    const emp = await makeEmp();
    await approved(emp, 5);
    await LeaveRequest.create({
      employee: emp._id, date: new Date('2026-07-03T00:00:00.000Z'), shift: 'DAY', leaveType: 'sick', reason: 'x', status: 'approved',
    });

    expect((await list(`?status=approved&year=${YEAR}&month=${MONTH}`)).body.data.map((l) => l.date)).toEqual([dstr(5)]);
    expect((await list(`?year=${YEAR}&month=7`)).body.data.map((l) => l.date)).toEqual(['2026-07-03']);
    expect((await list(`?from=${dstr(5)}&to=${dstr(5)}`)).body.count).toBe(1);
    expect((await list(`?from=${dstr(6)}`)).body.data.map((l) => l.date)).toEqual(['2026-07-03']);
    expect((await list(`?to=${dstr(4)}`)).body.count).toBe(0);
  });

  it('refuses what is not a status, a month or a day', async () => {
    for (const [query, message] of [
      ['?status=maybe', 'status must be pending, approved, rejected or all.'],
      ['?year=2026&month=13', 'year and month are not a valid month.'],
      ['?from=whenever', 'from is not a valid date.'],
      ['?to=whenever', 'to is not a valid date.'],
    ]) {
      const res = await list(query);
      expect([res.status, res.body.message]).toEqual([400, message]);
    }
  });

  it('is the office\'s list: a worker is refused', async () => {
    const { user } = await makeWorker();
    expect((await as(user).get('/leave/all')).status).toBe(403);
  });
});
