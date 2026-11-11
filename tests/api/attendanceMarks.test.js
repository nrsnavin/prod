'use strict';
// ══════════════════════════════════════════════════════════════════
//  WHAT A MARK BECOMES — and leave, attendance and pay agreeing
//
//  Two screens mark attendance: the web marks the people not yet marked,
//  the admin app sends the whole day back. Held here:
//
//    • a row sent back as it already stands changes nothing — the
//      overtime entered on the web and the minutes the timer recorded
//      used to be reset to 0 by the next Save from the admin app;
//    • only what is sent changes, and what is sent is checked: a status
//      the model does not know was stored as sent and paid as a full
//      shift, an edit left the hours as they were;
//    • a shift is approved leave when it is marked "on leave" and an
//      approved request covers it, whichever came first — leave approved
//      ahead of the day used to be lost, and paid as an absence;
//    • leave approved as unpaid is not paid;
//    • somebody who came in after all is paid for the work, not the leave.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, Employee, Attendance, LeaveRequest, User, computePayroll, admin;

const YEAR = 2026, MONTH = 6, RATE = 100; // ₹100 an hour: a 12-hour shift is ₹1,200
const dstr = (day) => `${YEAR}-${String(MONTH).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
const post = (url, body) => request(app).post(`/api/v2${url}`).set('Cookie', cookie()).send(body);
const put  = (url, body) => request(app).put(`/api/v2${url}`).set('Cookie', cookie()).send(body);
const get  = (url) => request(app).get(`/api/v2${url}`).set('Cookie', cookie());
const makeEmp = (over = {}) => Employee.create({ name: 'Ravi', hourlyRate: RATE, ...over });
const mark = (day, records, shift = 'DAY') => post('/attendance/mark', { date: dstr(day), shift, records });
const rowOf = (emp, day, shift = 'DAY') =>
  Attendance.findOne({ employee: emp._id, date: new Date(`${dstr(day)}T00:00:00.000Z`), shift }).lean();
const lines = (pay, re) => pay.lineItems.filter((l) => re.test(l.label));

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  Employee = require('../../models/Employee');
  Attendance = require('../../models/Attendence.js');
  LeaveRequest = require('../../models/LeaveRequest');
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
});

// What the admin app sends for a row it has on screen: the fields it
// knows, and nothing about overtime or worked minutes.
const asTheAdminAppSendsIt = (row) => ({
  employeeId: String(row.employee), status: row.status, checkIn: row.checkIn, checkOut: row.checkOut,
  lateMinutes: row.lateMinutes, leaveType: row.leaveType, notes: row.notes,
});

describe('a row sent back as it stands', () => {
  it('keeps the overtime entered on the web', async () => {
    const emp = await makeEmp();
    expect((await mark(2, [{ employeeId: emp._id, status: 'present', overtimeMinutes: 150 }])).status).toBe(200);
    const before = await rowOf(emp, 2);
    expect(before.overtimeMinutes).toBe(150);

    const res = await mark(2, [asTheAdminAppSendsIt(before)]);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ upserted: 0, modified: 0, unchanged: 1 });
    const after = await rowOf(emp, 2);
    expect(after.overtimeMinutes).toBe(150);
    expect(after.updatedAt).toEqual(before.updatedAt);
  });

  it('keeps the minutes the timer recorded, and whose mark it was', async () => {
    const emp = await makeEmp();
    await post('/attendance/clock-in', { employeeId: emp._id, shift: 'DAY', date: dstr(2) });
    await Attendance.updateOne({ employee: emp._id }, { $set: { clockInAt: new Date(Date.now() - 8 * 3600_000), markedBy: 'Kumar' } });
    await post('/attendance/clock-out', { employeeId: emp._id, shift: 'DAY', date: dstr(2) });
    const before = await rowOf(emp, 2);
    expect(before.workedMinutes).toBeGreaterThanOrEqual(479);
    expect(before.hoursWorked).toBeCloseTo(8, 1);
    await Attendance.updateOne({ _id: before._id }, { $set: { markedBy: 'Kumar' } });

    expect((await mark(2, [asTheAdminAppSendsIt(before)])).status).toBe(200);
    const after = await rowOf(emp, 2);
    expect(after.workedMinutes).toBe(before.workedMinutes);
    expect(after.hoursWorked).toBe(before.hoursWorked);
    expect(after.markedBy).toBe('Kumar');
  });

  it('is marked alongside the people who are new to the day', async () => {
    const [a, b] = [await makeEmp(), await makeEmp({ name: 'Mani' })];
    await mark(2, [{ employeeId: a._id, status: 'late', lateMinutes: 30 }]);
    const res = await mark(2, [
      asTheAdminAppSendsIt(await rowOf(a, 2)),
      { employeeId: b._id, status: 'present', checkIn: '', checkOut: '', lateMinutes: 0, leaveType: '', notes: '' },
    ]);
    expect(res.body).toMatchObject({ upserted: 1, modified: 0, unchanged: 1 });
    expect(await rowOf(b, 2)).toMatchObject({ status: 'present', hoursWorked: 12, markedBy: 'Asha' });
  });
});

describe('only what is sent changes', () => {
  it('a status alone: the hours follow it, the rest stays', async () => {
    const emp = await makeEmp();
    await mark(2, [{ employeeId: emp._id, status: 'present', overtimeMinutes: 60, notes: 'covered loom 4' }]);
    const res = await mark(2, [{ employeeId: emp._id, status: 'absent' }]);
    expect(res.body).toMatchObject({ modified: 1, unchanged: 0 });
    expect(await rowOf(emp, 2)).toMatchObject({
      status: 'absent', hoursWorked: 0, overtimeMinutes: 60, notes: 'covered loom 4',
    });
  });

  it('in and out times set the minutes worked; taking them away pays the shift again', async () => {
    const emp = await makeEmp();
    await mark(2, [{ employeeId: emp._id, status: 'present', checkIn: '20:00', checkOut: '04:30' }], 'NIGHT');
    expect(await rowOf(emp, 2, 'NIGHT')).toMatchObject({ workedMinutes: 510, hoursWorked: 8.5 });

    await mark(2, [{ employeeId: emp._id, status: 'present', checkIn: '', checkOut: '' }], 'NIGHT');
    expect(await rowOf(emp, 2, 'NIGHT')).toMatchObject({ workedMinutes: 0, hoursWorked: 12 });
  });

  it('the shift is read whatever its case', async () => {
    const emp = await makeEmp();
    const res = await post('/attendance/mark', { date: dstr(2), shift: 'night', records: [{ employeeId: emp._id, status: 'present' }] });
    expect(res.status).toBe(200);
    expect(await rowOf(emp, 2, 'NIGHT')).toBeTruthy();
  });
});

describe('what is sent is checked', () => {
  it.each([
    ['a status the register does not have', { status: 'untracked' }, /records\.0\.status: must be present, late, half_day, absent or on_leave/],
    ['minutes below zero', { status: 'late', lateMinutes: -5 }, /records\.0\.lateMinutes: cannot be less than 0/],
    ['more overtime than a day holds', { status: 'present', overtimeMinutes: 5000 }, /records\.0\.overtimeMinutes: cannot be more than a day/],
    ['minutes that are not a number', { status: 'present', workedMinutes: 'lots' }, /records\.0\.workedMinutes must be a number/],
    ['a time that is not one', { status: 'present', checkIn: '25:00' }, /records\.0\.checkIn: must be a time like 08:30/],
    ['a leave type the register does not have', { status: 'on_leave', leaveType: 'holiday' }, /records\.0\.leaveType: must be/],
  ])('%s is refused, and nothing is written', async (_what, fields, message) => {
    const emp = await makeEmp();
    const res = await mark(2, [{ employeeId: emp._id, ...fields }]);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(message);
    expect(await Attendance.countDocuments({})).toBe(0);
  });

  it('one bad row refuses the whole sheet', async () => {
    const [a, b] = [await makeEmp(), await makeEmp({ name: 'Mani' })];
    const res = await mark(2, [{ employeeId: a._id, status: 'present' }, { employeeId: b._id, status: 'nope' }]);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/records\.1\.status/);
    expect(await Attendance.countDocuments({})).toBe(0);
  });

  it('somebody who is not an employee, or the same person twice, is refused', async () => {
    const emp = await makeEmp();
    const nobody = await mark(2, [{ employeeId: emp._id, status: 'present' }, { employeeId: new mongoose.Types.ObjectId(), status: 'present' }]);
    expect(nobody.status).toBe(400);
    expect(nobody.body.message).toMatch(/records\.1\.employeeId: no such employee/);
    expect(await Attendance.countDocuments({})).toBe(0);

    const twice = await mark(2, [{ employeeId: emp._id, status: 'present' }, { employeeId: emp._id, status: 'absent' }]);
    expect(twice.status).toBe(400);
    expect(twice.body.message).toMatch(/more than once/);

    expect((await mark(2, [{ employeeId: 'ravi', status: 'present' }])).status).toBe(400);
  });

  it('a day that is not a date, a shift that is not one, an empty sheet', async () => {
    const emp = await makeEmp();
    const rec = [{ employeeId: emp._id, status: 'present' }];
    expect((await post('/attendance/mark', { date: 'someday', shift: 'DAY', records: rec })).status).toBe(400);
    expect((await post('/attendance/mark', { date: dstr(2), shift: 'EVENING', records: rec })).status).toBe(400);
    expect((await post('/attendance/mark', { date: dstr(2), shift: 7, records: rec })).status).toBe(400);
    expect((await post('/attendance/mark', { date: dstr(2), shift: 'DAY', records: [] })).body.message).toMatch(/must not be empty/);
    expect((await post('/attendance/mark', { shift: 'DAY', records: rec })).body.message).toMatch(/date and shift required/);
  });
});

describe('correcting one mark', () => {
  it('the hours follow the correction', async () => {
    const emp = await makeEmp();
    await mark(2, [{ employeeId: emp._id, status: 'present' }]);
    const row = await rowOf(emp, 2);
    expect(row.hoursWorked).toBe(12);

    const absent = await put(`/attendance/${row._id}`, { status: 'absent' });
    expect(absent.status).toBe(200);
    expect(absent.body.data).toMatchObject({ status: 'absent', markedBy: 'Asha' });
    expect((await rowOf(emp, 2)).hoursWorked).toBe(0);

    const late = await put(`/attendance/${row._id}`, { status: 'late', lateMinutes: 90 });
    expect(late.status).toBe(200);
    expect((await rowOf(emp, 2)).hoursWorked).toBe(10.5);

    const timed = await put(`/attendance/${row._id}`, { status: 'present', checkIn: '08:00', checkOut: '14:00' });
    expect(timed.body.data.workedMinutes).toBe(360);
    expect((await rowOf(emp, 2)).hoursWorked).toBe(6);
  });

  it('is checked like a row of the sheet, and says when there is no such record', async () => {
    const emp = await makeEmp();
    await mark(2, [{ employeeId: emp._id, status: 'present' }]);
    const row = await rowOf(emp, 2);
    const bad = await put(`/attendance/${row._id}`, { status: 'half' });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toMatch(/status: must be/);
    expect((await put(`/attendance/${row._id}`, { lateMinutes: -1 })).status).toBe(400);
    expect((await rowOf(emp, 2)).status).toBe('present');

    expect((await put(`/attendance/${new mongoose.Types.ObjectId()}`, { status: 'absent' })).status).toBe(404);
    expect((await put('/attendance/not-an-id', { status: 'absent' })).status).toBe(404);
  });

  it('a correction that changes nothing writes nothing, and names nobody', async () => {
    const emp = await makeEmp();
    await mark(2, [{ employeeId: emp._id, status: 'present' }]);
    const before = await rowOf(emp, 2);
    await Attendance.updateOne({ _id: before._id }, { $set: { markedBy: 'Kumar' } });
    const res = await put(`/attendance/${before._id}`, { status: 'present' });
    expect(res.status).toBe(200);
    expect((await rowOf(emp, 2)).markedBy).toBe('Kumar');
  });
});

describe('leave approved ahead of the day', () => {
  const ask = (emp, day, over = {}) => post('/leave/admin-request', {
    employeeId: emp._id, date: dstr(day), shift: 'DAY', leaveType: 'casual', reason: 'family function', ...over,
  });

  it('is on the day\'s sheet as leave from the moment it is approved: unpaid, and not an absence', async () => {
    const emp = await makeEmp();
    const asked = await ask(emp, 5);
    expect(asked.status).toBe(201);
    expect(await rowOf(emp, 5)).toBeNull(); // only asked for

    const ok = await put(`/leave/${asked.body.data.id}/approve`, {});
    expect(ok.status).toBe(200);
    expect(await rowOf(emp, 5)).toMatchObject({
      status: 'on_leave', leaveType: 'casual', isApprovedLeave: true, hoursWorked: 0, markedBy: 'leave_approval',
    });

    // The sheet for the day shows them, on leave, not waiting to be marked.
    const sheet = await get(`/attendance/date?date=${dstr(5)}&shift=DAY`);
    expect(sheet.body.data.unmarked.map((u) => String(u.id))).not.toContain(String(emp._id));
    expect(sheet.body.data.records[0]).toMatchObject({ status: 'on_leave' });

    const pay = await computePayroll(emp._id, YEAR, MONTH);
    expect(pay.approvedLeaveShifts).toBe(1);
    expect(pay.absentShifts).toBe(0);
    // Approved leave is unpaid (the owner's decision): no pay, no penalty.
    expect(lines(pay, /Approved casual leave — unpaid/)).toEqual([expect.objectContaining({ amount: 0 })]);
    expect(pay.grossEarnings).toBe(0);
  });

  it('comes to the same pay whichever came first, the approval or the mark', async () => {
    const [first, second] = [await makeEmp(), await makeEmp({ name: 'Mani' })];

    // Approved, then the day is marked (the admin app sends it back as on leave).
    const a = await ask(first, 5);
    await put(`/leave/${a.body.data.id}/approve`, {});
    await mark(5, [asTheAdminAppSendsIt(await rowOf(first, 5))]);

    // Marked on leave, then approved.
    await mark(5, [{ employeeId: second._id, status: 'on_leave', leaveType: 'casual' }]);
    const b = await ask(second, 5);
    await put(`/leave/${b.body.data.id}/approve`, {});

    const [p1, p2] = [await computePayroll(first._id, YEAR, MONTH), await computePayroll(second._id, YEAR, MONTH)];
    // Both are approved leave: unpaid, and neither is an absence.
    expect([p1.approvedLeaveShifts, p2.approvedLeaveShifts]).toEqual([1, 1]);
    expect(p1.absentShifts + p2.absentShifts).toBe(0);
    expect(p2.grossEarnings).toBe(p1.grossEarnings);
    expect(p2.netPay).toBe(p1.netPay);
  });

  it('a request approved before this was so is picked up when the day is marked on leave', async () => {
    const emp = await makeEmp();
    // As it was left by the old approval: approved, and no row for the day.
    const leave = await LeaveRequest.create({
      employee: emp._id, date: new Date(`${dstr(5)}T00:00:00.000Z`), shift: 'BOTH',
      leaveType: 'sick', reason: 'fever', status: 'approved',
    });
    await mark(5, [{ employeeId: emp._id, status: 'on_leave', leaveType: 'casual' }]);
    expect(await rowOf(emp, 5)).toMatchObject({
      status: 'on_leave', isApprovedLeave: true, leaveType: 'sick', leaveRequestId: leave._id,
    });
    // Marked absent instead, it is an absence: the mark is somebody's word for the day.
    await mark(5, [{ employeeId: emp._id, status: 'absent' }], 'NIGHT');
    expect((await rowOf(emp, 5, 'NIGHT')).isApprovedLeave).toBeFalsy();
  });

  it('created already approved, it is on the sheet too — both shifts when it covers both', async () => {
    const emp = await makeEmp();
    const res = await ask(emp, 6, { shift: 'BOTH', autoApprove: true });
    expect(res.status).toBe(201);
    expect(await rowOf(emp, 6, 'DAY')).toMatchObject({ status: 'on_leave', isApprovedLeave: true });
    expect(await rowOf(emp, 6, 'NIGHT')).toMatchObject({ status: 'on_leave', isApprovedLeave: true });
    // Asked for twice: refused, and nothing half-written.
    expect((await ask(emp, 6, { shift: 'BOTH', autoApprove: true })).status).toBe(409);
    expect(await Attendance.countDocuments({ employee: emp._id })).toBe(2);
  });

  it('CONTROL: a request refused, or only asked for, marks nothing', async () => {
    const emp = await makeEmp();
    const asked = await ask(emp, 5);
    await put(`/leave/${asked.body.data.id}/reject`, {});
    expect(await Attendance.countDocuments({})).toBe(0);
    await mark(5, [{ employeeId: emp._id, status: 'on_leave', leaveType: 'casual' }]);
    expect((await rowOf(emp, 5)).isApprovedLeave).toBeFalsy();
  });
});

describe('leave approved as unpaid', () => {
  it('is not paid, and is not an absence', async () => {
    const emp = await makeEmp();
    await mark(2, [{ employeeId: emp._id, status: 'present' }]);
    const res = await post('/leave/admin-request', {
      employeeId: emp._id, date: dstr(5), shift: 'DAY', leaveType: 'unpaid', reason: 'travel', autoApprove: true,
    });
    expect(res.status).toBe(201);

    const pay = await computePayroll(emp._id, YEAR, MONTH);
    expect(pay.grossEarnings).toBe(1200); // the one shift worked
    expect(pay.approvedLeaveShifts).toBe(1);
    expect(pay.absentShifts).toBe(0);
    expect(pay.excessAbsents).toBe(0);
    expect(lines(pay, /Approved leave — unpaid/)).toEqual([expect.objectContaining({ amount: 0 })]);
    expect(lines(pay, /Approved Leave — paid/)).toHaveLength(0);
  });

  it('leave approved as casual is unpaid too, and not an absence', async () => {
    const emp = await makeEmp();
    await post('/leave/admin-request', {
      employeeId: emp._id, date: dstr(5), shift: 'DAY', leaveType: 'casual', reason: 'x', autoApprove: true,
    });
    const pay = await computePayroll(emp._id, YEAR, MONTH);
    expect(pay.grossEarnings).toBe(0);
    expect(pay.absentShifts).toBe(0);
    expect(lines(pay, /Approved casual leave — unpaid/)).toEqual([expect.objectContaining({ amount: 0 })]);
  });
});

describe('somebody on approved leave who came in after all', () => {
  const approved = async (emp, leaveType = 'unpaid') => post('/leave/admin-request', {
    employeeId: emp._id, date: dstr(5), shift: 'DAY', leaveType, reason: 'x', autoApprove: true,
  });

  it('clocked in: paid for the hours on the clock, not the leave', async () => {
    const emp = await makeEmp();
    await approved(emp);
    const ci = await post('/attendance/clock-in', { employeeId: emp._id, shift: 'DAY', date: dstr(5) });
    expect(ci.status).toBe(200);
    await Attendance.updateOne({ employee: emp._id }, { $set: { clockInAt: new Date(Date.now() - 6 * 3600_000) } });
    await post('/attendance/clock-out', { employeeId: emp._id, shift: 'DAY', date: dstr(5) });

    expect(await rowOf(emp, 5)).toMatchObject({ status: 'present', isApprovedLeave: false, leaveType: '' });
    const pay = await computePayroll(emp._id, YEAR, MONTH);
    expect(pay.approvedLeaveShifts).toBe(0);
    expect(pay.grossEarnings).toBeCloseTo(600, 0);
  });

  it('marked present on the sheet: a worked shift', async () => {
    const emp = await makeEmp();
    await approved(emp, 'casual');
    await mark(5, [{ employeeId: emp._id, status: 'present', leaveType: 'casual' }]);
    expect(await rowOf(emp, 5)).toMatchObject({ status: 'present', isApprovedLeave: false, leaveType: '', hoursWorked: 12 });
    const pay = await computePayroll(emp._id, YEAR, MONTH);
    expect(pay.approvedLeaveShifts).toBe(0);
    expect(pay.presentShifts).toBe(1);

    // …and marked back as on leave, it is that leave again.
    await mark(5, [{ employeeId: emp._id, status: 'on_leave' }]);
    expect(await rowOf(emp, 5)).toMatchObject({ status: 'on_leave', isApprovedLeave: true, leaveType: 'casual' });
  });

  it('leave approved for a shift already on the clock leaves the shift as worked', async () => {
    const emp = await makeEmp();
    await post('/attendance/clock-in', { employeeId: emp._id, shift: 'DAY', date: dstr(5) });
    await approved(emp);
    expect(await rowOf(emp, 5)).toMatchObject({ status: 'present' });
    expect((await rowOf(emp, 5)).isApprovedLeave).toBeFalsy();
  });
});

describe('production verified for somebody on approved leave', () => {
  // A loom, a job on it, and a shift planned for the operator today.
  async function shiftFor(operator) {
    const M = Object.fromEntries(['Customer', 'Elastic', 'Order', 'JobOrder', 'Machine', 'ShiftDetail']
      .map((n) => [n, require(`../../models/${n}.js`)]));
    const customer = await M.Customer.create({ name: 'Acme', contactName: 'R', phoneNumber: '9000000001' });
    const elastic = await M.Elastic.create({
      name: `25mm Woven ${Math.random().toString(36).slice(2, 7)}`, weaveType: '8',
      spandexEnds: 40, yarnEnds: 120, pick: 12, noOfHook: 8, weight: 2.4,
    });
    const order = await M.Order.create({
      orderNo: Math.floor(Math.random() * 100000), customer: customer._id, status: 'InProgress', po: 'PO-1',
      date: new Date(), supplyDate: new Date(), elasticOrdered: [{ elastic: elastic._id, quantity: 100000 }],
    });
    const job = await M.JobOrder.create({
      date: new Date(), order: order._id, customer: customer._id, status: 'weaving',
      elastics: [{ elastic: elastic._id, quantity: 100000 }],
    });
    const machine = await M.Machine.create({
      ID: `M-${Math.floor(Math.random() * 100000)}`, manufacturer: 'Comez',
      NoOfHead: 2, NoOfHooks: 8, status: 'free', orderRunning: null, elastics: [],
    });
    const planned = await post('/job/plan-weaving', {
      jobId: String(job._id), machineId: String(machine._id),
      headElasticMap: { 0: String(elastic._id), 1: String(elastic._id) },
    });
    expect(planned.status).toBe(200);
    const { createShiftPlan } = require('../../services/shiftPlanCreate');
    const { shiftPlan } = await createShiftPlan({
      date: new Date().toISOString().slice(0, 10), shiftType: 'DAY',
      machines: [{ machine: machine._id, operator: operator._id }],
    });
    return M.ShiftDetail.findOne({ shiftPlan: shiftPlan._id });
  }
  const dayOf = (shift) => require('../../utils/factoryDay').ymd(shift.date);
  const todayRow = (emp, shift) => Attendance.findOne({ employee: emp._id, shift: 'DAY', date: require('../../utils/factoryDay').calendarDay(shift.date) }).lean();

  it('the leave row nobody has marked since becomes a worked shift', async () => {
    const emp = await makeEmp({ department: 'weaving' });
    const shift = await shiftFor(emp);
    const leave = await post('/leave/admin-request', {
      employeeId: emp._id, date: dayOf(shift), shift: 'DAY', leaveType: 'unpaid', reason: 'x', autoApprove: true,
    });
    expect(leave.status).toBe(201);
    expect(await todayRow(emp, shift)).toMatchObject({ status: 'on_leave', isApprovedLeave: true, markedBy: 'leave_approval' });

    const res = await post('/shift/verify-production', { shiftId: String(shift._id), productionMeters: 100 });
    expect(res.status).toBe(200);
    expect(await todayRow(emp, shift)).toMatchObject({
      status: 'present', isApprovedLeave: false, leaveType: '', hoursWorked: 12, markedBy: 'auto_shift_verify',
    });
  });

  it('CONTROL: a mark somebody made by hand is left as they made it', async () => {
    const emp = await makeEmp({ department: 'weaving' });
    const shift = await shiftFor(emp);
    await post('/attendance/mark', { date: dayOf(shift), shift: 'DAY', records: [{ employeeId: emp._id, status: 'on_leave', leaveType: 'casual' }] });
    await post('/shift/verify-production', { shiftId: String(shift._id), productionMeters: 100 });
    expect(await todayRow(emp, shift)).toMatchObject({ status: 'on_leave', markedBy: 'Asha' });
  });
});

describe('who went unmarked', () => {
  it('a day with nothing on it but leave is not a day everybody else missed', async () => {
    const factoryDay = require('../../utils/factoryDay');
    const DAY = 86_400_000;
    const today = factoryDay.calendarDay();
    const ymd = (d) => d.toISOString().slice(0, 10);
    const [a, b] = [await makeEmp(), await makeEmp({ name: 'Mani' })];

    // Three working days b missed, and a marked every one of.
    for (const back of [1, 2, 3]) {
      await post('/attendance/mark', { date: ymd(new Date(today.getTime() - back * DAY)), shift: 'DAY', records: [{ employeeId: a._id, status: 'present' }] });
    }
    // Leave for a on a day nobody worked, and on a day that has not come yet.
    for (const offset of [-5, +2]) {
      const res = await post('/leave/admin-request', {
        employeeId: a._id, date: ymd(new Date(today.getTime() + offset * DAY)), shift: 'DAY', leaveType: 'casual', reason: 'x', autoApprove: true,
      });
      expect(res.status).toBe(201);
    }

    const res = await get('/attendance/repeatedly-unmarked?days=7&threshold=2');
    expect(res.status).toBe(200);
    expect(res.body.employees).toEqual([expect.objectContaining({ name: 'Mani', unmarkedDays: 3, workingDays: 3 })]);
    expect(String(res.body.employees[0].employeeId)).toBe(String(b._id));
  });
});
